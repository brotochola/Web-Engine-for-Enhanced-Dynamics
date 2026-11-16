import test from 'node:test';
import assert from 'node:assert/strict';

import { GPU_GBUF_FLOATS, GPU_INDEXED_SLOT_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_WORLD, makePackContext } from '../../src/render/gpuQueueLayout.js';
import {
  GPU_KEYED_CHANGED, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_ONLY, GPU_KEYED_TEX_WORDS, bindGpuPack, packKeyedRowsByRowWasm,
  packKeyedRowsWasm,
} from '../../src/render/gpuPackClient.js';
import { GBUF_MAX_BANDS, writeGbufWords } from '../../src/render/gbufWord.js';
import { run as runKeyedMicrobench } from '../bench/gpuPackKeyedMicrobench.mjs';

// E-387: given the columns, the keyed pack writes each drawn instance's G-buffer words at its draw slot, bit for bit the
// words gbufWord.js writeGbufWords writes from the queue's key column (Pixi's frame before it): the entity's id, its
// gbufFlags and selfShadow (none past a shorter selfShadow column), 0 for a row that is no entity (no key, a key past the
// entities: a decoration's, a slot's past keyBase), whatever flag bits the key carries; and with a zIndex column the
// bands along the draw order. The rest of the pack's output is what it is without them. A column it cannot read
// declines the words alone: the pack runs, and says it wrote none.

const N = 4000;
// Past 65535, so the id wraps (entity % 65535 + 1).
const ENTITIES = 70000;
// Keys past the entities and under keyBase: E-188's keyed decorations.
const DECORATIONS = 300;
const KEY_BASE = ENTITIES + DECORATIONS;
const KEY_NONE = 0xffffffff;
const KEY_FLAGS = (GPU_KEYED_CHANGED | GPU_KEYED_TEX_ONLY) >>> 0;
const Z_VALUES = [-32768, -5, 0, 0, 0, 3, 7, 32767];

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
  const memory = new WebAssembly.Memory({ initial: 160, maximum: 8192, shared: true });
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
    q.alpha[i] = rng();
    q.tint[i] = (rng() * 0xffffffff) >>> 0;
    q.textureId[i] = (rng() * 65535) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.shadowH[i] = rng() < 0.3 ? 0 : rng() * 2;
    q.shadowOffX[i] = rng() * 4 - 2;
    q.shadowOffY[i] = rng() * 4 - 2;
    q.type[i] = (rng() * 5) | 0;
    // Entities with every mix of the flag bits, rows without a key, keys past the entities (a decoration's) and past
    // keyBase.
    const r = rng();
    const e = (rng() * ENTITIES) | 0;
    const flagBits = [0, GPU_KEYED_CHANGED, KEY_FLAGS, GPU_KEYED_TEX_ONLY][(rng() * 4) | 0];
    q.key[i] = r < 0.05 ? KEY_NONE
      : r < 0.08 ? (ENTITIES + ((rng() * DECORATIONS) | 0) | flagBits) >>> 0
        : r < 0.1 ? KEY_BASE + ((rng() * 100) | 0)
          : (e | flagBits) >>> 0;
  }
  // The first and last entities, and the ids either side of the wrap.
  q.key[0] = 0;
  q.key[1] = ENTITIES - 1;
  q.key[2] = 65534;
  q.key[3] = (65535 | GPU_KEYED_CHANGED) >>> 0;
  q.key[4] = 65536;
  const order = alloc(Uint32Array, N);
  for (let i = 0; i < N; i++) order[i] = i;
  for (let i = N - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  // The entity columns, every bit set somewhere (the words take 6 bits of the flags and 2 of selfShadow).
  const flags = alloc(Uint8Array, ENTITIES);
  const selfShadow = alloc(Uint8Array, ENTITIES);
  const zIndex = alloc(Int16Array, ENTITIES);
  for (let e = 0; e < ENTITIES; e++) {
    flags[e] = (rng() * 256) | 0;
    selfShadow[e] = (rng() * 256) | 0;
    zIndex[e] = Z_VALUES[(rng() * Z_VALUES.length) | 0];
  }
  // The painter's order zIndex first (a row that is no entity at 0), then the shuffle: a few bands, not the most.
  const zOf = (i) => {
    const ke = (q.key[i] & ~KEY_FLAGS) >>> 0;
    return q.key[i] !== KEY_NONE && ke < ENTITIES ? zIndex[ke] : 0;
  };
  const zOrder = alloc(Uint32Array, N);
  zOrder.set(Array.from(order).sort((a, b) => zOf(a) - zOf(b)));
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const rows = alloc(Float32Array, N);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
  const updates = alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS);
  const texUpdates = alloc(Uint32Array, N * GPU_KEYED_TEX_WORDS);
  const shadow = alloc(Float32Array, N * 3);
  const gbufOut = alloc(Float32Array, N * GPU_GBUF_FLOATS);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  return { rng, q, b, order, zOrder, flags, selfShadow, zIndex, pose, rows, slots, updates, texUpdates, shadow, gbufOut };
}

const u32 = (a, n) => new Uint32Array(a.buffer, a.byteOffset, n);

/** Everything a keyed pack writes but the words, copied: what a pack with the words must write too. */
function packOutput(s, n, byRow, keyed) {
  return {
    first: Uint32Array.from(byRow ? u32(s.rows, n) : u32(s.pose, n * GPU_POSE_FLOATS)),
    slots: Uint32Array.from(u32(s.slots, n * GPU_INDEXED_SLOT_FLOATS)),
    updates: Uint32Array.from(s.updates.subarray(0, keyed.updates * GPU_KEYED_ROW_WORDS)),
    texUpdates: Uint32Array.from(s.texUpdates.subarray(0, (keyed.texUpdates | 0) * GPU_KEYED_TEX_WORDS)),
    shadow: keyed.shadowed ? Uint32Array.from(u32(s.shadow, n * 3)) : null,
    counts: [keyed.updates, keyed.texUpdates | 0, keyed.shadowed],
  };
}

/**
 * One frame packed without the words, then with them: the same output, and the words writeGbufWords writes for the
 * frame's rows. `cols`: the selfShadow column and the zIndex column (null for none) the pack and writeGbufWords take;
 * `kernelZ`, what the pack is handed for no bands (null or an empty column), or the zIndex column.
 */
function checkWords(s, label, { opts, cap = N, byRow = false, shadow = false, texUpdates = false, self, z, kernelZ = z }) {
  const keyed = {
    keyBase: KEY_BASE, updatesByte: s.updates.byteOffset, updates: 0, shadowByte: shadow ? s.shadow.byteOffset : 0,
    texUpdatesByte: texUpdates ? s.texUpdates.byteOffset : 0, texUpdates: 0,
  };
  const pack = byRow ? packKeyedRowsByRowWasm : packKeyedRowsWasm;
  const first = byRow ? s.rows : s.pose;
  const n = pack(s.b, s.q, makePackContext(s.q, opts, cap, {}), first, s.slots, keyed, cap);
  assert.equal(n, Math.min(opts.indices ? opts.indexCount : N, cap), `${label}: rows`);
  assert.equal(keyed.gbufWritten, false, `${label}: no columns, no words`);
  const plain = packOutput(s, n, byRow, keyed);
  s.gbufOut.fill(-7);
  keyed.gbufOut = s.gbufOut;
  keyed.gbufFlags = s.flags;
  keyed.gbufSelf = self;
  keyed.gbufZ = kernelZ;
  assert.equal(pack(s.b, s.q, makePackContext(s.q, opts, cap, {}), first, s.slots, keyed, cap), n, `${label}: rows with the words`);
  assert.equal(keyed.gbufWritten, true, `${label}: the pack wrote the words`);
  assert.deepEqual(packOutput(s, n, byRow, keyed), plain, `${label}: the rest of the output as without them`);
  const want = new Float32Array(n * GPU_GBUF_FLOATS);
  writeGbufWords(want, n, opts.indices || null, null, null, s.q.key, s.flags.length, s.flags, self, z);
  const got = u32(s.gbufOut, n * GPU_GBUF_FLOATS);
  const wantBits = u32(want, n * GPU_GBUF_FLOATS);
  for (let w = 0; w < n * GPU_GBUF_FLOATS; w++) {
    if (got[w] !== wantBits[w]) {
      const k = w >> 1;
      const row = opts.indices ? opts.indices[k] : k;
      assert.fail(`${label}: slot ${k} (row ${row}, key 0x${s.q.key[row].toString(16)}) ${w & 1 ? 'band' : 'word'}: `
        + `${s.gbufOut[w]}, not ${want[w]}`);
    }
  }
  if (n < N) assert.equal(s.gbufOut[n * GPU_GBUF_FLOATS], -7, `${label}: nothing past the rows packed`);
  let entityRows = 0;
  let maxBand = 0;
  for (let k = 0; k < n; k++) {
    if (want[2 * k] !== 0) entityRows++;
    if (want[2 * k + 1] > maxBand) maxBand = want[2 * k + 1];
  }
  return { n, entityRows, maxBand };
}

const selfShort = (s) => new Uint8Array(s.selfShadow.buffer, s.selfShadow.byteOffset, ENTITIES >> 1);

test('the keyed pack writes writeGbufWords\' words and bands, bit for bit, on both forms and with every column', async () => {
  for (const seed of [387, 388]) {
    const s = await setup(seed);
    const painter = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
    const zFirst = { space: GPU_SPACE_WORLD, indices: s.zOrder, indexCount: N, type: s.q.type };
    for (const byRow of [false, true]) {
      const form = byRow ? 'by row' : 'pose';
      const c = (label, o) => checkWords(s, `${form}, ${label}`, { byRow, ...o });
      const all = c('painter order, no bands', { opts: painter, self: s.selfShadow, z: null });
      assert.ok(all.entityRows > N * 0.8 && all.entityRows < N, `entities and rows that are none (${all.entityRows})`);
      assert.equal(all.maxBand, 0, 'no bands without a zIndex column');
      c('no bands, an empty zIndex column', { opts: painter, self: s.selfShadow, z: null, kernelZ: new Int16Array(0) });
      const sat = c('painter order, bands', { opts: painter, self: s.selfShadow, z: s.zIndex });
      assert.equal(sat.maxBand, GBUF_MAX_BANDS - 1, 'a zIndex that changes every few rows reaches the most bands');
      const few = c('zIndex first, bands', { opts: zFirst, self: s.selfShadow, z: s.zIndex });
      assert.ok(few.maxBand > 0 && few.maxBand < GBUF_MAX_BANDS - 1, `bands below the most (${few.maxBand})`);
      c('selfShadow shorter than the flags', { opts: painter, self: selfShort(s), z: s.zIndex });
      c('no selfShadow', { opts: painter, self: null, z: s.zIndex });
      c('an empty selfShadow', { opts: painter, self: new Uint8Array(0), z: null });
      c('shadow terms and texture updates', { opts: painter, self: s.selfShadow, z: s.zIndex, shadow: true, texUpdates: true });
      c('shadow terms, no bands', { opts: zFirst, self: selfShort(s), z: null, shadow: true });
      c('capacity under count', { opts: painter, cap: 3210, self: s.selfShadow, z: s.zIndex });
      c('capacity under count, no bands', { opts: zFirst, cap: 1777, self: s.selfShadow, z: null, shadow: true });
      c('no list', { opts: { space: GPU_SPACE_WORLD, type: s.q.type }, self: s.selfShadow, z: s.zIndex });
      c('no type column', { opts: { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N }, self: s.selfShadow, z: s.zIndex });
      c('indices copied', {
        opts: { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.zOrder), indexCount: N, type: s.q.type },
        self: s.selfShadow, z: s.zIndex,
      });
      c('a short list', { opts: { space: GPU_SPACE_WORLD, indices: s.zOrder, indexCount: 999, type: s.q.type }, self: s.selfShadow, z: s.zIndex });
    }
  }
});

// What the pack cannot read declines the words alone: the frame is packed as without them, the destination untouched.
test('a G-buffer column the pack cannot read declines the words, not the frame', async () => {
  const s = await setup(389);
  const opts = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
  const base = { keyBase: KEY_BASE, updatesByte: s.updates.byteOffset, updates: 0 };
  const pack = (cols) => {
    const keyed = { ...base, ...cols };
    s.gbufOut.fill(-7);
    const n = packKeyedRowsWasm(s.b, s.q, makePackContext(s.q, opts, N, {}), s.pose, s.slots, keyed, N);
    return { n, keyed, out: packOutput(s, n, false, keyed) };
  };
  const plain = pack({});
  assert.equal(plain.n, N);
  assert.equal(plain.keyed.gbufWritten, false);
  const cols = { gbufOut: s.gbufOut, gbufFlags: s.flags, gbufSelf: s.selfShadow, gbufZ: s.zIndex };
  assert.equal(pack(cols).keyed.gbufWritten, true, 'every column readable: the words');
  for (const [label, bad] of [
    ['no destination', { gbufOut: null }],
    ['a destination outside the memory', { gbufOut: new Float32Array(N * GPU_GBUF_FLOATS) }],
    ['a destination without room for the rows', { gbufOut: s.gbufOut.subarray(0, N * GPU_GBUF_FLOATS - 1) }],
    ['no flags', { gbufFlags: null }],
    ['empty flags', { gbufFlags: new Uint8Array(0) }],
    ['flags outside the memory', { gbufFlags: new Uint8Array(ENTITIES) }],
    ['selfShadow outside the memory', { gbufSelf: new Uint8Array(ENTITIES) }],
    ['zIndex outside the memory', { gbufZ: new Int16Array(ENTITIES) }],
    ['zIndex shorter than the flags', { gbufZ: s.zIndex.subarray(0, ENTITIES - 1) }],
  ]) {
    const r = pack({ ...cols, ...bad });
    assert.equal(r.n, N, `${label}: the frame packed`);
    assert.equal(r.keyed.gbufWritten, false, `${label}: no words`);
    assert.deepEqual(r.out, plain.out, `${label}: the frame as without them`);
    assert.ok(s.gbufOut.every((v) => v === -7), `${label}: the destination untouched`);
  }
});

// The kernel's measurement tool on a small frame: its two G-buffer cases (the words in JavaScript after the pack, and the
// pack's own) agree, with bands and without (it throws when a float differs).
test('gpuPackKeyedMicrobench\'s G-buffer cases agree on a small frame', async () => {
  for (const gbuf of [true, 'bands']) {
    const report = await runKeyedMicrobench({ rows: 300, entities: 1000, frames: 1, gbuf });
    const { keyedWords, keyedGbuf } = report.cases;
    assert.ok(keyedWords && keyedGbuf, `${gbuf}: both cases ran`);
    assert.equal(keyedGbuf.check, keyedWords.check, `${gbuf}: the same words`);
  }
});
