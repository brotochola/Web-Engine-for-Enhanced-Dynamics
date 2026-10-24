/* The shadow-caster stamp (E-76 W23, E-114): stampLightRange (src/render/gpuShadowCasters.js) in C, the whole call: the stamp
   grid over the sun caster rows, each light's gather (grid walk or full scan), the index sort that only
   runs without a per-entity cap, takeClosest's quickselect + quicksort, the per-caster nearest lights
   with maxShadowsPerEntity, and the append of caster rows with the light vec4. Every array is a byte
   offset into the render-queue memory (src/render/shadowStampClient.js writes the table: the sun rows and the
   stamp output are GPU-queue regions, the scratch and the lights the stamp regions); the lights are a table of five
   doubles each (x, y, intensity, rangeSq, maxShadows), NaN rangeSq for an empty slot. Arithmetic as the
   JS does it: positions and distances in double, stored as float where the JS stores into a
   Float32Array, Math.floor(..) | 0 through an exact ToInt32. Returns the stamp cursor. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))
#define STAMP_CELL 256.0
#define STAMP_GRID_MAX_CELLS (128u * 128u)

enum {
  T_SUN, T_SUN_N, T_SUN_FLOATS, T_LIGHTS, T_LIGHT_BEGIN, T_LIGHT_END, T_LIGHT_STRIDE, T_MAX_PL, T_MAX_PE,
  T_TMP_IDX, T_DIST, T_ORDER, T_KEEP, T_TMP_CAP,
  T_GRID_COUNTS, T_GRID_STARTS, T_GRID_ITEMS, T_GRID_COUNTS_CAP, T_GRID_ITEMS_CAP,
  T_STAMP, T_STAMP_FLOATS, T_STAMP_CAP, T_STAMP_BASE, T_STAMP_LIGHT_IDX, T_LIGHT_FLOAT,
  T_NEAR_DIST, T_NEAR_SLOT, T_NEAR_COUNT,
  SLOT_COUNT
};

#define LIGHT_DOUBLES 5

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

typedef struct { double minX, minY; int32_t gw, gh; } Grid;

/* buildStampGrid. 0: no grid (the full scan runs). Inlined, so g stays in locals (no stack). */
INLINE int build_grid(const float *sun, uint32_t nSun, uint32_t sf, int32_t *counts, int32_t *starts,
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

/* noteNearest: keep the closest lights on this caster; ties go to the smaller light index. */
INLINE void note_nearest(float *nearDist, int32_t *nearSlot, uint8_t *nearCount, uint32_t caster, int32_t lightIndex,
                         double d2, uint32_t maxPE) {
  const uint32_t base = caster * maxPE;
  uint32_t n = nearCount[caster];
  if (n == maxPE) {
    const uint32_t worst = base + n - 1;
    const double wd = nearDist[worst];
    if (d2 > wd || (d2 == wd && lightIndex >= nearSlot[worst])) return;
    n--;
  }
  uint32_t i = n;
  while (i > 0) {
    const uint32_t prev = base + i - 1;
    const double pd = nearDist[prev];
    const int32_t pl = nearSlot[prev];
    if (pd < d2 || (pd == d2 && pl <= lightIndex)) break;
    nearDist[base + i] = (float)pd;
    nearSlot[base + i] = pl;
    i--;
  }
  nearDist[base + i] = (float)d2;
  nearSlot[base + i] = lightIndex;
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

/* takeClosest */
INLINE uint32_t take_closest(const uint32_t *tmpIdx, const float *tmpDist, uint32_t *order, uint32_t m, int32_t limit,
                             uint32_t *outIdx) {
  if (limit > 0 && m > (uint32_t)limit) {
    for (uint32_t k = 0; k < m; k++) order[k] = k;
    quickselect_order(order, tmpDist, 0, (int32_t)m - 1, limit - 1);
    quicksort_order(order, tmpDist, 0, limit - 1);
    for (int32_t k = 0; k < limit; k++) outIdx[k] = tmpIdx[order[k]];
    return (uint32_t)limit;
  }
  for (uint32_t k = 0; k < m; k++) outIdx[k] = tmpIdx[k];
  return m;
}

/* appendStampedCasters for one light vec4 (already float, as the JS Float32Array lightVec holds it). */
INLINE int32_t append_stamped(float *dst, uint32_t df, int32_t out, const float *src, uint32_t sf, const uint32_t *indices,
                              uint32_t n, const float *lightVec, int32_t cap, uint32_t lightAt) {
  const uint32_t row = sf < df ? sf : df;
  for (uint32_t k = 0; k < n && out < cap; k++) {
    const uint32_t s0 = indices[k] * sf;
    float *d = dst + (uint32_t)out * df;
    for (uint32_t f = 0; f < row; f++) d[f] = src[s0 + f];
    d[lightAt] = lightVec[0];
    d[lightAt + 1] = lightVec[1];
    d[lightAt + 2] = lightVec[2];
    d[lightAt + 3] = lightVec[3];
    out++;
  }
  return out;
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
  float *nearDist = (float *)(uintptr_t)t[T_NEAR_DIST];
  int32_t *nearSlot = (int32_t *)(uintptr_t)t[T_NEAR_SLOT];
  uint8_t *nearCount = (uint8_t *)(uintptr_t)t[T_NEAR_COUNT];
  float lightVec[4];

  if (begin < 0) begin = 0;
  if (nSun == 0) return cursor;
  if (maxPE > 0) for (uint32_t c = 0; c < nSun; c++) nearCount[c] = 0;
  Grid g;
  const int grid = gridCounts && gridStarts && gridItems
    ? build_grid(sun, nSun, sf, gridCounts, gridStarts, gridItems, t[T_GRID_COUNTS_CAP], t[T_GRID_ITEMS_CAP], &g)
    : 0;
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
    if (grid) {
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
            const uint32_t c = gridItems[p];
            const double dx = (double)sun[c * sf] - lx;
            const double dy = (double)sun[c * sf + 1] - ly;
            const double d2 = dx * dx + dy * dy;
            if (d2 > rangeSq) continue;
            tmpIdx[m] = c;
            dist[m] = (float)d2;
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
        m++;
      }
    }
    if (grid && m > 1 && maxPE == 0 && !(lim > 0 && m > (uint32_t)lim)) sort_pairs_by_index(tmpIdx, dist, m);
    if (m == 0) continue;
    m = take_closest(tmpIdx, dist, order, m, lim, keep);
    if (maxPE > 0) {
      for (uint32_t k = 0; k < m; k++) {
        const uint32_t c = keep[k];
        const double dx = (double)sun[c * sf] - lx;
        const double dy = (double)sun[c * sf + 1] - ly;
        note_nearest(nearDist, nearSlot, nearCount, c, i, dx * dx + dy * dy, maxPE);
      }
      continue;
    }
    lightVec[0] = (float)lx;
    lightVec[1] = (float)ly;
    lightVec[2] = (float)intensity;
    lightVec[3] = (float)rangeSq;
    const int32_t written = append_stamped(stamp, df, cursor, sun, sf, keep, m, lightVec, cap, lightAt);
    if (stampLightIdx) for (int32_t k = cursor; k < written; k++) stampLightIdx[k] = (uint16_t)i;
    cursor = written;
  }
  if (maxPE == 0) return cursor;
  for (uint32_t c = 0; c < nSun && cursor < cap; c++) {
    const uint32_t n = nearCount[c];
    const uint32_t base = c * maxPE;
    for (uint32_t k = 0; k < n && cursor < cap; k++) {
      const int32_t li = nearSlot[base + k];
      const double *L = lights + (uint32_t)li * LIGHT_DOUBLES;
      lightVec[0] = (float)L[0];
      lightVec[1] = (float)L[1];
      lightVec[2] = (float)L[2];
      lightVec[3] = (float)L[3];
      keep[0] = c;
      const int32_t written = append_stamped(stamp, df, cursor, sun, sf, keep, 1, lightVec, cap, lightAt);
      if (stampLightIdx && written > cursor) stampLightIdx[cursor] = (uint16_t)li;
      cursor = written;
    }
  }
  return cursor;
}
