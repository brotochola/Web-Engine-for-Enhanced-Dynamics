// E-387: a keyed batch handed the G-buffer columns (setGbufColumns) has its keyed pack write each instance's words, the
// words gbufWord.js writeGbufWords writes from the queue's key column bit for bit, says so (gbufPacked) and commits them
// from the render-queue memory (packedGbuf); a frame it draws otherwise, or a batch without the columns or without a
// G-buffer, leaves the words to the caller. On both keyed forms: by pose and by queue row (E-201).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { GPU_GBUF_FLOATS, gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_CHANGED, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS, bindGpuPack } from '../../src/render/gpuPackClient.js';
import { writeGbufWords } from '../../src/render/gbufWord.js';

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
// Keys past the entities and under keyBase (E-188's decorations).
const DECORATIONS = 50;
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
    q.rotC[i] = 1;
    q.scaleX[i] = q.scaleY[i] = 1;
    q.alpha[i] = 1;
    q.textureId[i] = (rng() * 400) | 0;
    q.type[i] = rng() < 0.1 ? 1 : 0;
    // Sprites keyed by entity, some marked changed; the particles without a key; a few keys past the entities.
    const e = (rng() * ENTITIES) | 0;
    q.key[i] = q.type[i] === 1 ? KEY_NONE
      : rng() < 0.03 ? ENTITIES + ((rng() * DECORATIONS) | 0)
        : (e | (rng() < 0.2 ? GPU_KEYED_CHANGED : 0)) >>> 0;
  }
  const flags = alloc(Uint8Array, ENTITIES);
  const selfShadow = alloc(Uint8Array, ENTITIES);
  const zIndex = alloc(Int16Array, ENTITIES);
  for (let e = 0; e < ENTITIES; e++) {
    flags[e] = (rng() * 256) | 0;
    selfShadow[e] = (rng() * 3) | 0;
    zIndex[e] = (rng() * 3) | 0;
  }
  const rows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const header = alloc(Uint32Array, 16);
  const keyed = {
    keyBase: ENTITIES + DECORATIONS,
    keyRows: gpuIndexedStaticRows(ENTITIES + DECORATIONS + N),
    updatesByte: alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS).byteOffset,
    headerByte: header.byteOffset,
    shadowByte: -1,
    texUpdatesByte: alloc(Uint32Array, N * GPU_KEYED_TEX_WORDS).byteOffset,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // A statics helper that keeps nothing: this test reads the words alone.
  const statics = {
    maxSize: 16384,
    make: (bits, width, height, label) => new TextureSource({ width, height, label }),
    upload() {},
    scatter() {},
  };
  const make = (extra) => {
    const b = new InstancedSpriteBatch({
      capacity: N, label: 'e387', useWebGpu: false, shaders, gpuPack: pack, split: true, data: rows, statics, keyed, ...extra,
    });
    for (const x of [...b._buffers, ...(b._staticBuffers || []), ...(b._slotBuffers || []), ...(b._gbufBuffers || [])]) {
      x.update = () => {};
    }
    // Queue frame 1, buffer 0, whose marks count from no frame (the header's SINCE0 is 0): drawn keyed.
    b.keyedFrame = 1;
    b.keyedBuffer = 0;
    return b;
  };
  return { rng, q, flags, selfShadow, zIndex, pack, make };
}

/** The batch's committed words against writeGbufWords' for the same rows, bit for bit; the entity rows and top band. */
function assertWords(label, got, n, order, keys, flags, self, z) {
  const want = new Float32Array(n * GPU_GBUF_FLOATS);
  writeGbufWords(want, n, order, null, null, keys, flags.length, flags, self, z);
  const g = new Uint32Array(got.buffer, got.byteOffset, n * GPU_GBUF_FLOATS);
  const w = new Uint32Array(want.buffer, 0, n * GPU_GBUF_FLOATS);
  for (let i = 0; i < w.length; i++) {
    if (g[i] !== w[i]) assert.fail(`${label}: slot ${i >> 1} ${i & 1 ? 'band' : 'word'} ${got[i]}, not ${want[i]}`);
  }
  let words = 0;
  let bands = 0;
  for (let k = 0; k < n; k++) {
    if (want[2 * k] !== 0) words++;
    if (want[2 * k + 1] > bands) bands = want[2 * k + 1];
  }
  return { words, bands };
}

test('a keyed batch handed the G-buffer columns commits its pack\'s words, writeGbufWords\' bit for bit', async () => {
  const s = await setup(387);
  const order = Uint32Array.from({ length: N }, (_, i) => i).sort(() => s.rng() - 0.5);
  const opts = {
    space: BATCH_SPACE.WORLD, type: s.q.type, indices: order, indexCount: N, depthDenom: N, includeType: -1,
    excludeType0: -1, excludeType1: -1,
  };
  for (const [form, extra] of [['by pose', { gbuf: true }], ['by queue row', { gbuf: true, posesByRow: true }]]) {
    const batch = s.make(extra);
    assert.equal(batch.keyed, true, `${form}: keyed`);
    assert.equal(batch.posesByRow, form === 'by queue row');
    assert.equal(batch.packedGbuf.length, N * GPU_GBUF_FLOATS, `${form}: room for every instance's words`);
    assert.equal(batch.packedGbuf.buffer, s.pack.buffer, `${form}: in the render-queue memory`);
    // Not handed the columns: drawn keyed, the words left to the caller.
    assert.equal(batch.upload(s.q, { ...opts }), N, `${form}: drawn`);
    assert.notEqual(batch.mesh.shader, batch.shader, `${form}: keyed`);
    assert.equal(batch.gbufPacked, false, `${form}: no columns, no words`);
    for (const [label, self, z] of [
      ['with bands', s.selfShadow, s.zIndex],
      ['no bands', s.selfShadow, null],
      ['no selfShadow', null, s.zIndex],
    ]) {
      batch.setGbufColumns(s.flags, self, z);
      batch.packedGbuf.fill(-7);
      batch.gbufData.fill(-9);
      const n = batch.upload(s.q, { ...opts });
      assert.equal(n, N, `${form}, ${label}: drawn`);
      assert.notEqual(batch.mesh.shader, batch.shader, `${form}, ${label}: keyed`);
      assert.equal(batch.gbufPacked, true, `${form}, ${label}: the pack wrote the words`);
      batch.commitGbuf(batch.packedGbuf, n);
      const seen = assertWords(`${form}, ${label}`, batch.gbufData, n, order, s.q.key, s.flags, self, z);
      assert.ok(seen.words > N * 0.8 && seen.words < N, `${form}, ${label}: entities and rows that are none (${seen.words})`);
      assert.equal(seen.bands > 0, z !== null, `${form}, ${label}: bands only with a zIndex column`);
    }
    // A frame drawn split (no key column): its words are the caller's.
    const key = s.q.key;
    s.q.key = null;
    assert.equal(batch.upload(s.q, { ...opts }), N);
    assert.equal(batch.mesh.shader, batch.shader, `${form}: drawn split`);
    assert.equal(batch.gbufPacked, false, `${form}: a frame drawn split has no words of the pack's`);
    s.q.key = key;
    assert.equal(batch.upload(s.q, { ...opts }), N);
    assert.equal(batch.gbufPacked, true, `${form}: keyed again, the words again`);
  }
  // A keyed batch without a G-buffer, handed the columns: nowhere to write them.
  const plain = s.make({});
  assert.equal(plain.packedGbuf.length, 0);
  plain.setGbufColumns(s.flags, s.selfShadow, s.zIndex);
  assert.equal(plain.upload(s.q, { ...opts }), N);
  assert.equal(plain.gbufPacked, false, 'no G-buffer, no words');
});
