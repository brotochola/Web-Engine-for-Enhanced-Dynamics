/** IEEE-754 bits → uint32 that orders like the float (negatives included). */
export function floatBitsToOrd(bits) {
  const u = bits >>> 0;
  return ((u & 0x80000000) ? ~u : (u | 0x80000000)) >>> 0;
}

/**
 * LSD radix, four 8-bit passes. Sorts idx[0..n) by keysU32[idx[i]] ascending.
 * scratch length >= n, hist length >= 256. No allocation. Result lands in idx.
 * @param {Uint32Array} idx
 * @param {number} n
 * @param {Uint32Array} keysU32
 * @param {Uint32Array} scratch
 * @param {Uint32Array} hist
 */
export function radixSortIndicesBySortKey(idx, n, keysU32, scratch, hist) {
  if ((n | 0) < 2) return;
  let src = idx;
  let dst = scratch;
  for (let shift = 0; shift < 32; shift += 8) {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const ord = floatBitsToOrd(keysU32[src[i]]);
      hist[(ord >>> shift) & 255]++;
    }
    let sum = 0;
    for (let bin = 0; bin < 256; bin++) {
      const c = hist[bin];
      hist[bin] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const id = src[i];
      const ord = floatBitsToOrd(keysU32[id]);
      dst[hist[(ord >>> shift) & 255]++] = id;
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
}

/**
 * Drop slots whose sort key changed and merge them back. Stable slots keep their order.
 * Returns how many slots changed, or -1 if `order` is not a permutation (caller radixes).
 * prevKey is keyed by queue slot. movedList and merge length >= n. slotMoved length >= n.
 * @param {Uint32Array} order
 * @param {number} n
 * @param {Uint32Array} keysU32
 * @param {Uint32Array} prevKey
 * @param {Uint8Array} slotMoved
 * @param {Uint32Array} movedList
 * @param {Uint32Array} merge
 * @param {Uint32Array} scratch
 * @param {Uint32Array} hist
 */
export function reinsertChangedSlots(order, n, keysU32, prevKey, slotMoved, movedList, merge, scratch, hist) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const slot = order[i];
    const key = keysU32[slot];
    if (key !== prevKey[slot]) {
      prevKey[slot] = key;
      slotMoved[slot] = 1;
      movedList[m++] = slot;
    }
  }
  if (m === 0) return 0;
  radixSortIndicesBySortKey(movedList, m, keysU32, scratch, hist);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const slot = order[i];
    if (slotMoved[slot]) continue;
    order[w++] = slot;
  }
  if (w + m !== n) {
    for (let j = 0; j < m; j++) slotMoved[movedList[j]] = 0;
    return -1;
  }
  let a = 0;
  let b = 0;
  let o = 0;
  while (a < w && b < m) {
    const ka = floatBitsToOrd(keysU32[order[a]]);
    const kb = floatBitsToOrd(keysU32[movedList[b]]);
    if (ka <= kb) merge[o++] = order[a++];
    else merge[o++] = movedList[b++];
  }
  while (a < w) merge[o++] = order[a++];
  while (b < m) merge[o++] = movedList[b++];
  for (let i = 0; i < n; i++) order[i] = merge[i];
  for (let j = 0; j < m; j++) slotMoved[movedList[j]] = 0;
  return m;
}
