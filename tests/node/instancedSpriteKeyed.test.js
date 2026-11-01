import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch, POSE_STATIC_FLOATS, SPLIT_POSE_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, bindGpuPack } from '../../src/render/gpuPackClient.js';
import { STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW } from '../../src/render/spriteIndexed.js';

// E-177: a keyed batch draws what a split batch draws. Over frames whose order, rows and statics move, each instance's
// pose and depth are the split batch's at the same slot, and the statics its key's row of the texture holds after the
// frame's scatter (applied in order, as the GL draw lands) are the split batch's statics at that slot. A frame the
// keyed pack declines goes split, and the keyed frames after it still find the texture right.

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
const DEPTH = 4;
const KEY_NONE = 0xffffffff;

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
  const keyed = {
    tableByte: alloc(Uint32Array, KEY_ROWS * 2).byteOffset,
    stampByte: alloc(Uint32Array, KEY_ROWS).byteOffset,
    updatesByte: alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS).byteOffset,
    keyBase: ENTITIES,
    keyRows: KEY_ROWS,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // The statics texture: a stand-in that keeps its texels and scatters each update into its key's row, in order.
  const tex = { made: [], texels: null, scatters: [] };
  const ops = {
    maxSize: 16384,
    make(bits, width, height, label) {
      tex.made.push({ width, height, label });
      tex.texels = Uint32Array.from(bits.subarray(0, width * height * 4));
      return new TextureSource({ width, height, label });
    },
    upload() {
      throw new Error('a keyed batch sends no statics rows');
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
  return { rng, q, split, keyed: keyedBatch, tex };
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

// What Pixi's upload options say for no type filter (pixiWorker._resetSpriteUploadOpts).
const NO_FILTER = { includeType: -1, excludeType0: -1, excludeType1: -1 };

function painterOrder(s) {
  return Uint32Array.from({ length: N }, (_, i) => i).sort(() => s.rng() - 0.5);
}

/** Upload one frame to both batches and check the keyed one draws the split one's sprites. */
function frame(s, label, opts) {
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

test('a keyed batch draws a split batch\'s sprites, its statics by key from the scattered texture', async () => {
  const s = await setup(177);
  const { keyed: k, tex } = s;
  assert.equal(k.keyed, true, 'a split batch with the regions, the scatter and the kernel goes keyed');
  assert.equal(s.split.keyed, false);
  assert.deepEqual(tex.made.map((t) => [t.width, t.height]), [[STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, KEY_ROWS / STATICS_TEX_ROW]],
    'one texture, a statics row for every key');
  assert.ok(!(k._keyUpdates.buffer instanceof SharedArrayBuffer) || k._keyUpdates.buffer !== k._sharedUpdates.buffer);
  assignKeys(s);
  const sorted = () => ({ ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, indices: painterOrder(s), indexCount: N, depthDenom: N });
  const first = frame(s, 'first frame', sorted());
  assert.ok(first > N * 0.9, `the first frame scatters nearly every slot (${first})`);
  const same = sorted();
  frame(s, 'a new order', same);
  assert.equal(frame(s, 'the same frame again', { ...same }), 0, 'nothing changed, nothing scattered');
  for (let m = 0; m < N / 20; m++) statics(s.q, (s.rng() * N) | 0, s.rng);
  const few = frame(s, 'a twentieth changed', sorted());
  assert.ok(few > 0 && few < N / 4, `a few scattered (${few})`);
  assignKeys(s);
  frame(s, 'other entities', sorted());
  frame(s, 'queue order', { ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, depthDenom: N });
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
