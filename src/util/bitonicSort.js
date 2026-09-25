import { floatBitsToOrd } from './sortIndexByKey.js';

export function nextPow2(n) {
  let v = n | 0;
  if (v <= 1) return 1;
  v--;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}

/** Bitonic stages for a padded length: log2(N) * (log2(N) + 1) / 2. */
export function bitonicStageCount(n) {
  const N = nextPow2(n | 0);
  if (N < 2) return 0;
  let log = 0;
  for (let v = N; v > 1; v >>= 1) log++;
  return (log * (log + 1)) >> 1;
}

const SENTINEL = 0xffffffff;

function keyOrd(keysU32, id, alreadyOrd) {
  if (id === SENTINEL) return SENTINEL;
  const raw = keysU32[id];
  return alreadyOrd ? raw >>> 0 : floatBitsToOrd(raw);
}

/**
 * Bitonic sort of idx[0..n) by keysU32[idx[i]] ascending.
 * Raw IEEE bits unless `alreadyOrd` (pre-render spriteKeys / GPU path).
 * idx length must be >= nextPow2(n). Slots n..N-1 are scratch.
 */
export function bitonicSortIndices(idx, n, keysU32, alreadyOrd) {
  const count = n | 0;
  if (count < 2) return;
  const N = nextPow2(count);
  const ord = !!alreadyOrd;
  for (let i = count; i < N; i++) idx[i] = SENTINEL;
  for (let k = 2; k <= N; k <<= 1) {
    for (let j = k >> 1; j > 0; j >>= 1) {
      for (let i = 0; i < N; i++) {
        const ixj = i ^ j;
        if (ixj <= i) continue;
        const idA = idx[i];
        const idB = idx[ixj];
        const keyA = keyOrd(keysU32, idA, ord);
        const keyB = keyOrd(keysU32, idB, ord);
        const ascending = (i & k) === 0;
        const swap = ascending ? keyA > keyB : keyA < keyB;
        if (swap) {
          idx[i] = idB;
          idx[ixj] = idA;
        }
      }
    }
  }
}

/** Copy instance floats: dst[k] = src[order[k]] for k in 0..n. */
export function permuteInstances(src, dst, order, n, floatsPer) {
  const fp = floatsPer | 0;
  const count = n | 0;
  for (let k = 0; k < count; k++) {
    const from = (order[k] | 0) * fp;
    const to = k * fp;
    for (let f = 0; f < fp; f++) dst[to + f] = src[from + f];
  }
}
