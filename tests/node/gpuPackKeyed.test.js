import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD,
  GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import {
  GPU_KEYED_CHANGED, GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, bindGpuPack, packKeyedRowsWasm, packSplitRowsWasm,
} from '../../src/render/gpuPackClient.js';

// E-177: the keyed pack writes, for each draw slot, the pose the split pack writes there and the slot pair (the row's
// key, its entity without the changed bit, or for a row without one the slot past the entities, and the depth the split
// pack writes at that slot), and lists as updates the statics, as the split pack packs them, of the rows the emit marked
// changed and of the rows without a key.

const N = 5000;
const ENTITIES = 12000;
const KEY_BASE = ENTITIES;
const DEPTH = 4; // the depth's float in the statics (gpuPack.c sprite_static)
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
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
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
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), key: alloc(Uint32Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    q.scaleX[i] = rng() * 3;
    q.scaleY[i] = rng() * 3;
    const a = rng();
    q.alpha[i] = a < 0.05 ? NaN : a < 0.1 ? -0.5 : a < 0.15 ? 1.7 : rng();
    q.tint[i] = (rng() * 0xffffffff) >>> 0;
    q.textureId[i] = (rng() * 65535) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.type[i] = (rng() * 7) | 0;
    // Sprites keyed by entity, a tenth marked changed; a few rows without a key or past the entities.
    const r = rng();
    const e = (rng() * ENTITIES) | 0;
    q.key[i] = r < 0.05 ? KEY_NONE : r < 0.07 ? KEY_BASE + ((rng() * 100) | 0) : rng() < 0.1 ? (e | GPU_KEYED_CHANGED) >>> 0 : e;
  }
  const order = alloc(Uint32Array, N);
  for (let i = 0; i < N; i++) order[i] = i;
  for (let i = N - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const splitPose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
  const updates = alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  const keyed = { keyBase: KEY_BASE, updatesByte: updates.byteOffset, updates: 0 };
  return { rng, q, b, order, splitPose, splitStat, pose, slots, updates, keyed };
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

function checkPack(s, label, opts, cap) {
  const splitCtx = makePackContext(s.q, opts, cap, {});
  const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, s.splitStat, cap);
  assert.ok(n > 0, `${label}: the split pack ran`);
  s.pose.fill(-7);
  s.slots.fill(-7);
  const ctx = makePackContext(s.q, opts, cap, {});
  assert.equal(packKeyedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, s.keyed, cap), n, `${label}: rows`);
  assert.equal(ctx.particleCount, splitCtx.particleCount, `${label}: particles`);
  const sp = words(s.splitPose, n * GPU_POSE_FLOATS);
  const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
  const kp = words(s.pose, n * GPU_POSE_FLOATS);
  const kSlot = words(s.slots, n * GPU_INDEXED_SLOT_FLOATS);
  let u = 0;
  for (let k = 0; k < n; k++) {
    const i = opts.indices ? opts.indices[k] : k;
    const raw = s.q.key[i];
    const key = (raw & ~GPU_KEYED_CHANGED) >>> 0;
    const keyless = key >= KEY_BASE;
    const slot = keyless ? KEY_BASE + k : key;
    const send = keyless || (raw & GPU_KEYED_CHANGED) !== 0;
    if (s.slots[k * GPU_INDEXED_SLOT_FLOATS] !== slot) assert.fail(`${label}: slot ${k} takes row ${s.slots[k * 2]}, not ${slot}`);
    if (kSlot[k * GPU_INDEXED_SLOT_FLOATS + 1] !== ss[k * GPU_STATIC_FLOATS + DEPTH]) assert.fail(`${label}: slot ${k}'s depth`);
    for (let j = 0; j < GPU_POSE_FLOATS; j++) {
      if (kp[k * GPU_POSE_FLOATS + j] !== sp[k * GPU_POSE_FLOATS + j]) assert.fail(`${label}: slot ${k} pose ${j}`);
    }
    if (!send) continue;
    // A changed row or a row without a key: its statics, as the split pack packs them, go up as the next update.
    const rec = s.updates.subarray(u * GPU_KEYED_ROW_WORDS, (u + 1) * GPU_KEYED_ROW_WORDS);
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
      const want = j === DEPTH ? 0 : ss[k * GPU_STATIC_FLOATS + j];
      if (rec[j] !== want) assert.fail(`${label}: slot ${k}'s update word ${j}`);
    }
    if (rec[GPU_STATIC_FLOATS] !== 0) assert.fail(`${label}: slot ${k}'s update pad`);
    if (rec[GPU_KEYED_KEY_WORD] !== slot) assert.fail(`${label}: slot ${k}'s update key ${rec[GPU_KEYED_KEY_WORD]}`);
    u++;
  }
  assert.equal(s.keyed.updates, u, `${label}: one update a changed row or a row without a key`);
  return u;
}

test('the keyed pack is the split pack: the pose and depth at each slot, the key, the changed and keyless rows\' statics', async () => {
  for (const seed of [177, 178]) {
    const s = await setup(seed);
    const sorted = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
    const sent = checkPack(s, 'painter order', sorted, N);
    assert.ok(sent > N * 0.1 && sent < N * 0.3, `the changed rows and the rows without a key go up (${sent})`);
    checkPack(s, 'capacity under count', sorted, 3210);
    checkPack(s, 'no list', { space: GPU_SPACE_WORLD, type: s.q.type }, N);
    checkPack(s, 'no type column', { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N }, N);
    checkPack(s, 'indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N);
  }
});

test('the keyed pack declines what it does not take', async () => {
  const s = await setup(5);
  const { q, b, pose, slots, keyed, order } = s;
  const run = (opts, qq = q, p = pose, sl = slots) => packKeyedRowsWasm(b, qq, makePackContext(qq, opts, N, {}), p, sl, keyed, N);
  assert.equal(run({ space: GPU_SPACE_SCREEN, zoom: 1, indices: order, indexCount: N }), -1, 'screen space');
  assert.equal(run({ space: GPU_SPACE_WORLD, pixelSnap: true, indices: order, indexCount: N }), -1, 'pixel snap');
  assert.equal(run({ space: GPU_SPACE_WORLD, type: q.type, includeType: 0 }), -1, 'a type filter');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, { ...q, key: null }), -1, 'no key column');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, { ...q, key: new Uint32Array(N) }), -1,
    'a key column outside the memory');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, q, new Float32Array(N * 4)), -1, 'poses outside');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, q, pose, new Float32Array(N * 2)), -1, 'slots outside');
});
