/**
 * Dense per-layer feeder lists for compute / density packers.
 * Mask writes are rare; packers walk O(feeders) not O(pool).
 *
 * E-354: each list has a slot index after it in its buffer (Layer._feedSlotView): an open-addressing table, linear
 * probing, of pairs (pool index + 1, the list slot holding it), so an add checks for the index and a remove finds it
 * without a walk of the list, under the layer's lock as before. The list changes as it did: an add appends, a remove
 * moves the last entry into the slot it frees. A list whose buffer has no index (built elsewhere) is walked.
 */
import { Layer } from '../core/layer.js';

function acquireLayerLock(lock, layerId) {
  if (!lock) return;
  while (Atomics.compareExchange(lock, layerId, 0, 1) !== 0) {
    // Mask writes are rare; short spin is enough.
  }
}

function releaseLayerLock(lock, layerId) {
  if (!lock) return;
  Atomics.store(lock, layerId, 0);
}

/**
 * E-354: the table entry for key `key1` (pool index + 1) or the empty entry where it would go; `mask` = entries - 1.
 * A key's home is the top bits of its Fibonacci hash (Math.clz32(mask) = 32 - log2(entries)), which spreads strided
 * pool indices too.
 */
function slotEntry(table, mask, key1) {
  let e = Math.imul(key1, 0x9e3779b1) >>> Math.clz32(mask);
  for (;;) {
    const k = table[e << 1];
    if (k === key1 || k === 0) return e;
    e = (e + 1) & mask;
  }
}

/**
 * E-354: empty entry `e`, then move back the entries after it in its run that it now separates from their home
 * (backward shift: the table holds no tombstones).
 */
function clearSlotEntry(table, mask, e) {
  let hole = e;
  let j = e;
  for (;;) {
    j = (j + 1) & mask;
    const k = table[j << 1];
    if (k === 0) break;
    const home = Math.imul(k, 0x9e3779b1) >>> Math.clz32(mask);
    // Stays when its home lies cyclically in (hole, j].
    const stays = hole <= j ? home > hole && home <= j : home > hole || home <= j;
    if (stays) continue;
    table[hole << 1] = k;
    table[(hole << 1) + 1] = table[(j << 1) + 1];
    hole = j;
  }
  table[hole << 1] = 0;
  table[(hole << 1) + 1] = 0;
}

/** E-354: removeFromList through the slot index: the slot from the table, the last entry into it, the table kept. */
function removeIndexed(indices, countArr, lock, layerId, index, table) {
  const mask = (table.length >> 1) - 1;
  const key1 = index + 1;
  acquireLayerLock(lock, layerId);
  const e = slotEntry(table, mask, key1);
  if (table[e << 1] === key1) {
    const n = Atomics.load(countArr, layerId);
    const found = table[(e << 1) + 1];
    const last = n - 1;
    clearSlotEntry(table, mask, e);
    if (found !== last) {
      const moved = indices[last] | 0;
      indices[found] = moved;
      table[(slotEntry(table, mask, moved + 1) << 1) + 1] = found;
    }
    Atomics.store(countArr, layerId, last);
  }
  releaseLayerLock(lock, layerId);
}

/** E-354: addToList through the slot index: a member found in the table, a new one appended and entered. */
function addIndexed(indices, countArr, lock, cap, overflowKey, layerId, index, warnLabel, table) {
  const mask = (table.length >> 1) - 1;
  const key1 = index + 1;
  acquireLayerLock(lock, layerId);
  const e = slotEntry(table, mask, key1);
  if (table[e << 1] === key1) {
    releaseLayerLock(lock, layerId);
    return;
  }
  const n = Atomics.load(countArr, layerId);
  if (n >= cap) {
    releaseLayerLock(lock, layerId);
    if (!Layer[overflowKey]) {
      Layer[overflowKey] = 1;
      console.warn(`${warnLabel}: overflow (max=${cap})`);
    }
    return;
  }
  indices[n] = index;
  table[e << 1] = key1;
  table[(e << 1) + 1] = n;
  Atomics.store(countArr, layerId, n + 1);
  releaseLayerLock(lock, layerId);
}

function removeFromList(indices, countArr, lock, layerId, index, table) {
  if (!indices || !countArr) return;
  if (table) {
    removeIndexed(indices, countArr, lock, layerId, index, table);
    return;
  }
  acquireLayerLock(lock, layerId);
  const n = Atomics.load(countArr, layerId);
  let found = -1;
  for (let s = 0; s < n; s++) {
    if ((indices[s] | 0) === index) {
      found = s;
      break;
    }
  }
  if (found >= 0) {
    const last = n - 1;
    if (found !== last) indices[found] = indices[last];
    Atomics.store(countArr, layerId, last);
  }
  releaseLayerLock(lock, layerId);
}

function addToList(indices, countArr, lock, feedMax, overflowKey, layerId, index, warnLabel, table) {
  if (!indices || !countArr) return;
  const cap = (feedMax && feedMax[layerId]) | 0;
  if (table) {
    addIndexed(indices, countArr, lock, cap, overflowKey, layerId, index, warnLabel, table);
    return;
  }
  acquireLayerLock(lock, layerId);
  const n = Atomics.load(countArr, layerId);
  for (let s = 0; s < n; s++) {
    if ((indices[s] | 0) === index) {
      releaseLayerLock(lock, layerId);
      return;
    }
  }
  if (n >= cap) {
    releaseLayerLock(lock, layerId);
    if (!Layer[overflowKey]) {
      Layer[overflowKey] = 1;
      console.warn(`${warnLabel}: overflow (max=${cap})`);
    }
    return;
  }
  indices[n] = index;
  Atomics.store(countArr, layerId, n + 1);
  releaseLayerLock(lock, layerId);
}

/**
 * Sync Collider index into compute-layer body feed lists.
 * @param {number} index
 * @param {number} oldMask
 * @param {number} newMask
 */
export function syncColliderFeed(index, oldMask, newMask) {
  const i = index | 0;
  const oldM = oldMask & 0xffff;
  const newM = newMask & 0xffff;
  if (oldM === newM) return;
  const lists = Layer._feedIndices;
  const counts = Layer._feedCount;
  const locks = Layer._feedLock;
  const maxs = Layer._feedMax;
  const slots = Layer._feedSlots;
  // The changed bits, the cleared ones then the set ones, each lowest first. Written out, with no callbacks: two
  // closures a call made garbage on every spawn and despawn.
  let cleared = oldM & ~newM;
  while (cleared) {
    const lsb = cleared & -cleared;
    const id = 31 - Math.clz32(lsb);
    if (lists[id]) removeFromList(lists[id], counts, locks, id, i, slots[id]);
    cleared ^= lsb;
  }
  let set = newM & ~oldM;
  while (set) {
    const lsb = set & -set;
    const id = 31 - Math.clz32(lsb);
    if (lists[id]) addToList(lists[id], counts, locks, maxs, '_feedOverflowWarned', id, i, 'syncColliderFeed', slots[id]);
    set ^= lsb;
  }
}

/**
 * Sync ParticleComponent index into density / compute-particle feed lists.
 * @param {number} index
 * @param {number} oldMask
 * @param {number} newMask
 */
export function syncParticleFeed(index, oldMask, newMask) {
  const i = index | 0;
  const oldM = oldMask & 0xffff;
  const newM = newMask & 0xffff;
  if (oldM === newM) return;
  const lists = Layer._particleFeedIndices;
  const counts = Layer._particleFeedCount;
  const locks = Layer._particleFeedLock;
  const maxs = Layer._particleFeedMax;
  const slots = Layer._particleFeedSlots;
  // The changed bits, the cleared ones then the set ones, each lowest first. Written out, with no callbacks: two
  // closures a call made garbage on every spawn and despawn.
  let cleared = oldM & ~newM;
  while (cleared) {
    const lsb = cleared & -cleared;
    const id = 31 - Math.clz32(lsb);
    if (lists[id]) removeFromList(lists[id], counts, locks, id, i, slots[id]);
    cleared ^= lsb;
  }
  let set = newM & ~oldM;
  while (set) {
    const lsb = set & -set;
    const id = 31 - Math.clz32(lsb);
    if (lists[id]) addToList(lists[id], counts, locks, maxs, '_particleFeedOverflowWarned', id, i, 'syncParticleFeed', slots[id]);
    set ^= lsb;
  }
}

function snapshotList(indices, counts, lock, layerId, scratchRef) {
  if (!indices || !counts) return null;
  acquireLayerLock(lock, layerId);
  const n = Atomics.load(counts, layerId);
  let scratch = scratchRef.buf;
  if (scratch.length < n) {
    scratch = new Uint32Array(n < 64 ? 64 : n);
    scratchRef.buf = scratch;
  }
  for (let f = 0; f < n; f++) scratch[f] = indices[f];
  releaseLayerLock(lock, layerId);
  return n;
}

const _colliderScratchRef = { buf: new Uint32Array(0) };
const _particleScratchRef = { buf: new Uint32Array(0) };
const _colliderSnap = { indices: null, count: 0 };
const _particleSnap = { indices: null, count: 0 };

/**
 * Copy collider feed indices out from under the layer spinlock.
 * @param {number} layerId
 * @returns {{ indices: Uint32Array, count: number } | null}
 */
export function snapshotColliderFeed(layerId) {
  const id = layerId | 0;
  const n = snapshotList(
    Layer._feedIndices[id],
    Layer._feedCount,
    Layer._feedLock,
    id,
    _colliderScratchRef,
  );
  if (n == null) return null;
  _colliderSnap.indices = _colliderScratchRef.buf;
  _colliderSnap.count = n;
  return _colliderSnap;
}

/**
 * Copy particle feed indices out from under the layer spinlock.
 * @param {number} layerId
 * @returns {{ indices: Uint32Array, count: number } | null}
 */
export function snapshotParticleFeed(layerId) {
  const id = layerId | 0;
  const n = snapshotList(
    Layer._particleFeedIndices[id],
    Layer._particleFeedCount,
    Layer._particleFeedLock,
    id,
    _particleScratchRef,
  );
  if (n == null) return null;
  _particleSnap.indices = _particleScratchRef.buf;
  _particleSnap.count = n;
  return _particleSnap;
}

/**
 * Visit dense collider feed indices (test helper).
 * @param {number} layerId
 * @param {(index: number) => void} visitor
 * @returns {boolean}
 */
export function visitColliderFeed(layerId, visitor) {
  const snap = snapshotColliderFeed(layerId);
  if (!snap) return false;
  for (let f = 0; f < snap.count; f++) visitor(snap.indices[f] | 0);
  return true;
}

/**
 * Visit dense particle feed indices (test helper).
 * @param {number} layerId
 * @param {(index: number) => void} visitor
 * @returns {boolean}
 */
export function visitParticleFeed(layerId, visitor) {
  const snap = snapshotParticleFeed(layerId);
  if (!snap) return false;
  for (let f = 0; f < snap.count; f++) visitor(snap.indices[f] | 0);
  return true;
}

/** Test helper: live feeder count for a compute layer. */
export function colliderFeedCount(layerId) {
  const counts = Layer._feedCount;
  if (!counts) return 0;
  return Atomics.load(counts, layerId | 0);
}

/** Test helper: live particle feeder count for a density/compute layer. */
export function particleFeedCount(layerId) {
  const counts = Layer._particleFeedCount;
  if (!counts) return 0;
  return Atomics.load(counts, layerId | 0);
}
