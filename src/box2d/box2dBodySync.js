// Sparse lifecycle/config synchronization from Weed workers to nested Box2D.
// Writers coalesce per-entity flags, then publish one bit in the dirty-word set.

export const BODY_DIRTY = Object.freeze({
  LIFECYCLE: 1,
  BODY_TYPE: 1 << 1,
  DAMPING: 1 << 2,
  MASS: 1 << 3,
  FILTER: 1 << 4,
  FRICTION: 1 << 5,
  GEOMETRY: 1 << 6,
});

let dirtyFlags = null;
let dirtyWords = null;
let generation = null;
let dirtyDeferDepth = 0;

export function bindBodySyncBuffers(buffers) {
  if (
    !buffers?.bodyDirtyFlags ||
    !buffers?.bodyDirtyWords ||
    !buffers?.bodyGeneration
  ) {
    dirtyFlags = null;
    dirtyWords = null;
    generation = null;
    return null;
  }

  dirtyFlags = new Int32Array(buffers.bodyDirtyFlags);
  dirtyWords = new Int32Array(buffers.bodyDirtyWords);
  generation = new Int32Array(buffers.bodyGeneration);
  return { dirtyFlags, dirtyWords, generation };
}

export function withBodyDirtyDeferred(fn) {
  dirtyDeferDepth++;
  try {
    return fn();
  } finally {
    dirtyDeferDepth--;
  }
}

export function markBodyDirty(entityIndex, flags = BODY_DIRTY.LIFECYCLE) {
  if (dirtyDeferDepth > 0) return false;
  if (!dirtyFlags || !dirtyWords) return false;
  const i = entityIndex | 0;
  if (i < 0 || i >= dirtyFlags.length) return false;
  Atomics.or(dirtyFlags, i, flags | 0);
  Atomics.or(dirtyWords, i >>> 5, 1 << (i & 31));
  return true;
}

export function bumpBodyGeneration(entityIndex) {
  if (!generation) return 0;
  const i = entityIndex | 0;
  if (i < 0 || i >= generation.length) return 0;
  const next = (Atomics.add(generation, i, 1) + 1) >>> 0;
  markBodyDirty(i, BODY_DIRTY.LIFECYCLE);
  return next;
}
