/**
 * Spawn/despawn command ring (MPSC writers, logic0 consumer).
 * Mirror of the Box2D command ring, no WASM.
 *
 * Header (i32): write, read, capacity, overflow.
 * Slot stride 8 i32:
 *   0 seq
 *   1 kind (1=spawn, 2=despawn)
 *   2 typeId      — values are Uint16 today; field is i32 so a later
 *                   Uint32 type ceiling does not change the protocol.
 *   3 entityIndex — values are Uint16 today (MAX_ENTITIES 65535); field
 *                   is i32 so a later Uint32 pool does not change the protocol.
 *   4–5 x, y as f32
 *   6–7 pad
 *
 * Capacity is the entity pool (covers one create() of 65k). Full ring
 * returns false; callers escape to the existing postMessage spawn/despawn.
 */

export const SPAWN_CMD_KIND = Object.freeze({
  SPAWN: 1,
  DESPAWN: 2,
});

export const SPAWN_CMD_HEADER_I32 = 4;
export const SPAWN_CMD_STRIDE_I32 = 8;

const HDR_WRITE = 0;
const HDR_READ = 1;
const HDR_CAP = 2;
const HDR_OVERFLOW = 3;

let ringI32 = null;
let ringF32 = null;
let capacity = 0;

export function createSpawnCommandRingSab(entityCapacity) {
  const cap = Math.max(1, entityCapacity | 0);
  const bytes = (SPAWN_CMD_HEADER_I32 + cap * SPAWN_CMD_STRIDE_I32) * 4;
  const sab = new SharedArrayBuffer(bytes);
  const i32 = new Int32Array(sab);
  Atomics.store(i32, HDR_WRITE, 0);
  Atomics.store(i32, HDR_READ, 0);
  Atomics.store(i32, HDR_CAP, cap);
  Atomics.store(i32, HDR_OVERFLOW, 0);
  for (let i = 0; i < cap; i++) {
    i32[SPAWN_CMD_HEADER_I32 + i * SPAWN_CMD_STRIDE_I32] = i;
  }
  return sab;
}

export function bindSpawnCommandRing(sab) {
  if (!sab) {
    ringI32 = null;
    ringF32 = null;
    capacity = 0;
    return;
  }
  ringI32 = new Int32Array(sab);
  ringF32 = new Float32Array(sab);
  capacity = Atomics.load(ringI32, HDR_CAP) | 0;
}

export function isSpawnCommandRingBound() {
  return ringI32 != null && capacity > 0;
}

export function spawnCommandRingCapacity() {
  return capacity;
}

export function spawnCommandRingOverflowCount() {
  return ringI32 ? Atomics.load(ringI32, HDR_OVERFLOW) : 0;
}

function tryPush(kind, typeId, entityIndex, x, y) {
  if (!ringI32) return false;
  const cap = capacity;
  for (;;) {
    const write = Atomics.load(ringI32, HDR_WRITE);
    const read = Atomics.load(ringI32, HDR_READ);
    if (write - read >= cap) {
      Atomics.add(ringI32, HDR_OVERFLOW, 1);
      return false;
    }
    if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
      continue;
    }
    const base = SPAWN_CMD_HEADER_I32 + (write % cap) * SPAWN_CMD_STRIDE_I32;
    while (Atomics.load(ringI32, base) !== write) {
      /* wait prior lap consumer / slower peer publish */
    }
    ringI32[base + 1] = kind | 0;
    ringI32[base + 2] = typeId | 0;
    ringI32[base + 3] = entityIndex | 0;
    ringF32[base + 4] = x;
    ringF32[base + 5] = y;
    Atomics.store(ringI32, base, write + 1);
    return true;
  }
}

export function tryPushSpawn(typeId, entityIndex, x, y) {
  return tryPush(SPAWN_CMD_KIND.SPAWN, typeId, entityIndex, x, y);
}

export function tryPushDespawn(entityIndex) {
  return tryPush(SPAWN_CMD_KIND.DESPAWN, 0, entityIndex, 0, 0);
}

/**
 * Single consumer (logic0). No alloc. Returns drained count.
 * @param {(kind: number, typeId: number, entityIndex: number, x: number, y: number) => void} visitor
 */
export function drainSpawnCommands(visitor) {
  if (!ringI32 || typeof visitor !== 'function') return 0;
  const cap = capacity;
  if (!(cap > 0)) return 0;
  let n = 0;
  for (;;) {
    const read = Atomics.load(ringI32, HDR_READ);
    const base = SPAWN_CMD_HEADER_I32 + (read % cap) * SPAWN_CMD_STRIDE_I32;
    if (Atomics.load(ringI32, base) !== read + 1) break;
    visitor(
      ringI32[base + 1] | 0,
      ringI32[base + 2] | 0,
      ringI32[base + 3] | 0,
      ringF32[base + 4],
      ringF32[base + 5],
    );
    Atomics.store(ringI32, base, read + cap);
    Atomics.store(ringI32, HDR_READ, read + 1);
    n++;
  }
  return n;
}
