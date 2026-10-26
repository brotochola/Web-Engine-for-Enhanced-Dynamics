// GPU particles (LAYER_KIND.GPU_PARTICLES): the shared memory one GPU layer lives in. A GPU particle is one
// record written once, at spawn, by the thread that emits it; the renderer's vertex shader evaluates it from its
// age (gpuParticleEval.js is the same math in JS). Weed's rule is one writer per shared region, so each layer has
// one ring per writer thread (the main thread, each logic worker, the particle worker). A ring is a header, its
// records and its group table (one row per emitGpu call: the slots it wrote, when they live, where they are).
//
// Counters are absolute (uint32, wrapping): `published` counts every record a ring ever wrote, slot = count &
// (capacity - 1), capacities being powers of two; `groupsPublished` the same for groups. A writer fills its records and group row, then stores the
// counts (Atomics.store), so a reader that loads them (Atomics.load) sees only finished records.

/** Floats per record (112 bytes, seven vec4 attributes). */
export const GPU_RECORD_FLOATS = 28;
export const GPU_RECORD_BYTES = GPU_RECORD_FLOATS * 4;

/** Record fields, as float indices. `T` fields are uint32 bits in the float (floatBitsToUint in the shader). */
export const GPU_REC = Object.freeze({
  X0: 0, Y0: 1, VX: 2, VY: 3, // px, px/frame
  Z0: 4, VZ: 5, GRAVITY: 6, DRAG: 7, // px, px/frame, px/frame², 1/frame
  BIRTH: 8, LIFE: 9, ROT_FROM: 10, ROT_TO: 11, // ms on the ring's epoch, ms, rad, rad
  SCALE_X_FROM: 12, SCALE_X_TO: 13, SCALE_Y_FROM: 14, SCALE_Y_TO: 15,
  ALPHA_FROM: 16, ALPHA_TO: 17, TINT_FROM_T: 18, TINT_TO_T: 19, // tints 0xRRGGBB as bits
  SPIN_FROM: 20, SPIN_TO: 21, EASES_T: 22, TEX01_T: 23, // rad/ms; eases and flags; texture ids 0 and 1
  TEX23_T: 24, TEX45_T: 25, TEX67_T: 26, RESERVED: 27,
});

/**
 * Bits of GPU_REC.EASES_T. Bits 0-23 are six 4-bit eases at PARTICLE_EASE_SHIFT (alpha, scaleX, scaleY, tint,
 * rotation, angular velocity); then the flags.
 */
export const GPU_FLAG = Object.freeze({
  HEIGHTED: 1 << 24, // z / vz / gravity on z, drawn at y + z; otherwise gravity on vy
  FLIP_X: 1 << 25,
  FLIP_Y: 1 << 26,
  FRAMES_SHIFT: 27, // 3 bits: frame count - 1 (1-8 frames, cycled over life)
  FRAMES_MASK: 7 << 27,
});

/** Most frames a GPU particle cycles through (texture ids packed two per float). */
export const GPU_MAX_FRAMES = 8;

/** Int32 slots of a ring header (64 bytes: one cache line). */
export const GPU_RING_HEADER_BYTES = 64;
export const GPU_RING = Object.freeze({
  PUBLISHED: 0, // records ever written (uint32, wrapping)
  GROUPS: 1, // groups ever written (uint32, wrapping)
  OVERFLOW: 2, // times the writer wrote over records that were still alive
  EPOCH_GEN: 3, // bumped each time the writer moves the epoch
  EPOCH_F64: 2, // Float64 index (byte 16): the ring's epoch, sim ms; births are ms after it
});

/** Words per group row: 48 bytes. Bounds are world px at the groups' widest (drawn positions, sprites padded). */
export const GPU_GROUP_WORDS = 12;
export const GPU_GROUP = Object.freeze({
  FIRST: 0, // uint32: the first record's absolute count
  COUNT: 1, // uint32
  BIRTH_F: 2, // float: earliest birth, ms on the epoch the group was written on
  END_F: 3, // float: latest death, same epoch
  SORT_Y_F: 4, // float: ground y the group sorts at among the entities
  MIN_X_F: 5, MIN_Y_F: 6, MAX_X_F: 7, MAX_Y_F: 8,
  EPOCH_GEN: 9, // uint32: the ring's EPOCH_GEN when written
  FLAGS: 10, // uint32: GPU_GROUP_FLAG
  RESERVED: 11,
});
export const GPU_GROUP_FLAG = Object.freeze({ HEIGHTED: 1 });

/** Group rows per ring (a power of two). */
export const GPU_GROUP_CAPACITY = 2048;

/** Writer slots: 0 = main thread, 1..L = logic workers 0..L-1, L+1 = the particle worker. */
export function gpuWriterCount(numberOfLogicWorkers) {
  return Math.max(1, numberOfLogicWorkers | 0) + 2;
}

/** The writer slot of logic worker `index`. */
export function gpuLogicWriterSlot(index) {
  return 1 + (index | 0);
}

/** The particle worker's writer slot. */
export function gpuParticleWorkerWriterSlot(numberOfLogicWorkers) {
  return 1 + Math.max(1, numberOfLogicWorkers | 0);
}

/** The largest power of two <= n (n >= 1). */
function floorPow2(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Records per ring: `maxParticles` split by `shares` (writer slot -> weight; missing weights are 1). Each ring is a
 * power of two, at least 64, so slot = count & (capacity - 1) stays right when the uint32 counts wrap.
 * `rings` is the writer count.
 * @param {number} maxParticles
 * @param {number} rings
 * @param {number[]|null} [shares]
 * @returns {number[]}
 */
export function gpuRingCapacities(maxParticles, rings, shares = null) {
  const n = Math.max(1, rings | 0);
  const total = Math.max(64 * n, maxParticles | 0);
  const w = new Array(n);
  let sum = 0;
  for (let r = 0; r < n; r++) {
    const s = shares && Number.isFinite(shares[r]) && shares[r] >= 0 ? shares[r] : 1;
    w[r] = s;
    sum += s;
  }
  const caps = new Array(n);
  for (let r = 0; r < n; r++) {
    const want = sum > 0 ? Math.floor((total * w[r]) / sum) : 64;
    caps[r] = floorPow2(Math.max(64, want));
  }
  return caps;
}

/** Slot of absolute count `count` in a ring of `capacity` (a power of two). */
export function gpuSlotOf(count, capacity) {
  return (count & (capacity - 1)) >>> 0;
}

/**
 * Byte layout of one GPU layer's memory: per ring, the header, the records (16-byte aligned) and the group table.
 * @param {number[]} capacities records per ring
 * @returns {{ bytes: number, rings: { headerByte: number, recordsByte: number, capacity: number, groupsByte: number, groupCapacity: number }[] }}
 */
export function gpuLayerLayout(capacities) {
  const align = (b) => (b + 63) & ~63;
  let at = 0;
  const rings = [];
  for (const cap of capacities) {
    const capacity = Math.max(1, cap | 0);
    const headerByte = at;
    at = align(at + GPU_RING_HEADER_BYTES);
    const recordsByte = at;
    at = align(at + capacity * GPU_RECORD_BYTES);
    const groupsByte = at;
    at = align(at + GPU_GROUP_CAPACITY * GPU_GROUP_WORDS * 4);
    rings.push({ headerByte, recordsByte, capacity, groupsByte, groupCapacity: GPU_GROUP_CAPACITY });
  }
  return { bytes: Math.max(64, at), rings };
}

/** Frames of age per ms: the unit CPU particles move in (velocities per frame, gravity per frame²). */
export const GPU_FRAME_MS = 16.67;

// The y-sort proxies' splits (src/render/gpuParticleProxies.js): per frame, the GPU particle groups and look-layer
// regions drawn among the entities, each with the entities instance it is drawn before. Two halves, one per
// render-queue buffer (A and B), written by the worker that packs the entities and read by Pixi with that frame.

/** Entries per frame (groups and regions). Past it, the rest are not drawn that frame. */
export const PROXY_MAX_ENTRIES = 1024;
/** Words per entry: instance index, kind and layer, ring, group (absolute), then the rectangle (floats). */
export const PROXY_ENTRY_WORDS = 8;
export const PROXY = Object.freeze({
  INDEX: 0, // packed entities drawn before the entry
  KIND_LAYER: 1, // kind << 8 | layer id
  RING: 2,
  GROUP: 3, // the group's absolute index in its ring (a region: its head group)
  MIN_X_F: 4, MIN_Y_F: 5, MAX_X_F: 6, MAX_Y_F: 7,
});
export const PROXY_KIND = Object.freeze({ GROUP: 0, REGION: 1 });
/** Int32 header of a half: entry count, entries dropped (past PROXY_MAX_ENTRIES), then reserved. */
export const PROXY_HEADER_INTS = 4;
const PROXY_HALF_INTS = PROXY_HEADER_INTS + PROXY_MAX_ENTRIES * PROXY_ENTRY_WORDS;

/** Bytes of the split memory (both halves). */
export function proxyMemoryBytes() {
  return 2 * PROXY_HALF_INTS * 4;
}

/**
 * Views of both halves.
 * @param {SharedArrayBuffer} sab
 */
export function bindProxyHalves(sab) {
  const out = [];
  for (let h = 0; h < 2; h++) {
    const byte = h * PROXY_HALF_INTS * 4;
    out.push({
      header: new Int32Array(sab, byte, PROXY_HEADER_INTS),
      ints: new Int32Array(sab, byte + PROXY_HEADER_INTS * 4, PROXY_MAX_ENTRIES * PROXY_ENTRY_WORDS),
      floats: new Float32Array(sab, byte + PROXY_HEADER_INTS * 4, PROXY_MAX_ENTRIES * PROXY_ENTRY_WORDS),
    });
  }
  return out;
}
