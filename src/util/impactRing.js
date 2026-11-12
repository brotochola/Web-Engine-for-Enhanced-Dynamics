// impactRing.js — bullet impacts from the particle worker to the logic workers (N-129).
//
// The particle worker ticks the bullets on its loop and each logic worker runs onGotShot on its own. They used to share
// one batch: the tick wrote the frame's impacts over the last ones and moved a sequence number, and a logic worker took
// the batch whose number it had not seen. A logic worker that missed a particle frame lost that frame's impacts, and one
// reading while the next batch was written could read a mix of the two.
//
// Now a ring of impact records, IMPACT_FLOATS floats each (entity, damage, x, y, owner, shooter type), after a header
// whose word 0 counts the impacts ever published (an int32 that wraps). The particle worker (its one writer) writes a
// frame's impacts after the last ones and then publishes the count; each logic worker reads from where it stopped up to
// the published count. The ring holds RING_FRAMES frames of the most impacts a frame keeps, so a logic worker up to that
// many particle frames behind loses nothing; one further behind loses the oldest, and says so.

export const IMPACT_FLOATS = 6;
const HEADER_BYTES = 64;
const RING_FRAMES = 8;
const MIN_SLOTS = 256;

/** The ring's records for up to `maxImpactsPerFrame` impacts a frame: RING_FRAMES frames, a power of two. */
export function impactRingSlots(maxImpactsPerFrame) {
  const want = Math.max(1, maxImpactsPerFrame | 0) * RING_FRAMES;
  let slots = MIN_SLOTS;
  while (slots < want) slots *= 2;
  return slots;
}

/** Bytes of an impact ring for up to `maxImpactsPerFrame` impacts a frame. */
export function impactRingBytes(maxImpactsPerFrame) {
  return HEADER_BYTES + impactRingSlots(maxImpactsPerFrame) * IMPACT_FLOATS * 4;
}

/** Views of an impact ring: `header` (word 0, the impacts published), its records `data`, `slots` and `mask`. */
export function bindImpactRing(buffer, maxImpactsPerFrame) {
  const slots = impactRingSlots(maxImpactsPerFrame);
  return {
    header: new Int32Array(buffer, 0, 2),
    data: new Float32Array(buffer, HEADER_BYTES, slots * IMPACT_FLOATS),
    slots,
    mask: slots - 1,
  };
}

/**
 * The writer: `n` impacts of `src` (IMPACT_FLOATS floats each, from index 0) after the ring's last, then published.
 * More than the ring holds keeps the last of them.
 */
export function publishImpacts(ring, src, n) {
  if (!(n > 0)) return;
  const d = ring.data;
  const mask = ring.mask;
  const at = Atomics.load(ring.header, 0);
  for (let j = 0; j < n; j++) {
    const o = ((at + j) & mask) * IMPACT_FLOATS;
    const s = j * IMPACT_FLOATS;
    d[o] = src[s];
    d[o + 1] = src[s + 1];
    d[o + 2] = src[s + 2];
    d[o + 3] = src[s + 3];
    d[o + 4] = src[s + 4];
    d[o + 5] = src[s + 5];
  }
  Atomics.store(ring.header, 0, (at + n) | 0);
}
