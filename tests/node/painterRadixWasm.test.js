// E-76 W10: the painter sort kernel (wasm/painterRadix.c, in src/wasm/engine.wasm) against the JS
// radixSortIndicesBySortKey, radixPainterOrder, reinsertChangedSlots and orderPainterSlots
// (src/util/sortIndexByKey.js), bit for bit, every variant, and the client's orderPainterSlotsWasm and
// radixSortIndicesWasm (what packSpriteLayer calls) on each. Keys are float32 bits as pre-render writes
// them: round(y) * 128 sprite keys (Predator's world, the painter stress scenes' grid with its five foot
// offsets), fractional keys, keys above the world origin (negative Y), zIndex bands with negative bands,
// -0, all equal, all zero, a few distinct values, ascending and descending, raw bits (NaN, infinities,
// denormals), keys whose only differing bits sit at each digit edge (0, 7, 8, 10, 11, 21, 22, 23, 31) or
// apart (0 and 31, 3 and 20: a middle digit that never differs), and spans of 11, 12, 22 and 23 bits (one,
// two, two and three adaptive passes); slot lists in order, reversed, shuffled, with gaps and with repeats.
// radixPainterOrder: runs that pay, runs that fail at the 1024-row check and at the end, a slot list with
// gaps and one with repeats, all-zero keys (cold). reinsert: from none to every slot changed, ties against
// stable rows, keys crossing zero, slots outside the order changing, and an order that is not a
// permutation (-1, then the rebuild). Every call: the same order, prevKey, slotMoved, runHeads, runLen and
// moved arrays and return value as the JS (merge too where the variant merges forward, scratch too for the
// scalar variant, the JS line for line), and no byte written outside the arrays the call may write.
import test from 'node:test';
import assert from 'node:assert/strict';

import { orderSortKey, spriteYSortKey, zSortBand } from '../../src/util/sortIndexByKey.js';
import { layoutRegions, NULL_GUARD_BYTES, painterStateLayout, painterStateRegions } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import {
  CORES,
  INPLACE_VARIANTS,
  PAINTER_VARIANT,
  VARIANTS,
  loadPainterRadix,
  orderPainterSlotsWasm,
  painterRadixVariant,
  radixSortIndicesWasm,
  resetWasmPainterState,
  variantCore,
  wasmPainterState,
} from '../../src/render/painterRadixClient.js';
import { createPainterState, orderPainterSlots, radixPainterOrder, radixSortIndicesBySortKey, reinsertChangedSlots } from '../reference/painterJs.mjs';

const CAP = 20480;

const layout = layoutRegions([
  { name: 'guard', owner: 'nobody: offset 0 is null', bytes: NULL_GUARD_BYTES },
  { name: 'keys', owner: 'pre-render writes the sort keys', bytes: CAP * 4 },
  { name: 'idx', owner: 'the radix input and output', bytes: (CAP + 16) * 4 },
  { name: 'idxE', owner: 'the type-filtered slot list', bytes: CAP * 4 },
  ...painterStateRegions('w.', CAP, 'the worker that sorts'),
  // Never passed to a call: must stay as it is.
  ...painterStateRegions('other.', 64, 'nobody'),
]);
const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
const buffer = memory.buffer;
const R = layout.regions;
const keys = new Uint32Array(buffer, R.keys.byte, CAP);
const idx = new Uint32Array(buffer, R.idx.byte, CAP + 16);
const idxE = new Uint32Array(buffer, R.idxE.byte, CAP);
const ws = wasmPainterState(buffer, painterStateLayout(R, 'w.', CAP));
wasmPainterState(buffer, painterStateLayout(R, 'other.', 64));
const kernel = await loadPainterRadix(memory);
const variants = Object.fromEntries(VARIANTS.map((v) => [v, painterRadixVariant(kernel, v, buffer)]));

const ALL_REGIONS = Object.keys(R);
const RADIX_WRITES = ['idx', 'w.Scratch', 'w.Hist', 'w.OrdsA', 'w.OrdsB'];
const ORDER_WRITES = ['w.Order', 'w.Scratch', 'w.Hist', 'w.OrdsA', 'w.OrdsB', 'w.RunHeads', 'w.RunLen', 'w.PrevKey'];
const REINSERT_WRITES = ['w.Order', 'w.Scratch', 'w.Hist', 'w.OrdsA', 'w.OrdsB', 'w.Moved', 'w.Merge', 'w.PrevKey', 'w.SlotMoved'];

/** Run `call`; every region outside `writes` must be byte for byte as before. */
function writesOnly(writes, call) {
  const fixed = ALL_REGIONS.filter((name) => !writes.includes(name));
  const before = fixed.map((name) => Buffer.from(new Uint8Array(buffer, R[name].byte, R[name].bytes)));
  const out = call();
  fixed.forEach((name, i) => {
    const now = new Uint8Array(buffer, R[name].byte, R[name].bytes);
    if (Buffer.compare(before[i], now) !== 0) assert.fail(`wrote region ${name}`);
  });
  return out;
}

function sameArray(got, want, n, label) {
  for (let i = 0; i < n; i++) {
    if (got[i] !== want[i]) assert.fail(`${label}: [${i}] is ${got[i]}, the JS has ${want[i]}`);
  }
}

// ---- keys ----

const f32 = (fn) => (S, r) => {
  const f = new Float32Array(S);
  for (let i = 0; i < S; i++) f[i] = fn(i, r, S);
  return new Uint32Array(f.buffer);
};
const raw = (fn) => (S, r) => {
  const u = new Uint32Array(S);
  for (let i = 0; i < S; i++) u[i] = fn(i, r, S) >>> 0;
  return u;
};
const oneBit = (bit, base = 0x4512a5c0) => raw((i, r) => (r() < 0.5 ? base ^ (2 ** bit) : base));
const span = (bits) => raw((i, r) => 0x40000000 + Math.floor(r() * 2 ** bits));
/** painterSortStressScene's queue: 400 columns, rows 22 px apart, five scales of a 14 px ball, centre anchored. */
const stressKey = (i) => spriteYSortKey(40 + Math.floor(i / 400) * 22 + 0.5 * 14 * (0.75 + (i % 5) * 0.06), 128);

const FAMILIES = {
  sprite: f32((i, r) => spriteYSortKey(r() * 5000, 128)),
  stressGrid: f32((i) => stressKey(i)),
  mixed: f32((i, r) => (r() < 0.2 ? r() * 5000 * 128 : spriteYSortKey(r() * 5000, 128))),
  aboveOrigin: f32((i, r) => spriteYSortKey(r() * 600 - 300, 128)),
  zBands: f32((i, r) => orderSortKey(spriteYSortKey(r() * 5000, 128), ((r() * 5) | 0) - 2, true, zSortBand(5000))),
  negatives: f32((i, r) => (i % 7 === 0 ? -0 : (r() - 0.5) * 1e6)),
  allEqual: f32(() => 4096),
  allZero: f32(() => 0),
  fewDistinct: f32((i, r) => [0, 128, 256, -128, -0][(r() * 5) | 0]),
  ascending: f32((i) => i * 128),
  descending: f32((i, r, S) => (S - i) * 128 - 64 * S),
  rawBits: raw((i, r) => r() * 2 ** 32),
  bit0: oneBit(0),
  bit7: oneBit(7),
  bit8: oneBit(8),
  bit10: oneBit(10),
  bit11: oneBit(11),
  bit21: oneBit(21),
  bit22: oneBit(22),
  bit23: oneBit(23),
  bit31: oneBit(31),
  bits0and31: raw((i, r) => 0x12345670 | (r() < 0.5 ? 1 : 0) | (r() < 0.5 ? 0x80000000 : 0)),
  bits3and20: raw((i, r) => 0x3c000000 | (r() < 0.5 ? 8 : 0) | (r() < 0.5 ? 2 ** 20 : 0)),
  span11: span(11),
  span12: span(12),
  span22: span(22),
  span23: span(23),
};

function shuffle(a, r) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Slot lists of n rows, every slot below S. */
const LISTS = {
  inOrder: (n) => Array.from({ length: n }, (_, i) => i),
  reversed: (n) => Array.from({ length: n }, (_, i) => n - 1 - i),
  shuffled: (n, r) => shuffle(Array.from({ length: n }, (_, i) => i), r),
  /** n of the S slots, ascending, the others left out at random. */
  gaps: (n, r, S) => {
    const out = [];
    for (let s = 0; s < S && out.length < n; s++) if (r() * (S - s) < n - out.length) out.push(s);
    return out;
  },
  repeats: (n, r) => Array.from({ length: n }, () => (r() * Math.max(1, n >> 1)) | 0),
};
const slotsFor = (n) => Math.min(CAP, Math.max(8, n * 2));

const SMALL = [0, 1, 2, 3, 4, 5, 7, 8, 63, 64, 65, 255, 256, 257];
const LARGE = [1000, 4096, CAP >> 1];

test('radix_sort_* = radixSortIndicesBySortKey on every key family and slot list', () => {
  const r = mulberry32(0x5a11);
  let checks = 0;
  for (const [family, make] of Object.entries(FAMILIES)) {
    const runs = [];
    for (const n of SMALL) for (const list of Object.keys(LISTS)) runs.push([n, list]);
    for (const n of LARGE) for (const list of ['shuffled', 'gaps']) runs.push([n, list]);
    for (const [n, list] of runs) {
      // The region check copies most of the memory: one variant per family and size, in turn.
      const checked = list === 'shuffled' ? CORES[checks++ % CORES.length] : null;
      const S = slotsFor(n);
      const bits = make(S, r);
      const slots = LISTS[list](n, r, S);
      keys.fill(0);
      keys.set(bits);
      const ref = Uint32Array.from(slots);
      radixSortIndicesBySortKey(ref, n, keys, new Uint32Array(Math.max(1, n)), new Uint32Array(256));
      const tail = Math.min(idx.length, n + 64);
      for (const core of CORES) {
        idx.fill(0xdeadbeef, 0, tail);
        idx.set(slots);
        const sort = () => variants[core].radixSort(ws, R.idx.byte, n, R.keys.byte);
        if (core === checked) writesOnly(RADIX_WRITES, sort);
        else sort();
        const label = `${core} ${family} ${list} n=${n}`;
        sameArray(idx, ref, n, label);
        for (let i = n; i < tail; i++) if (idx[i] !== 0xdeadbeef) assert.fail(`${label}: wrote idx[${i}]`);
      }
    }
  }
});

/** Keys in runs of 1..maxRun drawn from `distinct` values (separate runs share keys); as painterRunSort.test.js. */
function runKeys(n, maxRun, distinct, r) {
  const f = new Float32Array(n);
  let j = 0;
  while (j < n) {
    const key = ((r() * distinct) | 0) * 128 - distinct * 64 + (r() < 0.1 ? 0.5 : 0);
    const len = 1 + ((r() * maxRun) | 0);
    for (let k = 0; k < len && j < n; k++) f[j++] = key;
  }
  return new Uint32Array(f.buffer);
}

function freshPair() {
  resetWasmPainterState(ws);
  return createPainterState(CAP);
}

/** The state both sides keep: what later calls read, and the scratch where it is the JS line for line. */
function sameState(js, variant, label, { order = true, moved = true } = {}) {
  if (order) sameArray(ws.order, js.order, CAP, `${label} order`);
  sameArray(ws.prevKey, js.prevKey, CAP, `${label} prevKey`);
  sameArray(ws.slotMoved, js.slotMoved, CAP, `${label} slotMoved`);
  sameArray(ws.runHeads, js.runHeads, CAP, `${label} runHeads`);
  sameArray(ws.runLen, js.runLen, CAP, `${label} runLen`);
  if (moved) sameArray(ws.moved, js.moved, CAP, `${label} moved`);
  if (!INPLACE_VARIANTS.includes(variant)) sameArray(ws.merge, js.merge, CAP, `${label} merge`);
  if (variant === 'scalar') sameArray(ws.scratch, js.scratch, CAP, `${label} scratch`);
  assert.equal(ws.n, js.n, `${label} n`);
  assert.equal(ws.ready, js.ready, `${label} ready`);
}

/** radixPainterOrder on both sides from fresh states. */
function orderCase(core, bits, list, label) {
  const js = freshPair();
  keys.fill(0);
  keys.set(bits);
  const ne = list ? list.length : bits.length;
  if (list) idxE.set(list);
  const jsIdxE = list ? Uint32Array.from(list) : null;
  radixPainterOrder(js, jsIdxE, ne, keys);
  writesOnly(ORDER_WRITES, () => variants[core].painterOrder(ws, list ? R.idxE.byte : 0, ne, R.keys.byte));
  sameState(js, core, label);
}

test('painter_order_* = radixPainterOrder: runs that pay, runs that do not, gaps, repeats, cold keys', () => {
  const r = mulberry32(0x0bde);
  const cases = [];
  for (const [n, maxRun, distinct] of [
    [4000, 25, 50], [12000, 12, 9], [3000, 40, 3000], [1500, 2, 20], [1100, 1, 100000],
    [1023, 1, 50], [1023, 3, 50], [1024, 2, 7], [1025, 1, 7], [2047, 4, 400], [2048, 1, 2], [CAP, 25, 300],
  ]) {
    cases.push([`runs ${n}/${maxRun}/${distinct}`, runKeys(n, maxRun, distinct, r), null]);
  }
  for (const n of [2, 3, 4, 17, 1024, 5000, CAP]) {
    cases.push([`sprite ${n}`, FAMILIES.sprite(n, r), null]);
    cases.push([`stressGrid ${n}`, FAMILIES.stressGrid(n, r), null]);
    cases.push([`mixed ${n}`, FAMILIES.mixed(n, r), null]);
  }
  // Runs of exactly two: the runs halve the rows exactly at the 1024-row check and at the end (no bail).
  const pairKey = (i) => ((i >> 1) % 2 ? (i >> 1) : -(i >> 1)) * 128;
  cases.push(['runs of exactly two', f32(pairKey)(3000, r), null]);
  cases.push(['runs of exactly two, one single row', f32((i) => (i < 1023 ? pairKey(i) : pairKey(i + 1)))(3001, r), null]);
  // A row per stress-scene entity: runs of 400 equal keys when every scale is the same.
  cases.push(['stress rows, one scale', f32((i) => spriteYSortKey(40 + Math.floor(i / 400) * 22, 128))(CAP, r), null]);
  cases.push(['all zero (cold)', FAMILIES.allZero(3000, r), null]);
  const oneLive = FAMILIES.allZero(3000, r);
  oneLive[1234] = 0x80000000; // -0: not the integer 0, so live
  cases.push(['all zero but a -0', oneLive, null]);
  for (const name of ['sprite', 'stressGrid', 'aboveOrigin', 'zBands', 'rawBits', 'allEqual']) {
    const bits = FAMILIES[name](CAP, r);
    cases.push([`${name}, slot list with gaps`, bits, LISTS.gaps(Math.floor(CAP * 0.55), r, CAP)]);
    cases.push([`${name}, shuffled slot list`, bits, LISTS.shuffled(6000, r)]);
  }
  const runBits = runKeys(CAP, 20, 30, r);
  const kept = [];
  for (let i = 0; i < CAP; i++) if (r() > 0.05) kept.push(i);
  cases.push(['runs, glow rows left out', runBits, kept]);
  cases.push(['runs, repeated slots', runBits, [...kept.slice(0, 500), ...kept.slice(200, 900), 7, 7, 7, ...kept.slice(0, 50)]]);
  for (const core of CORES) {
    for (const [label, bits, list] of cases) orderCase(core, bits, list, `${core} ${label}`);
  }
});

/**
 * Frames of reinsert on both sides from one rebuild: each frame `step(frame, keysNow)` edits the keys in
 * place; both sides then reinsert and must agree. A -1 rebuilds both, as orderPainterSlots does (on that
 * path the in-place merges leave the stable rows at the end of order, the JS at its start: the rebuild
 * rewrites it).
 */
function reinsertRun(variant, bits, list, frames, step, label) {
  const js = freshPair();
  const core = variantCore(variant);
  keys.fill(0);
  keys.set(bits);
  const n = list ? list.length : bits.length;
  if (list) idxE.set(list);
  const jsList = list ? Uint32Array.from(list) : null;
  const rebuild = () => {
    radixPainterOrder(js, jsList, n, keys);
    variants[core].painterOrder(ws, list ? R.idxE.byte : 0, n, R.keys.byte);
  };
  rebuild();
  sameState(js, variant, `${label} rebuild`);
  const counts = [];
  for (let f = 1; f <= frames; f++) {
    step(f, keys);
    const want = reinsertChangedSlots(js.order, n, keys, js.prevKey, js.slotMoved, js.moved, js.merge, js.scratch, js.hist);
    const got = writesOnly(REINSERT_WRITES, () => variants[variant].reinsertChanged(ws, n, R.keys.byte));
    assert.equal(got, want, `${label} frame ${f}: returned ${got}, the JS ${want}`);
    sameState(js, variant, `${label} frame ${f}`, { order: want >= 0 || !INPLACE_VARIANTS.includes(variant) });
    if (want < 0) {
      rebuild();
      sameState(js, variant, `${label} frame ${f} rebuild`);
    }
    counts.push(want);
  }
  return counts;
}

const asF32 = new Float32Array(keys.buffer, keys.byteOffset, keys.length);

/** Move `share` of the first n slots by up to ±maxPx pixels (round(y) * 128 keys). */
function mover(n, share, maxPx, r) {
  return () => {
    for (let s = 0; s < n; s++) {
      if (r() >= share) continue;
      const y = asF32[s] / 128 + Math.round((r() * 2 - 1) * maxPx);
      asF32[s] = y * 128;
    }
  };
}

test('reinsert_* = reinsertChangedSlots from no slot changed to every slot changed', () => {
  const r = mulberry32(0x7e15);
  for (const variant of VARIANTS) {
    for (const [n, share, maxPx] of [[CAP, 0, 1], [CAP, 0.0001, 3], [CAP, 0.01, 3], [CAP, 0.1, 24], [CAP, 0.5, 2], [CAP, 1, 2], [5000, 1, 4000], [1000, 0.3, 1], [2, 1, 1], [3, 0.7, 1], [4, 1, 2]]) {
      const bits = FAMILIES.stressGrid(n, r);
      const counts = reinsertRun(variant, bits, null, 4, mover(n, share, maxPx, r), `${variant} grid n=${n} share=${share}`);
      if (share === 0) assert.deepEqual(counts, [0, 0, 0, 0]);
      if (share === 1 && n === CAP) assert.ok(counts.every((c) => c > CAP * 0.5));
    }
    // Predator-like keys and a slot list with gaps; slots outside the list change too.
    const bits = FAMILIES.sprite(CAP, r);
    const list = LISTS.gaps(12000, r, CAP);
    reinsertRun(variant, bits, list, 6, (f) => {
      for (let s = 0; s < CAP; s++) if (r() < 0.4) asF32[s] = Math.round(asF32[s] / 128 + (r() * 4 - 2)) * 128;
    }, `${variant} sprite gaps`);
    // One slot at a time, onto an existing key (a tie against a stable row), up and down.
    reinsertRun(variant, FAMILIES.fewDistinct(3000, r), null, 8, () => {
      const s = (r() * 3000) | 0;
      keys[s] = keys[(r() * 3000) | 0];
      if (r() < 0.5) keys[(s + 1) % 3000] = keys[(r() * 3000) | 0];
    }, `${variant} ties`);
    // Across the world origin: negative keys order before positive ones.
    reinsertRun(variant, FAMILIES.aboveOrigin(4000, r), null, 5, () => {
      for (let s = 0; s < 4000; s++) if (r() < 0.3) asF32[s] = -asF32[s];
    }, `${variant} across zero`);
    // Raw bits, zIndex bands, and every key moved to one value.
    reinsertRun(variant, FAMILIES.zBands(6000, r), null, 3, () => {
      for (let s = 0; s < 6000; s++) if (r() < 0.2) keys[s] = (r() * 2 ** 32) >>> 0;
    }, `${variant} raw`);
    reinsertRun(variant, FAMILIES.sprite(3000, r), null, 2, () => {
      keys.fill(0x45000000, 0, 3000);
    }, `${variant} all to one key`);
    // A slot list that repeats slots: the runs leave rows of the slot list behind the expanded runs, so
    // the stable rows are not in key order and the merge's exact steps decide the result.
    const runBits = runKeys(4000, 6, 40, r);
    const repeated = [...LISTS.inOrder(1500), ...LISTS.inOrder(700), 9, 9, ...LISTS.gaps(800, r, 4000)];
    reinsertRun(variant, runBits, repeated, 4, mover(4000, 0.2, 2, r), `${variant} repeated slots`);
  }
});

test('reinsert_* on an order that is not a permutation: the same -1 and the same rebuild after it', () => {
  const r = mulberry32(0xd0b1e);
  for (const variant of VARIANTS) {
    const core = variantCore(variant);
    for (const changeDuplicate of [true, false]) {
      const n = 5000;
      const js = freshPair();
      keys.fill(0);
      keys.set(FAMILIES.sprite(n, r));
      radixPainterOrder(js, null, n, keys);
      variants[core].painterOrder(ws, 0, n, R.keys.byte);
      // Row 3000 repeats row 1000's slot (and that slot's own row goes missing).
      js.order[3000] = js.order[1000];
      ws.order[3000] = ws.order[1000];
      const dup = js.order[1000];
      for (let s = 0; s < n; s++) if (s !== dup && r() < 0.05) asF32[s] += 128 * 3;
      if (changeDuplicate) asF32[dup] += 128 * 5;
      const want = reinsertChangedSlots(js.order, n, keys, js.prevKey, js.slotMoved, js.moved, js.merge, js.scratch, js.hist);
      const got = writesOnly(REINSERT_WRITES, () => variants[variant].reinsertChanged(ws, n, R.keys.byte));
      const label = `${variant} duplicate ${changeDuplicate ? 'changed' : 'unchanged'}`;
      assert.equal(got, want, label);
      assert.equal(want < 0, changeDuplicate, `${label}: the JS returns ${want}`);
      sameArray(ws.prevKey, js.prevKey, CAP, `${label} prevKey`);
      sameArray(ws.slotMoved, js.slotMoved, CAP, `${label} slotMoved`);
      sameArray(ws.moved, js.moved, CAP, `${label} moved`);
      // On the -1 path the in-place merges have the stable rows at the end of order, the JS at its start;
      // the rebuild rewrites it.
      if (!INPLACE_VARIANTS.includes(variant) || !changeDuplicate) sameArray(ws.order, js.order, CAP, `${label} order`);
      if (want < 0) {
        radixPainterOrder(js, null, n, keys);
        variants[variant].painterOrder(ws, 0, n, R.keys.byte);
      }
      sameState(js, variant, `${label} after`);
    }
  }
});

test('orderPainterSlotsWasm with each variant = orderPainterSlots, frame after frame', () => {
  const r = mulberry32(0xf4a3e);
  for (const variant of VARIANTS) {
    const js = freshPair();
    const { k, calls } = counted(variants[variant]);
    ws.kernel = k;
    keys.fill(0);
    const frames = [];
    // Cold (every key 0), then keys land, then they move; the slot count changes; a filtered list, the
    // same list moving, a list with the same count but other slots; one row; none.
    frames.push({ ne: 500, list: null, edit: () => {} });
    frames.push({ ne: 500, list: null, edit: () => keys.set(FAMILIES.sprite(500, r)) });
    for (let k = 0; k < 4; k++) frames.push({ ne: 500, list: null, edit: mover(500, 0.3, 2, r) });
    frames.push({ ne: 640, list: null, edit: () => keys.set(FAMILIES.sprite(640, r)) });
    frames.push({ ne: 640, list: null, edit: mover(640, 0.05, 30, r) });
    const listA = LISTS.gaps(3000, r, CAP - 1);
    frames.push({ ne: listA.length, list: listA, edit: () => keys.set(FAMILIES.mixed(CAP, r)) });
    for (let k = 0; k < 3; k++) frames.push({ ne: listA.length, list: listA, edit: mover(CAP, 0.2, 3, r) });
    const listB = listA.map((s) => s + 1);
    frames.push({ ne: listB.length, list: listB, edit: mover(CAP, 0.2, 3, r) });
    frames.push({ ne: listB.length, list: listB, edit: () => {} });
    // A list that repeats slot 5: the same set every frame, so reinsert runs, and returns -1 (the rebuild) once
    // slot 5's key changes.
    const listR = [...LISTS.inOrder(1200), 5, 5, 9];
    frames.push({ ne: listR.length, list: listR, edit: () => {} });
    frames.push({ ne: listR.length, list: listR, edit: mover(1200, 0.1, 2, r) });
    frames.push({ ne: listR.length, list: listR, edit: () => { asF32[5] += 128 * 7; } });
    frames.push({ ne: listR.length, list: listR, edit: () => { asF32[9] -= 128 * 3; } });
    frames.push({ ne: 1, list: null, edit: () => {} });
    frames.push({ ne: 1, list: [42], edit: () => {} });
    frames.push({ ne: 0, list: null, edit: () => {} });
    frames.push({ ne: 2, list: null, edit: () => {} });
    frames.push({ ne: 2, list: null, edit: () => { keys[0] = keys[1] + 128; } });
    frames.forEach(({ ne, list, edit }, f) => {
      edit();
      if (list) idxE.set(list);
      const view = list ? idxE : null;
      const want = orderPainterSlots(js, view, ne, keys);
      const got = orderPainterSlotsWasm(ws, view, ne, keys);
      const label = `${variant} frame ${f}`;
      assert.equal(got === ws.order, want === js.order, `${label}: returned array`);
      assert.equal(got === view, want === view, `${label}: returned idxE`);
      if (want) sameArray(got, want, ne, `${label} returned order`);
      sameState(js, variant, label);
      assert.equal(ws.frame, js.frame, `${label} frame`);
      assert.equal(ws.gen, js.gen, `${label} gen`);
    });
    assert.ok(calls.order >= 4 && calls.reinsert >= 8, `${variant}: the kernel rebuilt ${calls.order} times, reinserted ${calls.reinsert}`);
  }
  ws.kernel = null;
});

/** A variant whose calls are counted, as a state's kernel. */
function counted(v) {
  const calls = { radix: 0, order: 0, reinsert: 0 };
  const k = {
    ...v,
    radix: (...a) => {
      calls.radix++;
      return v.radix(...a);
    },
    reinsert: (...a) => {
      calls.reinsert++;
      return v.reinsert(...a);
    },
    painterOrder: (...a) => {
      calls.order++;
      return v.painterOrder(...a);
    },
  };
  return { k, calls };
}

test('a kernel state has createPainterState\'s shape; off the memory a call keeps queue order and says so once', () => {
  const js = createPainterState(CAP);
  assert.deepEqual(Object.keys(ws), Object.keys(js), 'the same fields in the same order');
  for (const [name, value] of Object.entries(js)) {
    if (ArrayBuffer.isView(value)) assert.equal(ws[name].constructor, value.constructor, `${name}'s class`);
    else assert.equal(typeof ws[name], name === 'kernel' ? 'object' : typeof value, `${name}'s type`);
  }
  assert.ok(VARIANTS.includes(PAINTER_VARIANT), `the workers bind ${PAINTER_VARIANT}`);

  const r = mulberry32(0x9e1);
  keys.fill(0);
  keys.set(FAMILIES.sprite(CAP, r));
  const slots = LISTS.shuffled(5000, r);
  const ref = Uint32Array.from(slots);
  radixSortIndicesBySortKey(ref, 5000, keys, new Uint32Array(5000), new Uint32Array(256));
  const { k, calls } = counted(variants[PAINTER_VARIANT]);
  ws.kernel = k;
  // The glow rows' radix: a list in the memory goes to the kernel; a list of its own stays in queue order.
  idx.set(slots);
  radixSortIndicesWasm(ws, idx, 5000, keys);
  sameArray(idx, ref, 5000, 'the kernel radix');
  assert.equal(calls.radix, 1, 'through the kernel');
  radixSortIndicesWasm(ws, idx, 1, keys);
  assert.equal(calls.radix, 1, 'one row: nothing to sort');
  const errors = [];
  const error = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    const own = Uint32Array.from(slots);
    radixSortIndicesWasm(ws, own, 5000, keys);
    sameArray(own, Uint32Array.from(slots), 5000, 'a list outside the memory: queue order');
    assert.equal(calls.radix, 1, 'and no kernel call');
    // Keys outside the memory: the slot list as given (null: the dense queue order), no kernel call.
    const ownKeys = Uint32Array.from(keys);
    assert.equal(orderPainterSlotsWasm(ws, null, 3000, ownKeys), null, 'keys outside the memory: queue order');
    const list = idx.subarray(0, 3000);
    assert.equal(orderPainterSlotsWasm(ws, list, 3000, ownKeys), list, 'the slot list as given');
    assert.equal(calls.order + calls.reinsert, 0, 'no kernel call');
  } finally {
    console.error = error;
  }
  // The refusal is said once a process: whichever call refused first in it said so.
  assert.ok(errors.length <= 1 && errors.every((e) => e.includes('drawn in queue order')), 'said once at most');
  ws.kernel = null;
});
