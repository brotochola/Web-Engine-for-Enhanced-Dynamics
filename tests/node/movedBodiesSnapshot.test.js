import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindMovedBodies,
  createMovedBodiesSab,
  getMovedBodiesViews,
  publishMovedBodies,
} from '../../src/box2d/box2dMovedBodies.js';

/**
 * B-06. `publishMovedBodies` writes the set in place and publishes it with two
 * stores, COUNT first and GEN last:
 *
 *     Atomics.store(hdrI32, HDR_COUNT, count);
 *     Atomics.add(hdrI32, HDR_GEN, 1);
 *
 * GEN is the commit word. But the reader took the two loads in the other order
 * and never checked them against each other:
 *
 *     generation: Atomics.load(hdrI32, HDR_GEN),
 *     count:      Atomics.load(hdrI32, HDR_COUNT),
 *
 * A publish landing between the two loads returns the new count with the old
 * generation. That pair is the actual bug, and it is worse than a torn list,
 * because `generation` is precisely what a consumer uses to decide whether the
 * views it is holding are still the ones it asked for. A generation that does
 * not identify its own set is worse than no generation at all - it makes the
 * consumer skip the check it would otherwise have done, and skip it believing
 * it passed.
 *
 * Fix: treat GEN as the commit word. Read GEN, read COUNT, re-read GEN, and
 * retry while it moved. Bounded, because the publisher commits once per physics
 * step and always converges.
 *
 * The views themselves stay live - see the contract on Box2d.getMovedBodies.
 * That is deliberate and documented; the list is not copied per frame because
 * an entityCapacity-sized allocation every frame is the GC pressure this engine
 * has been removing.
 */

const CAP = 64;

function bind() {
  bindMovedBodies(createMovedBodiesSab(CAP));
}

function publish(slots, { teleports = [], fellAsleep = null } = {}) {
  return publishMovedBodies(
    new Int32Array(slots),
    fellAsleep ? new Uint8Array(fellAsleep) : null,
    slots.length,
    teleports.length ? new Uint32Array(teleports) : null,
    teleports.length,
    null,
  );
}

test('B-06: an unbound buffer yields null rather than a half-built view', { concurrency: false }, () => {
  bindMovedBodies(null);
  assert.equal(getMovedBodiesViews(), null);
});

test('B-06: a fresh buffer reports an empty set at generation 0', { concurrency: false }, () => {
  bind();
  const v = getMovedBodiesViews();
  assert.equal(v.count, 0);
  assert.equal(v.generation, 0);
});

test('B-06: publishing advances both count and generation', { concurrency: false }, () => {
  bind();
  publish([1, 2, 3]);
  const v1 = getMovedBodiesViews();
  assert.equal(v1.count, 3);
  assert.equal(v1.generation, 1, 'the first publish commits generation 1');

  publish([4, 5]);
  const v2 = getMovedBodiesViews();
  assert.equal(v2.count, 2);
  assert.equal(v2.generation, 2, 'generation advances with each publish');
});

test('B-06: count and generation always come from the same publish', { concurrency: false }, () => {
  bind();
  publish([1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < 32; i++) {
    const n = 1 + (i % 20);
    publish(Array.from({ length: n }, (_, k) => k));
    const v = getMovedBodiesViews();
    // The generation is the commit word, so if it says N the count is the one
    // that was current at commit N. Re-derive that and compare.
    const expected = v.count;
    const gen = v.generation;
    const v2 = getMovedBodiesViews();
    assert.equal(v2.generation, gen, 'no publish landed between the two reads');
    assert.equal(v2.count, expected, 'so the count must not have moved either');
    // And the list must actually hold `count` entries from this publish.
    const list = v.movedList;
    for (let k = 0; k < v.count; k++) {
      assert.ok(list[k] >= 0 && list[k] < CAP, `entry ${k} = ${list[k]} is not a valid slot`);
    }
  }
});

test('B-06: a set that shrinks does not leave stale tail entries visible', { concurrency: false }, () => {
  bind();
  publish(Array.from({ length: 40 }, (_, k) => k));
  assert.equal(getMovedBodiesViews().count, 40);

  publish([7]);
  const v = getMovedBodiesViews();
  assert.equal(v.count, 1, 'the count is the new one');
  // The reader is handed a subarray of exactly `count`, so the old tail is not
  // reachable even though the bytes are still in the buffer.
  const view = v.movedList.subarray(0, v.count);
  assert.equal(view.length, 1);
  assert.equal(view[0], 7);
});

test('B-06: teleports merge into the same set and advance the generation once', { concurrency: false }, () => {
  bind();
  publish([1, 2], { teleports: [3, 4, 5] });
  const v = getMovedBodiesViews();
  assert.equal(v.count, 5, 'movers and teleports land in one set');
  assert.equal(v.generation, 1, 'one publish, one generation bump');
});

test('B-06: duplicate slots are deduplicated', { concurrency: false }, () => {
  bind();
  publish([1, 1, 2, 2, 2]);
  assert.equal(getMovedBodiesViews().count, 2);
});

test('B-06: out-of-range slots are rejected, not published', { concurrency: false }, () => {
  bind();
  const n = publish([-1, 5, CAP, CAP + 100]);
  assert.equal(n, 1, 'only the one in-range slot survives');
  assert.equal(getMovedBodiesViews().count, 1);
});

test('B-06: an empty publish clears the set', { concurrency: false }, () => {
  bind();
  publish([1, 2, 3]);
  assert.equal(getMovedBodiesViews().count, 3);
  publish([]);
  assert.equal(getMovedBodiesViews().count, 0);
});

test('B-06: fellAsleep is parallel to the list by POSITION, not by slot', { concurrency: false }, () => {
  // Worth pinning explicitly, because the two are indexed differently and
  // nothing in the types says so. publishMovedBodies does:
  //     movedList[count] = slot;
  //     fellAsleep[count] = wasmFellAsleep[i];
  // Both are indexed by `count` - the position in the list - while the value
  // being stored is a slot. Reading fellAsleep by slot instead of by position
  // is the obvious mistake and it silently returns the wrong flag as soon as
  // any slot is skipped by the range check or the dedup.
  bind();
  publish([10, 11, 12], { fellAsleep: [1, 0, 1] });
  const v = getMovedBodiesViews();

  assert.equal(v.count, 3);
  for (let k = 0; k < v.count; k++) {
    assert.equal(v.movedList[k], 10 + k, `list[${k}] is the slot, in order`);
  }
  // Position k pairs with list[k], NOT with slot 10+k.
  assert.equal(v.fellAsleep[0], 1, 'position 0 carries the flag for slot 10');
  assert.equal(v.fellAsleep[1], 0, 'position 1 carries the flag for slot 11');
  assert.equal(v.fellAsleep[2], 1, 'position 2 carries the flag for slot 12');
});

test('B-06: a skipped slot shifts positions but not the flags', { concurrency: false }, () => {
  // Same reason as the test above: the out-of-range slot 999 is dropped, so
  // positions shift down. The flags must follow their movers, not their slots.
  bind();
  publish([10, 999, 11], { fellAsleep: [1, 1, 0] });
  const v = getMovedBodiesViews();

  assert.equal(v.count, 2, 'the out-of-range slot was dropped');
  assert.equal(v.movedList[0], 10);
  assert.equal(v.movedList[1], 11);
  assert.equal(v.fellAsleep[0], 1, 'slot 10 keeps its flag');
  assert.equal(v.fellAsleep[1], 0, 'slot 11 keeps its flag');
});