/**
 * Entity message inbox: a multi-producer, single-consumer ring on a
 * SharedArrayBuffer, one per logic worker. Same sequence-slot scheme as the
 * Box2D command ring: a producer claims a slot with a CAS on WRITE, fills it
 * and publishes seq = claim + 1; the owning logic worker reads in order and
 * frees the slot with seq = read + capacity.
 *
 * Slot (12 × Int32 = 48 bytes, so the doubles stay 8-byte aligned):
 *   [0] seq   [1] target   [2] from   [3] nameId << 16 | target spawn generation
 *   [4..11]   a, b, c, d as Float64
 * No allocation on push or drain.
 */

export const MESSAGE_HDR_WRITE = 0;
export const MESSAGE_HDR_READ = 1;
export const MESSAGE_HDR_CAP = 2;
export const MESSAGE_HDR_OVERFLOW = 3;
const HEADER_I32 = 4;
const STRIDE_I32 = 12;

/** @param {number} capacity - messages the inbox holds between two drains */
export function messageInboxBytes(capacity) {
  return (HEADER_I32 + (capacity | 0) * STRIDE_I32) * 4;
}

/** @param {number} capacity */
export function createMessageInbox(capacity) {
  const cap = Math.max(16, capacity | 0);
  const sab = new SharedArrayBuffer(messageInboxBytes(cap));
  const i32 = new Int32Array(sab);
  i32[MESSAGE_HDR_CAP] = cap;
  for (let s = 0; s < cap; s++) i32[HEADER_I32 + s * STRIDE_I32] = s;
  return sab;
}

/**
 * @returns {boolean} false when the inbox is full (the overflow counter is bumped)
 */
export function pushMessage(i32, f64, target, from, nameId, gen, a, b, c, d) {
  const cap = i32[MESSAGE_HDR_CAP];
  for (;;) {
    const write = Atomics.load(i32, MESSAGE_HDR_WRITE);
    const read = Atomics.load(i32, MESSAGE_HDR_READ);
    if (write - read >= cap) return false;
    if (Atomics.compareExchange(i32, MESSAGE_HDR_WRITE, write, write + 1) !== write) continue;
    const base = HEADER_I32 + (write % cap) * STRIDE_I32;
    // Slot free once the consumer of the previous lap stored read + cap.
    while (Atomics.load(i32, base) !== write) {
      /* a slower peer or the previous lap's consumer */
    }
    i32[base + 1] = target;
    i32[base + 2] = from;
    i32[base + 3] = (nameId << 16) | (gen & 0xffff);
    const fb = (base + 4) >> 1;
    f64[fb] = a;
    f64[fb + 1] = b;
    f64[fb + 2] = c;
    f64[fb + 3] = d;
    Atomics.store(i32, base, write + 1);
    return true;
  }
}

/**
 * Deliver what was in the inbox when the drain began (a message sent while
 * delivering waits for the next drain, so two entities cannot ping-pong
 * forever inside one frame).
 * @param {(target: number, from: number, nameId: number, gen: number, a: number, b: number, c: number, d: number) => void} deliver
 * @returns {number} messages delivered
 */
export function drainMessages(i32, f64, deliver) {
  const cap = i32[MESSAGE_HDR_CAP];
  const end = Atomics.load(i32, MESSAGE_HDR_WRITE);
  let n = 0;
  for (;;) {
    const read = Atomics.load(i32, MESSAGE_HDR_READ);
    if (read === end) break;
    const base = HEADER_I32 + (read % cap) * STRIDE_I32;
    if (Atomics.load(i32, base) !== read + 1) break; // claimed, not yet published
    const target = i32[base + 1];
    const from = i32[base + 2];
    const packed = i32[base + 3];
    const fb = (base + 4) >> 1;
    const a = f64[fb];
    const b = f64[fb + 1];
    const c = f64[fb + 2];
    const d = f64[fb + 3];
    Atomics.store(i32, base, read + cap);
    Atomics.store(i32, MESSAGE_HDR_READ, read + 1);
    deliver(target, from, packed >>> 16, packed & 0xffff, a, b, c, d);
    n++;
  }
  return n;
}
