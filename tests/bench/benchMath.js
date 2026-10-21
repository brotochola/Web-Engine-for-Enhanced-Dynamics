/**
 * Pure helpers for benches and stress scenes. No Node imports, so the browser
 * stress scenes load it as well as the Node scripts. One copy each (review R12).
 */

/** Seeded PRNG (mulberry32): a function returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The middle value; for an even count, the mean of the two middle values. NaN when empty. */
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The middle value; for an even count, the upper of the two middle values.
 * Same as median for an odd count. The timing loops that used this keep it so
 * their numbers do not move. undefined when empty.
 */
export function upperMedian(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}
