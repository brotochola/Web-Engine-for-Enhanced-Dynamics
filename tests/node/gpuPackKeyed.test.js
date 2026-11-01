import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD,
  GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import {
  GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, bindGpuPack, packKeyedRowsWasm, packSplitRowsWasm,
} from '../../src/render/gpuPackClient.js';

// E-177: the keyed pack writes, for each draw slot, the pose the split pack writes there and the slot pair (its key's
// table row and the depth the split pack writes at that slot), and lists as updates the statics that differ from what
// the key's row held. Applied in order to a copy of the table that starts as zeros, the updates leave every drawn slot's
// key row holding that slot's split statics (their depth term 0, a zero after them): a frame drawn from the poses, the
// keys and that copy is the split frame, whatever changed between frames.

const N = 5000;
const ENTITIES = 12000;
const KEY_BASE = ENTITIES;
const KEY_ROWS = KEY_BASE + N;
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

function randomStatics(q, i, rng) {
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
    q.type[i] = (rng() * 7) | 0;
    randomStatics(q, i, rng);
  }
  const order = alloc(Uint32Array, N);
  const splitPose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
  const table = alloc(Uint32Array, KEY_ROWS * GPU_KEYED_ROW_WORDS);
  const stamps = alloc(Uint32Array, KEY_ROWS);
  const updates = alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  const keyed = {
    tableByte: table.byteOffset, stampByte: stamps.byteOffset, keyBase: KEY_BASE, epoch: 0,
    updatesByte: updates.byteOffset, updates: 0,
  };
  // The renderer's copy of the key table: three RGBA texels a row, zeros at first.
  const gpu = new Uint32Array(KEY_ROWS * GPU_INDEXED_STATIC_FLOATS);
  return { rng, q, b, order, splitPose, splitStat, pose, slots, table, stamps, updates, keyed, gpu };
}

/** A frame's keys: distinct entities ascending in the queue's order, a few rows with none, past the base or repeated. */
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
    q.key[i] = e++;
  }
  for (let m = 0; m < 60; m++) q.key[(rng() * N) | 0] = KEY_NONE;
  for (let m = 0; m < 20; m++) q.key[(rng() * N) | 0] = KEY_BASE + ((rng() * 50) | 0);
  for (let m = 0; m < 20; m++) {
    const i = (rng() * N) | 0;
    q.key[i] = q.key[(rng() * N) | 0];
  }
}

function shuffle(s, n) {
  const { order, rng } = s;
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

/** Pack one frame both ways, apply the updates to the renderer's copy, and check the keyed frame is the split frame. */
function checkFrame(s, label, opts, cap) {
  const splitCtx = makePackContext(s.q, opts, cap, {});
  const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, s.splitStat, cap);
  assert.ok(n > 0, `${label}: the split pack ran`);
  s.pose.fill(-7);
  s.slots.fill(-7);
  s.keyed.epoch = (s.keyed.epoch + 1) >>> 0 || 1;
  const before = Uint32Array.from(s.gpu);
  const ctx = makePackContext(s.q, opts, cap, {});
  assert.equal(packKeyedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, s.keyed, cap), n, `${label}: rows`);
  assert.equal(ctx.particleCount, splitCtx.particleCount, `${label}: particles`);
  // The slots each row takes: its key the first time this frame, else past the base.
  const taken = new Set();
  const sp = words(s.splitPose, n * GPU_POSE_FLOATS);
  const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
  const kp = words(s.pose, n * GPU_POSE_FLOATS);
  const kSlot = words(s.slots, n * GPU_INDEXED_SLOT_FLOATS);
  const want = new Map();
  for (let k = 0; k < n; k++) {
    const i = opts.indices ? opts.indices[k] : k;
    const key = s.q.key[i];
    const slot = key < KEY_BASE && !taken.has(key) ? key : KEY_BASE + k;
    taken.add(slot);
    if (s.slots[k * GPU_INDEXED_SLOT_FLOATS] !== slot) assert.fail(`${label}: slot ${k} takes row ${s.slots[k * 2]}, not ${slot}`);
    if (kSlot[k * GPU_INDEXED_SLOT_FLOATS + 1] !== ss[k * GPU_STATIC_FLOATS + DEPTH]) assert.fail(`${label}: slot ${k}'s depth`);
    for (let j = 0; j < GPU_POSE_FLOATS; j++) {
      if (kp[k * GPU_POSE_FLOATS + j] !== sp[k * GPU_POSE_FLOATS + j]) assert.fail(`${label}: slot ${k} pose ${j}`);
    }
    const row = new Uint32Array(GPU_INDEXED_STATIC_FLOATS);
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) row[j] = j === DEPTH ? 0 : ss[k * GPU_STATIC_FLOATS + j];
    want.set(slot, row);
  }
  // The updates: one per slot whose row the renderer's copy held otherwise, each a key once, in any order.
  const count = s.keyed.updates;
  const seen = new Set();
  for (let u = 0; u < count; u++) {
    const rec = s.updates.subarray(u * GPU_KEYED_ROW_WORDS, (u + 1) * GPU_KEYED_ROW_WORDS);
    const key = rec[GPU_KEYED_KEY_WORD];
    if (seen.has(key)) assert.fail(`${label}: key ${key} updated twice`);
    seen.add(key);
    if (!want.has(key)) assert.fail(`${label}: an update for key ${key}, which no slot took`);
    for (let j = GPU_KEYED_KEY_WORD + 1; j < GPU_KEYED_ROW_WORDS; j++) if (rec[j] !== 0) assert.fail(`${label}: update ${u}'s pad`);
    s.gpu.set(rec.subarray(0, GPU_INDEXED_STATIC_FLOATS), key * GPU_INDEXED_STATIC_FLOATS);
  }
  let changed = 0;
  for (const [slot, row] of want) {
    const at = slot * GPU_INDEXED_STATIC_FLOATS;
    let differed = false;
    for (let j = 0; j < GPU_INDEXED_STATIC_FLOATS; j++) {
      if (before[at + j] !== row[j]) differed = true;
      if (s.gpu[at + j] !== row[j]) assert.fail(`${label}: slot row ${slot} word ${j} after the updates`);
    }
    if (differed) changed++;
  }
  assert.equal(count, changed, `${label}: updates`);
  return { n, updates: count };
}

test('the keyed pack is the split pack: the pose and depth at each slot, the statics by key after the updates', async () => {
  for (const seed of [177, 178]) {
    const s = await setup(seed);
    assignKeys(s);
    shuffle(s, N);
    const sorted = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
    const first = checkFrame(s, 'first frame', sorted, N);
    assert.ok(first.updates > N - 200, 'a first frame updates almost every slot');
    // The same frame again: nothing moved, so nothing goes up.
    assert.equal(checkFrame(s, 'the same frame', sorted, N).updates, 0);
    // A twentieth of the rows change a static, the order moves: those rows go up, and the rows past the base whose
    // slot another row held before.
    for (let m = 0; m < N / 20; m++) randomStatics(s.q, (s.rng() * N) | 0, s.rng);
    shuffle(s, N);
    const third = checkFrame(s, 'changed statics', sorted, N);
    assert.ok(third.updates > 0 && third.updates < N / 4, `a frame of a few changes: ${third.updates} updates`);
    // Other entities on screen: new keys.
    assignKeys(s);
    checkFrame(s, 'new keys', sorted, N);
    checkFrame(s, 'capacity under count', sorted, 3210);
    checkFrame(s, 'no list', { space: GPU_SPACE_WORLD, type: s.q.type }, N);
    checkFrame(s, 'no type column', { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N }, N);
    checkFrame(s, 'indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N);
  }
});

test('the keyed pack declines what it does not take', async () => {
  const s = await setup(5);
  assignKeys(s);
  shuffle(s, N);
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
