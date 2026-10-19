// Sparse lifecycle/config synchronization from Weed workers to nested Box2D.
// Writers coalesce per-entity flags, then publish one bit in the dirty-word set.
// During spawn defer, marks are saved here (pendingFlags). The outermost
// window publishes every saved slot. A bump still publishes that one slot
// immediately so a child spawn is not left shapeless.

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
let epoch = null;
let pendingFlags = null;
let pendingList = null;
let pendingListCount = 0;
let pendingOverflow = 0;
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
  const sabs = [pose.dataA, pose.dataB];
  const slots = [];
  for (let i = 0; i < 2; i++) {
    const sab = sabs[i];
    // Each buffer names its own capacity. Production allocates both at
    // poseN * 16, so this matches the shared `pose.capacity`. A shorter first
    // buffer must not shrink the view of the second: that is the case where
    // `return` in invalidatePoseSlot skips a slot the longer buffer still holds.
    const fromBytes = (sab.byteLength / 16) | 0;
    const n = fromBytes > 0 ? fromBytes : (pose.capacity | 0);
    if (!(n > 0)) {
      poseSlots = null;
      return;
    }
    slots.push({
      rotC: new Float32Array(sab, n * 8, n),
      rotS: new Float32Array(sab, n * 12, n),
    });
  }
  poseSlots = slots;
}

function invalidatePoseSlot(i) {
  const slots = poseSlots;
  if (!slots || i < 0) return;
  for (let b = 0; b < slots.length; b++) {
    const slot = slots[b];
    // continue, not return: the two pose buffers are allocated with the same
    // capacity today, but a return here would leave the second one holding the
    // previous life's rotation for this slot if they ever diverged.
    if (i >= slot.rotC.length) continue;
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
    epoch = null;
    pendingFlags = null;
    pendingList = null;
    pendingListCount = 0;
    pendingOverflow = 0;
    poseSlots = null;
    return null;
  }

  dirtyFlags = new Int32Array(buffers.bodyDirtyFlags);
  dirtyWords = new Int32Array(buffers.bodyDirtyWords);
  generation = new Int32Array(buffers.bodyGeneration);
  epoch = buffers.bodyGenEpoch ? new Int32Array(buffers.bodyGenEpoch) : null;
  pendingFlags = new Int32Array(dirtyFlags.length);
  pendingList = new Int32Array(dirtyFlags.length);
  pendingListCount = 0;
  pendingOverflow = 0;
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

function rememberPending(i) {
  const list = pendingList;
  if (!list) return;
  const n = pendingListCount;
  if (n >= list.length) {
    pendingOverflow = 1;
    return;
  }
  list[n] = i;
  pendingListCount = n + 1;
}

function flushPendingBodyDirty() {
  const pending = pendingFlags;
  if (!pending || !dirtyFlags) return;
  if (pendingOverflow) {
    pendingOverflow = 0;
    pendingListCount = 0;
    for (let i = 0; i < pending.length; i++) {
      if (!pending[i]) continue;
      publishBodyDirty(i, 0);
    }
    return;
  }
  const list = pendingList;
  const n = pendingListCount;
  pendingListCount = 0;
  if (!list) return;
  for (let k = 0; k < n; k++) {
    const i = list[k];
    if (!pending[i]) continue;
    publishBodyDirty(i, 0);
  }
}

export function withBodyDirtyDeferred(fn) {
  dirtyDeferDepth++;
  try {
    return fn();
  } finally {
    dirtyDeferDepth--;
    if (dirtyDeferDepth === 0) flushPendingBodyDirty();
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
    rememberPending(i);
    return true;
  }
  return publishBodyDirty(i, flags);
}

export function bumpBodyGeneration(entityIndex) {
  if (!generation) return 0;
  const i = entityIndex | 0;
  if (i < 0 || i >= generation.length) return 0;
  const next = (Atomics.add(generation, i, 1) + 1) >>> 0;
  if (epoch) Atomics.add(epoch, 0, 1);
  // Reused slot still holds the previous body's published pose. Drop it so
  // the first frames draw Transform until physics publishes this life.
  invalidatePoseSlot(i);
  // Parent onSpawned may still be deferred. Publish this entity's saved
  // marks plus LIFECYCLE so the child body is created with the real shape.
  markBodyDirty(i, BODY_DIRTY.LIFECYCLE, true);
  return next;
}
