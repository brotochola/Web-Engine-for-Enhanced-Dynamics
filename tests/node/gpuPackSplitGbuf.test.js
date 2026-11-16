import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_GBUF_FLOATS, GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_WORLD, GPU_STATIC_FLOATS,
  makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, packIndexedRowsWasm, packSplitRowsWasm, SCATTER_MIN_ROWS } from '../../src/render/gpuPackClient.js';
import { GBUF_MAX_BANDS, writeGbufWords } from '../../src/render/gbufWord.js';
import { run as runIndexedMicrobench } from '../bench/gpuPackIndexedMicrobench.mjs';

// E-444: given the columns, pre-render's split and indexed packs write each drawn instance's G-buffer words at its draw
// slot, bit for bit the words gbufWord.js writeGbufWords writes from the collector's columns (pre-render's frame before
// it): the entity's id, its gbufFlags and selfShadow (none past a shorter selfShadow column), 0 for a row that is no
// entity (a row type other than 0, an entity at or past the entity count, a negative one); with a zIndex column the bands
// along the draw order, the scatters' too (which visit the rows in the queue's order). On every form: the gather (no list,
// a list in the memory or copied into the scratch, statics or none), the split scatter, the indexed scatter (statics or
// none). The rest of each pack's output is what it is without them. A column the pack cannot read declines the words
// alone: the pack runs, and says it wrote none.

// Over SCATTER_MIN_ROWS, so a list over the queue takes the scatters.
const N = 5000;
// Past 65535, so the id wraps (entity % 65535 + 1).
const ENTITIES = 70000;
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
  const memory = new WebAssembly.Memory({ initial: 200, maximum: 8192, shared: true });
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
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N),
  };
  // The collector's columns by queue row: an entity's sprite (type 0) or another row (a decoration's, a particle's).
  const rowType = alloc(Uint8Array, N);
  const rowEntity = alloc(Int32Array, N);
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
    q.tileMulX[i] = rng() * 2;
    q.tileMulY[i] = rng() * 2;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.type[i] = (rng() * 5) | 0;
    // Entities, rows of other types, and type-0 rows whose entity is none: past the count, or negative.
    const r = rng();
    rowType[i] = r < 0.08 ? 1 + ((rng() * 4) | 0) : 0;
    rowEntity[i] = r < 0.08 ? (rng() * ENTITIES) | 0
      : r < 0.1 ? ENTITIES + ((rng() * 1000) | 0)
        : r < 0.11 ? -1 - ((rng() * 3) | 0)
          : (rng() * ENTITIES) | 0;
  }
  // The first and last entities, and the ids either side of the wrap.
  rowType.fill(0, 0, 5);
  rowEntity.set([0, ENTITIES - 1, 65534, 65535, 65536], 0);
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
    const e = rowEntity[i];
    return rowType[i] === 0 && e >= 0 && e < ENTITIES ? zIndex[e] : 0;
  };
  const zOrder = alloc(Uint32Array, N);
  zOrder.set(Array.from(order).sort((a, b) => zOf(a) - zOf(b)));
  // A list with a row twice: the scatters decline it, and the gather packs it.
  const twice = alloc(Uint32Array, N);
  twice.set(order);
  twice[N - 1] = twice[0];
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const stat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
  const rowStat = alloc(Float32Array, N * GPU_INDEXED_STATIC_FLOATS);
  const gbufOut = alloc(Float32Array, N * GPU_GBUF_FLOATS);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const inverseByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte });
  return {
    rng, q, b, order, zOrder, twice, rowType, rowEntity, flags, selfShadow, zIndex, pose, stat, slots, rowStat, gbufOut,
  };
}

const u32 = (a, n) => new Uint32Array(a.buffer, a.byteOffset, n);

/** Every array a pack writes but the words, copied: what the pack with the words must write too. */
function packOutput(s, n, kind, statics, ctx) {
  const out = { first: Uint32Array.from(u32(s.pose, n * GPU_POSE_FLOATS)), particles: ctx.particleCount };
  if (kind === 'indexed') {
    out.slots = Uint32Array.from(u32(s.slots, n * GPU_INDEXED_SLOT_FLOATS));
    if (statics) out.stat = Uint32Array.from(u32(s.rowStat, N * GPU_INDEXED_STATIC_FLOATS));
  } else if (statics) {
    out.stat = Uint32Array.from(u32(s.stat, n * GPU_STATIC_FLOATS));
  }
  return out;
}

/** A pack of `kind` (split or indexed), with or without the statics, the G-buffer columns `gbuf` (null: none). */
function pack(s, kind, opts, cap, statics, gbuf) {
  const ctx = makePackContext(s.q, opts, cap, {});
  const n = kind === 'indexed'
    ? packIndexedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, statics ? s.rowStat : null, cap, gbuf)
    : packSplitRowsWasm(s.b, s.q, ctx, s.pose, statics ? s.stat : null, cap, gbuf);
  return { n, ctx };
}

/** The exports each call of a pack reaches, counted. */
function countCalls(b) {
  const calls = {};
  for (const name of ['spritesSplit', 'spritesSplitScatter', 'spritesIndexedScatter', 'spritesSplitGbuf',
    'spritesSplitScatterGbuf', 'spritesIndexedScatterGbuf']) {
    const real = b[name];
    calls[name] = 0;
    b[name] = (...args) => {
      calls[name]++;
      return real(...args);
    };
  }
  return calls;
}

/**
 * One frame packed without the words, then with them: the same output, the words writeGbufWords writes for the frame's
 * rows, and the export `via` (gpuPackClient's binding name) that wrote them. `self` and `z`, the columns the pack and
 * writeGbufWords take (null: none); `kernelZ` what the pack is handed for no bands (null or an empty column).
 */
function checkWords(s, calls, label, { kind = 'split', opts, cap = N, statics = true, self, z, kernelZ = z, via }) {
  const plain = pack(s, kind, opts, cap, statics, null);
  const count = opts.indices ? opts.indexCount : N;
  assert.equal(plain.n, Math.min(count, cap), `${label}: rows`);
  const n = plain.n;
  const want = packOutput(s, n, kind, statics, plain.ctx);
  s.gbufOut.fill(-7);
  for (const k of Object.keys(calls)) calls[k] = 0;
  const gbuf = {
    out: s.gbufOut, flags: s.flags, self, z: kernelZ, types: s.rowType, entities: s.rowEntity, written: false,
  };
  const withWords = pack(s, kind, opts, cap, statics, gbuf);
  assert.equal(withWords.n, n, `${label}: rows with the words`);
  assert.equal(gbuf.written, true, `${label}: the pack wrote the words`);
  assert.ok(calls[via] > 0, `${label}: through ${via} (${JSON.stringify(calls)})`);
  assert.deepEqual(packOutput(s, n, kind, statics, withWords.ctx), want, `${label}: the rest of the output as without them`);
  const words = new Float32Array(n * GPU_GBUF_FLOATS);
  writeGbufWords(words, n, opts.indices || null, s.rowType, s.rowEntity, null, s.flags.length, s.flags, self, z);
  const got = u32(s.gbufOut, n * GPU_GBUF_FLOATS);
  const wantBits = u32(words, n * GPU_GBUF_FLOATS);
  for (let w = 0; w < n * GPU_GBUF_FLOATS; w++) {
    if (got[w] !== wantBits[w]) {
      const k = w >> 1;
      const row = opts.indices ? opts.indices[k] : k;
      assert.fail(`${label}: slot ${k} (row ${row}, type ${s.rowType[row]}, entity ${s.rowEntity[row]}) `
        + `${w & 1 ? 'band' : 'word'}: ${s.gbufOut[w]}, not ${words[w]}`);
    }
  }
  if (n < N) assert.equal(s.gbufOut[n * GPU_GBUF_FLOATS], -7, `${label}: nothing past the rows packed`);
  let entityRows = 0;
  let maxBand = 0;
  for (let k = 0; k < n; k++) {
    if (words[2 * k] !== 0) entityRows++;
    if (words[2 * k + 1] > maxBand) maxBand = words[2 * k + 1];
  }
  return { n, entityRows, maxBand };
}

const selfShort = (s) => new Uint8Array(s.selfShadow.buffer, s.selfShadow.byteOffset, ENTITIES >> 1);

test('the split and indexed packs write writeGbufWords\' words and bands, bit for bit, on every form and with every column', async () => {
  assert.ok(N >= SCATTER_MIN_ROWS, 'the list takes the scatters');
  for (const seed of [444, 445]) {
    const s = await setup(seed);
    const calls = countCalls(s.b);
    const painter = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
    const zFirst = { space: GPU_SPACE_WORLD, indices: s.zOrder, indexCount: N, type: s.q.type };
    const none = { space: GPU_SPACE_WORLD, type: s.q.type };
    const c = (label, o) => checkWords(s, calls, label, o);
    // The gather: no list (an unsorted frame), statics or none.
    const plain = c('no list, statics', { opts: none, self: s.selfShadow, z: null, via: 'spritesSplitGbuf' });
    assert.ok(plain.entityRows > N * 0.85 && plain.entityRows < N, `entities and rows that are none (${plain.entityRows})`);
    assert.equal(plain.maxBand, 0, 'no bands without a zIndex column');
    c('no list, no statics', { opts: none, statics: false, self: s.selfShadow, z: null, via: 'spritesSplitGbuf' });
    c('no list, bands', { opts: none, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitGbuf' });
    c('no list, an empty zIndex column', { opts: none, self: s.selfShadow, z: null, kernelZ: new Int16Array(0), via: 'spritesSplitGbuf' });
    c('no list, no type column', { opts: { space: GPU_SPACE_WORLD }, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitGbuf' });
    // The gather through a list: no statics (the scatter needs them), a short list, a capacity under the count, a list
    // copied into the scratch, a list with a row twice.
    const sat = c('painter order, no statics, bands', { opts: painter, statics: false, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitGbuf' });
    assert.equal(sat.maxBand, GBUF_MAX_BANDS - 1, 'a zIndex that changes every few rows reaches the most bands');
    c('zIndex first, no statics, bands', { opts: zFirst, statics: false, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitGbuf' });
    c('a short list', {
      opts: { space: GPU_SPACE_WORLD, indices: s.zOrder, indexCount: 999, type: s.q.type }, self: s.selfShadow,
      z: s.zIndex, via: 'spritesSplitGbuf',
    });
    c('capacity under count: the split scatter', { opts: painter, cap: 3210, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitScatterGbuf' });
    c('indices copied: the split scatter', {
      opts: { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.zOrder), indexCount: N, type: s.q.type },
      self: s.selfShadow, z: s.zIndex, via: 'spritesSplitScatterGbuf',
    });
    c('a row twice: the gather', {
      opts: { space: GPU_SPACE_WORLD, indices: s.twice, indexCount: N, type: s.q.type }, self: s.selfShadow, z: s.zIndex,
      via: 'spritesSplitGbuf',
    });
    // The split scatter (a list over the queue, with the statics).
    const few = c('split scatter, zIndex first, bands', { opts: zFirst, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitScatterGbuf' });
    assert.ok(few.maxBand > 0 && few.maxBand < GBUF_MAX_BANDS - 1, `bands below the most (${few.maxBand})`);
    c('split scatter, painter order, bands', { opts: painter, self: s.selfShadow, z: s.zIndex, via: 'spritesSplitScatterGbuf' });
    c('split scatter, no bands', { opts: painter, self: s.selfShadow, z: null, via: 'spritesSplitScatterGbuf' });
    c('split scatter, selfShadow shorter than the flags', { opts: zFirst, self: selfShort(s), z: s.zIndex, via: 'spritesSplitScatterGbuf' });
    c('split scatter, no selfShadow', { opts: painter, self: null, z: null, via: 'spritesSplitScatterGbuf' });
    // The indexed scatter, statics or none.
    for (const statics of [false, true]) {
      const k = (label, o) => c(`indexed${statics ? ' with statics' : ''}, ${label}`, { kind: 'indexed', statics, via: 'spritesIndexedScatterGbuf', ...o });
      k('painter order, bands', { opts: painter, self: s.selfShadow, z: s.zIndex });
      k('zIndex first, bands', { opts: zFirst, self: s.selfShadow, z: s.zIndex });
      k('no bands', { opts: zFirst, self: s.selfShadow, z: null });
      k('an empty selfShadow', { opts: painter, self: new Uint8Array(0), z: s.zIndex });
      k('selfShadow shorter than the flags, no bands', { opts: painter, self: selfShort(s), z: null });
      k('capacity under count', { opts: painter, cap: 4500, self: s.selfShadow, z: s.zIndex });
    }
  }
});

// What the pack cannot read declines the words alone: the frame is packed as without them, the destination untouched.
test('a G-buffer column the split or indexed pack cannot read declines the words, not the frame', async () => {
  const s = await setup(446);
  const painter = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
  const none = { space: GPU_SPACE_WORLD, type: s.q.type };
  const cols = {
    out: s.gbufOut, flags: s.flags, self: s.selfShadow, z: s.zIndex, types: s.rowType, entities: s.rowEntity,
  };
  for (const [kind, opts, statics] of [['split', none, true], ['split', painter, true], ['indexed', painter, false]]) {
    const label = `${kind}${opts.indices ? ', a list' : ''}`;
    const plain = pack(s, kind, opts, N, statics, null);
    const want = packOutput(s, plain.n, kind, statics, plain.ctx);
    const all = { ...cols, written: false };
    assert.equal(pack(s, kind, opts, N, statics, all).n, N);
    assert.equal(all.written, true, `${label}: every column readable, the words`);
    for (const [what, bad] of [
      ['no destination', { out: null }],
      ['a destination outside the memory', { out: new Float32Array(N * GPU_GBUF_FLOATS) }],
      ['a destination without room for the rows', { out: s.gbufOut.subarray(0, N * GPU_GBUF_FLOATS - 1) }],
      ['no flags', { flags: null }],
      ['empty flags', { flags: new Uint8Array(0) }],
      ['flags outside the memory', { flags: new Uint8Array(ENTITIES) }],
      ['selfShadow outside the memory', { self: new Uint8Array(ENTITIES) }],
      ['zIndex outside the memory', { z: new Int16Array(ENTITIES) }],
      ['zIndex shorter than the flags', { z: s.zIndex.subarray(0, ENTITIES - 1) }],
      ['no row types', { types: null }],
      ['row types outside the memory', { types: new Uint8Array(N) }],
      ['row types shorter than the queue', { types: s.rowType.subarray(0, N - 1) }],
      ['row types of another element size', { types: new Uint16Array(s.rowType.buffer, s.rowType.byteOffset, N) }],
      ['no row entities', { entities: null }],
      ['row entities outside the memory', { entities: new Int32Array(N) }],
      ['row entities shorter than the queue', { entities: s.rowEntity.subarray(0, N - 1) }],
      ['row entities of another element size', { entities: new Uint8Array(s.rowEntity.buffer, s.rowEntity.byteOffset, N) }],
    ]) {
      s.gbufOut.fill(-7);
      const gbuf = { ...cols, ...bad, written: true };
      const r = pack(s, kind, opts, N, statics, gbuf);
      assert.equal(r.n, N, `${label}, ${what}: the frame packed`);
      assert.equal(gbuf.written, false, `${label}, ${what}: no words`);
      assert.deepEqual(packOutput(s, r.n, kind, statics, r.ctx), want, `${label}, ${what}: the frame as without them`);
      assert.ok(s.gbufOut.every((v) => v === -7), `${label}, ${what}: the destination untouched`);
    }
  }
  // A call the pack does not take at all (screen space) says it wrote none.
  const gbuf = { ...cols, written: true };
  assert.equal(pack(s, 'split', { ...none, space: 1 }, N, true, gbuf).n, -1);
  assert.equal(gbuf.written, false, 'a declined pack wrote no words');
});

// The kernel's measurement tool on a small frame: its two G-buffer cases of each pack (the words in JavaScript after the
// pack, and the pack's own) agree, with bands and without (it throws when a float differs), with a list and without.
test('gpuPackIndexedMicrobench\'s G-buffer cases agree on a small frame', async () => {
  for (const [order, gbuf] of [['near', true], ['random', 'bands'], ['none', true], ['none', 'bands']]) {
    const report = await runIndexedMicrobench({ rows: 5000, order, gbuf });
    const { splitWords, splitGbuf, indexedWords, indexedGbuf } = report.cases;
    assert.ok(splitWords && splitGbuf, `${order} ${gbuf}: both split cases ran`);
    assert.equal(splitGbuf.check, splitWords.check, `${order} ${gbuf}: the same words`);
    if (order !== 'none') {
      assert.ok(indexedWords && indexedGbuf, `${order} ${gbuf}: both indexed cases ran`);
      assert.equal(indexedGbuf.check, indexedWords.check, `${order} ${gbuf}: the same indexed words`);
    }
  }
});
