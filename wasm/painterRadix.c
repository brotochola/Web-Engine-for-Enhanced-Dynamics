/* The painter sort (E-76 W10): radixSortIndicesBySortKey, radixPainterOrder (with its radixSortRuns) and
   reinsertChangedSlots of src/util/sortIndexByKey.js, on arrays in the imported shared memory (the
   render-queue memory: src/render/painterRadixClient.js binds simd_inplace there). A painter state is a
   table of u32 byte offsets (P_*), one array per createPainterState field plus the histograms (the JS
   module's radixHist4) and two ordinal buffers for the key-value variants (wasmMemoryMap.js PAINTER_SLOTS);
   the sort keys are float32 bits by slot, passed by offset with each call. Offset 0 is the memory's null
   guard, so an idxE of 0 is the JS `null` (the dense [0, ne) layer queue).

   Every variant writes the order, prevKey, slotMoved, runHeads, runLen and moved arrays the JS writes, and
   returns what it returns: the radix is a stable sort by floatBitsToOrd(key) compared as unsigned, which is
   one order whatever the digits, so the variants differ only in the scratch they leave (scratch, merge,
   the histograms, the ordinals), which no later call reads. Variants, one export of each function:

     scalar    the JS line for line: four 8-bit histograms in one read of keys[idx[i]], a pass skipped when
               one bin holds every key, each pass reading keys[id] again through the index
     kv8       the ordinals read once, in index order, into a buffer the passes carry with the ids (each
               pass reads its source in order instead of keys[id] at random); 8-bit digits, a digit whose
               bits agree for every key skipped (the JS skip: one bin holds every key)
     kv11      kv8 with 11-bit digits: three passes (11, 11, 10 bits), histograms 3 x 2048
     adaptive  kv with only the bits that differ: the read of the ordinals also ANDs and ORs them, the
               digits then cover the lowest to the highest differing bit, ceil(span / 11) passes of equal
               width, and the histograms come from the ordinal buffer, in order
     simd      adaptive with the ordinal read (four keys a vector), its AND/OR and the histograms' digit
               extraction in 128-bit lanes; the scatter stays scalar
     inplace   reinsert only: the scalar radix, then the stable rows compacted to the end of `order`
               without a branch and the JS merge run inside `order` from the front, its choice a select,
               so `merge` is not written and nothing is copied back. On the -1 path `order` holds the
               stable rows at its end, not its start (radixPainterOrder rewrites it next)
     simd_inplace  reinsert only: simd's radix of the moved slots, then inplace's compaction and merge

   Returns: radix_sort_* nothing; painter_order_* 1 when some key is not 0 (the JS `ready`), the caller
   sets n and ready; reinsert_* the changed slot count, 0, or -1 when order is not a permutation. */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))
#define NOINLINE static __attribute__((noinline))

/* u32 slots of a painter state's table (PAINTER_SLOTS in src/util/wasmMemoryMap.js). */
enum {
  P_ORDER,      /* u32 per row: the draw order (state.order) */
  P_SCRATCH,    /* u32 per row: the radix's other id buffer (state.scratch) */
  P_MOVED,      /* u32 per row: the changed slots (state.moved) */
  P_MERGE,      /* u32 per row: the merge's output (state.merge) */
  P_PREV_KEY,   /* u32 per slot: each slot's key when it was last placed (state.prevKey) */
  P_SLOT_MOVED, /* u8 per slot: 1 while the slot is in the moved list (state.slotMoved) */
  P_RUN_HEADS,  /* u32 per row: the runs' first slots (state.runHeads) */
  P_RUN_LEN,    /* u32 per slot: each run's length by its first slot (state.runLen) */
  P_HIST,       /* u32, HIST_WORDS: the histograms (radixHist4) */
  P_ORDS_A,     /* u32 per row: the key-value variants' ordinals */
  P_ORDS_B,     /* u32 per row: their other buffer */
  P_SLOT_COUNT
};

/* The largest histogram set: three 11-bit digits (kv11, and adaptive at a span of 23 bits or more);
   wasmMemoryMap.js PAINTER_HIST_WORDS. */
#define HIST_WORDS 6144u

#define CORE_SCALAR 0
#define CORE_KV8 1
#define CORE_KV11 2
#define CORE_ADAPTIVE 3
#define CORE_SIMD 4

INLINE uint32_t *slot_u32(const uint32_t *t, uint32_t slot) { return (uint32_t *)(uintptr_t)t[slot]; }

/* floatBitsToOrd: ~u for a negative float, u | 2^31 otherwise; unsigned order is the float order. */
INLINE uint32_t ord_of(uint32_t u) { return u ^ ((uint32_t)((int32_t)u >> 31) | 0x80000000u); }

/* Exclusive prefix sums over one digit's bins. */
INLINE void prefix(uint32_t *h, uint32_t bins) {
  uint32_t sum = 0;
  for (uint32_t b = 0; b < bins; b++) {
    const uint32_t c = h[b];
    h[b] = sum;
    sum += c;
  }
}

/* ---- scalar: the JS radix ---- */

INLINE void hist4_gather(const uint32_t *restrict idx, uint32_t n, const uint32_t *restrict keys, uint32_t *restrict h) {
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t ord = ord_of(keys[idx[i]]);
    h[ord & 255u]++;
    h[256u + ((ord >> 8) & 255u)]++;
    h[512u + ((ord >> 16) & 255u)]++;
    h[768u + (ord >> 24)]++;
  }
}

INLINE void scatter_gather(const uint32_t *restrict src, uint32_t *restrict dst, uint32_t n,
                           const uint32_t *restrict keys, uint32_t *restrict hp, uint32_t shift) {
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t id = src[i];
    const uint32_t ord = ord_of(keys[id]);
    dst[hp[(ord >> shift) & 255u]++] = id;
  }
}

NOINLINE void radix_scalar(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys) {
  if ((int32_t)n < 2) return;
  uint32_t *h = slot_u32(t, P_HIST);
  __builtin_memset(h, 0, 1024u * 4u);
  hist4_gather(idx, n, keys, h);
  uint32_t *src = idx;
  uint32_t *dst = slot_u32(t, P_SCRATCH);
  for (uint32_t pass = 0; pass < 4; pass++) {
    uint32_t *hp = h + (pass << 8);
    uint32_t sum = 0;
    uint32_t constant = 0;
    for (uint32_t bin = 0; bin < 256; bin++) {
      const uint32_t c = hp[bin];
      constant |= c == n;
      hp[bin] = sum;
      sum += c;
    }
    if (constant) continue;
    scatter_gather(src, dst, n, keys, hp, pass << 3);
    uint32_t *swap = src;
    src = dst;
    dst = swap;
  }
  if (src != idx) __builtin_memcpy(idx, src, n * 4u);
}

/* ---- key-value: the ordinals travel with the ids ---- */

/* The ordinals in index order into oa and every digit's histogram in the same read; returns the bits
   that differ between the keys. */
INLINE uint32_t gather_hist(const uint32_t *restrict idx, uint32_t n, const uint32_t *restrict keys,
                            uint32_t *restrict oa, uint32_t *restrict h, const uint32_t digit, const uint32_t passes) {
  const uint32_t mask = (1u << digit) - 1u;
  uint32_t all = ~0u;
  uint32_t any = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t o = ord_of(keys[idx[i]]);
    oa[i] = o;
    all &= o;
    any |= o;
    h[o & mask]++;
    if (passes > 1) h[(1u << digit) + ((o >> digit) & mask)]++;
    if (passes > 2) h[(2u << digit) + ((o >> (2u * digit)) & mask)]++;
    if (passes > 3) h[(3u << digit) + ((o >> (3u * digit)) & mask)]++;
  }
  return all ^ any;
}

/* The ordinals in index order into oa; returns the bits that differ between the keys. Kept scalar: clang
   would vectorize it into gather_ords_simd's loop, and the two variants are there to tell them apart. */
INLINE uint32_t gather_ords(const uint32_t *restrict idx, uint32_t n, const uint32_t *restrict keys, uint32_t *restrict oa) {
  uint32_t all = ~0u;
  uint32_t any = 0;
#pragma clang loop vectorize(disable)
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t o = ord_of(keys[idx[i]]);
    oa[i] = o;
    all &= o;
    any |= o;
  }
  return all ^ any;
}

/* The same, four keys a vector. */
INLINE uint32_t gather_ords_simd(const uint32_t *restrict idx, uint32_t n, const uint32_t *restrict keys,
                                 uint32_t *restrict oa) {
  const v128_t top = wasm_u32x4_const_splat(0x80000000u);
  v128_t all4 = wasm_i32x4_const_splat(-1);
  v128_t any4 = wasm_i32x4_const_splat(0);
  uint32_t i = 0;
  for (; i + 4u <= n; i += 4u) {
    v128_t u = wasm_v128_load32_zero(keys + idx[i]);
    u = wasm_v128_load32_lane(keys + idx[i + 1u], u, 1);
    u = wasm_v128_load32_lane(keys + idx[i + 2u], u, 2);
    u = wasm_v128_load32_lane(keys + idx[i + 3u], u, 3);
    const v128_t o = wasm_v128_xor(u, wasm_v128_or(wasm_i32x4_shr(u, 31), top));
    wasm_v128_store(oa + i, o);
    all4 = wasm_v128_and(all4, o);
    any4 = wasm_v128_or(any4, o);
  }
  uint32_t all = wasm_u32x4_extract_lane(all4, 0) & wasm_u32x4_extract_lane(all4, 1) &
                 wasm_u32x4_extract_lane(all4, 2) & wasm_u32x4_extract_lane(all4, 3);
  uint32_t any = wasm_u32x4_extract_lane(any4, 0) | wasm_u32x4_extract_lane(any4, 1) |
                 wasm_u32x4_extract_lane(any4, 2) | wasm_u32x4_extract_lane(any4, 3);
  for (; i < n; i++) {
    const uint32_t o = ord_of(keys[idx[i]]);
    oa[i] = o;
    all &= o;
    any |= o;
  }
  return all ^ any;
}

/* Every digit's histogram from the ordinal buffer, digit p at bit lo + p * digit. */
INLINE void hist_ords(const uint32_t *restrict oa, uint32_t n, uint32_t *restrict h, uint32_t lo, uint32_t digit,
                      const uint32_t passes) {
  const uint32_t mask = (1u << digit) - 1u;
  const uint32_t bins = 1u << digit;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t o = oa[i];
    h[(o >> lo) & mask]++;
    if (passes > 1) h[bins + ((o >> (lo + digit)) & mask)]++;
    if (passes > 2) h[2u * bins + ((o >> (lo + 2u * digit)) & mask)]++;
  }
}

/* The same, the digits of four ordinals a vector. */
INLINE void hist_ords_simd(const uint32_t *restrict oa, uint32_t n, uint32_t *restrict h, uint32_t lo,
                           uint32_t digit, const uint32_t passes) {
  const uint32_t mask = (1u << digit) - 1u;
  const uint32_t bins = 1u << digit;
  const v128_t vmask = wasm_i32x4_splat((int32_t)mask);
  const v128_t base1 = wasm_i32x4_splat((int32_t)bins);
  const v128_t base2 = wasm_i32x4_splat((int32_t)(2u * bins));
  uint32_t i = 0;
  for (; i + 4u <= n; i += 4u) {
    const v128_t o = wasm_v128_load(oa + i);
    const v128_t d0 = wasm_v128_and(wasm_u32x4_shr(o, lo), vmask);
    h[wasm_u32x4_extract_lane(d0, 0)]++;
    h[wasm_u32x4_extract_lane(d0, 1)]++;
    h[wasm_u32x4_extract_lane(d0, 2)]++;
    h[wasm_u32x4_extract_lane(d0, 3)]++;
    if (passes > 1) {
      const v128_t d1 = wasm_i32x4_add(wasm_v128_and(wasm_u32x4_shr(o, lo + digit), vmask), base1);
      h[wasm_u32x4_extract_lane(d1, 0)]++;
      h[wasm_u32x4_extract_lane(d1, 1)]++;
      h[wasm_u32x4_extract_lane(d1, 2)]++;
      h[wasm_u32x4_extract_lane(d1, 3)]++;
    }
    if (passes > 2) {
      const v128_t d2 = wasm_i32x4_add(wasm_v128_and(wasm_u32x4_shr(o, lo + 2u * digit), vmask), base2);
      h[wasm_u32x4_extract_lane(d2, 0)]++;
      h[wasm_u32x4_extract_lane(d2, 1)]++;
      h[wasm_u32x4_extract_lane(d2, 2)]++;
      h[wasm_u32x4_extract_lane(d2, 3)]++;
    }
  }
  for (; i < n; i++) {
    const uint32_t o = oa[i];
    h[(o >> lo) & mask]++;
    if (passes > 1) h[bins + ((o >> (lo + digit)) & mask)]++;
    if (passes > 2) h[2u * bins + ((o >> (lo + 2u * digit)) & mask)]++;
  }
}

INLINE void scatter_kv(const uint32_t *restrict srcId, const uint32_t *restrict srcO, uint32_t *restrict dstId,
                       uint32_t *restrict dstO, uint32_t n, uint32_t *restrict hp, uint32_t shift, uint32_t mask) {
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t o = srcO[i];
    const uint32_t pos = hp[(o >> shift) & mask]++;
    dstId[pos] = srcId[i];
    dstO[pos] = o;
  }
}

/* The last pass: only the ids move. */
INLINE void scatter_ids(const uint32_t *restrict srcId, const uint32_t *restrict srcO, uint32_t *restrict dstId,
                        uint32_t n, uint32_t *restrict hp, uint32_t shift, uint32_t mask) {
  for (uint32_t i = 0; i < n; i++) dstId[hp[(srcO[i] >> shift) & mask]++] = srcId[i];
}

/* The passes over digits at lo + p * digit (p < passes), histograms filled, ordinals in P_ORDS_A in idx's
   order; a digit whose bits agree for every key is skipped. The result lands in idx. */
INLINE void kv_passes(const uint32_t *t, uint32_t *idx, uint32_t n, uint32_t diff, uint32_t lo, uint32_t digit,
                      uint32_t passes) {
  uint32_t *h = slot_u32(t, P_HIST);
  const uint32_t mask = (1u << digit) - 1u;
  uint32_t last = passes;
  for (uint32_t p = 0; p < passes; p++) {
    if ((diff >> (lo + p * digit)) & mask) last = p;
  }
  if (last == passes) return;
  uint32_t *srcId = idx;
  uint32_t *dstId = slot_u32(t, P_SCRATCH);
  uint32_t *srcO = slot_u32(t, P_ORDS_A);
  uint32_t *dstO = slot_u32(t, P_ORDS_B);
  for (uint32_t p = 0; p <= last; p++) {
    const uint32_t shift = lo + p * digit;
    if (!((diff >> shift) & mask)) continue;
    uint32_t *hp = h + (p << digit);
    prefix(hp, 1u << digit);
    if (p == last) {
      scatter_ids(srcId, srcO, dstId, n, hp, shift, mask);
      srcId = dstId;
      break;
    }
    scatter_kv(srcId, srcO, dstId, dstO, n, hp, shift, mask);
    uint32_t *swapId = srcId;
    srcId = dstId;
    dstId = swapId;
    uint32_t *swapO = srcO;
    srcO = dstO;
    dstO = swapO;
  }
  if (srcId != idx) __builtin_memcpy(idx, srcId, n * 4u);
}

INLINE void radix_kv_fixed(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys, const uint32_t digit,
                           const uint32_t passes) {
  if ((int32_t)n < 2) return;
  uint32_t *h = slot_u32(t, P_HIST);
  __builtin_memset(h, 0, (passes << digit) * 4u);
  const uint32_t diff = gather_hist(idx, n, keys, slot_u32(t, P_ORDS_A), h, digit, passes);
  kv_passes(t, idx, n, diff, 0, digit, passes);
}

NOINLINE void radix_kv8(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys) {
  radix_kv_fixed(t, idx, n, keys, 8, 4);
}

NOINLINE void radix_kv11(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys) {
  radix_kv_fixed(t, idx, n, keys, 11, 3);
}

INLINE void radix_span(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys, const int simd) {
  if ((int32_t)n < 2) return;
  uint32_t *oa = slot_u32(t, P_ORDS_A);
  const uint32_t diff = simd ? gather_ords_simd(idx, n, keys, oa) : gather_ords(idx, n, keys, oa);
  /* Every key the same: the stable order is the one given. */
  if (diff == 0) return;
  const uint32_t lo = (uint32_t)__builtin_ctz(diff);
  const uint32_t span = 32u - (uint32_t)__builtin_clz(diff) - lo;
  const uint32_t passes = (span + 10u) / 11u;
  const uint32_t digit = (span + passes - 1u) / passes;
  uint32_t *h = slot_u32(t, P_HIST);
  __builtin_memset(h, 0, (passes << digit) * 4u);
  if (simd) {
    if (passes == 1) hist_ords_simd(oa, n, h, lo, digit, 1);
    else if (passes == 2) hist_ords_simd(oa, n, h, lo, digit, 2);
    else hist_ords_simd(oa, n, h, lo, digit, 3);
  } else {
    if (passes == 1) hist_ords(oa, n, h, lo, digit, 1);
    else if (passes == 2) hist_ords(oa, n, h, lo, digit, 2);
    else hist_ords(oa, n, h, lo, digit, 3);
  }
  kv_passes(t, idx, n, diff, lo, digit, passes);
}

NOINLINE void radix_adaptive(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys) {
  radix_span(t, idx, n, keys, 0);
}

NOINLINE void radix_simd(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys) {
  radix_span(t, idx, n, keys, 1);
}

/* radixSortIndicesBySortKey(idx, n, keys, state.scratch, state.hist) in the chosen variant. */
INLINE void radix_core(const uint32_t *t, uint32_t *idx, uint32_t n, const uint32_t *keys, const int core) {
  if (core == CORE_SCALAR) radix_scalar(t, idx, n, keys);
  else if (core == CORE_KV8) radix_kv8(t, idx, n, keys);
  else if (core == CORE_KV11) radix_kv11(t, idx, n, keys);
  else if (core == CORE_ADAPTIVE) radix_adaptive(t, idx, n, keys);
  else radix_simd(t, idx, n, keys);
}

/* ---- radixPainterOrder ---- */

/* radixSortRuns: 0, with order untouched, when the runs do not halve the rows (checked once the first
   1024 rows are read, and at the end). */
INLINE uint32_t sort_runs(const uint32_t *t, uint32_t *order, uint32_t ne, const uint32_t *keys, const int core) {
  uint32_t *heads = slot_u32(t, P_RUN_HEADS);
  uint32_t *lens = slot_u32(t, P_RUN_LEN);
  uint32_t r = 0;
  uint32_t i = 0;
  uint32_t checked = 0;
  while (i < ne) {
    const uint32_t first = order[i];
    const uint32_t key = keys[first];
    uint32_t j = i + 1u;
    while (j < ne && order[j] == first + (j - i) && keys[order[j]] == key) j++;
    heads[r++] = first;
    lens[first] = j - i;
    i = j;
    if (!checked && i >= 1024u) {
      checked = 1;
      if (r * 2u > i) return 0;
    }
  }
  if (r * 2u > ne) return 0;
  radix_core(t, heads, r, keys, core);
  uint32_t w = 0;
  for (uint32_t k = 0; k < r; k++) {
    const uint32_t first = heads[k];
    const uint32_t end = first + lens[first];
    for (uint32_t slot = first; slot < end; slot++) order[w++] = slot;
  }
  return 1;
}

INLINE uint32_t painter_order(const uint32_t *t, const uint32_t *idxE, uint32_t ne, const uint32_t *keys, const int core) {
  uint32_t *order = slot_u32(t, P_ORDER);
  if (idxE) {
    for (uint32_t i = 0; i < ne; i++) order[i] = idxE[i];
  } else {
    for (uint32_t i = 0; i < ne; i++) order[i] = i;
  }
  if (!sort_runs(t, order, ne, keys, core)) radix_core(t, order, ne, keys, core);
  uint32_t *prev = slot_u32(t, P_PREV_KEY);
  uint32_t live = 0;
  for (uint32_t i = 0; i < ne; i++) {
    const uint32_t slot = order[i];
    const uint32_t key = keys[slot];
    prev[slot] = key;
    live |= key != 0;
  }
  return live;
}

/* ---- reinsertChangedSlots ---- */

/* inplace: the rows whose slot did not move, in their order, to the end of order[0, n), without a branch
   (walking back, each row is written at or after where it was read). Returns where they start. */
INLINE uint32_t compact_back(uint32_t *order, uint32_t n, const uint8_t *slotMoved) {
  uint32_t w = n;
  for (uint32_t i = n; i-- > 0;) {
    const uint32_t slot = order[i];
    order[w - 1u] = slot;
    w -= slotMoved[slot] == 0;
  }
  return w;
}

/* inplace: the JS merge, stable rows from order[a, n) and the sorted moved rows, into order[0, n) from the
   front: the write position (a - start) + b stays behind a while a moved row is left, and once none is the
   stable rows are already where they belong. A tie takes the stable row, as the JS does. */
INLINE void merge_front(uint32_t *restrict order, uint32_t a, uint32_t n, const uint32_t *restrict moved, uint32_t m,
                        const uint32_t *restrict keys) {
  uint32_t b = 0;
  uint32_t o = 0;
  while (a < n && b < m) {
    const uint32_t sa = order[a];
    const uint32_t sb = moved[b];
    const uint32_t takeA = ord_of(keys[sa]) <= ord_of(keys[sb]);
    order[o++] = takeA ? sa : sb;
    a += takeA;
    b += takeA ^ 1u;
  }
  while (b < m) order[o++] = moved[b++];
}

INLINE int32_t reinsert(const uint32_t *t, uint32_t n, const uint32_t *keys, const int core, const int inplace) {
  uint32_t *order = slot_u32(t, P_ORDER);
  uint32_t *prevKey = slot_u32(t, P_PREV_KEY);
  uint8_t *slotMoved = (uint8_t *)(uintptr_t)t[P_SLOT_MOVED];
  uint32_t *moved = slot_u32(t, P_MOVED);
  uint32_t m = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t slot = order[i];
    const uint32_t key = keys[slot];
    if (key != prevKey[slot]) {
      prevKey[slot] = key;
      slotMoved[slot] = 1;
      moved[m++] = slot;
    }
  }
  if (m == 0) return 0;
  radix_core(t, moved, m, keys, core);
  uint32_t w = 0;
  uint32_t start = 0;
  if (inplace) {
    start = compact_back(order, n, slotMoved);
    w = n - start;
  } else {
    for (uint32_t i = 0; i < n; i++) {
      const uint32_t slot = order[i];
      if (slotMoved[slot]) continue;
      order[w++] = slot;
    }
  }
  if (w + m != n) {
    for (uint32_t j = 0; j < m; j++) slotMoved[moved[j]] = 0;
    return -1;
  }
  if (inplace) {
    merge_front(order, start, n, moved, m, keys);
  } else {
    uint32_t *merge = slot_u32(t, P_MERGE);
    uint32_t a = 0;
    uint32_t b = 0;
    uint32_t o = 0;
    while (a < w && b < m) {
      const uint32_t ka = ord_of(keys[order[a]]);
      const uint32_t kb = ord_of(keys[moved[b]]);
      if (ka <= kb) merge[o++] = order[a++];
      else merge[o++] = moved[b++];
    }
    while (a < w) merge[o++] = order[a++];
    while (b < m) merge[o++] = moved[b++];
    __builtin_memcpy(order, merge, n * 4u);
  }
  for (uint32_t j = 0; j < m; j++) slotMoved[moved[j]] = 0;
  return (int32_t)m;
}

/* ---- exports: table, then offsets and counts ---- */

#define T(p) ((const uint32_t *)(uintptr_t)(p))
#define U(p) ((uint32_t *)(uintptr_t)(p))

#define PAINTER_EXPORTS(name, core)                                                                  \
  __attribute__((export_name("radix_sort_" #name)))                                                  \
  void radix_sort_##name(uint32_t table, uint32_t idx, uint32_t n, uint32_t keys) {                  \
    radix_core(T(table), U(idx), n, T(keys), core);                                                  \
  }                                                                                                  \
  __attribute__((export_name("painter_order_" #name)))                                               \
  uint32_t painter_order_##name(uint32_t table, uint32_t idxE, uint32_t ne, uint32_t keys) {         \
    return painter_order(T(table), T(idxE), ne, T(keys), core);                                      \
  }                                                                                                  \
  __attribute__((export_name("reinsert_" #name)))                                                    \
  int32_t reinsert_##name(uint32_t table, uint32_t n, uint32_t keys) {                               \
    return reinsert(T(table), n, T(keys), core, 0);                                                  \
  }

PAINTER_EXPORTS(scalar, CORE_SCALAR)
PAINTER_EXPORTS(kv8, CORE_KV8)
PAINTER_EXPORTS(kv11, CORE_KV11)
PAINTER_EXPORTS(adaptive, CORE_ADAPTIVE)
PAINTER_EXPORTS(simd, CORE_SIMD)

__attribute__((export_name("reinsert_inplace")))
int32_t reinsert_inplace(uint32_t table, uint32_t n, uint32_t keys) {
  return reinsert(T(table), n, T(keys), CORE_SCALAR, 1);
}

__attribute__((export_name("reinsert_simd_inplace")))
int32_t reinsert_simd_inplace(uint32_t table, uint32_t n, uint32_t keys) {
  return reinsert(T(table), n, T(keys), CORE_SIMD, 1);
}
