/* The shadow-caster stamp (E-76 W23, E-114): stampLightRange (src/render/gpuShadowCasters.js) in C, the whole call: the stamp
   grid over the sun caster rows, each light's gather (grid walk or full scan), the index sort that only
   runs without a per-entity cap, takeClosest's quickselect + quicksort, the per-caster nearest lights
   with maxShadowsPerEntity, and the append of caster rows with the light vec4. Every array is a byte
   offset into the render-queue memory (src/render/shadowStampClient.js writes the table: the sun rows and the
   stamp output are GPU-queue regions, the scratch and the lights the stamp regions); the lights are a table of eleven
   doubles each (x, y, intensity, rangeSq, maxShadows, then DX-SPOT's cone: the direction on the floor as x and as y over
   groundScaleY, the cosine of the half aperture (-2: no cone), 1 / the soft edge's width, 1 / groundScaleY²; then the
   shade, min(brightness, 1)), NaN rangeSq for an empty slot. A cone light keeps only the casters inside its cone
   (before maxShadowsPerLight); a caster on its soft edge, or any caster of a light dimmer than 1, takes the intensity
   that gives f × the shadow's alpha (f the edge's smoothstep times the shade): a full light runs the loops it always
   ran. Arithmetic as the
   JS does it: positions and distances in double, stored as float where the JS stores into a
   Float32Array, Math.floor(..) | 0 through an exact ToInt32. Returns the stamp cursor.
   E-160: the grid also packs the casters' x and y in its own order (two float arrays), so a light's walk reads them
   there and not out of each candidate's 88-byte row; the build reads each row once. The walk keeps each candidate's
   double distance, which the per-caster nearest lights take instead of reading the row again; a caster row is copied
   in v128s. The stamp is the same, bit for bit (tests/bench/shadowStampReplay.mjs replays Predator's own frames).
   E-315: a light that keeps at most KNN_MAX_LIM casters walks its cells nearest first and skips the cells too far to
   hold one of its kept (ring_select), and a larger budget picks its kept with a radix select on the float distances'
   bits (radix_select) instead of the quickselect; a tie at the cut (or among sorted rows) goes the old way, so the
   rows stay the same, bit for bit (tests/node/shadowStampSelect.test.js).
   E-359: a keyed row (the caster's 7 floats, the light after them) and a full row (22 floats, the light over the last 4)
   go out in fixed stores, the light vec4 in one v128, converted once a light. E-358: a caster's nearest lights are one
   record, its maxShadowsPerEntity (float distance, light) pairs side by side (8 bytes a pair at T_NEAR_DIST), so a note
   on a caster reads and moves whole pairs, mostly in one line; the rows of the nearest lights test the counts sixteen
   at a time and skip the unlit casters. The same rows, bit for bit (tests/node/shadowStampWasm.test.js and
   shadowStampKeyed.test.js). */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))
#define STAMP_CELL 256.0
#define STAMP_GRID_MAX_CELLS (128u * 128u)

enum {
  T_SUN, T_SUN_N, T_SUN_FLOATS, T_LIGHTS, T_LIGHT_BEGIN, T_LIGHT_END, T_LIGHT_STRIDE, T_MAX_PL, T_MAX_PE,
  T_TMP_IDX, T_DIST, T_ORDER, T_KEEP, T_TMP_CAP,
  T_GRID_COUNTS, T_GRID_STARTS, T_GRID_ITEMS, T_GRID_COUNTS_CAP, T_GRID_ITEMS_CAP,
  T_STAMP, T_STAMP_FLOATS, T_STAMP_CAP, T_STAMP_BASE, T_STAMP_LIGHT_IDX, T_LIGHT_FLOAT,
  /* E-358: T_NEAR_DIST holds the casters' records (maxShadowsPerEntity pairs each, 8 bytes a pair); the stamp does
     not read T_NEAR_SLOT (the float32 test module, wasm/test/shadowStampF32.c, keeps its own light slots there). */
  T_NEAR_DIST, T_NEAR_SLOT, T_NEAR_COUNT,
  T_PACKED_X, T_PACKED_Y, T_CELL_OF, T_DIST64,
  SLOT_COUNT
};

#define LIGHT_DOUBLES 11

/* ECMAScript ToInt32 (V8's DoubleToInt32): in range a truncation, else the low 32 bits. */
INLINE int32_t js_to_int32(double x) {
  if (x >= -2147483648.0 && x <= 2147483647.0) return (int32_t)x;
  union { double d; uint64_t u; } b = { .d = x };
  const int biased = (int)((b.u >> 52) & 0x7ff);
  if (biased == 0x7ff) return 0;
  const int exponent = biased - 1075;
  const uint64_t sig = (b.u & 0xfffffffffffffull) | 0x10000000000000ull;
  uint64_t bits;
  if (exponent < 0) {
    if (exponent <= -53) return 0;
    bits = sig >> -exponent;
  } else {
    if (exponent > 31) return 0;
    bits = sig << exponent;
  }
  const uint64_t v = (b.u >> 63) ? (uint64_t)(-(int64_t)bits) : bits;
  return (int32_t)(uint32_t)v;
}

INLINE int32_t floor_int32(double x) { return js_to_int32(__builtin_floor(x)); }

/* exact (build_grid_packed only): every caster lies in its cell's square, so a cell's distance bounds its casters'
   (E-315's ring walk): no NaN caster (binned in cell 0), and the casters' box within KNN_COORD_MAX of the origin, so no
   width wraps and a cell's edges in double are off by far less than KNN_EPS. */
typedef struct { double minX, minY; int32_t gw, gh, exact; } Grid;
#define KNN_COORD_MAX 16777216.0

/* buildStampGrid. 0: no grid (the full scan runs). Inlined, so g stays in locals (no stack). The stamp below builds
   build_grid_packed; this one is the float32 test module's (wasm/test/shadowStampF32.c). */
__attribute__((unused)) INLINE int build_grid(const float *sun, uint32_t nSun, uint32_t sf, int32_t *counts, int32_t *starts,
                      uint32_t *items, uint32_t countsCap, uint32_t itemsCap, Grid *g) {
  double minX = __builtin_inf();
  double minY = __builtin_inf();
  double maxX = -__builtin_inf();
  double maxY = -__builtin_inf();
  for (uint32_t c = 0; c < nSun; c++) {
    const double x = sun[c * sf];
    const double y = sun[c * sf + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!(minX - minX == 0.0)) return 0; /* !Number.isFinite(minX) */
  /* (x | 0) + 1 is a JS number: 2^31 is a width the checks below refuse, as here. */
  const int64_t gw64 = (int64_t)floor_int32((maxX - minX) / STAMP_CELL) + 1;
  const int64_t gh64 = (int64_t)floor_int32((maxY - minY) / STAMP_CELL) + 1;
  const int64_t cells = gw64 * gh64;
  if (gw64 < 1 || gh64 < 1 || cells > (int64_t)countsCap || cells > (int64_t)STAMP_GRID_MAX_CELLS || nSun > itemsCap) return 0;
  const int32_t gw = (int32_t)gw64;
  const int32_t gh = (int32_t)gh64;
  const int32_t n = (int32_t)cells;
  for (int32_t i = 0; i < n; i++) counts[i] = 0;
  for (uint32_t c = 0; c < nSun; c++) {
    int32_t col = floor_int32(((double)sun[c * sf] - minX) / STAMP_CELL);
    int32_t row = floor_int32(((double)sun[c * sf + 1] - minY) / STAMP_CELL);
    if (col < 0) col = 0;
    else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0;
    else if (row >= gh) row = gh - 1;
    counts[row * gw + col]++;
  }
  int32_t sum = 0;
  for (int32_t i = 0; i < n; i++) {
    starts[i] = sum;
    sum += counts[i];
  }
  starts[n] = (int32_t)nSun;
  int32_t *cursor = counts;
  for (int32_t i = 0; i < n; i++) cursor[i] = starts[i];
  for (uint32_t c = 0; c < nSun; c++) {
    int32_t col = floor_int32(((double)sun[c * sf] - minX) / STAMP_CELL);
    int32_t row = floor_int32(((double)sun[c * sf + 1] - minY) / STAMP_CELL);
    if (col < 0) col = 0;
    else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0;
    else if (row >= gh) row = gh - 1;
    items[cursor[row * gw + col]++] = c;
  }
  g->minX = minX;
  g->minY = minY;
  g->gw = gw;
  g->gh = gh;
  return 1;
}

/* build_grid, with the casters' x and y packed in its item order (cell by cell, caster order within a cell) at px
   and py. The first pass keeps each row's x and y at tx and ty (scratch the gather does not use until the first
   light), and the other passes read them there: the same cells and items as build_grid. */
INLINE int build_grid_packed(const float *sun, uint32_t nSun, uint32_t sf, int32_t *counts, int32_t *starts,
                             uint32_t *items, uint32_t countsCap, uint32_t itemsCap, Grid *g, float *tx, float *ty,
                             float *px, float *py, int32_t *cellOf) {
  double minX = __builtin_inf();
  double minY = __builtin_inf();
  double maxX = -__builtin_inf();
  double maxY = -__builtin_inf();
  int nan = 0;
  for (uint32_t c = 0; c < nSun; c++) {
    const float fx = sun[c * sf];
    const float fy = sun[c * sf + 1];
    tx[c] = fx;
    ty[c] = fy;
    const double x = fx;
    const double y = fy;
    nan |= (x != x) | (y != y);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!(minX - minX == 0.0)) return 0; /* !Number.isFinite(minX) */
  g->exact = !nan && minX >= -KNN_COORD_MAX && maxX <= KNN_COORD_MAX && minY >= -KNN_COORD_MAX && maxY <= KNN_COORD_MAX;
  const int64_t gw64 = (int64_t)floor_int32((maxX - minX) / STAMP_CELL) + 1;
  const int64_t gh64 = (int64_t)floor_int32((maxY - minY) / STAMP_CELL) + 1;
  const int64_t cells = gw64 * gh64;
  if (gw64 < 1 || gh64 < 1 || cells > (int64_t)countsCap || cells > (int64_t)STAMP_GRID_MAX_CELLS || nSun > itemsCap) return 0;
  const int32_t gw = (int32_t)gw64;
  const int32_t gh = (int32_t)gh64;
  const int32_t n = (int32_t)cells;
  for (int32_t i = 0; i < n; i++) counts[i] = 0;
  for (uint32_t c = 0; c < nSun; c++) {
    int32_t col = floor_int32(((double)tx[c] - minX) / STAMP_CELL);
    int32_t row = floor_int32(((double)ty[c] - minY) / STAMP_CELL);
    if (col < 0) col = 0;
    else if (col >= gw) col = gw - 1;
    if (row < 0) row = 0;
    else if (row >= gh) row = gh - 1;
    const int32_t cell = row * gw + col;
    cellOf[c] = cell;
    counts[cell]++;
  }
  int32_t sum = 0;
  for (int32_t i = 0; i < n; i++) {
    starts[i] = sum;
    sum += counts[i];
  }
  starts[n] = (int32_t)nSun;
  int32_t *cursor = counts;
  for (int32_t i = 0; i < n; i++) cursor[i] = starts[i];
  for (uint32_t c = 0; c < nSun; c++) {
    const int32_t p = cursor[cellOf[c]]++;
    items[p] = c;
    px[p] = tx[c];
    py[p] = ty[c];
  }
  g->minX = minX;
  g->minY = minY;
  g->gw = gw;
  g->gh = gh;
  return 1;
}

INLINE uint32_t f32_bits(float f) {
  union { float f; uint32_t u; } b = { .f = f };
  return b.u;
}

/* A nearest-light pair (E-358): its float distance in the low word, its light in the high one. */
INLINE double pair_dist(uint64_t pair) {
  union { uint32_t u; float f; } b = { .u = (uint32_t)pair };
  return b.f;
}

INLINE int32_t pair_light(uint64_t pair) { return (int32_t)(uint32_t)(pair >> 32); }

/* noteNearest: keep the closest lights on this caster; ties go to the smaller light index. The caster's record is its
   maxPE pairs, nearest first: a pair moves as one word, the bits the float and the int had apart (a NaN distance
   compares false whatever its bits). */
INLINE void note_nearest(uint64_t *near, uint8_t *nearCount, uint32_t caster, int32_t lightIndex, double d2,
                         uint32_t maxPE) {
  uint64_t *rec = near + caster * maxPE;
  uint32_t n = nearCount[caster];
  if (n == maxPE) {
    const uint64_t worst = rec[n - 1];
    const double wd = pair_dist(worst);
    if (d2 > wd || (d2 == wd && lightIndex >= pair_light(worst))) return;
    n--;
  }
  uint32_t i = n;
  while (i > 0) {
    const uint64_t prev = rec[i - 1];
    const double pd = pair_dist(prev);
    if (pd < d2 || (pd == d2 && pair_light(prev) <= lightIndex)) break;
    rec[i] = prev;
    i--;
  }
  rec[i] = (uint64_t)f32_bits((float)d2) | ((uint64_t)(uint32_t)lightIndex << 32);
  nearCount[caster] = (uint8_t)(n + 1);
}

/* sortPairsByIndex: each light's candidates are distinct casters, so any sort by index gives the
   order the JS comparator sort gives. Heap sort of (index, dist) pairs, in place. */
static void sort_pairs_by_index(uint32_t *idx, float *dist, uint32_t m) {
  if (m < 2) return;
  for (uint32_t start = m / 2; start-- > 0;) {
    uint32_t root = start;
    for (;;) {
      uint32_t child = 2 * root + 1;
      if (child >= m) break;
      if (child + 1 < m && idx[child] < idx[child + 1]) child++;
      if (idx[root] >= idx[child]) break;
      const uint32_t ti = idx[root]; idx[root] = idx[child]; idx[child] = ti;
      const float td = dist[root]; dist[root] = dist[child]; dist[child] = td;
      root = child;
    }
  }
  for (uint32_t end = m - 1; end > 0; end--) {
    const uint32_t ti = idx[0]; idx[0] = idx[end]; idx[end] = ti;
    const float td = dist[0]; dist[0] = dist[end]; dist[end] = td;
    uint32_t root = 0;
    for (;;) {
      uint32_t child = 2 * root + 1;
      if (child >= end) break;
      if (child + 1 < end && idx[child] < idx[child + 1]) child++;
      if (idx[root] >= idx[child]) break;
      const uint32_t t2 = idx[root]; idx[root] = idx[child]; idx[child] = t2;
      const float d3 = dist[root]; dist[root] = dist[child]; dist[child] = d3;
      root = child;
    }
  }
}

static void insertion_sort_order(uint32_t *order, const float *dist, int32_t left, int32_t right) {
  for (int32_t i = left + 1; i <= right; i++) {
    const uint32_t cur = order[i];
    const float val = dist[cur];
    int32_t j = i - 1;
    while (j >= left && dist[order[j]] > val) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = cur;
  }
}

static int32_t partition_order(uint32_t *order, const float *dist, int32_t left, int32_t right, int32_t pivotIdx) {
  const float pivotVal = dist[order[pivotIdx]];
  const uint32_t tmpPivot = order[pivotIdx];
  order[pivotIdx] = order[right];
  order[right] = tmpPivot;
  int32_t storeIdx = left;
  for (int32_t i = left; i < right; i++) {
    if (dist[order[i]] < pivotVal) {
      const uint32_t t = order[storeIdx];
      order[storeIdx] = order[i];
      order[i] = t;
      storeIdx++;
    }
  }
  const uint32_t t = order[storeIdx];
  order[storeIdx] = order[right];
  order[right] = t;
  return storeIdx;
}

INLINE int32_t median_of_three(const uint32_t *order, const float *dist, int32_t left, int32_t mid, int32_t right) {
  const float a = dist[order[left]];
  const float b = dist[order[mid]];
  const float c = dist[order[right]];
  return a < b ? (b < c ? mid : (a < c ? right : left)) : (a < c ? left : (b < c ? right : mid));
}

static void quickselect_order(uint32_t *order, const float *dist, int32_t left, int32_t right, int32_t k) {
  while (left < right) {
    if (right - left < 16) {
      insertion_sort_order(order, dist, left, right);
      return;
    }
    const int32_t mid = (left + right) >> 1;
    const int32_t p = partition_order(order, dist, left, right, median_of_three(order, dist, left, mid, right));
    if (p == k) return;
    if (k < p) right = p - 1;
    else left = p + 1;
  }
}

static void quicksort_order(uint32_t *order, const float *dist, int32_t left, int32_t right) {
  while (left < right) {
    if (right - left < 16) {
      insertion_sort_order(order, dist, left, right);
      return;
    }
    const int32_t mid = (left + right) >> 1;
    const int32_t p = partition_order(order, dist, left, right, median_of_three(order, dist, left, mid, right));
    if (p - left < right - p) {
      quicksort_order(order, dist, left, p - 1);
      left = p + 1;
    } else {
      quicksort_order(order, dist, p + 1, right);
      right = p - 1;
    }
  }
}

/* E-315: a light's lim nearest candidates without the quickselect's partitions (whose branch on dist[order[i]]
   mispredicts about half the time): a non-negative float orders as its bits, so the candidates go into SEL_BINS bins
   by the high bits of their float distance, 16 bins an octave over the 16 octaves below the light's rangeSq (the
   octaves under those share bin 0). One pass counts the bins, which finds the bin that holds the lim-th distance; a
   second puts the candidates of the bins below it (all kept) into order and that bin's into a list; the next 8 bits
   split the list again, and so on, until the rest of the cut is the whole list or a list of at most SEL_SMALL, sorted
   outright. The kept are then the lim smallest distances, the set the quickselect keeps whenever the lim-th and the
   (lim+1)-th distances differ. Returns 1 with order[0..lim) those candidates (the bins below first, unsorted), 0 when
   it cannot decide that way: a tie at the cut, a NaN distance, or a crowded bin 0 that holds the octaves under it;
   the caller then runs the quickselect, which decides as it always did. hist: SEL_BINS words of scratch; list: m. */
#define SEL_BINS 256
#define SEL_SHIFT 19
#define SEL_SMALL 32
/* Fewer candidates than this: the quickselect (the bins' fixed cost would weigh more than its partitions). */
#define SEL_MIN 64

static int radix_select(const float *dist, uint32_t m, uint32_t lim, uint32_t kTop, uint32_t *order, uint32_t *list,
                        uint32_t *hist) {
  const int32_t base = (int32_t)(kTop >> SEL_SHIFT) - (SEL_BINS - 1);
  for (uint32_t b = 0; b < SEL_BINS; b++) hist[b] = 0;
  uint32_t bad = 0;
  uint32_t low = 0;
  for (uint32_t i = 0; i < m; i++) {
    const uint32_t k = f32_bits(dist[i]);
    int32_t b = (int32_t)(k >> SEL_SHIFT) - base;
    bad |= k > kTop; /* past the range: NaN */
    low |= b < 0;
    b = b < 0 ? 0 : (b > SEL_BINS - 1 ? SEL_BINS - 1 : b);
    hist[b]++;
  }
  if (bad) return 0;
  uint32_t lo = 0;
  int32_t cut = 0;
  for (; cut < SEL_BINS - 1; cut++) {
    if (lo + hist[cut] >= lim) break;
    lo += hist[cut];
  }
  uint32_t n = hist[cut];
  uint32_t need = lim - lo;
  /* Bin 0 with distances of the octaves under it is not one run of high bits: only sorted outright, or kept whole. */
  if (cut == 0 && low && n > SEL_SMALL && n != need) return 0;
  /* Every candidate is written to both outputs and counted in the one its bin picks: no branch on the bin. */
  uint32_t kept = 0;
  uint32_t at = 0;
  for (uint32_t i = 0; i < m; i++) {
    int32_t b = (int32_t)(f32_bits(dist[i]) >> SEL_SHIFT) - base;
    b = b < 0 ? 0 : b;
    order[kept] = i;
    kept += b < cut;
    list[at] = i;
    at += b == cut;
  }
  uint32_t shift = SEL_SHIFT;
  for (;;) {
    if (n == need) { /* the whole list: every other candidate is in a higher bin, so farther */
      for (uint32_t j = 0; j < n; j++) order[lo + j] = list[j];
      return 1;
    }
    if (n <= SEL_SMALL) {
      insertion_sort_order(list, dist, 0, (int32_t)n - 1);
      if (dist[list[need - 1]] == dist[list[need]]) return 0;
      for (uint32_t j = 0; j < need; j++) order[lo + j] = list[j];
      return 1;
    }
    if (shift == 0) return 0; /* the list shares every bit: equal distances across the cut */
    const uint32_t s = shift > 8 ? shift - 8 : 0;
    const uint32_t mask = (1u << (shift - s)) - 1u;
    for (uint32_t b = 0; b <= mask; b++) hist[b] = 0;
    for (uint32_t j = 0; j < n; j++) hist[(f32_bits(dist[list[j]]) >> s) & mask]++;
    uint32_t below = 0;
    uint32_t sub = 0;
    for (; sub < mask; sub++) {
      if (below + hist[sub] >= need) break;
      below += hist[sub];
    }
    uint32_t w = 0;
    for (uint32_t j = 0; j < n; j++) {
      const uint32_t p = list[j];
      const uint32_t b = (f32_bits(dist[p]) >> s) & mask;
      if (b < sub) order[lo++] = p;
      else if (b == sub) list[w++] = p;
    }
    n = w;
    need -= below;
    shift = s;
  }
}

/* takeClosest. ordered 0 (maxShadowsPerEntity): the kept casters only go into their own nearest-light slots,
   whose order is (distance, light) whatever order they come in, so the kept slice is not sorted (E-133). The stamp
   below runs it as radix_select with this as the fallback; the float32 test module runs it whole. */
__attribute__((unused)) INLINE uint32_t take_closest(const uint32_t *tmpIdx, const float *tmpDist, uint32_t *order, uint32_t m, int32_t limit,
                             uint32_t *outIdx, int ordered) {
  if (limit > 0 && m > (uint32_t)limit) {
    for (uint32_t k = 0; k < m; k++) order[k] = k;
    quickselect_order(order, tmpDist, 0, (int32_t)m - 1, limit - 1);
    if (ordered) quicksort_order(order, tmpDist, 0, limit - 1);
    for (int32_t k = 0; k < limit; k++) outIdx[k] = tmpIdx[order[k]];
    return (uint32_t)limit;
  }
  for (uint32_t k = 0; k < m; k++) outIdx[k] = tmpIdx[k];
  return m;
}

/* One caster row into a stamp row: a caster row's 22 floats in five v128 and a 64-bit lane when both strides are
   that (a memcpy of 88 bytes would be memory.copy, a runtime call in V8); otherwise float by float. put_row copies
   the rows of any layout but its own two through it. */
INLINE void copy_row(float *d, const float *s, uint32_t sf, uint32_t df) {
  if (sf == 22 && df == 22) {
    wasm_v128_store(d, wasm_v128_load(s));
    wasm_v128_store(d + 4, wasm_v128_load(s + 4));
    wasm_v128_store(d + 8, wasm_v128_load(s + 8));
    wasm_v128_store(d + 12, wasm_v128_load(s + 12));
    wasm_v128_store(d + 16, wasm_v128_load(s + 16));
    wasm_v128_store64_lane(d + 20, wasm_v128_load64_zero(s + 20), 0);
    return;
  }
  const uint32_t row = sf < df ? sf : df;
  for (uint32_t f = 0; f < row; f++) d[f] = s[f];
}

/* E-359: the stamp rows pre-render writes (gpuQueueLayout.js): a keyed row (E-191 step 2) is the caster's 7 floats
   with the light vec4 after them, 11 floats; a full row is the caster's 22 floats with the light over its last 4. */
#define KEYED_CASTER_FLOATS 7
#define KEYED_STAMP_FLOATS 11
#define CASTER_FLOATS 22
#define CASTER_LIGHT_FLOAT 18
enum { ROW_ANY, ROW_KEYED, ROW_FULL };

INLINE int row_kind(uint32_t sf, uint32_t df, uint32_t lightAt) {
  if (sf == KEYED_CASTER_FLOATS && df == KEYED_STAMP_FLOATS && lightAt == KEYED_CASTER_FLOATS) return ROW_KEYED;
  if (sf == CASTER_FLOATS && df == CASTER_FLOATS && lightAt == CASTER_LIGHT_FLOAT) return ROW_FULL;
  return ROW_ANY;
}

/* A light's vec4 as the stamp rows hold it: x, y, intensity and rangeSq as float. */
INLINE v128_t light_vec(const double *L) {
  return wasm_f32x4_make((float)L[0], (float)L[1], (float)L[2], (float)L[3]);
}

/* One stamp row: caster row s with light vec4 lv (kind: row_kind's). A keyed row in fixed stores (the caster's floats
   as a v128, a 64-bit and a 32-bit lane, then the light in one v128), a full row its first 18 floats and then the light,
   each byte stored once and nothing read or written past either row; any other layout as it always went: copy_row,
   then the light float by float. */
INLINE void put_row(float *d, const float *s, uint32_t sf, uint32_t df, uint32_t lightAt, int kind, v128_t lv) {
  if (kind == ROW_KEYED) {
    wasm_v128_store(d, wasm_v128_load(s));
    wasm_v128_store64_lane(d + 4, wasm_v128_load64_zero(s + 4), 0);
    wasm_v128_store32_lane(d + 6, wasm_v128_load32_zero(s + 6), 0);
    wasm_v128_store(d + KEYED_CASTER_FLOATS, lv);
    return;
  }
  if (kind == ROW_FULL) {
    wasm_v128_store(d, wasm_v128_load(s));
    wasm_v128_store(d + 4, wasm_v128_load(s + 4));
    wasm_v128_store(d + 8, wasm_v128_load(s + 8));
    wasm_v128_store(d + 12, wasm_v128_load(s + 12));
    wasm_v128_store64_lane(d + 16, wasm_v128_load64_zero(s + 16), 0);
    wasm_v128_store(d + CASTER_LIGHT_FLOAT, lv);
    return;
  }
  copy_row(d, s, sf, df);
  d[lightAt] = wasm_f32x4_extract_lane(lv, 0);
  d[lightAt + 1] = wasm_f32x4_extract_lane(lv, 1);
  d[lightAt + 2] = wasm_f32x4_extract_lane(lv, 2);
  d[lightAt + 3] = wasm_f32x4_extract_lane(lv, 3);
}

/* DX-SPOT: is a caster at (dx, dy) from a cone light inside its cone (factor above 0)? On the floor, with no root:
   cos > coneCos as dot > 0 and dot² > coneCos²·d² (aperture up to 180°), or dot ≥ 0 or dot² < coneCos²·d² (wider). */
INLINE int in_cone(double dx, double dy, const double *L) {
  const double fd2 = dx * dx + dy * dy * L[9];
  if (fd2 == 0.0) return 1;
  const double dot = dx * L[5] + dy * L[6];
  const double c = L[7];
  const double c2 = c * c * fd2;
  return c >= 0.0 ? (dot > 0.0 && dot * dot > c2) : (dot >= 0.0 || dot * dot < c2);
}

/* DX-SPOT: the intensity a caster row of a cone or dim light takes: f·I·D² / (I + D² − f·I), which the unchanged shader
   turns into f × the alpha I / (I + D²) (D on the floor), f the cone's soft edge (1 without a cone) times the shade
   (DX-LIGHTAPI: min(brightness, 1)). At f 1, the light's own. */
INLINE double cone_intensity(double dx, double dy, double intensity, const double *L) {
  const double fd2 = dx * dx + dy * dy * L[9];
  double f = L[10];
  if (L[7] > -1.0 && fd2 != 0.0) {
    const double cosA = (dx * L[5] + dy * L[6]) / __builtin_sqrt(fd2);
    double t = (cosA - L[7]) * L[8];
    if (t < 1.0) {
      if (t < 0.0) t = 0.0;
      f *= t * t * (3.0 - 2.0 * t);
    }
  }
  if (f >= 1.0) return intensity;
  return f * intensity * fd2 / (intensity + fd2 - f * intensity);
}

/* appendStampedCasters for one light vec4 lv (made once for the light). */
INLINE int32_t append_rows(float *dst, uint32_t df, int32_t out, const float *src, uint32_t sf, const uint32_t *indices,
                           uint32_t n, v128_t lv, int32_t cap, uint32_t lightAt) {
  const int kind = row_kind(sf, df, lightAt);
  for (uint32_t k = 0; k < n && out < cap; k++) {
    put_row(dst + (uint32_t)out * df, src + indices[k] * sf, sf, df, lightAt, kind, lv);
    out++;
  }
  return out;
}

/* append_rows with the vec4 as floats (as the JS Float32Array lightVec holds it): the float32 test module's
   (wasm/test/shadowStampF32.c). */
__attribute__((unused)) INLINE int32_t append_stamped(float *dst, uint32_t df, int32_t out, const float *src, uint32_t sf,
                                                      const uint32_t *indices, uint32_t n, const float *lightVec,
                                                      int32_t cap, uint32_t lightAt) {
  const v128_t lv = wasm_f32x4_make(lightVec[0], lightVec[1], lightVec[2], lightVec[3]);
  return append_rows(dst, df, out, src, sf, indices, n, lv, cap, lightAt);
}

/* append_rows for a cone light: each row's intensity from where its caster stands in the cone (cone_intensity). */
INLINE int32_t append_rows_cone(float *dst, uint32_t df, int32_t out, const float *src, uint32_t sf,
                                const uint32_t *indices, uint32_t n, v128_t lv, int32_t cap, uint32_t lightAt, double lx,
                                double ly, double intensity, const double *L) {
  const int kind = row_kind(sf, df, lightAt);
  for (uint32_t k = 0; k < n && out < cap; k++) {
    const float *s = src + indices[k] * sf;
    const float f = (float)cone_intensity((double)s[0] - lx, (double)s[1] - ly, intensity, L);
    put_row(dst + (uint32_t)out * df, s, sf, df, lightAt, kind, wasm_f32x4_replace_lane(lv, 2, f));
    out++;
  }
  return out;
}

/* One light's rows without maxShadowsPerEntity: its kept casters keep[0..n) with its vec4 (a cone or dim light's
   intensity row by row), and their light index. Returns the new cursor. */
INLINE int32_t stamp_light_rows(float *stamp, uint32_t df, int32_t cursor, const float *sun, uint32_t sf,
                                const uint32_t *keep, uint32_t n, int32_t cap, uint32_t lightAt, int folded, double lx,
                                double ly, double intensity, double rangeSq, const double *L, uint16_t *stampLightIdx,
                                int32_t i) {
  const v128_t lv = wasm_f32x4_make((float)lx, (float)ly, (float)intensity, (float)rangeSq);
  const int32_t written = folded
    ? append_rows_cone(stamp, df, cursor, sun, sf, keep, n, lv, cap, lightAt, lx, ly, intensity, L)
    : append_rows(stamp, df, cursor, sun, sf, keep, n, lv, cap, lightAt);
  if (stampLightIdx) for (int32_t k = cursor; k < written; k++) stampLightIdx[k] = (uint16_t)i;
  return written;
}

/* The rows of one caster's nearest lights (its record rec, n pairs), in the record's order, until the stamp is full. lvt
   (table 1): each light's vec4, made once a light; table 0 makes it row by row. folded: a cone or dim light's rows take
   their caster's place in the cone and its shade. table and folded are constants once inlined. */
INLINE int32_t caster_rows(float *stamp, uint32_t df, int32_t cursor, int32_t cap, const float *s, uint32_t sf,
                           uint32_t lightAt, int kind, const double *lights, const float *lvt, const uint64_t *rec,
                           uint32_t n, uint16_t *stampLightIdx, const int table, const int folded) {
  for (uint32_t k = 0; k < n && cursor < cap; k++) {
    const int32_t li = pair_light(rec[k]);
    const double *L = lights + (uint32_t)li * LIGHT_DOUBLES;
    v128_t lv = table ? wasm_v128_load(lvt + 4 * (uint32_t)li) : light_vec(L);
    if (folded && (L[7] > -1.0 || L[10] < 1.0)) {
      lv = wasm_f32x4_replace_lane(lv, 2, (float)cone_intensity((double)s[0] - L[0], (double)s[1] - L[1], L[2], L));
    }
    put_row(stamp + (uint32_t)cursor * df, s, sf, df, lightAt, kind, lv);
    if (stampLightIdx) stampLightIdx[cursor] = (uint16_t)li;
    cursor++;
  }
  return cursor;
}

/* E-358: the rows of maxShadowsPerEntity, caster by caster in caster order, until the stamp is full. The counts are
   tested sixteen at a time (one i8x16 compare and its bitmask): a block of unlit casters costs one test, and each lit
   caster of a block is found by its bit, in order. */
INLINE int32_t stamp_nearest_rows(float *stamp, uint32_t df, int32_t cursor, int32_t cap, const float *sun, uint32_t sf,
                                  uint32_t lightAt, const double *lights, const float *lvt, const uint64_t *near,
                                  const uint8_t *nearCount, uint32_t nSun, uint32_t maxPE, uint16_t *stampLightIdx,
                                  const int table, const int folded) {
  const int kind = row_kind(sf, df, lightAt);
  const uint32_t blocks = nSun & ~15u;
  uint32_t c = 0;
  for (; c < blocks && cursor < cap; c += 16) {
    const v128_t unlit = wasm_i8x16_eq(wasm_v128_load(nearCount + c), wasm_i8x16_splat(0));
    uint32_t lit = (uint32_t)wasm_i8x16_bitmask(unlit) ^ 0xffffu;
    while (lit && cursor < cap) {
      const uint32_t at = c + (uint32_t)__builtin_ctz(lit);
      lit &= lit - 1u;
      cursor = caster_rows(stamp, df, cursor, cap, sun + at * sf, sf, lightAt, kind, lights, lvt, near + at * maxPE,
                           nearCount[at], stampLightIdx, table, folded);
    }
  }
  for (; c < nSun && cursor < cap; c++) {
    cursor = caster_rows(stamp, df, cursor, cap, sun + c * sf, sf, lightAt, kind, lights, lvt, near + c * maxPE,
                         nearCount[c], stampLightIdx, table, folded);
  }
  return cursor;
}

/* E-315: a light that keeps at most KNN_MAX_LIM casters walks its cells nearest first and skips the cells too far to
   hold one of its kept, instead of gathering every candidate of its box and selecting among them. */
#define KNN_MAX_LIM 64
/* A light farther out than this takes the gather: its cells' distances in double stay well within KNN_EPS. */
#define KNN_LIGHT_MAX 1073741824.0
/* How much nearer than its cell's square (px) a caster may be, and the relative margin on a squared distance: far
   more than the doubles' rounding (under 1e-6 px and 1e-15 here), so a skipped cell never holds a distance a kept one
   ties or beats. */
#define KNN_EPS (1.0 / 64.0)
#define KNN_SHRINK (1.0 - 1.0 / 1048576.0)

/* The ring walk (E-315). The light's box of cells is the gather's, cell for cell, but walked in rings around the
   light's cell; each candidate (in range, and in the cone when `cone`) goes into bufKey/bufPos, its float distance and
   its packed position kept sorted by distance (an equal one after those already there), lim at most. Once lim are
   held, a candidate past the last is dropped, a nearer one drops the last, and a cell whose nearest point (minus
   KNN_EPS) is past the last distance (in float, so a skipped caster cannot even tie it) is skipped, as are the rings
   after one whose inner edge is past it (when the light is in its own cell). `over` records that a candidate was left
   out (m > lim, so the gather would select): for a skipped cell while that is not known yet, the walk looks for one
   candidate in it. Returns (n << 1) | over with n the candidates held: every candidate of the box when not over, else
   the lim nearest; -1 when a candidate ties the last held distance (or a dropped one ties the new last): the gather
   and its selection then decide that light, as they always did. bufKey and bufPos have room for lim. */
INLINE int32_t ring_select(const int32_t *gridStarts, const float *px, const float *py, double minX, double minY,
                           int32_t gw, int32_t gh, double lx, double ly, double rangeSq, const double *L, int cone,
                           int32_t lim, float *bufKey, uint32_t *bufPos) {
  const double r = __builtin_sqrt(rangeSq);
  int32_t col0 = floor_int32((lx - r - minX) / STAMP_CELL);
  int32_t col1 = floor_int32((lx + r - minX) / STAMP_CELL);
  int32_t row0 = floor_int32((ly - r - minY) / STAMP_CELL);
  int32_t row1 = floor_int32((ly + r - minY) / STAMP_CELL);
  if (col0 < 0) col0 = 0;
  if (row0 < 0) row0 = 0;
  if (col1 >= gw) col1 = gw - 1;
  if (row1 >= gh) row1 = gh - 1;
  if (col0 > col1 || row0 > row1) return 0;
  int32_t lc = floor_int32((lx - minX) / STAMP_CELL);
  int32_t lr = floor_int32((ly - minY) / STAMP_CELL);
  /* The light in a cell of its box: the rings after the k-th lie past that ring's inner edge. */
  const int inside = lc >= col0 && lc <= col1 && lr >= row0 && lr <= row1;
  lc = lc < col0 ? col0 : (lc > col1 ? col1 : lc);
  lr = lr < row0 ? row0 : (lr > row1 ? row1 : lr);
  int32_t rings = lc - col0;
  if (col1 - lc > rings) rings = col1 - lc;
  if (lr - row0 > rings) rings = lr - row0;
  if (row1 - lr > rings) rings = row1 - lr;
  float top = __builtin_inff();
  int32_t n = 0;
  int over = 0;
  for (int32_t k = 0; k <= rings; k++) {
    if (k > 0 && over && inside) {
      double gap = __builtin_inf();
      if (lc - k >= col0) {
        const double d = lx - (minX + (double)(lc - k + 1) * STAMP_CELL);
        if (d < gap) gap = d;
      }
      if (lc + k <= col1) {
        const double d = (minX + (double)(lc + k) * STAMP_CELL) - lx;
        if (d < gap) gap = d;
      }
      if (lr - k >= row0) {
        const double d = ly - (minY + (double)(lr - k + 1) * STAMP_CELL);
        if (d < gap) gap = d;
      }
      if (lr + k <= row1) {
        const double d = (minY + (double)(lr + k) * STAMP_CELL) - ly;
        if (d < gap) gap = d;
      }
      gap -= KNN_EPS;
      if (gap > 0.0 && (float)(gap * gap * KNN_SHRINK) > top) break;
    }
    const int32_t rowFrom = lr - k < row0 ? row0 : lr - k;
    const int32_t rowTo = lr + k > row1 ? row1 : lr + k;
    for (int32_t row = rowFrom; row <= rowTo; row++) {
      /* The ring's first and last rows whole; the rows between, their two ends. */
      int32_t colFrom = lc - k;
      int32_t colTo = lc + k;
      int32_t step = 2 * k;
      if (row == lr - k || row == lr + k) {
        if (colFrom < col0) colFrom = col0;
        if (colTo > col1) colTo = col1;
        step = 1;
      }
      for (int32_t col = colFrom; col <= colTo; col += step) {
        if (col < col0 || col > col1) continue;
        const int32_t cell = row * gw + col;
        const int32_t from = gridStarts[cell];
        const int32_t to = gridStarts[cell + 1];
        if (from == to) continue;
        if (n == lim) {
          const double x0 = minX + (double)col * STAMP_CELL;
          const double y0 = minY + (double)row * STAMP_CELL;
          double gx = x0 - lx;
          const double gx1 = lx - (x0 + STAMP_CELL);
          if (gx1 > gx) gx = gx1;
          double gy = y0 - ly;
          const double gy1 = ly - (y0 + STAMP_CELL);
          if (gy1 > gy) gy = gy1;
          gx -= KNN_EPS;
          gy -= KNN_EPS;
          if (gx < 0.0) gx = 0.0;
          if (gy < 0.0) gy = 0.0;
          if ((float)((gx * gx + gy * gy) * KNN_SHRINK) > top) {
            if (over) continue;
            for (int32_t p = from; p < to; p++) {
              const double dx = (double)px[p] - lx;
              const double dy = (double)py[p] - ly;
              const double d2 = dx * dx + dy * dy;
              if (d2 > rangeSq || (cone && !in_cone(dx, dy, L))) continue;
              over = 1;
              break;
            }
            continue;
          }
        }
        for (int32_t p = from; p < to; p++) {
          const double dx = (double)px[p] - lx;
          const double dy = (double)py[p] - ly;
          const double d2 = dx * dx + dy * dy;
          if (d2 > rangeSq) continue;
          if (cone && !in_cone(dx, dy, L)) continue;
          const float key = (float)d2;
          if (key > top) {
            over = 1;
            continue;
          }
          if (n < lim) {
            int32_t j = n;
            while (j > 0 && key < bufKey[j - 1]) {
              bufKey[j] = bufKey[j - 1];
              bufPos[j] = bufPos[j - 1];
              j--;
            }
            bufKey[j] = key;
            bufPos[j] = (uint32_t)p;
            if (++n == lim) top = bufKey[lim - 1];
            continue;
          }
          over = 1;
          if (!(key < top)) return -1;
          int32_t j = lim - 1;
          while (j > 0 && key < bufKey[j - 1]) {
            bufKey[j] = bufKey[j - 1];
            bufPos[j] = bufPos[j - 1];
            j--;
          }
          bufKey[j] = key;
          bufPos[j] = (uint32_t)p;
          if (bufKey[lim - 1] == top) return -1;
          top = bufKey[lim - 1];
        }
      }
    }
  }
  return (n << 1) | over;
}

__attribute__((export_name("stamp_light_range")))
int32_t stamp_light_range(uint32_t table) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const float *sun = (const float *)(uintptr_t)t[T_SUN];
  const uint32_t nSun = t[T_SUN_N];
  const uint32_t sf = t[T_SUN_FLOATS];
  const double *lights = (const double *)(uintptr_t)t[T_LIGHTS];
  int32_t begin = (int32_t)t[T_LIGHT_BEGIN];
  const int32_t capL = (int32_t)t[T_LIGHT_END];
  const int32_t stride = (int32_t)t[T_LIGHT_STRIDE] > 0 ? (int32_t)t[T_LIGHT_STRIDE] : 1;
  const int32_t maxPL = (int32_t)t[T_MAX_PL];
  const uint32_t maxPE = t[T_MAX_PE];
  uint32_t *tmpIdx = (uint32_t *)(uintptr_t)t[T_TMP_IDX];
  float *dist = (float *)(uintptr_t)t[T_DIST];
  uint32_t *order = (uint32_t *)(uintptr_t)t[T_ORDER];
  uint32_t *keep = (uint32_t *)(uintptr_t)t[T_KEEP];
  const uint32_t tmpCap = t[T_TMP_CAP];
  int32_t *gridCounts = (int32_t *)(uintptr_t)t[T_GRID_COUNTS];
  int32_t *gridStarts = (int32_t *)(uintptr_t)t[T_GRID_STARTS];
  uint32_t *gridItems = (uint32_t *)(uintptr_t)t[T_GRID_ITEMS];
  float *stamp = (float *)(uintptr_t)t[T_STAMP];
  const uint32_t df = t[T_STAMP_FLOATS];
  const int32_t cap = (int32_t)t[T_STAMP_CAP];
  int32_t cursor = (int32_t)t[T_STAMP_BASE];
  uint16_t *stampLightIdx = (uint16_t *)(uintptr_t)t[T_STAMP_LIGHT_IDX];
  const uint32_t lightAt = t[T_LIGHT_FLOAT];
  uint64_t *near = (uint64_t *)(uintptr_t)t[T_NEAR_DIST];
  uint8_t *nearCount = (uint8_t *)(uintptr_t)t[T_NEAR_COUNT];
  float *px = (float *)(uintptr_t)t[T_PACKED_X];
  float *py = (float *)(uintptr_t)t[T_PACKED_Y];
  int32_t *cellOf = (int32_t *)(uintptr_t)t[T_CELL_OF];
  double *d64 = (double *)(uintptr_t)t[T_DIST64];

  if (begin < 0) begin = 0;
  if (nSun == 0) return cursor;
  if (maxPE > 0) for (uint32_t c = 0; c < nSun; c++) nearCount[c] = 0;
  Grid g;
  g.exact = 0;
  /* tmpIdx and dist hold the rows' x and y while the grid is built: they are maxSun long, and the gather does not
     use them until the first light. */
  const int grid = gridCounts && gridStarts && gridItems
    ? build_grid_packed(sun, nSun, sf, gridCounts, gridStarts, gridItems, t[T_GRID_COUNTS_CAP], t[T_GRID_ITEMS_CAP], &g,
                        dist, (float *)tmpIdx, px, py, cellOf)
    : 0;
  /* E-315: the ring walk needs cells that bound their casters, and a scratch that holds every candidate (the gather
     stops at tmpCap; the walk keeps no list to stop at that place). */
  const int knn = grid && g.exact && tmpCap >= nSun;
  /* Whether a light this call took is a cone or dim: the per-entity rows then go through their own copy of the loop. */
  int anyFolded = 0;
  for (int32_t i = begin; i < capL && (maxPE > 0 || cursor < cap); i += stride) {
    const double *L = lights + (uint32_t)i * LIGHT_DOUBLES;
    const double lx = L[0];
    const double ly = L[1];
    const double intensity = L[2];
    const double rangeSq = L[3];
    const double maxShadows = L[4];
    if (!(rangeSq > 0) || !(intensity > 0)) continue;
    int32_t lim;
    if (maxShadows > 0) {
      const int32_t ms = js_to_int32(maxShadows);
      lim = maxPL > 0 ? (maxPL < ms ? maxPL : ms) : ms;
    } else {
      lim = maxPL > 0 ? maxPL : (int32_t)nSun;
    }
    uint32_t m = 0;
    /* DX-SPOT: a cone light gathers in its own copy of the walk, which drops the casters outside its cone; it and a dim
       light (shade under 1) write their rows in their own copy too. */
    const int cone = L[7] > -1.0;
    const int folded = cone || L[10] < 1.0;
    anyFolded |= folded;
    /* E-315: a small budget walks its cells nearest first (ring_select); a tie at its cut takes the gather below. */
    if (knn && lim > 0 && lim <= KNN_MAX_LIM && lx >= -KNN_LIGHT_MAX && lx <= KNN_LIGHT_MAX && ly >= -KNN_LIGHT_MAX &&
        ly <= KNN_LIGHT_MAX) {
      const int32_t got = cone
        ? ring_select(gridStarts, px, py, g.minX, g.minY, g.gw, g.gh, lx, ly, rangeSq, L, 1, lim, dist, order)
        : ring_select(gridStarts, px, py, g.minX, g.minY, g.gw, g.gh, lx, ly, rangeSq, L, 0, lim, dist, order);
      if (got >= 0) {
        const uint32_t n = (uint32_t)got >> 1;
        const int over = got & 1;
        if (n == 0) continue;
        if (maxPE > 0) {
          /* Each kept caster into its own slots, in any order (E-133), with the gather's double distance. */
          for (uint32_t k = 0; k < n; k++) {
            const uint32_t p = order[k];
            const double dx = (double)px[p] - lx;
            const double dy = (double)py[p] - ly;
            note_nearest(near, nearCount, gridItems[p], i, dx * dx + dy * dy, maxPE);
          }
          continue;
        }
        /* The rows in takeClosest's order: the lim nearest by distance (the gather decides when two of them tie, the
           order of a tie being its quicksort's), or every candidate by caster index (sortPairsByIndex). */
        int ok = 1;
        if (over) for (uint32_t k = 1; k < n && ok; k++) ok = dist[k - 1] != dist[k];
        if (ok) {
          for (uint32_t k = 0; k < n; k++) keep[k] = gridItems[order[k]];
          if (!over) {
            for (uint32_t a = 1; a < n; a++) {
              const uint32_t v = keep[a];
              uint32_t j = a;
              while (j > 0 && keep[j - 1] > v) {
                keep[j] = keep[j - 1];
                j--;
              }
              keep[j] = v;
            }
          }
          cursor = stamp_light_rows(stamp, df, cursor, sun, sf, keep, n, cap, lightAt, folded, lx, ly, intensity, rangeSq,
                                    L, stampLightIdx, i);
          continue;
        }
      }
    }
    if (cone && grid) {
      const double r = __builtin_sqrt(rangeSq);
      int32_t col0 = floor_int32((lx - r - g.minX) / STAMP_CELL);
      int32_t col1 = floor_int32((lx + r - g.minX) / STAMP_CELL);
      int32_t row0 = floor_int32((ly - r - g.minY) / STAMP_CELL);
      int32_t row1 = floor_int32((ly + r - g.minY) / STAMP_CELL);
      if (col0 < 0) col0 = 0;
      if (row0 < 0) row0 = 0;
      if (col1 >= g.gw) col1 = g.gw - 1;
      if (row1 >= g.gh) row1 = g.gh - 1;
      for (int32_t row = row0; row <= row1 && m < tmpCap; row++) {
        const int32_t rowBase = row * g.gw;
        for (int32_t col = col0; col <= col1 && m < tmpCap; col++) {
          const int32_t cell = rowBase + col;
          const int32_t from = gridStarts[cell];
          const int32_t to = gridStarts[cell + 1];
          for (int32_t p = from; p < to && m < tmpCap; p++) {
            const double dx = (double)px[p] - lx;
            const double dy = (double)py[p] - ly;
            const double d2 = dx * dx + dy * dy;
            if (d2 > rangeSq || !in_cone(dx, dy, L)) continue;
            tmpIdx[m] = gridItems[p];
            dist[m] = (float)d2;
            d64[m] = d2;
            m++;
          }
        }
      }
    } else if (cone) {
      for (uint32_t c = 0; c < nSun && m < tmpCap; c++) {
        const double dx = (double)sun[c * sf] - lx;
        const double dy = (double)sun[c * sf + 1] - ly;
        const double d2 = dx * dx + dy * dy;
        if (d2 > rangeSq || !in_cone(dx, dy, L)) continue;
        tmpIdx[m] = c;
        dist[m] = (float)d2;
        d64[m] = d2;
        m++;
      }
    } else if (grid) {
      const double r = __builtin_sqrt(rangeSq);
      int32_t col0 = floor_int32((lx - r - g.minX) / STAMP_CELL);
      int32_t col1 = floor_int32((lx + r - g.minX) / STAMP_CELL);
      int32_t row0 = floor_int32((ly - r - g.minY) / STAMP_CELL);
      int32_t row1 = floor_int32((ly + r - g.minY) / STAMP_CELL);
      if (col0 < 0) col0 = 0;
      if (row0 < 0) row0 = 0;
      if (col1 >= g.gw) col1 = g.gw - 1;
      if (row1 >= g.gh) row1 = g.gh - 1;
      for (int32_t row = row0; row <= row1 && m < tmpCap; row++) {
        const int32_t rowBase = row * g.gw;
        for (int32_t col = col0; col <= col1 && m < tmpCap; col++) {
          const int32_t cell = rowBase + col;
          const int32_t from = gridStarts[cell];
          const int32_t to = gridStarts[cell + 1];
          for (int32_t p = from; p < to && m < tmpCap; p++) {
            const double dx = (double)px[p] - lx;
            const double dy = (double)py[p] - ly;
            const double d2 = dx * dx + dy * dy;
            if (d2 > rangeSq) continue;
            tmpIdx[m] = gridItems[p];
            dist[m] = (float)d2;
            d64[m] = d2;
            m++;
          }
        }
      }
    } else {
      for (uint32_t c = 0; c < nSun && m < tmpCap; c++) {
        const double dx = (double)sun[c * sf] - lx;
        const double dy = (double)sun[c * sf + 1] - ly;
        const double d2 = dx * dx + dy * dy;
        if (d2 > rangeSq) continue;
        tmpIdx[m] = c;
        dist[m] = (float)d2;
        d64[m] = d2;
        m++;
      }
    }
    if (m == 0) continue;
    /* E-315: the radix select needs SEL_BINS words of cellOf (the grid build's, free after it: nSun words). */
    const int radix = m >= SEL_MIN && nSun >= SEL_BINS;
    if (maxPE > 0) {
      /* takeClosest without its copy (the kept slice is not sorted here, E-133): the kept are order[0..lim) when it
         selects, else every candidate, and each brings its own distance. */
      if (lim > 0 && m > (uint32_t)lim) {
        if (!(radix && radix_select(dist, m, (uint32_t)lim, f32_bits((float)rangeSq), order, keep, (uint32_t *)cellOf))) {
          for (uint32_t k = 0; k < m; k++) order[k] = k;
          quickselect_order(order, dist, 0, (int32_t)m - 1, lim - 1);
        }
        for (int32_t k = 0; k < lim; k++) {
          const uint32_t at = order[k];
          note_nearest(near, nearCount, tmpIdx[at], i, d64[at], maxPE);
        }
      } else {
        for (uint32_t k = 0; k < m; k++) note_nearest(near, nearCount, tmpIdx[k], i, d64[k], maxPE);
      }
      continue;
    }
    if (grid && m > 1 && !(lim > 0 && m > (uint32_t)lim)) sort_pairs_by_index(tmpIdx, dist, m);
    if (lim > 0 && m > (uint32_t)lim) {
      /* takeClosest: the kept sorted by distance. After the radix select they are sorted only when no two of them
         tie (the quickselect's order of a tie is its own); else, and when it cannot decide, the quickselect. */
      int ok = radix && radix_select(dist, m, (uint32_t)lim, f32_bits((float)rangeSq), order, keep, (uint32_t *)cellOf);
      if (ok) {
        quicksort_order(order, dist, 0, lim - 1);
        for (int32_t k = 1; k < lim && ok; k++) ok = dist[order[k - 1]] != dist[order[k]];
      }
      if (!ok) {
        for (uint32_t k = 0; k < m; k++) order[k] = k;
        quickselect_order(order, dist, 0, (int32_t)m - 1, lim - 1);
        quicksort_order(order, dist, 0, lim - 1);
      }
      for (int32_t k = 0; k < lim; k++) keep[k] = tmpIdx[order[k]];
      m = (uint32_t)lim;
    } else {
      for (uint32_t k = 0; k < m; k++) keep[k] = tmpIdx[k];
    }
    cursor = stamp_light_rows(stamp, df, cursor, sun, sf, keep, m, cap, lightAt, folded, lx, ly, intensity, rangeSq, L,
                              stampLightIdx, i);
  }
  if (maxPE == 0) return cursor;
  /* E-359: the lights' vec4s, once a light, into dist (the candidates' distances, free once the lights are done) when it
     holds them: the gather may write min(tmpCap, nSun) floats there, four a vec4. The rows below read a light's there. */
  const uint32_t room = tmpCap < nSun ? tmpCap : nSun;
  if (capL > 0 && (uint32_t)capL <= room / 4) {
    float *lvt = dist;
    for (int32_t i = begin; i < capL; i += stride) {
      wasm_v128_store(lvt + 4 * (uint32_t)i, light_vec(lights + (uint32_t)i * LIGHT_DOUBLES));
    }
    /* Point lights at full shade only: each row is its caster's with the light's vec4. DX-SPOT: a call with a cone or
       dim light; that light's rows take their caster's place in the cone and its shade. */
    return anyFolded
      ? stamp_nearest_rows(stamp, df, cursor, cap, sun, sf, lightAt, lights, lvt, near, nearCount, nSun, maxPE,
                           stampLightIdx, 1, 1)
      : stamp_nearest_rows(stamp, df, cursor, cap, sun, sf, lightAt, lights, lvt, near, nearCount, nSun, maxPE,
                           stampLightIdx, 1, 0);
  }
  /* More lights than dist holds (a few casters): each row makes its light's vec4, any light. */
  return stamp_nearest_rows(stamp, df, cursor, cap, sun, sf, lightAt, lights, (const float *)0, near, nearCount, nSun,
                            maxPE, stampLightIdx, 0, 1);
}
