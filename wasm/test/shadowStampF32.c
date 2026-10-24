/* Float32 variants of the shadow-caster stamp (wasm/shadowStamp.c, E-76 W23, E-114), a test module for the
   float32 pass (WASM_HYPOTHESES "Open decisions" 5). The shipped kernel tests each candidate in double, as
   stampLightRange does; here the test is float32: the light's x, y and rangeSq rounded to float once per
   light, then dx, dy and dx * dx + dy * dy in float and the range test against the float rangeSq (a NaN
   distance is kept, as in the JS). With maxShadowsPerEntity the per-caster nearest lights compare those float
   distances, read back from the gather's dist instead of computed again. The rest is the shipped code
   (included): the grid in double (the same casters binned in the same cells, the same cells walked), the
   index sort, takeClosest's quickselect and quicksort (already on float distances), the append. The rows are
   copies either way; float32 can change only which casters a light keeps, and in which order, where two
   distances, or a distance and the range, lie within float rounding of each other.
     stamp_light_range_f32    the candidate test in scalar float32
     stamp_light_range_f32x4  the candidate test four casters a step: their indices one v128 load from the
                              grid cell (consecutive in the full scan), x and y of each caster one 64-bit lane
                              load, dx * dx + dy * dy and the range test in f32x4, the kept lanes appended in
                              order; a block only while four more candidates fit the scratch, so the gather
                              stops where the scalar one does. Bit-identical to stamp_light_range_f32.
   Same table and memory contract as stamp_light_range, which this module also exports (the shipped body). */
#include <wasm_simd128.h>

#include "../shadowStamp.c"

/* note_nearest on float distances: ties still go to the smaller light index. */
INLINE void note_nearest_f32(float *nearDist, int32_t *nearSlot, uint8_t *nearCount, uint32_t caster, int32_t lightIndex,
                             float d2, uint32_t maxPE) {
  const uint32_t base = caster * maxPE;
  uint32_t n = nearCount[caster];
  if (n == maxPE) {
    const uint32_t worst = base + n - 1;
    const float wd = nearDist[worst];
    if (d2 > wd || (d2 == wd && lightIndex >= nearSlot[worst])) return;
    n--;
  }
  uint32_t i = n;
  while (i > 0) {
    const uint32_t prev = base + i - 1;
    const float pd = nearDist[prev];
    const int32_t pl = nearSlot[prev];
    if (pd < d2 || (pd == d2 && pl <= lightIndex)) break;
    nearDist[base + i] = pd;
    nearSlot[base + i] = pl;
    i--;
  }
  nearDist[base + i] = d2;
  nearSlot[base + i] = lightIndex;
  nearCount[caster] = (uint8_t)(n + 1);
}

/* One caster's test; appends it unless dx * dx + dy * dy is past rangeSq. Returns the new count. */
INLINE uint32_t test_one(const float *sun, uint32_t sf, uint32_t c, float lx, float ly, float rangeSq,
                         uint32_t *tmpIdx, float *dist, uint32_t m) {
  const float dx = sun[c * sf] - lx;
  const float dy = sun[c * sf + 1] - ly;
  const float d2 = dx * dx + dy * dy;
  if (d2 > rangeSq) return m;
  tmpIdx[m] = c;
  dist[m] = d2;
  return m + 1;
}

/* Four casters' tests (ids: their indices), the kept ones appended in lane order. Needs m + 4 <= the cap: a
   lane that is not kept is written at m and then overwritten or left past the count. */
INLINE uint32_t test_four(const float *sun, uint32_t sf, v128_t ids, v128_t lx, v128_t ly, v128_t rangeSq,
                          uint32_t *tmpIdx, float *dist, uint32_t m) {
  const uint32_t c0 = wasm_u32x4_extract_lane(ids, 0);
  const uint32_t c1 = wasm_u32x4_extract_lane(ids, 1);
  const uint32_t c2 = wasm_u32x4_extract_lane(ids, 2);
  const uint32_t c3 = wasm_u32x4_extract_lane(ids, 3);
  v128_t a = wasm_v128_load64_zero(sun + c0 * sf);
  a = wasm_v128_load64_lane(sun + c1 * sf, a, 1);
  v128_t b = wasm_v128_load64_zero(sun + c2 * sf);
  b = wasm_v128_load64_lane(sun + c3 * sf, b, 1);
  const v128_t dx = wasm_f32x4_sub(wasm_i32x4_shuffle(a, b, 0, 2, 4, 6), lx);
  const v128_t dy = wasm_f32x4_sub(wasm_i32x4_shuffle(a, b, 1, 3, 5, 7), ly);
  const v128_t d2 = wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dy, dy));
  const uint32_t past = (uint32_t)wasm_i32x4_bitmask(wasm_f32x4_gt(d2, rangeSq));
  if (past == 0) {
    wasm_v128_store(tmpIdx + m, ids);
    wasm_v128_store(dist + m, d2);
    return m + 4;
  }
  if (past == 15) return m;
  const uint32_t keep = ~past;
  tmpIdx[m] = c0;
  dist[m] = wasm_f32x4_extract_lane(d2, 0);
  m += keep & 1u;
  tmpIdx[m] = c1;
  dist[m] = wasm_f32x4_extract_lane(d2, 1);
  m += (keep >> 1) & 1u;
  tmpIdx[m] = c2;
  dist[m] = wasm_f32x4_extract_lane(d2, 2);
  m += (keep >> 2) & 1u;
  tmpIdx[m] = c3;
  dist[m] = wasm_f32x4_extract_lane(d2, 3);
  m += (keep >> 3) & 1u;
  return m;
}

/* stamp_light_range with the float32 candidate test (simd: 0 scalar, 1 f32x4; a constant once inlined). */
INLINE int32_t stamp_light_range_with(uint32_t table, const int simd) {
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
  const v128_t lane = wasm_u32x4_make(0, 1, 2, 3);
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
    const float lxf = (float)lx;
    const float lyf = (float)ly;
    const float rangeSqF = (float)rangeSq;
    const v128_t lx4 = wasm_f32x4_splat(lxf);
    const v128_t ly4 = wasm_f32x4_splat(lyf);
    const v128_t r4 = wasm_f32x4_splat(rangeSqF);
    uint32_t m = 0;
    if (grid) {
      /* The cell range in double, as shipped: the cells walked do not depend on the variant. */
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
          const int32_t to = gridStarts[cell + 1];
          int32_t p = gridStarts[cell];
          if (simd) {
            for (; p + 4 <= to && m + 4 <= tmpCap; p += 4) {
              m = test_four(sun, sf, wasm_v128_load(gridItems + p), lx4, ly4, r4, tmpIdx, dist, m);
            }
          }
          for (; p < to && m < tmpCap; p++) m = test_one(sun, sf, gridItems[p], lxf, lyf, rangeSqF, tmpIdx, dist, m);
        }
      }
    } else {
      uint32_t c = 0;
      if (simd) {
        for (; c + 4 <= nSun && m + 4 <= tmpCap; c += 4) {
          m = test_four(sun, sf, wasm_i32x4_add(wasm_i32x4_splat((int32_t)c), lane), lx4, ly4, r4, tmpIdx, dist, m);
        }
      }
      for (; c < nSun && m < tmpCap; c++) m = test_one(sun, sf, c, lxf, lyf, rangeSqF, tmpIdx, dist, m);
    }
    if (grid && m > 1 && maxPE == 0 && !(lim > 0 && m > (uint32_t)lim)) sort_pairs_by_index(tmpIdx, dist, m);
    if (m == 0) continue;
    /* takeClosest moves only `order`: a kept caster's distance is dist[order[k]] after a selection, dist[k]
       without one. */
    const int selected = lim > 0 && m > (uint32_t)lim;
    m = take_closest(tmpIdx, dist, order, m, lim, keep);
    if (maxPE > 0) {
      for (uint32_t k = 0; k < m; k++) {
        note_nearest_f32(nearDist, nearSlot, nearCount, keep[k], i, selected ? dist[order[k]] : dist[k], maxPE);
      }
      continue;
    }
    lightVec[0] = lxf;
    lightVec[1] = lyf;
    lightVec[2] = (float)intensity;
    lightVec[3] = rangeSqF;
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

__attribute__((export_name("stamp_light_range_f32")))
int32_t stamp_light_range_f32(uint32_t table) {
  return stamp_light_range_with(table, 0);
}

__attribute__((export_name("stamp_light_range_f32x4")))
int32_t stamp_light_range_f32x4(uint32_t table) {
  return stamp_light_range_with(table, 1);
}
