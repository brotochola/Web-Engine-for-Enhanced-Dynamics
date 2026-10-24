// Pool slot ids (E-129): the particle, decoration and bullet pools. Each pool sizes its slot ids from its own
// maximum (particle.maxParticles, decoration.maxDecorations, bullet.maxBullets), once: where the scene makes its
// buffers (sceneSharedBuffers.js) and where each worker binds them, since every worker is given the maximum. Up
// to 65 535 slots the ids are 16-bit: the arrays, buffers and code the pools have always had. Past that they are
// 32-bit, up to MAX_POOL_SLOTS, the ceiling of the FL4 free list's 19-bit index (atomicFreeList.js). Bind-time
// helpers only: a hot loop gets the array it was handed, never a width test.

export const MAX_POOL_SLOTS_U16 = 65535;
/** The FL4 free list's 19-bit (index + 1): 524 287 slots. */
export const MAX_POOL_SLOTS = (1 << 19) - 1;

/** Whether a pool of `maxSlots` takes 32-bit slot ids. */
export function poolSlotWide(maxSlots) {
  return maxSlots > MAX_POOL_SLOTS_U16;
}

/** The class of the pool's slot lists and free-list links: Uint16Array, or Uint32Array past 65 535 slots. */
export function PoolSlotArray(maxSlots) {
  return maxSlots > MAX_POOL_SLOTS_U16 ? Uint32Array : Uint16Array;
}

/** Bytes per slot id: 2, or 4 past 65 535 slots. */
export function poolSlotBytes(maxSlots) {
  return maxSlots > MAX_POOL_SLOTS_U16 ? 4 : 2;
}

/** Bytes of the free list's head: Int32Array[2] for the u16 Treiber stack, Int32Array[4] for FL4. */
export function poolFreeListTopBytes(maxSlots) {
  return maxSlots > MAX_POOL_SLOTS_U16 ? 16 : 8;
}

/** The "no slot" value of the pool's lists and links: 0xffff, or 0xffffffff past 65 535 slots. */
export function poolSlotNone(maxSlots) {
  return maxSlots > MAX_POOL_SLOTS_U16 ? 0xffffffff : 0xffff;
}
