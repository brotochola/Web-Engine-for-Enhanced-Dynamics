/* The visibility sweep of one light (E-76 W2a), pre-render's: buildVisibilityPolygon
   (src/render/visibility/angularSweep.js) with emitVertex, emitArcVertices, rayCircleDist, rayPolyDist,
   distSqToConvex, pointInConvex, polyTangentIndices, sortEventsByAngle and buildFullCircle, and, when the
   light's polar bins hold a compound solid's boundary, clipVisibilityToPolar with mergeSweep and
   markSeenPolarOwners. One call per light (src/render/visibility/visibilitySweepClient.js).

   The two exports Chrome kept from the screen (wasm/test/visibilitySweep.c, the module
   visibilitySweepVariants, which keeps every variant timed): the same code, bit for bit
   (tests/node/visibilitySweepWasm.test.js compares them).
   - sweep_light_f32 (wasm.visibilitySweepF32, the default): the events keyed by mergeSweep's pseudoAngle of
     each event's own direction (the E-63 direction the ray uses) instead of normalizeAngleSigned(atan2(...)),
     with no atan2 or asin per occluder (a quarter turn is exactly one pseudo unit, so a free gap that may
     need midpoints is found without an angle; only there are the two ends' angles taken). What the ray
     tests take from the light and the occluder alone is worked out once per light: per polygon edge fx,
     fy, ex, ey and fx * ey - fy * ex, per circle dx, dy, dx * dx + dy * dy and r * r. The edge terms are
     rounded to float32 and each polygon's ray test runs in float32 (f32x4 over a 4-vertex polygon's
     edges), except a polygon with an edge whose line passes next to the light (rays meet it at a sine
     under 1e-3), which keeps the double terms (f64x2 for a box). Circles, tangents and the vertex placement
     stay double. Gate: 1e-4 of each vertex's distance from the light, plus a float32 ulp.
   - sweep_light_simd: the same in double (a box's ray test as two f64x2 halves). Gate: H-06's 1e-4 world
     units plus a float32 ulp of the coordinate.

   Every array is a byte offset into the imported memory, in a table of u32 words (T_* below) that the
   caller writes once; the light, its radius, its occluder count and whether its polar bins are active are
   the call's arguments. The occluders are laid out as pre-render packs them (kinds u8, circles f32, vertex
   starts i32, vertex counts u8, the world-space vertex pool f32) and the polygon comes back in the f32
   outputs. The scratch (events, the sort, the occluder cache, the active list, the merge's rays, the edge
   and circle terms) and the constant tables (the empty light's 32-gon, the polar bins' cos/sin/pseudoAngle,
   three doubles the JS module computes with Math.cos) come in by pointer: a kernel owns no memory. Results
   (the counts, the seen stamp, overflow flags, the merge's shape) go to the results words; the seen stamps
   of N-39 to the T_SEEN array, as sweepSawOccluder reads them, and the seen owners of N-19 to T_OWNER_SEEN
   when the caller gives one.

   No stack: every helper is inlined (the rules forbid a shadow stack) or takes and returns scalars, and no
   constant lives in a data segment (musl's atan tables became branch constants). */
#include <stdint.h>
#include <wasm_simd128.h>

#include "fdlibmSincos.h"

#define INLINE static inline __attribute__((always_inline))
/* Out of line: scalars in and out (no stack), one copy for every call site. */
#define OUTLINE static __attribute__((noinline))

#define PI 0x1.921fb54442d18p+1      /* Math.PI */
#define TWO_PI 0x1.921fb54442d18p+2  /* Math.PI * 2 */
#define MAX_FREE_GAP 0x1.921fb54442d18p+0 /* Math.PI / 2 */
#define EPSILON 1e-5
#define END_ANGLE (PI - EPSILON)
#define ARC_PAD 1e-6
#define OCC_CIRCLE 0

enum { MODE_SIMD, MODE_F32 };

/* The table, one u32 per slot: byte offsets, then counts and capacities. Mirrored by SWEEP_SLOTS in
   src/render/visibility/visibilitySweepClient.js. The edge terms are indexed like the vertex pool (edge i of
   a polygon is vertex vertStart + i to the next), the circle terms like the occluders. */
enum {
  T_KIND, T_CX, T_CY, T_CR, T_VERT_START, T_VERT_COUNT, T_VERTS_X, T_VERTS_Y,
  T_OUT_X, T_OUT_Y, T_MAX_VERTS,
  T_EV_KEY, T_EV_C, T_EV_S, T_EV_OCC, T_EV_TYPE, T_SORT, T_MAX_EVENTS,
  T_OCC_OPEN, T_OCC_CLOSE, T_OCC_VALID, T_SEEN, T_OCC_CACHE,
  T_ACTIVE, T_MAX_ACTIVE,
  T_CONSTS, T_FULL_C, T_FULL_S, T_FULL_SEGS,
  T_POLAR_DIST, T_POLAR_OWNER, T_POLAR_COS, T_POLAR_SIN, T_POLAR_PSEUDO, T_POLAR_BINS,
  T_RAY_ANG, T_RAY_COS, T_RAY_SIN, T_RAY_BEST,
  T_OWNER_SEEN, T_OWNER_SEEN_CAP, T_OWNER_STAMP,
  T_EDGE_FX, T_EDGE_FY, T_EDGE_EX, T_EDGE_EY, T_EDGE_TN,
  T_EDGE32_FX, T_EDGE32_FY, T_EDGE32_EX, T_EDGE32_EY, T_EDGE32_TN,
  T_CIRC_DX, T_CIRC_DY, T_CIRC_DD, T_CIRC_R2,
  T_OCC_F32,
  T_RESULTS,
  SLOT_COUNT
};

/* Doubles at T_CONSTS, as angularSweep.js computes them: 1 / Math.cos(MAX_FREE_GAP / 2), and the end
   direction Math.cos / Math.sin(Math.PI - EPSILON). */
enum { C_FREE_OVERSIZE, C_END_DIR_C, C_END_DIR_S, CONST_COUNT };

/* u32 words at T_RESULTS. R_STAMP carries the N-39 stamp from one call to the next (start it at 0). */
enum {
  R_SWEEP_COUNT, R_COUNT, R_STAMP, R_SEEN_VALID, R_EVENT_OVERFLOW, R_ACTIVE_OVERFLOW,
  R_MERGE_COUNT, R_MERGE_GROUP, R_MERGE_EDGES, R_OWNERS_MARKED, R_EVENTS,
  RESULT_COUNT
};

/* ---- fdlibm ------------------------------------------------------------------------------------------ */
/* musl's FreeBSD-derived atan, and atan2 as V8's ieee754::atan2 has it (FreeBSD e_atan2.c), as in
 * tests/bench/trigPremise/trigQ2.c, rewritten so they need no stack and no data: atan's atanhi/atanlo
 * tables are constants in the branch that picks them.
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 * musl libc is MIT licensed. */

INLINE double fd_atan(double x) {
  const double aT0 = 3.33333333333329318027e-01, aT1 = -1.99999999998764832476e-01,
               aT2 = 1.42857142725034663711e-01, aT3 = -1.11111104054623557880e-01,
               aT4 = 9.09088713343650656196e-02, aT5 = -7.69187620504482999495e-02,
               aT6 = 6.66107313738753120669e-02, aT7 = -5.83357013379057348645e-02,
               aT8 = 4.97687799461593236017e-02, aT9 = -3.65315727442169155270e-02,
               aT10 = 1.62858201153657823623e-02;
  uint32_t ix = (uint32_t)(weed_bits(x) >> 32);
  const uint32_t sign = ix >> 31;
  ix &= 0x7fffffffu;
  double hi = 0, lo = 0, z, w, s1, s2;
  int reduced = 1;
  if (ix >= 0x44100000u) { /* |x| >= 2^66 */
    if (x != x) return x;
    z = 1.57079632679489655800e+00 + 0x1p-120f;
    return sign ? -z : z;
  }
  if (ix < 0x3fdc0000u) { /* |x| < 0.4375 */
    if (ix < 0x3e400000u) return x; /* |x| < 2^-27 */
    reduced = 0;
  } else {
    x = __builtin_fabs(x);
    if (ix < 0x3ff30000u) {   /* |x| < 1.1875 */
      if (ix < 0x3fe60000u) { /* 7/16 <= |x| < 11/16 */
        hi = 4.63647609000806093515e-01;
        lo = 2.26987774529616870924e-17;
        x = (2.0 * x - 1.0) / (2.0 + x);
      } else {                /* 11/16 <= |x| < 19/16 */
        hi = 7.85398163397448278999e-01;
        lo = 3.06161699786838301793e-17;
        x = (x - 1.0) / (x + 1.0);
      }
    } else {
      if (ix < 0x40038000u) { /* |x| < 2.4375 */
        hi = 9.82793723247329054082e-01;
        lo = 1.39033110312309984516e-17;
        x = (x - 1.5) / (1.0 + 1.5 * x);
      } else {                /* 2.4375 <= |x| < 2^66 */
        hi = 1.57079632679489655800e+00;
        lo = 6.12323399573676603587e-17;
        x = -1.0 / x;
      }
    }
  }
  z = x * x;
  w = z * z;
  s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))));
  s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))));
  if (!reduced) return x - x * (s1 + s2);
  z = hi - (x * (s1 + s2) - lo - x);
  return sign ? -z : z;
}

OUTLINE double fd_atan2(double y, double x) {
  const double tiny = 1.0e-300, pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00,
               pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473531772e-16;
  const uint64_t bx = weed_bits(x);
  const uint64_t by = weed_bits(y);
  const int32_t hx = (int32_t)(uint32_t)(bx >> 32);
  const uint32_t lx = (uint32_t)bx;
  const int32_t ix = hx & 0x7fffffff;
  const int32_t hy = (int32_t)(uint32_t)(by >> 32);
  const uint32_t ly = (uint32_t)by;
  const int32_t iy = hy & 0x7fffffff;
  double z;
  int32_t k, m;
  if (((uint32_t)ix | ((lx | (0u - lx)) >> 31)) > 0x7ff00000u || ((uint32_t)iy | ((ly | (0u - ly)) >> 31)) > 0x7ff00000u)
    return x + y; /* x or y is NaN */
  if ((((uint32_t)hx - 0x3ff00000u) | lx) == 0) return fd_atan(y); /* x = 1.0 */
  m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2*sign(x)+sign(y) */
  /* The constant cases as selects, not switches: clang turns a switch of constants into a table in a data
     segment, which a kernel may not have. -(a + tiny) is -a - tiny, bit for bit. */
  if ((iy | (int32_t)ly) == 0) {
    if (!(m & 2)) return y;
    return (m & 1) ? -(pi + tiny) : pi + tiny;
  }
  if ((ix | (int32_t)lx) == 0) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
  if (ix == 0x7ff00000) {
    if (iy == 0x7ff00000) {
      const double v = (m & 2) ? 3.0 * pi_o_4 + tiny : pi_o_4 + tiny;
      return (m & 1) ? -v : v;
    }
    const double v = (m & 2) ? pi + tiny : 0.0;
    return (m & 1) ? -v : v;
  }
  if (iy == 0x7ff00000) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
  k = (iy - ix) >> 20;
  if (k > 60) { /* |y/x| > 2^60 */
    z = pi_o_2 + 0.5 * pi_lo;
    m &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0.0; /* 0 > |y|/x > -2^-60 */
  } else {
    z = fd_atan(__builtin_fabs(y / x));
  }
  if (m == 0) return z;
  if (m == 1) return -z;
  if (m == 2) return pi - (z - pi_lo);
  return (z - pi_lo) - pi;
}

OUTLINE double fd_cos(double x) {
  double s, c;
  weed_sincos(x, &s, &c); /* |x| < 2^20 pi/2 here: an angle of the sweep */
  return c;
}

OUTLINE double fd_sin(double x) {
  double s, c;
  weed_sincos(x, &s, &c);
  return s;
}

/* ---- the sweep's helpers ----------------------------------------------------------------------------- */

/* normalizeSweepPair / normalizeAngleSigned on one angle. */
INLINE double normalize_angle(double angle) {
  if (angle > PI) {
    angle -= TWO_PI;
    if (angle > PI) angle -= TWO_PI;
  } else if (angle <= -PI) {
    angle += TWO_PI;
    if (angle <= -PI) angle += TWO_PI;
  }
  return angle;
}

/* mergeSweep's pseudoAngle: keeps the order of atan2 over (-pi, pi], -2 at -pi, 2 at pi, one unit per
   quarter turn (exactly: rotating (x, y) by a quarter turn adds 1). */
INLINE double pseudo_angle(double x, double y) {
  const double ax = x < 0 ? -x : x;
  const double ay = y < 0 ? -y : y;
  const double p = ay / (ax + ay);
  if (y < 0) return x < 0 ? p - 2 : -p;
  return x < 0 ? 2 - p : p;
}

/* crossOrigin: (a - o) x (b - o). */
INLINE double cross_origin(double ox, double oy, double ax, double ay, double bx, double by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

INLINE int point_in_convex(double px, double py, const float *vx, const float *vy, int32_t start, int32_t count) {
  if (count < 3) return 0;
  int sign = 0;
  for (int32_t i = 0; i < count; i++) {
    const int32_t i0 = start + i;
    const int32_t i1 = start + (i + 1 < count ? i + 1 : 0);
    const double c = cross_origin(vx[i0], vy[i0], vx[i1], vy[i1], px, py);
    if (c == 0) continue;
    const int s = c > 0 ? 1 : -1;
    if (sign == 0) sign = s;
    else if (s != sign) return 0;
  }
  return sign != 0;
}

INLINE double dist_sq_to_convex(double px, double py, const float *vx, const float *vy, int32_t start, int32_t count) {
  if (point_in_convex(px, py, vx, vy, start, count)) return 0;
  double minSq = __builtin_inf();
  for (int32_t i = 0; i < count; i++) {
    const int32_t i0 = start + i;
    const int32_t i1 = start + (i + 1 < count ? i + 1 : 0);
    const double ax = vx[i0];
    const double ay = vy[i0];
    const double abx = (double)vx[i1] - ax;
    const double aby = (double)vy[i1] - ay;
    const double apx = px - ax;
    const double apy = py - ay;
    const double abLenSq = abx * abx + aby * aby;
    double t = abLenSq > 0 ? (apx * abx + apy * aby) / abLenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const double dx = ax + abx * t - px;
    const double dy = ay + aby * t - py;
    const double dSq = dx * dx + dy * dy;
    if (dSq < minSq) minSq = dSq;
  }
  return minSq;
}

/* polyTangentIndices: iLeft * 256 + iRight, or -1 when the light is inside (vertex counts are u8). */
INLINE int32_t poly_tangents(double lx, double ly, const float *vx, const float *vy, int32_t start, int32_t count) {
  if (count < 3) return -1;
  if (point_in_convex(lx, ly, vx, vy, start, count)) return -1;
  int32_t iLeft = 0;
  int32_t iRight = 0;
  for (int32_t i = 1; i < count; i++) {
    const double xi = vx[start + i];
    const double yi = vy[start + i];
    if (cross_origin(lx, ly, vx[start + iRight], vy[start + iRight], xi, yi) > 0) iRight = i;
    if (cross_origin(lx, ly, vx[start + iLeft], vy[start + iLeft], xi, yi) < 0) iLeft = i;
  }
  return iLeft * 256 + iRight;
}

/* rayCircleDist from the light's terms: d2 = (dx * dx + dy * dy) - tca * tca, as the JS evaluates it. */
INLINE double ray_circle_pre(double dx, double dy, double dd, double r2, double dirX, double dirY) {
  const double tca = dx * dirX + dy * dirY;
  if (tca < 0) return __builtin_inf();
  const double d2 = dd - tca * tca;
  if (d2 > r2) return __builtin_inf();
  const double thc = __builtin_sqrt(r2 - d2);
  const double t0 = tca - thc;
  return t0 > 0 ? t0 : tca + thc;
}

/* rayPolyDist from the light's edge terms. */
INLINE double ray_poly_pre(const double *efx, const double *efy, const double *eex, const double *eey,
                           const double *etn, int32_t start, int32_t count, double dirX, double dirY) {
  double minT = __builtin_inf();
  for (int32_t e = start; e < start + count; e++) {
    const double ex = eex[e];
    const double ey = eey[e];
    const double denom = dirX * ey - dirY * ex;
    if (__builtin_fabs(denom) < 1e-12) continue;
    const double t = etn[e] / denom;
    const double u = (efx[e] * dirY - efy[e] * dirX) / denom;
    if (t > EPSILON && u >= 0 && u <= 1 && t < minT) minT = t;
  }
  return minT;
}

#define EDGE_PAIR_PRE_F64(E)                                                                       \
  do {                                                                                             \
    const v128_t ex = wasm_v128_load(eex + (E));                                                   \
    const v128_t ey = wasm_v128_load(eey + (E));                                                   \
    const v128_t denom = wasm_f64x2_sub(wasm_f64x2_mul(dX, ey), wasm_f64x2_mul(dY, ex));           \
    const v128_t t = wasm_f64x2_div(wasm_v128_load(etn + (E)), denom);                             \
    const v128_t u = wasm_f64x2_div(                                                               \
        wasm_f64x2_sub(wasm_f64x2_mul(wasm_v128_load(efx + (E)), dY), wasm_f64x2_mul(wasm_v128_load(efy + (E)), dX)), \
        denom);                                                                                    \
    v128_t ok = wasm_f64x2_ge(wasm_f64x2_abs(denom), tinyDenom);                                   \
    ok = wasm_v128_and(ok, wasm_f64x2_gt(t, eps));                                                 \
    ok = wasm_v128_and(ok, wasm_f64x2_ge(u, zero));                                                \
    ok = wasm_v128_and(ok, wasm_f64x2_le(u, one));                                                 \
    best = wasm_f64x2_pmin(best, wasm_v128_bitselect(t, inf, ok));                                 \
  } while (0)

/* ray_poly_pre of a 4-edge polygon as two f64x2 halves. */
INLINE double ray_box_pre_f64x2(const double *efx, const double *efy, const double *eex, const double *eey,
                                const double *etn, int32_t start, double dirX, double dirY) {
  const v128_t dX = wasm_f64x2_splat(dirX);
  const v128_t dY = wasm_f64x2_splat(dirY);
  const v128_t tinyDenom = wasm_f64x2_splat(1e-12);
  const v128_t eps = wasm_f64x2_splat(EPSILON);
  const v128_t zero = wasm_f64x2_splat(0.0);
  const v128_t one = wasm_f64x2_splat(1.0);
  const v128_t inf = wasm_f64x2_splat(__builtin_inf());
  v128_t best = inf;
  EDGE_PAIR_PRE_F64(start);
  EDGE_PAIR_PRE_F64(start + 2);
  const double m0 = wasm_f64x2_extract_lane(best, 0);
  const double m1 = wasm_f64x2_extract_lane(best, 1);
  return m1 < m0 ? m1 : m0;
}

/* ray_poly_pre in float32. */
INLINE float ray_poly_pre_f32(const float *efx, const float *efy, const float *eex, const float *eey,
                              const float *etn, int32_t start, int32_t count, float dirX, float dirY) {
  float minT = __builtin_inff();
  for (int32_t e = start; e < start + count; e++) {
    const float ex = eex[e];
    const float ey = eey[e];
    const float denom = dirX * ey - dirY * ex;
    if (__builtin_fabsf(denom) < 1e-12f) continue;
    const float t = etn[e] / denom;
    const float u = (efx[e] * dirY - efy[e] * dirX) / denom;
    if (t > (float)EPSILON && u >= 0 && u <= 1 && t < minT) minT = t;
  }
  return minT;
}

/* ray_poly_pre_f32 of a 4-edge polygon in one f32x4. */
INLINE float ray_box_pre_f32x4(const float *efx, const float *efy, const float *eex, const float *eey,
                               const float *etn, int32_t start, float dirX, float dirY) {
  const v128_t dX = wasm_f32x4_splat(dirX);
  const v128_t dY = wasm_f32x4_splat(dirY);
  const v128_t ex = wasm_v128_load(eex + start);
  const v128_t ey = wasm_v128_load(eey + start);
  const v128_t denom = wasm_f32x4_sub(wasm_f32x4_mul(dX, ey), wasm_f32x4_mul(dY, ex));
  const v128_t t = wasm_f32x4_div(wasm_v128_load(etn + start), denom);
  const v128_t u = wasm_f32x4_div(
      wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(efx + start), dY), wasm_f32x4_mul(wasm_v128_load(efy + start), dX)),
      denom);
  v128_t ok = wasm_f32x4_ge(wasm_f32x4_abs(denom), wasm_f32x4_splat(1e-12f));
  ok = wasm_v128_and(ok, wasm_f32x4_gt(t, wasm_f32x4_splat((float)EPSILON)));
  ok = wasm_v128_and(ok, wasm_f32x4_ge(u, wasm_f32x4_splat(0.0f)));
  ok = wasm_v128_and(ok, wasm_f32x4_le(u, wasm_f32x4_splat(1.0f)));
  v128_t m = wasm_v128_bitselect(t, wasm_f32x4_splat(__builtin_inff()), ok);
  m = wasm_f32x4_pmin(m, wasm_i32x4_shuffle(m, m, 2, 3, 0, 1));
  m = wasm_f32x4_pmin(m, wasm_i32x4_shuffle(m, m, 1, 0, 3, 2));
  return wasm_f32x4_extract_lane(m, 0);
}

/* ---- one light ---------------------------------------------------------------------------------------- */

typedef struct {
  const uint8_t *kind;
  const float *cx, *cy, *cr;
  const int32_t *vertStart;
  const uint8_t *vertCount;
  const float *vx, *vy;
  float *outX, *outY;
  int32_t maxV;
  double *evKey, *evC, *evS;
  int32_t *evOcc;
  uint8_t *evType;
  int32_t *sortIdx;
  int32_t maxEvents;
  double *occOpen, *occClose;
  uint8_t *occValid;
  uint32_t *seen;
  int32_t cacheCap;
  int32_t *active;
  int32_t maxActive;
  const double *consts;
  const double *fullC, *fullS;
  int32_t fullSegs;
  uint32_t *res;
  uint32_t stamp;
  double lx, ly, R;
  /* The ray tests' per-light terms. */
  double *efx, *efy, *eex, *eey, *etn;
  float *ffx, *ffy, *fex, *fey, *ftn;
  double *cdx, *cdy, *cdd, *cr2;
  uint8_t *occF32; /* MODE_F32: 1 when the polygon's float32 terms hold the gate (see sweep_polygon) */
} Sweep;

/* emitVertex: one sample along the unit direction (dirX, dirY) over the active occluders. */
INLINE int32_t emit_vertex(const Sweep *s, int32_t activeCount, double dirX, double dirY, int32_t n, const int MODE) {
  if (n >= s->maxV) return n;
  const float dirXf = (float)dirX;
  const float dirYf = (float)dirY;
  double minDist = s->R;
  int32_t hitOcc = -1;
  for (int32_t a = 0; a < activeCount; a++) {
    const int32_t oi = s->active[a];
    double d;
    if (s->kind[oi] == OCC_CIRCLE) {
      d = ray_circle_pre(s->cdx[oi], s->cdy[oi], s->cdd[oi], s->cr2[oi], dirX, dirY);
    } else {
      const int32_t vs = s->vertStart[oi];
      const int32_t vc = s->vertCount[oi];
      const int f32 = MODE == MODE_F32 && s->occF32[oi];
      if (f32 && vc == 4) d = ray_box_pre_f32x4(s->ffx, s->ffy, s->fex, s->fey, s->ftn, vs, dirXf, dirYf);
      else if (f32) d = ray_poly_pre_f32(s->ffx, s->ffy, s->fex, s->fey, s->ftn, vs, vc, dirXf, dirYf);
      else if (vc == 4) d = ray_box_pre_f64x2(s->efx, s->efy, s->eex, s->eey, s->etn, vs, dirX, dirY);
      else d = ray_poly_pre(s->efx, s->efy, s->eex, s->eey, s->etn, vs, vc, dirX, dirY);
    }
    if (d < minDist) {
      minDist = d;
      hitOcc = oi;
    }
  }
  if (hitOcc >= 0 && minDist < s->R - EPSILON && hitOcc < s->cacheCap) s->seen[hitOcc] = s->stamp;

  const double placeDist = minDist >= s->R - EPSILON ? s->R * s->consts[C_FREE_OVERSIZE] : minDist;
  const double vx = s->lx + dirX * placeDist;
  const double vy = s->ly + dirY * placeDist;
  if (n > 0) {
    const double dx = vx - (double)s->outX[n - 1];
    const double dy = vy - (double)s->outY[n - 1];
    if (dx * dx + dy * dy < 0.25) return n;
  }
  s->outX[n] = (float)vx;
  s->outY[n] = (float)vy;
  return n + 1;
}

/* emitArcVertices: midpoints of a free gap wider than MAX_FREE_GAP. */
INLINE int32_t emit_arc(const Sweep *s, int32_t activeCount, double fromAngle, double toAngle, int32_t n, const int MODE) {
  const double gap = toAngle - fromAngle;
  if (gap <= MAX_FREE_GAP || gap <= 0) return n;
  const double steps = __builtin_ceil(gap / MAX_FREE_GAP);
  const double step = gap / steps;
  double c = fd_cos(fromAngle);
  double sn = fd_sin(fromAngle);
  const double ch = fd_cos(step);
  const double sh = fd_sin(step);
  for (int32_t k = 1; k < steps && n < s->maxV; k++) {
    const double nc = c * ch - sn * sh;
    const double ns = sn * ch + c * sh;
    c = nc;
    sn = ns;
    n = emit_vertex(s, activeCount, c, sn, n, MODE);
  }
  return n;
}

/* The sweep's angle of an event, taken only around a wide free gap. */
INLINE double event_angle(const Sweep *s, int32_t idx) {
  return normalize_angle(fd_atan2(s->evS[idx], s->evC[idx]));
}

INLINE int32_t full_circle(const Sweep *s) {
  const int32_t segments = s->fullSegs < s->maxV ? s->fullSegs : s->maxV;
  for (int32_t i = 0; i < segments; i++) {
    s->outX[i] = (float)(s->lx + s->fullC[i] * s->R);
    s->outY[i] = (float)(s->ly + s->fullS[i] * s->R);
  }
  return segments;
}

/* buildVisibilityPolygon after its stamp. */
INLINE int32_t sweep_polygon(Sweep *s, int32_t occCount, const int MODE) {
  if (occCount == 0) return full_circle(s);
  const double lx = s->lx;
  const double ly = s->ly;
  const double R = s->R;
  int32_t eventCount = 0;
  const int32_t cacheN = occCount < s->cacheCap ? occCount : s->cacheCap;
  for (int32_t i = 0; i < cacheN; i++) s->occValid[i] = 0;

  for (int32_t i = 0; i < occCount; i++) {
    double openK, closeK, oc, os, kc, ks;
    if (s->kind[i] == OCC_CIRCLE) {
      const double dx = (double)s->cx[i] - lx;
      const double dy = (double)s->cy[i] - ly;
      const double dist = __builtin_sqrt(dx * dx + dy * dy);
      const double r = s->cr[i];
      if (dist <= r) continue;
      if (dist - r > R) continue;
      const double sh = r / dist;
      if (sh < 0) continue; /* asin(r / dist) < 0 */
      /* E-63: the tangents' directions from the center direction, sin = r / dist, cos = sqrt(1 - sin^2). */
      const double cc = dx / dist;
      const double sc = dy / dist;
      const double ch = __builtin_sqrt(1 - sh * sh);
      oc = cc * ch + sc * sh;
      os = sc * ch - cc * sh;
      kc = cc * ch - sc * sh;
      ks = sc * ch + cc * sh;
      openK = pseudo_angle(oc, os);
      closeK = pseudo_angle(kc, ks);
      s->cdx[i] = dx;
      s->cdy[i] = dy;
      s->cdd[i] = dx * dx + dy * dy;
      s->cr2[i] = r * r;
    } else {
      const int32_t vs = s->vertStart[i];
      const int32_t vc = s->vertCount[i];
      if (vc < 3) continue;
      if (dist_sq_to_convex(lx, ly, s->vx, s->vy, vs, vc) > R * R) continue;
      const int32_t tangents = poly_tangents(lx, ly, s->vx, s->vy, vs, vc);
      if (tangents < 0) continue; /* light inside the polygon */
      const int32_t iLeft = tangents >> 8;
      const int32_t iRight = tangents & 255;
      const double oX = (double)s->vx[vs + iLeft] - lx;
      const double oY = (double)s->vy[vs + iLeft] - ly;
      const double kX = (double)s->vx[vs + iRight] - lx;
      const double kY = (double)s->vy[vs + iRight] - ly;
      const double oR = __builtin_sqrt(oX * oX + oY * oY);
      const double kR = __builtin_sqrt(kX * kX + kY * kY);
      /* A light on the vertex (length 0) keeps cos/sin of atan2's answer, as the JS does. */
      if (oR > 0) {
        oc = oX / oR;
        os = oY / oR;
      } else {
        const double a = normalize_angle(fd_atan2(oY, oX));
        oc = fd_cos(a);
        os = fd_sin(a);
      }
      if (kR > 0) {
        kc = kX / kR;
        ks = kY / kR;
      } else {
        const double a = normalize_angle(fd_atan2(kY, kX));
        kc = fd_cos(a);
        ks = fd_sin(a);
      }
      openK = pseudo_angle(oc, os);
      closeK = pseudo_angle(kc, ks);
      /* rayPolyDist's terms that do not depend on the ray, edge k from vertex vs + k. */
      int safe = 1;
      for (int32_t k = 0; k < vc; k++) {
        const int32_t i0 = vs + k;
        const int32_t i1 = vs + (k + 1 < vc ? k + 1 : 0);
        const double ax = s->vx[i0];
        const double ay = s->vy[i0];
        const double ex = (double)s->vx[i1] - ax;
        const double ey = (double)s->vy[i1] - ay;
        const double fx = ax - lx;
        const double fy = ay - ly;
        const double tn = fx * ey - fy * ex;
        s->efx[i0] = fx;
        s->efy[i0] = fy;
        s->eex[i0] = ex;
        s->eey[i0] = ey;
        s->etn[i0] = tn;
        if (MODE == MODE_F32) {
          s->ffx[i0] = (float)fx;
          s->ffy[i0] = (float)fy;
          s->fex[i0] = (float)ex;
          s->fey[i0] = (float)ey;
          s->ftn[i0] = (float)tn;
          /* A ray that hits this edge meets it at a sine of at least |tn| / (|e| max(|f|, |f + e|)) (the
             farther end); float32's relative error in the hit is about its epsilon over that sine. Under
             1e-3 (an edge whose line passes next to the light: a light on a box's corner) the polygon
             keeps the double terms. */
          const double gx = fx + ex;
          const double gy = fy + ey;
          const double f2 = fx * fx + fy * fy;
          const double g2 = gx * gx + gy * gy;
          if (tn * tn < 1e-6 * (ex * ex + ey * ey) * (f2 > g2 ? f2 : g2)) safe = 0;
        }
      }
      if (MODE == MODE_F32) s->occF32[i] = (uint8_t)safe;
    }
    if (i < s->cacheCap) {
      s->occOpen[i] = openK;
      s->occClose[i] = closeK;
      s->occValid[i] = 1;
    }
    if (eventCount + 2 > s->maxEvents) {
      s->res[R_SEEN_VALID] = 0;
      s->res[R_EVENT_OVERFLOW] = 1;
      return full_circle(s);
    }
    s->evKey[eventCount] = openK;
    s->evC[eventCount] = oc;
    s->evS[eventCount] = os;
    s->evOcc[eventCount] = i;
    s->evType[eventCount] = 1;
    eventCount++;
    s->evKey[eventCount] = closeK;
    s->evC[eventCount] = kc;
    s->evS[eventCount] = ks;
    s->evOcc[eventCount] = i;
    s->evType[eventCount] = 0;
    eventCount++;
  }
  s->res[R_EVENTS] = (uint32_t)eventCount;
  if (eventCount == 0) return full_circle(s);

  /* sortEventsByAngle: insertion sort of the indices, stable. */
  int32_t *idxs = s->sortIdx;
  const double *keys = s->evKey;
  for (int32_t i = 0; i < eventCount; i++) idxs[i] = i;
  for (int32_t i = 1; i < eventCount; i++) {
    const int32_t key = idxs[i];
    const double keyAngle = keys[key];
    int32_t j = i - 1;
    while (j >= 0 && keys[idxs[j]] > keyAngle) {
      idxs[j + 1] = idxs[j];
      j--;
    }
    idxs[j + 1] = key;
  }

  /* The active set at the sweep's start (-pi): the occluders whose span wraps. */
  int32_t activeCount = 0;
  for (int32_t i = 0; i < occCount; i++) {
    if (i >= s->cacheCap || !s->occValid[i]) continue;
    if (s->occOpen[i] > s->occClose[i]) {
      if (activeCount < s->maxActive) {
        s->active[activeCount++] = i;
      } else {
        s->res[R_SEEN_VALID] = 0;
        s->res[R_ACTIVE_OVERFLOW] = 1;
        return full_circle(s);
      }
    }
  }

  int32_t n = 0;
  double lastKey = -2.0; /* -pi */
  int32_t lastIdx = -1;

  /* e = -1 is the start sample (-pi) and e = eventCount the last free arc and the end sample, so that
     emitVertex is inlined at two sites (the arc's and the samples'), not six. */
  for (int32_t e = -1; e <= eventCount; e++) {
    const int end = e == eventCount;
    const int32_t idx = e >= 0 && !end ? idxs[e] : 0;
    double ca = -1.0;
    double sa = 0.0;
    if (e >= 0) {
      if ((end ? 2.0 : keys[idx]) - lastKey > 1.0) {
        /* Over a quarter turn of pseudo angle is over a quarter turn of angle: maybe a wide free gap. */
        const double from = lastIdx < 0 ? -PI : event_angle(s, lastIdx) + EPSILON;
        n = emit_arc(s, activeCount, from, end ? END_ANGLE : event_angle(s, idx) - EPSILON, n, MODE);
      }
      ca = end ? s->consts[C_END_DIR_C] : s->evC[idx];
      sa = end ? s->consts[C_END_DIR_S] : s->evS[idx];
    }
    /* H-06 / E-63: the samples just before and after the event, from the event's own direction; the
       start and the end are one sample along their own. */
    for (int side = 0; side < 2; side++) {
      double dirX = ca;
      double dirY = sa;
      if (e < 0 || end) {
        if (side) break;
      } else if (side == 0) {
        dirX = ca + EPSILON * sa;
        dirY = sa - EPSILON * ca;
      } else {
        const int32_t oi = s->evOcc[idx];
        if (s->evType[idx]) {
          if (activeCount < s->maxActive) {
            s->active[activeCount++] = oi;
          } else {
            s->res[R_SEEN_VALID] = 0;
            s->res[R_ACTIVE_OVERFLOW] = 1;
            return full_circle(s);
          }
        } else {
          for (int32_t a = 0; a < activeCount; a++) {
            if (s->active[a] == oi) {
              s->active[a] = s->active[--activeCount];
              break;
            }
          }
        }
        dirX = ca - EPSILON * sa;
        dirY = sa + EPSILON * ca;
      }
      if (n < s->maxV) n = emit_vertex(s, activeCount, dirX, dirY, n, MODE);
    }
    if (e >= 0 && !end) {
      lastKey = keys[idx];
      lastIdx = idx;
    }
  }
  return n;
}

/* ---- the polar merge (compound solids) --------------------------------------------------------------- */

INLINE double ray_seg_t(double ox, double oy, double dx, double dy, double ax, double ay, double bx, double by) {
  const double ex = bx - ax;
  const double ey = by - ay;
  const double denom = dx * ey - dy * ex;
  if (__builtin_fabs(denom) < 1e-12) return __builtin_inf();
  const double fx = ax - ox;
  const double fy = ay - oy;
  const double t = (fx * ey - fy * ex) / denom;
  const double u = (fx * dy - fy * dx) / denom;
  if (t > 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) return t;
  return __builtin_inf();
}

INLINE int32_t first_ray_at_or_after(const double *rayAng, int32_t n, double a) {
  int32_t lo = 0;
  int32_t hi = n;
  while (lo < hi) {
    const int32_t mid = (lo + hi) >> 1;
    if (rayAng[mid] < a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

INLINE int32_t first_ray_after(const double *rayAng, int32_t n, double a) {
  int32_t lo = 0;
  int32_t hi = n;
  while (lo < hi) {
    const int32_t mid = (lo + hi) >> 1;
    if (rayAng[mid] <= a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* clipVisibilityToPolar with mergeSweep (E-43), in and out the same buffers; then markSeenPolarOwners. */
INLINE int32_t clip_polar(const uint32_t *t, Sweep *s, int32_t n) {
  const int32_t cap = s->maxV;
  if (cap < 3) return n;
  const int32_t bins = (int32_t)t[T_POLAR_BINS];
  const int32_t group = cap >= bins ? 1 : (bins + cap - 1) / cap;
  const int32_t count = group == 1 ? bins : (bins + group - 1) / group;
  const float *polarDist = (const float *)(uintptr_t)t[T_POLAR_DIST];
  const double *polarCos = (const double *)(uintptr_t)t[T_POLAR_COS];
  const double *polarSin = (const double *)(uintptr_t)t[T_POLAR_SIN];
  const double *polarPseudo = (const double *)(uintptr_t)t[T_POLAR_PSEUDO];
  double *rayAng = (double *)(uintptr_t)t[T_RAY_ANG];
  double *rayCos = (double *)(uintptr_t)t[T_RAY_COS];
  double *raySin = (double *)(uintptr_t)t[T_RAY_SIN];
  double *rayBest = (double *)(uintptr_t)t[T_RAY_BEST];
  const double lx = s->lx;
  const double ly = s->ly;
  const double radius = s->R > 0 ? s->R : 0; /* clearPolarBins(radius) with the light's radius */
  const float *xs = s->outX;
  const float *ys = s->outY;
  const int32_t edges = n >= 3 ? n : 0;

  if (edges > 0) {
    for (int32_t k = 0; k < count; k++) {
      const int32_t b0 = k * group;
      const int32_t b1 = b0 + group < bins ? b0 + group : bins;
      const int32_t m = b0 + b1;
      rayAng[k] = polarPseudo[m];
      rayCos[k] = polarCos[m];
      raySin[k] = polarSin[m];
      rayBest[k] = radius;
    }
  }
  for (int32_t i = 0; i < edges; i++) {
    const int32_t j = i + 1 < edges ? i + 1 : 0;
    const double ax = xs[i];
    const double ay = ys[i];
    const double bx = xs[j];
    const double by = ys[j];
    const double ex = bx - ax;
    const double ey = by - ay;
    const double fx = ax - lx;
    const double fy = ay - ly;
    const double sx = fx - 1e-4 * ex;
    const double sy = fy - 1e-4 * ey;
    const double tx = fx + (1 + 1e-4) * ex;
    const double ty = fy + (1 + 1e-4) * ey;
    const double cr = sx * ty - sy * tx;
    int32_t k0 = 0;
    int32_t k1 = count;
    int32_t k2 = 0;
    if (cr * cr > 1e-6 * (sx * sx + sy * sy) * (tx * tx + ty * ty) || sx * tx + sy * ty > 0) {
      const double ps = pseudo_angle(sx, sy);
      const double pt = pseudo_angle(tx, ty);
      const double p0 = cr >= 0 ? ps : pt;
      const double p1 = cr >= 0 ? pt : ps;
      double lo, hi;
      if (p1 >= p0) {
        lo = p0;
        hi = p1;
      } else if (p0 - p1 < ARC_PAD) {
        lo = p1;
        hi = p0;
      } else {
        lo = p0;
        hi = p1 + 4;
      }
      lo -= ARC_PAD;
      hi += ARC_PAD;
      if (lo < -2) {
        k0 = first_ray_at_or_after(rayAng, count, lo + 4);
        k2 = first_ray_after(rayAng, count, hi);
      } else if (hi > 2) {
        k0 = first_ray_at_or_after(rayAng, count, lo);
        k2 = first_ray_after(rayAng, count, hi - 4);
      } else {
        k0 = first_ray_at_or_after(rayAng, count, lo);
        k1 = first_ray_after(rayAng, count, hi);
      }
    }
    for (int32_t k = k0; k < k1; k++) {
      const double tt = ray_seg_t(lx, ly, rayCos[k], raySin[k], ax, ay, bx, by);
      if (tt < rayBest[k]) rayBest[k] = tt;
    }
    for (int32_t k = 0; k < k2; k++) {
      const double tt = ray_seg_t(lx, ly, rayCos[k], raySin[k], ax, ay, bx, by);
      if (tt < rayBest[k]) rayBest[k] = tt;
    }
  }
  for (int32_t k = 0; k < count; k++) {
    const int32_t b0 = k * group;
    const int32_t b1 = b0 + group < bins ? b0 + group : bins;
    double d = polarDist[b0];
    for (int32_t b = b0 + 1; b < b1; b++) {
      if (polarDist[b] < d) d = polarDist[b];
    }
    if (edges > 0 && rayBest[k] < d) d = rayBest[k];
    const int32_t m = b0 + b1;
    s->outX[k] = (float)(lx + polarCos[m] * d);
    s->outY[k] = (float)(ly + polarSin[m] * d);
  }
  s->res[R_MERGE_COUNT] = (uint32_t)count;
  s->res[R_MERGE_GROUP] = (uint32_t)group;
  s->res[R_MERGE_EDGES] = (uint32_t)edges;

  /* markSeenPolarOwners, when the caller gave a seen array. */
  uint32_t *ownerSeen = (uint32_t *)(uintptr_t)t[T_OWNER_SEEN];
  if (ownerSeen) {
    const int32_t *polarOwner = (const int32_t *)(uintptr_t)t[T_POLAR_OWNER];
    const uint32_t seenCap = t[T_OWNER_SEEN_CAP];
    const uint32_t stamp = t[T_OWNER_STAMP];
    int32_t marked = 0;
    for (int32_t k = 0; k < count; k++) {
      const int32_t b0 = k * group;
      const int32_t b1 = b0 + group < bins ? b0 + group : bins;
      const double sweep = edges > 0 ? rayBest[k] : __builtin_inf();
      for (int32_t b = b0; b < b1; b++) {
        const int32_t owner = polarOwner[b];
        if (owner >= 0 && (double)polarDist[b] <= sweep) {
          if ((uint32_t)owner < seenCap) ownerSeen[owner] = stamp;
          marked++;
        }
      }
    }
    s->res[R_OWNERS_MARKED] = (uint32_t)marked;
  }
  return count;
}

INLINE int32_t sweep_light(uint32_t table, double lx, double ly, double maxRadius, int32_t occCount, int32_t polar,
                           const int MODE) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  Sweep s;
  s.kind = (const uint8_t *)(uintptr_t)t[T_KIND];
  s.cx = (const float *)(uintptr_t)t[T_CX];
  s.cy = (const float *)(uintptr_t)t[T_CY];
  s.cr = (const float *)(uintptr_t)t[T_CR];
  s.vertStart = (const int32_t *)(uintptr_t)t[T_VERT_START];
  s.vertCount = (const uint8_t *)(uintptr_t)t[T_VERT_COUNT];
  s.vx = (const float *)(uintptr_t)t[T_VERTS_X];
  s.vy = (const float *)(uintptr_t)t[T_VERTS_Y];
  s.outX = (float *)(uintptr_t)t[T_OUT_X];
  s.outY = (float *)(uintptr_t)t[T_OUT_Y];
  s.maxV = (int32_t)t[T_MAX_VERTS];
  s.evKey = (double *)(uintptr_t)t[T_EV_KEY];
  s.evC = (double *)(uintptr_t)t[T_EV_C];
  s.evS = (double *)(uintptr_t)t[T_EV_S];
  s.evOcc = (int32_t *)(uintptr_t)t[T_EV_OCC];
  s.evType = (uint8_t *)(uintptr_t)t[T_EV_TYPE];
  s.sortIdx = (int32_t *)(uintptr_t)t[T_SORT];
  s.maxEvents = (int32_t)t[T_MAX_EVENTS];
  s.occOpen = (double *)(uintptr_t)t[T_OCC_OPEN];
  s.occClose = (double *)(uintptr_t)t[T_OCC_CLOSE];
  s.occValid = (uint8_t *)(uintptr_t)t[T_OCC_VALID];
  s.seen = (uint32_t *)(uintptr_t)t[T_SEEN];
  s.cacheCap = (int32_t)t[T_OCC_CACHE];
  s.active = (int32_t *)(uintptr_t)t[T_ACTIVE];
  s.maxActive = (int32_t)t[T_MAX_ACTIVE];
  s.consts = (const double *)(uintptr_t)t[T_CONSTS];
  s.fullC = (const double *)(uintptr_t)t[T_FULL_C];
  s.fullS = (const double *)(uintptr_t)t[T_FULL_S];
  s.fullSegs = (int32_t)t[T_FULL_SEGS];
  s.res = (uint32_t *)(uintptr_t)t[T_RESULTS];
  s.lx = lx;
  s.ly = ly;
  s.R = maxRadius;
  s.efx = (double *)(uintptr_t)t[T_EDGE_FX];
  s.efy = (double *)(uintptr_t)t[T_EDGE_FY];
  s.eex = (double *)(uintptr_t)t[T_EDGE_EX];
  s.eey = (double *)(uintptr_t)t[T_EDGE_EY];
  s.etn = (double *)(uintptr_t)t[T_EDGE_TN];
  s.ffx = (float *)(uintptr_t)t[T_EDGE32_FX];
  s.ffy = (float *)(uintptr_t)t[T_EDGE32_FY];
  s.fex = (float *)(uintptr_t)t[T_EDGE32_EX];
  s.fey = (float *)(uintptr_t)t[T_EDGE32_EY];
  s.ftn = (float *)(uintptr_t)t[T_EDGE32_TN];
  s.cdx = (double *)(uintptr_t)t[T_CIRC_DX];
  s.cdy = (double *)(uintptr_t)t[T_CIRC_DY];
  s.cdd = (double *)(uintptr_t)t[T_CIRC_DD];
  s.cr2 = (double *)(uintptr_t)t[T_CIRC_R2];
  s.occF32 = (uint8_t *)(uintptr_t)t[T_OCC_F32];

  /* N-39's stamp: one per call, the seen array cleared when it wraps. */
  uint32_t stamp = s.res[R_STAMP] + 1;
  if (stamp == 0) {
    for (int32_t i = 0; i < s.cacheCap; i++) s.seen[i] = 0;
    stamp = 1;
  }
  s.stamp = stamp;
  s.res[R_STAMP] = stamp;
  s.res[R_SEEN_VALID] = 1;
  s.res[R_EVENT_OVERFLOW] = 0;
  s.res[R_ACTIVE_OVERFLOW] = 0;
  s.res[R_MERGE_COUNT] = 0xffffffffu; /* -1: no merge ran (clearPolarBins) */
  s.res[R_OWNERS_MARKED] = 0xffffffffu;
  s.res[R_EVENTS] = 0;

  int32_t n = sweep_polygon(&s, occCount, MODE);
  s.res[R_SWEEP_COUNT] = (uint32_t)n;
  if (polar) n = clip_polar(t, &s, n);
  s.res[R_COUNT] = (uint32_t)n;
  return n;
}

__attribute__((export_name("sweep_light_f32")))
int32_t sweep_light_f32(uint32_t table, double lx, double ly, double maxRadius, int32_t occCount, int32_t polar) {
  return sweep_light(table, lx, ly, maxRadius, occCount, polar, MODE_F32);
}

__attribute__((export_name("sweep_light_simd")))
int32_t sweep_light_simd(uint32_t table, double lx, double ly, double maxRadius, int32_t occCount, int32_t polar) {
  return sweep_light(table, lx, ly, maxRadius, occCount, polar, MODE_SIMD);
}
