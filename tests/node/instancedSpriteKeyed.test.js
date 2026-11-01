import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch, POSE_STATIC_FLOATS, SPLIT_POSE_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, GPU_KEYED_STORE_WORDS, bindGpuPack } from '../../src/render/gpuPackClient.js';
import { STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW } from '../../src/render/spriteIndexed.js';

// E-177: a keyed batch draws what a split batch draws. With the emit's statics store and ring kept as the emit keeps
// them (here by the test, from the queue rows: each sprite's statics into its entity's row, a change rung), each
// instance's pose and depth are the split batch's at the same slot, and the statics its key's row of the texture holds
// after the frame's upload and scatter (applied in order, as the GL draw lands) are the split batch's statics at that
// slot, over frames whose order, rows and statics move. The first keyed frame sends the whole store; so does a frame
// the ring overran. A frame the keyed pack declines goes split, and the keyed frames after it still find the texture
// right.

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const shaders = {
  spriteVertPose: read('instancedSpritePose.vert.glsl'),
  spriteVert: read('instancedSprite.vert.glsl'),
  spriteFrag: read('instancedSprite.frag.glsl'),
  spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
  spriteFragBlend: read('instancedSpriteBlend.frag.glsl'),
};

const N = 2500;
const ENTITIES = 6000;
const KEY_ROWS = gpuIndexedStaticRows(ENTITIES + N);
const RING = 8192;
const DEPTH = 4;
const KEY_NONE = 0xffffffff;
// What Pixi's upload options say for no type filter (pixiWorker._resetSpriteUploadOpts).
const NO_FILTER = { includeType: -1, excludeType0: -1, excludeType1: -1 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function statics(q, i, rng) {
  q.scaleX[i] = rng() * 3;
  q.scaleY[i] = rng() * 3;
  q.alpha[i] = rng();
  q.tint[i] = (rng() * 0xffffff) >>> 0;
  q.textureId[i] = (rng() * 400) | 0;
  q.anchorX[i] = rng();
  q.anchorY[i] = rng();
  q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
  q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
  q.tileOffsetU[i] = (rng() * 65535) | 0;
  q.tileOffsetV[i] = (rng() * 65535) | 0;
}

/** Queue row i's statics as gpuPack.c packs them for an indexed frame (depth 0, a zero after): a store row. */
function rowStatics(q, i) {
  const f = new Float32Array(GPU_KEYED_STORE_WORDS);
  const u = new Uint32Array(f.buffer);
  f[0] = q.scaleX[i];
  f[1] = q.scaleY[i];
  f[2] = q.anchorX[i];
  f[3] = q.anchorY[i];
  let a = q.alpha[i];
  if (!(a >= 0)) a = 0;
  else if (a > 1) a = 1;
  u[5] = ((((a * 255 + 0.5) | 0) & 255) << 24 | (q.tint[i] & 0xffffff)) >>> 0;
  f[6] = q.textureId[i];
  f[7] = q.tileMulX[i];
  f[8] = q.tileMulY[i];
  f[9] = q.tileOffsetU[i] * (1 / 65535);
  f[10] = q.tileOffsetV[i] * (1 / 65535);
  return u;
}

async function setup(seed) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 63) & ~63;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMode: alloc(Uint8Array, N),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), key: alloc(Uint32Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    q.type[i] = rng() < 0.1 ? 1 : 0;
    statics(q, i, rng);
  }
  const splitRows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const keyedRows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const store = alloc(Uint32Array, ENTITIES * GPU_KEYED_STORE_WORDS);
  const ring = alloc(Uint32Array, RING);
  const head = alloc(Uint32Array, 16);
  const keyed = {
    keyBase: ENTITIES,
    keyRows: KEY_ROWS,
    updatesByte: alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS).byteOffset,
    storeByte: store.byteOffset,
    ringByte: ring.byteOffset,
    ringEntries: RING,
    ringHeadByte: head.byteOffset,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // The statics texture: a stand-in that keeps its texels, takes whole rows (upload) and scatters each update into its
  // key's row, in order.
  const tex = { made: [], texels: null, scatters: [], uploads: [] };
  const ops = {
    maxSize: 16384,
    make(bits, width, height, label) {
      tex.made.push({ width, height, label });
      tex.texels = Uint32Array.from(bits.subarray(0, width * height * 4));
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      assert.ok(!(bits.buffer instanceof SharedArrayBuffer), 'the upload reads a private copy (E-123)');
      tex.texels.set(bits.subarray(y0 * width * 4, (y0 + rows) * width * 4), y0 * width * 4);
      tex.uploads.push([y0, rows]);
    },
    scatter(source, updates, count, width, height) {
      assert.deepEqual([width, height], [tex.made[0].width, tex.made[0].height], 'the scatter targets the texture');
      assert.ok(!(updates.buffer instanceof SharedArrayBuffer), 'the scatter reads a private copy (E-123)');
      for (let u = 0; u < count; u++) {
        const at = u * GPU_KEYED_ROW_WORDS;
        tex.texels.set(updates.subarray(at, at + GPU_INDEXED_STATIC_FLOATS), updates[at + GPU_KEYED_KEY_WORD] * GPU_INDEXED_STATIC_FLOATS);
      }
      tex.scatters.push(count);
    },
  };
  const opts = { capacity: N, label: 'e177', useWebGpu: false, shaders, gpuPack: pack, split: true };
  const split = new InstancedSpriteBatch({ ...opts, data: splitRows });
  const keyedBatch = new InstancedSpriteBatch({ ...opts, data: keyedRows, statics: ops, keyed });
  for (const b of [split, keyedBatch]) {
    for (const x of [...b._buffers, ...(b._staticBuffers || []), ...(b._slotBuffers || [])]) x.update = () => {};
  }
  return { rng, q, split, keyed: keyedBatch, tex, store, ring, head, ringHead: 0 };
}

/** What the emit does after writing the queue: each sprite's statics into its entity's store row, a change rung. */
function emitStore(s) {
  for (let i = 0; i < N; i++) {
    const e = s.q.key[i];
    if (e >= ENTITIES) continue;
    const row = rowStatics(s.q, i);
    const at = e * GPU_KEYED_STORE_WORDS;
    let same = true;
    for (let j = 0; j < GPU_KEYED_STORE_WORDS; j++) if (s.store[at + j] !== row[j]) same = false;
    if (same) continue;
    s.store.set(row, at);
    s.ring[s.ringHead & (RING - 1)] = e;
    s.ringHead = (s.ringHead + 1) >>> 0;
  }
  Atomics.store(s.head, 0, s.ringHead);
}

function assignKeys(s) {
  const { q, rng } = s;
  const picked = new Uint8Array(ENTITIES);
  for (let left = N; left > 0;) {
    const e = (rng() * ENTITIES) | 0;
    if (picked[e] === 0) {
      picked[e] = 1;
      left--;
    }
  }
  let e = 0;
  for (let i = 0; i < N; i++) {
    while (picked[e] === 0) e++;
    q.key[i] = q.type[i] === 1 ? KEY_NONE : e;
    e++;
  }
}

function painterOrder(s) {
  return Uint32Array.from({ length: N }, (_, i) => i).sort(() => s.rng() - 0.5);
}

/** Emit, then upload one frame to both batches and check the keyed one draws the split one's sprites. */
function frame(s, label, opts, { emit = true } = {}) {
  if (emit) emitStore(s);
  const n = s.split.upload(s.q, { ...opts });
  const scatters = s.tex.scatters.length;
  const m = s.keyed.upload(s.q, { ...opts });
  assert.equal(m, n, `${label}: instances`);
  assert.ok(n > 0, `${label}: the frame was drawn`);
  const k = s.keyed;
  assert.equal(k.mesh.shader, k._indexedShader, `${label}: the indexed program`);
  assert.ok(k._indexedGeometries.includes(k.mesh.geometry), `${label}: an indexed geometry`);
  assert.equal(k.mesh.geometry.instanceCount, n);
  const sp = new Uint32Array(s.split.data.buffer, s.split.data.byteOffset, n * SPLIT_POSE_FLOATS);
  const kp = new Uint32Array(k.data.buffer, k.data.byteOffset, n * SPLIT_POSE_FLOATS);
  for (let w = 0; w < sp.length; w++) if (sp[w] !== kp[w]) assert.fail(`${label}: pose word ${w}`);
  const ss = s.split.staticDataU32;
  const slotWords = new Uint32Array(k._slotData.buffer, k._slotData.byteOffset, n * GPU_INDEXED_SLOT_FLOATS);
  const texels = s.tex.texels;
  for (let slot = 0; slot < n; slot++) {
    const row = k._slotData[slot * GPU_INDEXED_SLOT_FLOATS];
    if (slotWords[slot * GPU_INDEXED_SLOT_FLOATS + 1] !== ss[slot * POSE_STATIC_FLOATS + DEPTH]) assert.fail(`${label}: slot ${slot}'s depth`);
    for (let j = 0; j < POSE_STATIC_FLOATS; j++) {
      const want = j === DEPTH ? 0 : ss[slot * POSE_STATIC_FLOATS + j];
      if (texels[row * GPU_INDEXED_STATIC_FLOATS + j] !== want) assert.fail(`${label}: slot ${slot} (key row ${row}) static ${j}`);
    }
  }
  return s.tex.scatters.slice(scatters).reduce((a, c) => a + c, 0);
}

test('a keyed batch draws a split batch\'s sprites, its statics from the emit\'s store by the ring', async () => {
  const s = await setup(177);
  const { keyed: k, tex } = s;
  assert.equal(k.keyed, true, 'a split batch with the regions, the scatter and the kernel goes keyed');
  assert.equal(s.split.keyed, false);
  assert.deepEqual(tex.made.map((t) => [t.width, t.height]), [[STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, KEY_ROWS / STATICS_TEX_ROW]],
    'one texture, a statics row for every key');
  assignKeys(s);
  const sorted = () => ({ ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, indices: painterOrder(s), indexCount: N, depthDenom: N });
  const keyless = () => s.q.key.filter((key) => key === KEY_NONE).length;
  frame(s, 'first frame', sorted());
  assert.deepEqual(tex.uploads, [[0, Math.ceil(ENTITIES / STATICS_TEX_ROW)]], 'the first keyed frame sends the whole store');
  const same = sorted();
  assert.equal(frame(s, 'a new order', same), keyless(), 'nothing changed: only the rows without a key go up');
  assert.equal(frame(s, 'the same frame again', { ...same }), keyless());
  for (let m = 0; m < N / 20; m++) statics(s.q, (s.rng() * N) | 0, s.rng);
  const few = frame(s, 'a twentieth changed', sorted());
  assert.ok(few > keyless() && few < keyless() + N / 10, `the changed sprites and the rows without a key (${few})`);
  assignKeys(s);
  frame(s, 'other entities', sorted());
  frame(s, 'queue order', { ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, depthDenom: N });
  assert.equal(tex.uploads.length, 1, 'the store went up once');
  // A queue without the key column: the frame goes split, with the split program; keyed frames after it hold.
  const key = s.q.key;
  s.q.key = null;
  const n = s.split.upload(s.q, sorted());
  assert.ok(n > 0);
  assert.equal(k.upload(s.q, sorted()), n);
  assert.equal(k.mesh.shader, k.shader, 'a frame without keys draws split');
  s.q.key = key;
  for (let m = 0; m < N / 20; m++) statics(s.q, (s.rng() * N) | 0, s.rng);
  frame(s, 'keyed again', sorted());
});

test('frames the emit wrote while the batch drew none come up from the ring; a ring the emit overran, from the store', async () => {
  const s = await setup(178);
  assignKeys(s);
  const sorted = () => ({ ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, indices: painterOrder(s), indexCount: N, depthDenom: N });
  frame(s, 'first frame', sorted());
  // Three emitted frames the batch skipped (Pixi drew none of them), then one it draws: the ring holds them all.
  for (let f = 0; f < 3; f++) {
    for (let m = 0; m < N / 10; m++) statics(s.q, (s.rng() * N) | 0, s.rng);
    emitStore(s);
  }
  frame(s, 'after three skipped frames', sorted());
  assert.equal(s.tex.uploads.length, 1, 'the ring covered them');
  // The emit laps the ring: more changes than its entries since the batch's last frame.
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < N; i++) statics(s.q, i, s.rng);
    emitStore(s);
  }
  assert.ok(s.ringHead - RING > 0, 'the ring was lapped');
  frame(s, 'after the ring was lapped', sorted());
  assert.equal(s.tex.uploads.length, 2, 'the whole store went up again');
  for (let m = 0; m < N / 20; m++) statics(s.q, (s.rng() * N) | 0, s.rng);
  frame(s, 'and on from the ring', sorted());
  assert.equal(s.tex.uploads.length, 2);
});
