/**
 * Y-sort key for a sprite or Adobe root. Rounded to a whole pixel so a
 * sub-pixel pose tremor does not change bits. `ySortK` is the gap that
 * leaves room for a decoration's integer innerZ inside the pixel.
 * Same-pixel ties stay ties. A fractional entity id was measured and
 * made PainterMove's pixi step about twice as expensive, so it is not here.
 * @param {number} y
 * @param {number} ySortK
 */
export function spriteYSortKey(y, ySortK) {
  return Math.round(y) * ySortK;
}

/**
 * Y-sort line for a sprite: the world Y of its bottom edge, not its pose.
 * Identity rotation: y + (1 - anchorY) * height * scaleY, or, flipped
 * (scaleY < 0), y + anchorY * height * |scaleY|: the shader places local y at
 * (v - anchorY) * height * scaleY, so a flip puts the frame's top edge
 * lowest. With rotation it
 * is the same local offset the sprite vertex shader uses — which means it has
 * to use the SAME rotation the sprite is drawn with. `inheritRotation[index]`
 * is that choice: truthy takes the body pose's rotation, falsy takes the
 * sprite's own facing (`spriteRotC`/`spriteRotS`). `emitSpriteQueue` and the
 * pixi self-lit path both branch on that flag; a sort line that ignores it
 * puts a turning sprite on the wrong side of its neighbours (a car whose
 * facing lives in the frame, on a body that steers, is the live case).
 *
 * `w`/`h` are the frame size in px, 0 when the texture is unresolved — then
 * the offset is 0 and the sort line collapses to the pose, which is the old
 * behaviour for a missing frame, not a special case.
 *
 * @param {object} s component arrays: anchorX, anchorY, scaleX, scaleY,
 *   inheritRotation, spriteRotC, spriteRotS. Any missing array falls back to poseY.
 * @param {number} index entity slot
 * @param {number} poseY world Y of the pose
 * @param {number} rotC pose rotation cos
 * @param {number} rotS pose rotation sin
 * @param {number} w frame width px, 0 if unknown
 * @param {number} h frame height px, 0 if unknown
 * @returns {number} world Y of the sprite's bottom edge
 */
export function spriteSortFootY(s, index, poseY, rotC, rotS, w, h) {
  if (!s || !s.anchorX || !s.anchorY || !s.scaleX || !s.scaleY) return poseY;
  const ax = s.anchorX[index];
  const ay = s.anchorY[index];
  // Feet-anchored sprites sort on the pose itself. Callers may short-circuit
  // this before resolving the frame; the check lives here so the helper is
  // correct standalone.
  if (ax === 0.5 && ay === 1.0) return poseY;
  const sy = s.scaleY[index];
  const ox = (0.5 - ax) * w * s.scaleX[index];
  // The lower edge on screen: the frame's top edge when vertically flipped.
  const oy = sy < 0 ? -ay * h * sy : (1 - ay) * h * sy;
  const inherit = s.inheritRotation;
  if (inherit && !inherit[index]) {
    rotC = s.spriteRotC[index];
    rotS = s.spriteRotS[index];
  }
  return poseY + ox * rotS + oy * rotC;
}

/** Width of one zIndex band. Larger than any Y key inside the world. */
export function zSortBand(worldHeight) {
  const h = worldHeight > 0 ? worldHeight : 1;
  return h * 128 + 128;
}

/**
 * Coarse key is zIndex. With ySort, Y (already round(y)*128 + innerZ) sits inside the band.
 * Without ySort the key is the integer. Larger is in front.
 * ponytail: zIndex is int16. A Y past ±worldHeight overlaps the next band.
 */
export function orderSortKey(yKey, zIndex, ySort, band) {
  const z = zIndex | 0;
  if (!ySort) return z;
  return z * band + yKey;
}

/**
 * IEEE-754 bits → uint32 that orders like the float (negatives included).
 * The trailing `>>> 0` is load-bearing: the transform flips bit 31, so every
 * POSITIVE float comes out as a value ≥ 2^31 and every NEGATIVE float as one
 * < 2^31. Compare the result as unsigned (`>>> 0` again, or as a Uint32Array
 * element). Comparing it as a signed int32 puts all positive keys ahead of all
 * negative ones, which is backwards.
 */
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
const radixHist4 = new Uint32Array(1024);

export function radixSortIndicesBySortKey(idx, n, keysU32, scratch, hist) {
  if ((n | 0) < 2) return;
  // All four byte histograms in one read of the keys. A pass whose byte is the
  // same for every key keeps the order (LSD radix is stable), so it is skipped:
  // round(y) * 128 keys have a constant low byte. `hist` is kept for callers.
  void hist;
  const h = radixHist4;
  h.fill(0);
  // `ord` is the floatBitsToOrd transform, inlined. It is only ever consumed
  // through `&` / `>>>`, which coerce to unsigned — that is what makes this
  // loop agree with the reinsert merge. Do not compare `ord` directly.
  for (let i = 0; i < n; i++) {
    const u = keysU32[idx[i]] >>> 0;
    const ord = (u & 0x80000000) ? ~u : (u | 0x80000000);
    h[ord & 255]++;
    h[256 + ((ord >>> 8) & 255)]++;
    h[512 + ((ord >>> 16) & 255)]++;
    h[768 + (ord >>> 24)]++;
  }
  let src = idx;
  let dst = scratch;
  for (let pass = 0; pass < 4; pass++) {
    const off = pass << 8;
    const shift = pass << 3;
    let sum = 0;
    let constant = false;
    for (let bin = 0; bin < 256; bin++) {
      const c = h[off + bin];
      if (c === n) constant = true;
      h[off + bin] = sum;
      sum += c;
    }
    if (constant) continue;
    for (let i = 0; i < n; i++) {
      const id = src[i];
      const u = keysU32[id] >>> 0;
      const ord = (u & 0x80000000) ? ~u : (u | 0x80000000);
      dst[h[off + ((ord >>> shift) & 255)]++] = id;
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  if (src !== idx) idx.set(src.subarray(0, n));
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
    // Unsigned ordinals. Sorting these as signed int32 puts every positive key
    // ahead of every negative one, which swaps the two halves of the draw order
    // the moment any entity sits above the world origin (negative world Y).
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
 * `kernel` and `table` are the WASM sort's (W10, render/painterRadixClient.js): a state made there has
 * these fields in this order, its arrays on the render-queue memory, and its kernel here; this one has none.
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
    // E-103: the runs' first slots, and each run's length by its first slot.
    runHeads: new Uint32Array(n),
    runLen: new Uint32Array(n),
    hist: new Uint32Array(256),
    ready: false,
    n: 0,
    gen: 0,
    frame: 0,
    kernel: null,
    table: 0,
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
 * E-103. Sort `order` by key as runs: a run is consecutive slots under one key (an Adobe Animate
 * character's pieces). A stable sort of every row keeps a run together, at its first row's place among
 * equal keys, so sorting the runs' first slots with the same stable radix and expanding each run in
 * place gives the same order. Returns false, with `order` untouched, when the runs do not halve the
 * rows (checked after the first 1024 rows and at the end): the caller sorts the rows.
 * @param {Uint32Array} order
 * @param {number} ne
 * @param {Uint32Array} keysU32
 * @param {ReturnType<typeof createPainterState>} state
 * @returns {boolean}
 */
function radixSortRuns(order, ne, keysU32, state) {
  const heads = state.runHeads;
  const lens = state.runLen;
  let r = 0;
  let i = 0;
  let checked = false;
  while (i < ne) {
    const first = order[i];
    const key = keysU32[first];
    let j = i + 1;
    while (j < ne && order[j] === first + (j - i) && keysU32[order[j]] === key) j++;
    heads[r++] = first;
    lens[first] = j - i;
    i = j;
    if (!checked && i >= 1024) {
      checked = true;
      if (r * 2 > i) return false;
    }
  }
  if (r * 2 > ne) return false;
  radixSortIndicesBySortKey(heads, r, keysU32, state.scratch, state.hist);
  let w = 0;
  for (let k = 0; k < r; k++) {
    const first = heads[k];
    const end = first + lens[first];
    for (let slot = first; slot < end; slot++) order[w++] = slot;
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
  if (!radixSortRuns(order, ne, keysU32, state)) {
    radixSortIndicesBySortKey(order, ne, keysU32, state.scratch, state.hist);
  }
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
