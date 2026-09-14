/**
 * Dense per-layer feeder lists for compute / density packers.
 * Mask writes are rare; packers walk O(feeders) not O(pool).
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

function removeFromList(indices, countArr, lock, layerId, index) {
  if (!indices || !countArr) return;
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

function addToList(indices, countArr, lock, feedMax, overflowKey, layerId, index, warnLabel) {
  if (!indices || !countArr) return;
  const cap = (feedMax && feedMax[layerId]) | 0;
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

function forEachChangedBit(oldMask, newMask, onCleared, onSet) {
  let removed = (oldMask & ~newMask) & 0xffff;
  let added = (newMask & ~oldMask) & 0xffff;
  while (removed) {
    const lsb = removed & -removed;
    onCleared(31 - Math.clz32(lsb));
    removed ^= lsb;
  }
  while (added) {
    const lsb = added & -added;
    onSet(31 - Math.clz32(lsb));
    added ^= lsb;
  }
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
  forEachChangedBit(
    oldM,
    newM,
    (id) => {
      if (lists[id]) removeFromList(lists[id], counts, locks, id, i);
    },
    (id) => {
      if (lists[id]) {
        addToList(lists[id], counts, locks, maxs, '_feedOverflowWarned', id, i, 'syncColliderFeed');
      }
    },
  );
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
  forEachChangedBit(
    oldM,
    newM,
    (id) => {
      if (lists[id]) removeFromList(lists[id], counts, locks, id, i);
    },
    (id) => {
      if (lists[id]) {
        addToList(
          lists[id],
          counts,
          locks,
          maxs,
          '_particleFeedOverflowWarned',
          id,
          i,
          'syncParticleFeed',
        );
      }
    },
  );
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
  return { indices: _colliderScratchRef.buf, count: n };
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
  return { indices: _particleScratchRef.buf, count: n };
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
