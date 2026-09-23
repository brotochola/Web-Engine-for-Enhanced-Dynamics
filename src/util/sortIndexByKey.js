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

/**
 * Painter-sort scratch for one Y-sorted sprite queue (the main ENTITIES queue,
 * or one custom layer). Every array is sized once, reused every frame — no
 * per-frame allocation. `ready`/`n`/`gen`/`frame` are bookkeeping written by
 * `orderPainterSlots` and friends; callers do not touch them directly.
 * @param {number} maxItems
 */
export function createPainterState(maxItems) {
  const n = Math.max(1, maxItems | 0);
  return {
    order: new Uint32Array(n),
    scratch: new Uint32Array(n),
    moved: new Uint32Array(n),
    merge: new Uint32Array(n),
    prevKey: new Uint32Array(n),
    stamp: new Int32Array(n),
    slotMoved: new Uint8Array(n),
    hist: new Uint32Array(256),
    ready: false,
    n: 0,
    gen: 0,
    frame: 0,
  };
}

/**
 * Is `state.order` (last frame's permutation) still a valid slot set for this
 * frame? `idxE === null` means the dense range [0, ne) with no type filter
 * (a custom layer's queue is never split by type): same `ne` implies the same
 * integer set, no scan needed. A real `idxE` (the main queue's type-filtered
 * slot list, glow excluded) needs the O(n) stamp check since it is a proper
 * subset of [0, count) whose membership can shift frame to frame.
 * @param {ReturnType<typeof createPainterState>} state
 * @param {Uint32Array|null} idxE
 * @param {number} ne
 */
export function painterSameSet(state, idxE, ne) {
  if (!state.ready || state.n !== ne) return false;
  if (!idxE) return true;
  let gen = (state.gen + 1) | 0;
  if (gen === 0) {
    state.stamp.fill(0);
    gen = 1;
  }
  state.gen = gen;
  const stamp = state.stamp;
  for (let i = 0; i < ne; i++) stamp[idxE[i]] = gen;
  const order = state.order;
  for (let i = 0; i < ne; i++) {
    if (stamp[order[i]] !== gen) return false;
  }
  return true;
}

/**
 * Full radix rebuild into `state.order`. `idxE === null` fills the dense
 * range [0, ne) first (custom layer); a real array copies that filtered list
 * (main queue).
 * @param {ReturnType<typeof createPainterState>} state
 * @param {Uint32Array|null} idxE
 * @param {number} ne
 * @param {Uint32Array} keysU32
 */
export function radixPainterOrder(state, idxE, ne, keysU32) {
  const order = state.order;
  if (idxE) {
    for (let i = 0; i < ne; i++) order[i] = idxE[i];
  } else {
    for (let i = 0; i < ne; i++) order[i] = i;
  }
  radixSortIndicesBySortKey(order, ne, keysU32, state.scratch, state.hist);
  const prev = state.prevKey;
  let live = false;
  for (let i = 0; i < ne; i++) {
    const slot = order[i];
    const key = keysU32[slot];
    prev[slot] = key;
    if (key !== 0) live = true;
  }
  state.n = ne;
  // All-zero keys are an empty queue buffer. A stable radix would freeze spawn
  // order, and reinsert would never move static sprites. Stay cold until a real Y lands.
  state.ready = live;
  return order;
}

/**
 * Cheapest correct draw order for this frame: reinsert only the slots whose
 * key changed when the slot set is unchanged, full radix otherwise. Shared by
 * the main ENTITIES queue and every Y-sorted custom layer — one algorithm,
 * one scratch shape, no per-call-site copy.
 * @param {ReturnType<typeof createPainterState>} state
 * @param {Uint32Array|null} idxE - type-filtered slot list, or null for a dense [0, ne) layer queue
 * @param {number} ne
 * @param {Uint32Array} keysU32
 * @returns {Uint32Array|null} the draw order (state.order), or idxE/null unchanged when ne < 2
 */
export function orderPainterSlots(state, idxE, ne, keysU32) {
  if (ne <= 0) return idxE;
  if (ne < 2) {
    if (idxE) return idxE;
    state.order[0] = 0;
    return state.order;
  }
  state.frame = (state.frame + 1) | 0;
  if (!painterSameSet(state, idxE, ne)) {
    return radixPainterOrder(state, idxE, ne, keysU32);
  }
  const changed = reinsertChangedSlots(
    state.order,
    ne,
    keysU32,
    state.prevKey,
    state.slotMoved,
    state.moved,
    state.merge,
    state.scratch,
    state.hist,
  );
  if (changed < 0) return radixPainterOrder(state, idxE, ne, keysU32);
  return state.order;
}
