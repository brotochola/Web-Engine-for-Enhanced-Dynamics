import test from 'node:test';
import assert from 'node:assert/strict';
import {
  radixSortIndicesBySortKey,
  reinsertChangedSlots,
  createPainterState,
  painterSameSet,
  orderPainterSlots,
  spriteYSortKey,
  depthFromSortKey,
  orderSortKey,
  zSortBand,
  floatBitsToOrd,
} from '../../src/util/sortIndexByKey.js';

function cmpFloat(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortCheck(values) {
  const keys = new Float32Array(values);
  const n = keys.length;
  const keysU32 = new Uint32Array(keys.buffer);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  radixSortIndicesBySortKey(idx, n, keysU32, new Uint32Array(Math.max(1, n)), new Uint32Array(256));
  const expect = Array.from({ length: n }, (_, i) => i);
  expect.sort((a, b) => cmpFloat(keys[a], keys[b]));
  assert.deepEqual(Array.from(idx), expect);
}

test('orderSortKey: zIndex band beats any Y; without ySort the key is the integer', () => {
  const band = zSortBand(1000);
  const farY = orderSortKey(1000 * 128, 0, true, band);
  const front = orderSortKey(0, 1, true, band);
  assert.ok(front > farY);
  assert.equal(orderSortKey(99999, 4, false, band), 4);
  assert.equal(orderSortKey(99999, 0, false, band), 0);
});

test('depthFromSortKey larger key is closer', () => {
  const h = 1000;
  const k = 128;
  assert.equal(depthFromSortKey(0, h, k), 1);
  assert.equal(depthFromSortKey(h * k, h, k), 0);
  const mid = depthFromSortKey(500 * k, h, k);
  assert.ok(mid < 1 && mid > 0);
  assert.equal(depthFromSortKey(-10, h, k), 1);
  assert.equal(depthFromSortKey(h * k + 50, h, k), 0);
});

test('radix sort indices by float sortKey', () => {
  sortCheck([]);
  sortCheck([3]);
  sortCheck([4, 3, 2, 1]);
  sortCheck([0, -1, 2, 2, 100.5, -100.5]);
});

test('reinsert a slot index above the list length', () => {
  const keys = new Float32Array(8);
  keys[0] = 1;
  keys[5] = 3;
  const keysU32 = new Uint32Array(keys.buffer);
  const order = new Uint32Array([0, 5]);
  const prev = new Uint32Array(keysU32);
  keys[5] = 0;
  const n = 2;
  const slotMoved = new Uint8Array(8);
  const movedList = new Uint32Array(8);
  const merge = new Uint32Array(8);
  assert.equal(
    reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, new Uint32Array(8), new Uint32Array(256)),
    1,
  );
  assert.deepEqual(Array.from(order.subarray(0, n)), [5, 0]);
});

test('reinsert only the slot whose key changed', () => {
  const keys = new Float32Array([1, 2, 3, 4]);
  const keysU32 = new Uint32Array(keys.buffer);
  const n = 4;
  const order = new Uint32Array([0, 1, 2, 3]);
  const prev = new Uint32Array(keysU32);
  const slotMoved = new Uint8Array(n);
  const movedList = new Uint32Array(n);
  const merge = new Uint32Array(n);
  const scratch = new Uint32Array(n);
  const hist = new Uint32Array(256);
  keys[2] = 0;
  assert.equal(reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, scratch, hist), 1);
  assert.deepEqual(Array.from(order), [2, 0, 1, 3]);
  assert.equal(reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, scratch, hist), 0);
});

function orderCheck(keysU32, ne, idxE, state) {
  const order = orderPainterSlots(state, idxE, ne, keysU32);
  const slots = idxE ? Array.from(idxE.subarray(0, ne)) : Array.from({ length: ne }, (_, i) => i);
  const got = order ? Array.from(order.subarray(0, ne)) : slots;
  // Compare ordinals, not raw bits: for a negative key the raw bits run the
  // other way, so `keysU32[a] <= keysU32[b]` is only valid while every key is
  // positive. `floatBitsToOrd` is the transform the painter itself orders by.
  const drawn = got.map((slot) => floatBitsToOrd(keysU32[slot]));
  assert.equal(got.length, ne);
  assert.deepEqual(new Set(got), new Set(slots), 'order is a permutation of the live slot set');
  for (let i = 1; i < drawn.length; i++) {
    assert.ok(
      drawn[i - 1] <= drawn[i],
      `order not ascending by key at ${i}: ...${drawn.slice(Math.max(0, i - 3), i + 2)}...`,
    );
  }
}

test('orderPainterSlots: dense layer queue (idxE=null) sorts by key every frame', () => {
  const cap = 16;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);

  keys.set([50, 10, 30, 20, 40]);
  orderCheck(keysU32, 5, null, state);

  // Same dense count next frame, values reshuffled — models a shard split
  // shifting while the total published count happens to stay the same.
  keys.set([15, 45, 5, 35, 25]);
  orderCheck(keysU32, 5, null, state);

  // Count drops (some slot fell out of the queue): must not reuse stale order.
  keys.set([1, 2, 3, 4]);
  orderCheck(keysU32, 4, null, state);

  // Count grows back past the old size.
  keys.set([9, 8, 7, 6, 5, 4]);
  orderCheck(keysU32, 6, null, state);
});

test('orderPainterSlots: reinsert stays a valid permutation; radix when the set changes', () => {
  const cap = 10;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);
  for (const vals of [[3, 1, 2], [1, 3, 2], [2, 2, 2]]) {
    keys.set(vals);
    orderCheck(keysU32, vals.length, null, state);
  }
  keys.set([9, 8, 7, 6]);
  orderCheck(keysU32, 4, null, state);
  keys.set([1, 2]);
  orderCheck(keysU32, 2, null, state);
});

test('painterSameSet: dense set (idxE=null) needs only a matching count', () => {
  const state = createPainterState(8);
  state.ready = true;
  state.n = 4;
  assert.equal(painterSameSet(state, null, 4), true);
  assert.equal(painterSameSet(state, null, 5), false);
});

test('spriteYSortKey: half a pixel is the same key, crossing it changes once', () => {
  const k = 128;
  const pixel = 2500;
  assert.equal(spriteYSortKey(pixel + 0.4, k), pixel * k);
  assert.equal(spriteYSortKey(pixel - 0.4, k), pixel * k);
  assert.equal(spriteYSortKey(pixel + 0.6, k), (pixel + 1) * k);
  assert.equal(spriteYSortKey(pixel - 0.6, k), (pixel - 1) * k);
});

test('reinsert: sub-pixel jitter does not permute quantized keys', () => {
  const n = 8;
  const state = createPainterState(n);
  const base = new Float32Array(n);
  const raw = new Float32Array(n);
  const quant = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = 100 + i;
  const rawU = new Uint32Array(raw.buffer);
  const quantU = new Uint32Array(quant.buffer);
  for (let i = 0; i < n; i++) {
    raw[i] = base[i] * 128;
    quant[i] = spriteYSortKey(base[i], 128);
  }
  orderPainterSlots(state, null, n, quantU);
  const before = Array.from(state.order.subarray(0, n));
  for (let i = 0; i < n; i += 2) {
    raw[i] = (base[i] + 0.2) * 128;
    quant[i] = spriteYSortKey(base[i] + 0.2, 128);
  }
  const changed = reinsertChangedSlots(
    state.order, n, quantU, state.prevKey, state.slotMoved, state.moved, state.merge, state.scratch, state.hist,
  );
  assert.equal(changed, 0);
  assert.deepEqual(Array.from(state.order.subarray(0, n)), before);
  const rawChanged = reinsertChangedSlots(
    state.order, n, rawU, state.prevKey, state.slotMoved, state.moved, state.merge, state.scratch, state.hist,
  );
  assert.ok(rawChanged > 0);
});

test('equal keys: a left insert that repacks two sprites flips their draw order', () => {
  const k = spriteYSortKey(100, 128);
  const keys = new Float32Array(4);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(4);
  keys[0] = k;
  keys[1] = k;
  orderPainterSlots(state, null, 2, keysU32);
  assert.deepEqual(Array.from(state.order.subarray(0, 2)), [0, 1]);
  // Frame 2: new sprite on the left, the two old ones swapped in the collector.
  // Entities: slot0=5, slot1=20, slot2=10. Frame 1 was slot0=10, slot1=20.
  const ent = [5, 20, 10];
  keys[0] = k;
  keys[1] = k;
  keys[2] = k;
  orderPainterSlots(state, null, 3, keysU32);
  const drawn = [];
  for (let i = 0; i < 3; i++) drawn.push(ent[state.order[i]]);
  const i10 = drawn.indexOf(10);
  const i20 = drawn.indexOf(20);
  assert.ok(i20 < i10);
});

test('painter on each id-half then concat is not the global Y order', () => {
  const keys = new Float32Array([10, 40, 20, 30]);
  const keysU32 = new Uint32Array(keys.buffer);
  const left = new Uint32Array([0, 1]);
  const right = new Uint32Array([2, 3]);
  const a = createPainterState(4);
  const b = createPainterState(4);
  const all = createPainterState(4);
  orderPainterSlots(a, left, 2, keysU32);
  orderPainterSlots(b, right, 2, keysU32);
  const concat = [a.order[0], a.order[1], b.order[0], b.order[1]];
  const idxE = new Uint32Array([0, 1, 2, 3]);
  const global = orderPainterSlots(all, idxE, 4, keysU32);
  assert.deepEqual(Array.from(global.subarray(0, 4)), [0, 2, 3, 1]);
  assert.notDeepEqual(concat, Array.from(global.subarray(0, 4)));
});


test('painterSameSet: filtered set (real idxE) needs matching integers, not just count', () => {
  const cap = 8;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);
  keys.set([10, 20, 30, 40]);
  const idxE = new Uint32Array([0, 1, 2, 3]);
  orderPainterSlots(state, idxE, 4, keysU32);
  // Same count, different integer set (2 swapped for 4) — must not be "same set".
  const shiftedIdxE = new Uint32Array([0, 1, 3, 4]);
  assert.equal(painterSameSet(state, shiftedIdxE, 4), false);
  assert.equal(painterSameSet(state, idxE, 4), true);
});

// --- negative sort keys (anything above the world origin) -------------------

test('floatBitsToOrd orders negatives before positives, as an unsigned value', () => {
  const bits = (v) => { const f = new Float32Array(1); f[0] = v; return new Uint32Array(f.buffer)[0]; };
  const ord = (v) => floatBitsToOrd(bits(v));
  const ascending = [-1e6, -128, -1, -0, 0, 1, 128, 5e3];
  for (let i = 1; i < ascending.length; i++) {
    assert.ok(
      ord(ascending[i - 1]) <= ord(ascending[i]),
      `ord(${ascending[i - 1]}) must not exceed ord(${ascending[i]})`,
    );
  }
  // The whole point: a positive key's ordinal has bit 31 set, so reading it as
  // a signed int32 makes it look smaller than any negative key's ordinal.
  assert.ok(ord(1) > 0x7fffffff, 'positive key ordinal must exceed INT32_MAX');
  assert.ok(ord(-1) >= 0 && ord(-1) < 0x80000000, 'negative key ordinal must fit below 2^31');
});

test('reinsert: a negative key stays behind a positive one', () => {
  const n = 2;
  const keys = new Float32Array([-128, 128]); // world y = -1 and y = +1
  const keysU32 = new Uint32Array(keys.buffer);
  const order = new Uint32Array([0, 1]);
  const prev = new Uint32Array(keysU32);
  const slotMoved = new Uint8Array(n);
  const movedList = new Uint32Array(n);
  const merge = new Uint32Array(n);
  const scratch = new Uint32Array(n);
  const hist = new Uint32Array(256);
  // Nudge slot 0 so it has to travel back through the merge.
  keys[0] = -1024;
  assert.equal(reinsertChangedSlots(order, n, keysU32, prev, slotMoved, movedList, merge, scratch, hist), 1);
  assert.deepEqual(Array.from(order), [0, 1], 'y=-8 must still draw before y=+1');
});

test('orderPainterSlots: mixed-sign keys stay sorted across many reinsert frames', () => {
  const n = 512;
  const keys = new Float32Array(n);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(n);
  // Fixed count every frame, so painterSameSet always approves and every frame
  // after the first goes through the incremental merge, never a radix rebuild.
  for (let i = 0; i < n; i++) keys[i] = spriteYSortKey(i < n / 2 ? -(1 + (i % 120)) : 100 + (i % 120), 128);
  orderCheck(keysU32, n, null, state);
  for (let frame = 1; frame < 200; frame++) {
    for (let i = 0; i < 5; i++) {
      const s = (frame * 7 + i * 13) % n;
      keys[s] = spriteYSortKey((frame % 60) - 30, 128);
    }
    orderCheck(keysU32, n, null, state);
  }
});

test('orderPainterSlots: mixed-sign keys survive a visible-set size change', () => {
  const cap = 64;
  const keys = new Float32Array(cap);
  const keysU32 = new Uint32Array(keys.buffer);
  const state = createPainterState(cap);
  for (const vals of [
    [-512, -256, 0, 128, 640],
    [-128, -128, 256, 256, 1280, 0],
    [-1024, 512],
    [-768, -256, 384, 1536, 2048, 0, 64],
  ]) {
    keys.set(vals);
    orderCheck(keysU32, vals.length, null, state);
  }
});
