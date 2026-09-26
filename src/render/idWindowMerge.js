/**
 * Merge N sorted AoS windows into one dense buffer.
 * `keys[i * cap + head]` is the sort key for that row. Smaller key first.
 */

export function mergeSortedWindows(dst, src, keys, counts, cap, floats, heads) {
  const n = counts.length | 0;
  const fp = floats | 0;
  const span = cap | 0;
  if (!dst || !src || !keys || !heads || n <= 0 || fp <= 0 || span <= 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    let c = counts[i] | 0;
    if (c < 0) c = 0;
    if (c > span) c = span;
    counts[i] = c;
    heads[i] = 0;
    total += c;
  }
  const room = (dst.length / fp) | 0;
  if (total > room) total = room;
  let out = 0;
  while (out < total) {
    let best = -1;
    let bestK = 0;
    for (let i = 0; i < n; i++) {
      const h = heads[i];
      if (h >= counts[i]) continue;
      const k = keys[(i * span + h) | 0];
      if (best < 0 || k < bestK) {
        best = i;
        bestK = k;
      }
    }
    if (best < 0) break;
    const h = heads[best];
    const from = ((best * span + h) * fp) | 0;
    const to = (out * fp) | 0;
    for (let k = 0; k < fp; k++) dst[to + k] = src[from + k];
    heads[best] = h + 1;
    out++;
  }
  return out;
}

/** Copy windows in worker order. No sort. */
export function concatWindows(dst, src, counts, cap, floats) {
  const fp = floats | 0;
  const span = cap | 0;
  if (!dst || !src || nBad(counts) || fp <= 0 || span <= 0) return 0;
  const n = counts.length | 0;
  const room = (dst.length / fp) | 0;
  let out = 0;
  for (let i = 0; i < n && out < room; i++) {
    let c = counts[i] | 0;
    if (c < 0) c = 0;
    if (c > span) c = span;
    if (out + c > room) c = room - out;
    if (c <= 0) continue;
    const from = (i * span * fp) | 0;
    dst.set(src.subarray(from, from + c * fp), out * fp);
    out += c;
  }
  return out;
}

function nBad(counts) {
  return !counts || !(counts.length > 0);
}
