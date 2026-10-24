// E-129: pool slot ids sized by the pool's maximum. poolSlotWidth.js's thresholds, and the free lists of the
// particle, decoration and bullet pools (SharedAtomicPool with slotIdsFromMax):
// - up to 65 535 slots each binds the u16 Treiber stack it always had: a Uint16Array of links, an 8-byte head,
//   popU16 / popIndicesU16 / pushU16 / resetU16, the head packed (tag << 16) | (index + 1), and a sequence of
//   acquires and returns gives the indices the bare u16 functions give on a copy of the same buffers;
// - past 65 535 slots, FL4: Uint32 links, a 16-byte head, every one of 200 000 slots acquired once (by one and in
//   batches), returned and acquired again, the free count right throughout;
// - a pool without slotIdsFromMax (Joint) keeps the u16 stack at any size, and reset() rebinds the u16 stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BulletPool } from '../../src/core/bulletPool.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { Joint } from '../../src/core/joint.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import {
  getFreeListCount,
  popFl4,
  popIndicesU16,
  popU16,
  pushU16,
  resetFreeList,
  resetU16,
} from '../../src/util/atomicFreeList.js';
import {
  MAX_POOL_SLOTS,
  MAX_POOL_SLOTS_U16,
  poolFreeListTopBytes,
  PoolSlotArray,
  poolSlotBytes,
  poolSlotNone,
  poolSlotWide,
} from '../../src/util/poolSlotWidth.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

const POOLS = [ParticleEmitter, DecorationPool, BulletPool];

test('poolSlotWidth: 16-bit up to 65 535 slots, 32-bit past it, up to the FL4 ceiling', () => {
  assert.equal(MAX_POOL_SLOTS_U16, 65535);
  assert.equal(MAX_POOL_SLOTS, 524287);
  for (const [n, wide] of [[0, false], [1, false], [65535, false], [65536, true], [200000, true], [MAX_POOL_SLOTS, true]]) {
    assert.equal(poolSlotWide(n), wide, `${n}`);
    assert.equal(PoolSlotArray(n), wide ? Uint32Array : Uint16Array);
    assert.equal(poolSlotBytes(n), wide ? 4 : 2);
    assert.equal(poolFreeListTopBytes(n), wide ? 16 : 8);
    assert.equal(poolSlotNone(n), wide ? 0xffffffff : 0xffff);
  }
});

/** A pool bound as the scene binds it, on buffers sized for `n` slots of `bytes` (old layout: 2 and 8). */
function bind(Pool, n, linkBytes = poolSlotBytes(n), topBytes = poolFreeListTopBytes(n)) {
  Pool.reset();
  Pool.initialize(n);
  const links = new SharedArrayBuffer(n * linkBytes);
  const top = new SharedArrayBuffer(topBytes);
  Pool.initializeFreeList(links, top);
  resetFreeList(Pool.freeListTop, Pool.freeList, n, 1);
  return { links, top };
}

test('up to 65 535 slots each pool binds the u16 stack on the old buffers, acquiring what popU16 acquires', () => {
  for (const Pool of POOLS) {
    const n = 65535;
    const { links, top } = bind(Pool, n, 2, 8);
    assert.ok(Pool.freeList instanceof Uint16Array && Pool.freeList.length === n, `${Pool.poolName}: Uint16 links`);
    assert.equal(Pool.freeListTop.length, 2, `${Pool.poolName}: an 8-byte head`);
    assert.ok(Pool._popSlot === popU16 && Pool._pushSlot === pushU16 && Pool._popSlots === popIndicesU16 && Pool._resetSlots === resetU16, `${Pool.poolName}: the u16 stack`);
    // A reference copy driven by the bare u16 functions.
    const refLinks = new Uint16Array(new SharedArrayBuffer(n * 2));
    const refTop = new Int32Array(new SharedArrayBuffer(8));
    refLinks.set(new Uint16Array(links));
    refTop.set(new Int32Array(top));
    const r = mulberry32(0x129 + n);
    const held = [];
    const batch = new Uint16Array(64);
    const refBatch = new Uint16Array(64);
    for (let step = 0; step < 20000; step++) {
      const u = r();
      if (u < 0.45 || held.length === 0) {
        const a = Pool.acquireIndex();
        assert.equal(a, popU16(refTop, refLinks), `${Pool.poolName} step ${step}: acquire`);
        if (a >= 0) held.push(a);
      } else if (u < 0.55) {
        const m = 1 + Math.floor(r() * 64);
        const got = Pool.acquireIndices(m, batch, 0);
        assert.equal(got, popIndicesU16(refTop, refLinks, m, refBatch, 0), `${Pool.poolName} step ${step}: batch`);
        assert.deepEqual(Array.from(batch.subarray(0, got)), Array.from(refBatch.subarray(0, got)));
        held.push(...batch.subarray(0, got));
      } else {
        const i = held.splice(Math.floor(r() * held.length), 1)[0];
        Pool.returnToPool(i);
        pushU16(refTop, refLinks, i);
      }
      assert.equal(Pool.freeListTop[0], refTop[0], `${Pool.poolName} step ${step}: the packed head`);
    }
    assert.equal(Pool.getFreeCount(), getFreeListCount(refTop));
  }
});

test('past 65 535 slots each pool binds FL4: every slot once, returned, acquired again', () => {
  for (const Pool of POOLS) {
    const n = 200000;
    bind(Pool, n);
    assert.ok(Pool.freeList instanceof Uint32Array && Pool.freeList.length === n, `${Pool.poolName}: Uint32 links`);
    assert.equal(Pool.freeListTop.length, 4, `${Pool.poolName}: a 16-byte head`);
    assert.equal(Pool._popSlot, popFl4);
    if (Pool === ParticleEmitter) assert.ok(Pool._acquireBatch instanceof Uint32Array, 'the emit batch is 32-bit');
    const seen = new Uint8Array(n);
    const batch = new Uint32Array(997);
    let count = 0;
    while (count < n) {
      if (count % 2 === 0) {
        const i = Pool.acquireIndex();
        assert.ok(i >= 0 && i < n && !seen[i], `${Pool.poolName}: slot ${i}`);
        seen[i] = 1;
        count++;
      } else {
        const got = Pool.acquireIndices(997, batch, 0);
        assert.ok(got > 0);
        for (const i of batch.subarray(0, got)) {
          assert.ok(i < n && !seen[i], `${Pool.poolName}: batch slot ${i}`);
          seen[i] = 1;
        }
        count += got;
      }
    }
    assert.equal(Pool.acquireIndex(), -1, 'exhausted');
    assert.equal(Pool.getFreeCount(), 0);
    for (let i = 0; i < n; i += 3) Pool.returnToPool(i);
    assert.equal(Pool.getFreeCount(), Math.ceil(n / 3));
    const again = new Set();
    for (let i = Pool.acquireIndex(); i >= 0; i = Pool.acquireIndex()) again.add(i);
    assert.equal(again.size, Math.ceil(n / 3));
    assert.ok([...again].every((i) => i % 3 === 0) && again.has(199998), 'the returned slots, past 65 535 too');
    Pool.reset();
    assert.equal(Pool._popSlot, popU16, `${Pool.poolName}: reset rebinds the u16 stack`);
    if (Pool === ParticleEmitter) assert.ok(Pool._acquireBatch instanceof Uint16Array);
  }
});

test('a pool without slotIdsFromMax keeps the u16 stack at any size', () => {
  assert.equal(Joint.slotIdsFromMax, false);
  Joint.reset();
  Joint.initialize(70000);
  Joint.initializeFreeList(new SharedArrayBuffer(70000 * 2), new SharedArrayBuffer(8));
  assert.ok(Joint.freeList instanceof Uint16Array);
  assert.equal(Joint._popSlot, popU16);
  Joint.reset();
});
