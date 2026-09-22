// Sparse lifecycle/config synchronization from Weed workers to nested Box2D.
// Writers coalesce per-entity flags, then publish one bit in the dirty-word set.
// During spawn defer, marks are saved here (pendingFlags) and published on
// bump after activate — physics never sees the reset Box 0×0.

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
let pendingFlags = null;
let dirtyDeferDepth = 0;
let poseSlots = null;

/** Published pose uses a unit complex. Zeros mean this life has not been published. */
export function poseRotationLive(rotC, rotS) {
  return rotC * rotC + rotS * rotS > 0.25;
}

export function bindPoseSlotBuffers(pose) {
  if (!pose?.dataA || !pose?.dataB) {
    poseSlots = null;
    return;
  }
  const n = pose.capacity | 0;
  if (!(n > 0)) {
    poseSlots = null;
    return;
  }
  const sabs = [pose.dataA, pose.dataB];
  poseSlots = [];
  for (let i = 0; i < 2; i++) {
    poseSlots.push({
      rotC: new Float32Array(sabs[i], n * 8, n),
      rotS: new Float32Array(sabs[i], n * 12, n),
    });
  }
}

function invalidatePoseSlot(i) {
  const slots = poseSlots;
  if (!slots || i < 0) return;
  for (let b = 0; b < slots.length; b++) {
    const slot = slots[b];
    if (i >= slot.rotC.length) return;
    slot.rotC[i] = 0;
    slot.rotS[i] = 0;
  }
}

export function bindBodySyncBuffers(buffers) {
  if (
    !buffers?.bodyDirtyFlags ||
    !buffers?.bodyDirtyWords ||
    !buffers?.bodyGeneration
  ) {
    dirtyFlags = null;
    dirtyWords = null;
    generation = null;
    pendingFlags = null;
    poseSlots = null;
    return null;
  }

  dirtyFlags = new Int32Array(buffers.bodyDirtyFlags);
  dirtyWords = new Int32Array(buffers.bodyDirtyWords);
  generation = new Int32Array(buffers.bodyGeneration);
  pendingFlags = new Int32Array(dirtyFlags.length);
  poseSlots = null;
  if (buffers.poseDataA && buffers.poseDataB) {
    const n = (buffers.poseDataA.byteLength / 16) | 0;
    bindPoseSlotBuffers({
      dataA: buffers.poseDataA,
      dataB: buffers.poseDataB,
      capacity: n,
    });
  }
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

function publishBodyDirty(i, flags) {
  let extra = 0;
  if (pendingFlags && i < pendingFlags.length) {
    extra = pendingFlags[i];
    pendingFlags[i] = 0;
  }
  Atomics.or(dirtyFlags, i, (flags | extra) | 0);
  Atomics.or(dirtyWords, i >>> 5, 1 << (i & 31));
  return true;
}

/**
 * `force` publishes even inside `withBodyDirtyDeferred` (child bump while
 * the parent spawn window is still open). Game code does not pass `force`.
 */
export function markBodyDirty(entityIndex, flags = BODY_DIRTY.LIFECYCLE, force = false) {
  if (!dirtyFlags || !dirtyWords) return false;
  const i = entityIndex | 0;
  if (i < 0 || i >= dirtyFlags.length) return false;
  if (dirtyDeferDepth > 0 && !force) {
    if (!pendingFlags || i >= pendingFlags.length) return false;
    pendingFlags[i] |= flags | 0;
    return true;
  }
  return publishBodyDirty(i, flags);
}

export function bumpBodyGeneration(entityIndex) {
  if (!generation) return 0;
  const i = entityIndex | 0;
  if (i < 0 || i >= generation.length) return 0;
  const next = (Atomics.add(generation, i, 1) + 1) >>> 0;
  // Reused slot still holds the previous body's published pose. Drop it so
  // the first frames draw Transform until physics publishes this life.
  invalidatePoseSlot(i);
  // Parent onSpawned may still be deferred. Publish this entity's saved
  // marks plus LIFECYCLE so the child body is created with the real shape.
  markBodyDirty(i, BODY_DIRTY.LIFECYCLE, true);
  return next;
}
