/* The compound-solid polar raster (E-76 W1), a test module: collectSolidSegments
   (src/render/visibility/angularSweep.js) with rasterPolarSpan, stampPolarBin and raySegT inlined, the whole
   edge loop of one (light, compound solid) pair in one call. The bins live in the memory instead of the
   module's _polarDist / _polarOwner; every array is a byte offset, the per-worker ones through the context
   table (ctx), the solid's own ones (solid.seg, solid.chain) as arguments. Each call returns the JS's `hit`
   and stores 1 at C_ACTIVE when it stamped a bin (the JS's `_polarActive = 1`); the caller clears the bins and
   the flag (clearPolarBins). One export per variant:

   collect_solid_f64     the JS's arithmetic and loop, angles by an fdlibm atan2 written as V8's
                         ieee754::atan2 has it (tests/bench/trigPremise/trigQ2.c) over musl's atan, with
                         normalizeAngleSigned and the JS's reuse of the last end's angle (E-61). Bit for bit
                         the JS where Math.atan2 is that fdlibm (Node 22); Chrome's differs by an ulp in some
                         angles (Q2), which moves a span edge only when an end is that close to a bin edge.
   collect_solid_pseudo  no atan2. The bins are uniform in angle, 64 to each octant, so an end's bin is its
                         octant and a search of tan(k pi / 256) for min(|dx|, |dy|) / max(|dx|, |dy|) (pseudo_bin).
                         The angles did three more things: the swap (a front-facing edge always takes it, its
                         cross product is the JS's own facing test), the 1e-4 span cutoff (a cross/dot test of
                         the two ends) and the wrap (the bins' order). Every other value is the JS's: a bin it
                         stamps holds the JS's distance and owner, bit for bit, and the bins it stamps are the
                         JS's except where an end lies within about 1e-15 rad of a bin edge (the JS's own
                         rounding blurs the edge there), which moves that span's first or last bin by one.
                         An end shared with the previous edge reuses its world position and bin (same float bits
                         in solid.seg give the same doubles).
   collect_solid_fast    pseudo, with the range test taking an end inside the disc without its division, and
                         each bin stamped through a division-free filter (a hair wider than the JS's tests)
                         before the JS's own two divisions and tests: same results, about one division per
                         stamp that wins instead of two per stamp.
   collect_solid_f64x2   fast, with two bins per f64x2: the JS's raySegT lane by lane (the same operations in
                         the same order, so the same doubles), the winning lanes blended into the bins.
   collect_solid_f32x4   fast, with four bins per f32x4 through a float filter whose margins cover its rounding
                         (so it passes every bin the JS stamps), and the JS's raySegT in double for each lane it
                         passes.

   The angle reuse in f64 and the bin reuse in the others follow solid.chain (E-61's walk order); the bins take
   a minimum, so the order changes only the JS's `hit` count past its first, which callers read as hit > 0. */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))

#define BINS 512
#define BIN_MASK 511
#define PI 3.141592653589793
#define TWO_PI (PI * 2.0)
#define BIN_SCALE (512.0 / TWO_PI)
/* tan(1e-4) (Math.tan(1e-4)): a span is over 1e-4 rad when -cross > tan(1e-4) * dot, or dot <= 0. */
#define TAN_SPAN_MIN 1.0000000033333334e-4
/* atan(r) * 256 / pi to within 0.13 for r in [0, 1]: r * (64 + (1 - r) * (A + B * r))
   (pi/4 r + r (1 - r)(0.2447 + 0.0663 r), in bin units). */
#define ATAN_A (0.2447 * 256.0 / PI)
#define ATAN_B (0.0663 * 256.0 / PI)
/* The division-free filter's widening: 1e-12 relative, far above the 2^-52 its rounding can differ by. */
#define WIDE_LO (1.0 - 1e-12)
#define WIDE_HI (1.0 + 1e-12)
/* The float filter's margins, relative to |e|_1, |f|_1 and the edge's cross product: four times the
   rounding of its products and sums (4 * 2^-24 relative each). */
#define F32_MARGIN 1e-6

enum {
  C_DIST,   /* f32[512]: each bin's nearest hit (the JS's _polarDist) */
  C_OWNER,  /* i32[512]: who stamped it (_polarOwner) */
  C_ACTIVE, /* i32: set to 1 when a bin is stamped (_polarActive) */
  C_COS,    /* f64[512]: cos of bin b's centre ray (the JS's _polarCos[2b + 1]) */
  C_SIN,    /* f64[512]: sin of it (_polarSin[2b + 1]) */
  C_COSF,   /* f32[516]: C_COS rounded to float, then [0..3] again (four-lane loads at bin 511) */
  C_SINF,   /* f32[516] */
  C_TAN,    /* f64[65]: tan(k pi / 256); [0] = 0, [64] = 1 */
  CTX_SLOTS
};

INLINE uint64_t bits64(double x) {
  union { double f; uint64_t i; } u = { .f = x };
  return u.i;
}

/* musl's atan (FreeBSD s_atan.c). The atanhi/atanlo tables are the constants of their branch, so the module
   has no data segment.
   ====================================================
   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
   Developed at SunPro, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and distribute
   this software is freely granted, provided that this notice is preserved.
   ==================================================== */
INLINE double fd_atan(double x) {
  const double aT0 = 3.33333333333329318027e-01, aT1 = -1.99999999998764832476e-01,
               aT2 = 1.42857142725034663711e-01, aT3 = -1.11111104054623557880e-01,
               aT4 = 9.09088713343650656196e-02, aT5 = -7.69187620504482999495e-02,
               aT6 = 6.66107313738753120669e-02, aT7 = -5.83357013379057348645e-02,
               aT8 = 4.97687799461593236017e-02, aT9 = -3.65315727442169155270e-02,
               aT10 = 1.62858201153657823623e-02;
  uint32_t ix = (uint32_t)(bits64(x) >> 32);
  const uint32_t sign = ix >> 31;
  ix &= 0x7fffffff;
  if (ix >= 0x44100000) { /* |x| >= 2^66 */
    if (x != x) return x;
    const double z = 1.57079632679489655800e+00 + 0x1p-120f;
    return sign ? -z : z;
  }
  int id;
  double hi = 0;
  double lo = 0;
  if (ix < 0x3fdc0000) { /* |x| < 0.4375 */
    if (ix < 0x3e400000) return x; /* |x| < 2^-27 */
    id = -1;
  } else {
    x = __builtin_fabs(x);
    if (ix < 0x3ff30000) { /* |x| < 1.1875 */
      if (ix < 0x3fe60000) { /* 7/16 <= |x| < 11/16 */
        id = 0;
        hi = 4.63647609000806093515e-01;
        lo = 2.26987774529616870924e-17;
        x = (2.0 * x - 1.0) / (2.0 + x);
      } else { /* 11/16 <= |x| < 19/16 */
        id = 1;
        hi = 7.85398163397448278999e-01;
        lo = 3.06161699786838301793e-17;
        x = (x - 1.0) / (x + 1.0);
      }
    } else if (ix < 0x40038000) { /* |x| < 2.4375 */
      id = 2;
      hi = 9.82793723247329054082e-01;
      lo = 1.39033110312309984516e-17;
      x = (x - 1.5) / (1.0 + 1.5 * x);
    } else { /* 2.4375 <= |x| < 2^66 */
      id = 3;
      hi = 1.57079632679489655800e+00;
      lo = 6.12323399573676603587e-17;
      x = -1.0 / x;
    }
  }
  const double z = x * x;
  const double w = z * z;
  const double s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))));
  const double s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))));
  if (id < 0) return x - x * (s1 + s2);
  const double r = hi - (x * (s1 + s2) - lo - x);
  return sign ? -r : r;
}

/* atan2 as V8's ieee754::atan2 has it (FreeBSD e_atan2.c; see trigQ2.c), its switches as selects so no
   lookup table is made of them. */
INLINE double fd_atan2(double y, double x) {
  const double tiny = 1.0e-300, pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00,
               pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473531772e-16;
  const uint64_t bx = bits64(x);
  const uint64_t by = bits64(y);
  const int32_t hx = (int32_t)(bx >> 32);
  const uint32_t lx = (uint32_t)bx;
  const int32_t hy = (int32_t)(by >> 32);
  const uint32_t ly = (uint32_t)by;
  const int32_t ix = hx & 0x7fffffff;
  const int32_t iy = hy & 0x7fffffff;
  if (((uint32_t)ix | ((lx | (0u - lx)) >> 31)) > 0x7ff00000u ||
      ((uint32_t)iy | ((ly | (0u - ly)) >> 31)) > 0x7ff00000u)
    return x + y; /* x or y is NaN */
  if ((((uint32_t)hx - 0x3ff00000u) | lx) == 0) return fd_atan(y); /* x = 1.0 */
  int32_t m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2 * sign(x) + sign(y) */
  if ((iy | (int32_t)ly) == 0) {
    if (m < 2) return y;
    return m == 2 ? pi + tiny : -pi - tiny;
  }
  if ((ix | (int32_t)lx) == 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
  if (ix == 0x7ff00000) {
    if (iy == 0x7ff00000) {
      const double z = (m & 2) ? 3.0 * pi_o_4 + tiny : pi_o_4 + tiny;
      return (m & 1) ? -z : z;
    }
    if (m < 2) return m ? -0.0 : 0.0;
    return m == 2 ? pi + tiny : -pi - tiny;
  }
  if (iy == 0x7ff00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
  const int32_t k = (iy - ix) >> 20;
  double z;
  if (k > 60) { /* |y/x| > 2^60 */
    z = pi_o_2 + 0.5 * pi_lo;
    m &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0.0; /* 0 > |y|/x > -2^-60 */
  } else {
    z = fd_atan(__builtin_fabs(y / x));
  }
  if (m < 2) return m ? -z : z;
  const double zl = z - pi_lo;
  return m == 2 ? pi - zl : zl - pi;
}

/* normalizeAngleSigned (src/util/utils.js). */
INLINE double normalize_angle_signed(double a) {
  if (a > PI) {
    a -= TWO_PI;
    if (a > PI) a -= TWO_PI;
  } else if (a <= -PI) {
    a += TWO_PI;
    if (a <= -PI) a += TWO_PI;
  }
  return a;
}

/* segmentDistSq */
INLINE double seg_dist_sq(double px, double py, double ax, double ay, double bx, double by) {
  const double abx = bx - ax;
  const double aby = by - ay;
  const double apx = px - ax;
  const double apy = py - ay;
  const double abLenSq = abx * abx + aby * aby;
  double t = abLenSq > 0 ? (apx * abx + apy * aby) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const double dx = ax + abx * t - px;
  const double dy = ay + aby * t - py;
  return dx * dx + dy * dy;
}

/* segmentDistSq(light, p0, p1) <= radiusSq. `fast`: an end inside the disc answers without the division
   (the nearest point of a segment is no farther than its ends; the JS's sum differs only where both are
   within rounding of the radius). tx, ty = light - p0; bx, by = p1 - light. */
INLINE int in_range(double lightX, double lightY, double x0, double y0, double x1, double y1, double tx, double ty,
                    double bx, double by, double radiusSq, const int fast) {
  if (fast && (tx * tx + ty * ty <= radiusSq || bx * bx + by * by <= radiusSq)) return 1;
  return seg_dist_sq(lightX, lightY, x0, y0, x1, y1) <= radiusSq;
}

/* raySegT */
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

/* stampPolarBin, the bin's direction read from the centre tables. */
INLINE int stamp_js(float *dist, int32_t *own, int32_t b, const double *cosC, const double *sinC, double lx,
                    double ly, double x0, double y0, double x1, double y1, int32_t owner) {
  const double t = ray_seg_t(lx, ly, cosC[b], sinC[b], x0, y0, x1, y1);
  if (t < (double)dist[b]) {
    dist[b] = (float)t;
    own[b] = owner;
    return 1;
  }
  return 0;
}

/* rasterPolarSpan */
INLINE int raster_span_js(double open, double close, double x0, double y0, double x1, double y1, double lx,
                          double ly, int32_t owner, float *dist, int32_t *own, const double *cosC,
                          const double *sinC) {
  double span = close - open;
  if (span < 0) span += TWO_PI;
  if (span > PI) {
    const double swap = open;
    open = close;
    close = swap;
    span = TWO_PI - span;
  }
  if (!(span > 1e-4)) return 0;
  /* open and close are in (-pi, pi], so both products are in [0, 512]: `| 0` is a truncation. */
  int32_t b0 = (int32_t)((open + PI) * BIN_SCALE);
  int32_t b1 = (int32_t)((close + PI) * BIN_SCALE);
  if (b0 < 0) b0 = 0;
  else if (b0 >= BINS) b0 = BINS - 1;
  if (b1 < 0) b1 = 0;
  else if (b1 >= BINS) b1 = BINS - 1;
  const int32_t end = open <= close ? b1 : b1 + BINS;
  int stamped = 0;
  for (int32_t v = b0; v <= end; v++) {
    stamped |= stamp_js(dist, own, v < BINS ? v : v - BINS, cosC, sinC, lx, ly, x0, y0, x1, y1, owner);
  }
  return stamped;
}

__attribute__((export_name("collect_solid_f64")))
int32_t collect_solid_f64(uint32_t ctxByte, uint32_t segByte, uint32_t chainByte, int32_t n, double entityX,
                          double entityY, double rotC, double rotS, double offX, double offY, double lightX,
                          double lightY, double radiusSq, int32_t owner) {
  if (n <= 0) return 0;
  const uint32_t *ctx = (const uint32_t *)(uintptr_t)ctxByte;
  const float *seg = (const float *)(uintptr_t)segByte;
  const int32_t *chain = (const int32_t *)(uintptr_t)chainByte;
  float *dist = (float *)(uintptr_t)ctx[C_DIST];
  int32_t *own = (int32_t *)(uintptr_t)ctx[C_OWNER];
  const double *cosC = (const double *)(uintptr_t)ctx[C_COS];
  const double *sinC = (const double *)(uintptr_t)ctx[C_SIN];
  const double originX = entityX + rotC * offX - rotS * offY;
  const double originY = entityY + rotS * offX + rotC * offY;
  int32_t hit = 0;
  int stamped = 0;
  double lastX = __builtin_nan("");
  double lastY = __builtin_nan("");
  double lastAngle = 0;
  for (int32_t q = 0; q < n; q++) {
    const uint32_t o = (uint32_t)chain[q] * 4u;
    const double lx0 = seg[o];
    const double ly0 = seg[o + 1];
    const double lx1 = seg[o + 2];
    const double ly1 = seg[o + 3];
    const double x0 = originX + rotC * lx0 - rotS * ly0;
    const double y0 = originY + rotS * lx0 + rotC * ly0;
    const double x1 = originX + rotC * lx1 - rotS * ly1;
    const double y1 = originY + rotS * lx1 + rotC * ly1;
    const double ex = x1 - x0;
    const double ey = y1 - y0;
    const double tx = lightX - x0;
    const double ty = lightY - y0;
    if (ex * ty - ey * tx >= 0) {
      if (hit == 0 && seg_dist_sq(lightX, lightY, x0, y0, x1, y1) <= radiusSq) hit++;
      continue;
    }
    if (seg_dist_sq(lightX, lightY, x0, y0, x1, y1) > radiusSq) continue;
    hit++;
    const double open = x0 == lastX && y0 == lastY
      ? lastAngle
      : normalize_angle_signed(fd_atan2(y0 - lightY, x0 - lightX));
    const double close = normalize_angle_signed(fd_atan2(y1 - lightY, x1 - lightX));
    lastX = x1;
    lastY = y1;
    lastAngle = close;
    stamped |= raster_span_js(open, close, x0, y0, x1, y1, lightX, lightY, owner, dist, own, cosC, sinC);
  }
  if (stamped) *(int32_t *)(uintptr_t)ctx[C_ACTIVE] = 1;
  return hit;
}

/* The bin of direction (dx, dy) as the JS takes it, ((normalizeAngleSigned(atan2(dy, dx)) + pi) * 512 /
   (2 pi)) | 0 clamped to 511, without atan2. Quadrant q of the angle from -pi (q = 0: dx < 0, dy < 0; 1: dx >= 0,
   dy < 0; 2: dx > 0, dy >= 0; 3: dx <= 0, dy >= 0, with -pi folded to pi) holds bins 128 q .. 128 q + 127, 64
   to each octant; across its first octant the angle is atan(s / p), across its second pi/2 - atan(p / s), with
   (p, s) = (|dx|, |dy|) in even quadrants and (|dy|, |dx|) in odd ones. So the bin is 128 q + j or
   128 q + 127 - j, j = #{k in 1..64 : tan(k pi / 256) <= r}, r = min / max. A diagonal (r = 1) belongs to the
   first octant (j = 64: the next octant's first bin), and an axis (r = 0) starts its quadrant, as the JS has
   them; the -x axis is the fold (pi, the second octant of quadrant 3 at r = 0): bin 511, the JS's clamp. j comes
   from a cubic within 0.13 of atan(r) * 256 / pi and one step of the table either way. The light on the end
   (0 / 0) is never rastered (its edge fails the facing test), so r is merely kept in range there. */
INLINE int32_t pseudo_bin(double dx, double dy, const double *tanK) {
  const double ax = __builtin_fabs(dx);
  const double ay = __builtin_fabs(dy);
  const int32_t q = dy < 0 ? (dx < 0 ? 0 : 1) : (dx > 0 ? 2 : 3);
  const int odd = q & 1;
  const double p = odd ? ay : ax;
  const double s = odd ? ax : ay;
  const int first = s <= p;
  double r = (first ? s : p) / (first ? p : s);
  if (!(r <= 1.0)) r = 1.0;
  const double guess = r * (64.0 + (1.0 - r) * (ATAN_A + ATAN_B * r));
  int32_t j = (int32_t)guess; /* guess is in [0, 64.2) */
  if (j > 63) j = 63;
  j += (r >= tanK[j + 1]) - (r < tanK[j]);
  return 128 * q + (first ? j : 127 - j);
}

enum { STAMP_JS, STAMP_FILTER, STAMP_F64X2, STAMP_F32X4 };

/* One edge's values for its stamps: the JS's raySegT operands with the light as origin. */
typedef struct {
  double lx, ly, x0, y0, x1, y1;
  double ex, ey, fx, fy; /* p1 - p0, p0 - light */
  double nF;             /* -(fx * ey - fy * ex) > 0: -(raySegT's numerator of t) */
} Edge;

/* The division-free filter, then the JS's own divisions and tests on what passes. With nd = -denom,
   t = nF / nd and u = un / nd are the JS's t and u bit for bit (both operands negated exactly). */
INLINE int stamp_filter(float *dist, int32_t *own, int32_t b, const double *cosC, const double *sinC,
                        const Edge *e, int32_t owner) {
  const double c = cosC[b];
  const double s = sinC[b];
  const double denom = c * e->ey - s * e->ex;
  /* t = nF / -denom with nF > 0: a positive denom gives t < 0, which the JS's t > 1e-4 refuses. */
  if (!(denom <= -1e-12)) return 0;
  const double nd = -denom;
  const double un = e->fy * c - e->fx * s;
  const double d = dist[b];
  if (!(e->nF > (1e-4 * WIDE_LO) * nd && un >= (-1e-4 * WIDE_HI) * nd && un <= ((1 + 1e-4) * WIDE_HI) * nd &&
        e->nF < d * nd * WIDE_HI))
    return 0;
  const double t = e->nF / nd;
  const double u = un / nd;
  if (t > 1e-4 && u >= -1e-4 && u <= 1 + 1e-4 && t < d) {
    dist[b] = (float)t;
    own[b] = owner;
    return 1;
  }
  return 0;
}

/* Bins b and b + 1 (b <= 510) with the JS's raySegT in each lane. */
INLINE int stamp_pair_f64x2(float *dist, int32_t *own, int32_t b, const double *cosC, const double *sinC,
                            v128_t vex, v128_t vey, v128_t vfx, v128_t vfy, v128_t vtnum, v128_t vown) {
  const v128_t c = wasm_v128_load(cosC + b);
  const v128_t s = wasm_v128_load(sinC + b);
  const v128_t denom = wasm_f64x2_sub(wasm_f64x2_mul(c, vey), wasm_f64x2_mul(s, vex));
  const v128_t t = wasm_f64x2_div(vtnum, denom);
  const v128_t u = wasm_f64x2_div(wasm_f64x2_sub(wasm_f64x2_mul(vfx, s), wasm_f64x2_mul(vfy, c)), denom);
  const v128_t old = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(dist + b));
  v128_t m = wasm_f64x2_ge(wasm_f64x2_abs(denom), wasm_f64x2_splat(1e-12));
  m = wasm_v128_and(m, wasm_f64x2_gt(t, wasm_f64x2_splat(1e-4)));
  m = wasm_v128_and(m, wasm_f64x2_ge(u, wasm_f64x2_splat(-1e-4)));
  m = wasm_v128_and(m, wasm_f64x2_le(u, wasm_f64x2_splat(1 + 1e-4)));
  m = wasm_v128_and(m, wasm_f64x2_lt(t, old));
  if (!wasm_v128_any_true(m)) return 0;
  /* A lane not stamped stores its own float back: promote then demote is exact. */
  wasm_v128_store64_lane(dist + b, wasm_f32x4_demote_f64x2_zero(wasm_v128_bitselect(t, old, m)), 0);
  const v128_t m32 = wasm_i32x4_shuffle(m, m, 0, 2, 0, 2);
  const v128_t o = wasm_v128_load64_zero(own + b);
  wasm_v128_store64_lane(own + b, wasm_v128_bitselect(vown, o, m32), 0);
  return 1;
}

/* Bins v .. v + len - 1 (len 1..4, wrapping past 511) through the float filter, each lane it passes through
   the JS's raySegT in double. The filter holds the JS's tests with the light as origin, nd = -denom > 0:
   nd >= 1e-12, nF > 1e-4 nd, un >= -1e-4 nd, un <= (1 + 1e-4) nd, nF < d nd. Each side is widened by the
   rounding bound of its float terms (F32_MARGIN of |e|_1 for nd, of |f|_1 for un, of nF for nF). */
INLINE int stamp_quad_f32x4(float *dist, int32_t *own, int32_t v, int32_t len, const float *cosF,
                            const float *sinF, const double *cosC, const double *sinC, const Edge *e,
                            int32_t owner, v128_t vexf, v128_t veyf, v128_t vfxf, v128_t vfyf, v128_t vnFf,
                            v128_t vMe, v128_t vNegMe, v128_t vM2, v128_t vM3, v128_t vM4, v128_t vMnF) {
  const int32_t b = v & BIN_MASK;
  const v128_t c = wasm_v128_load(cosF + b);
  const v128_t s = wasm_v128_load(sinF + b);
  v128_t d;
  if (b <= BINS - 4) {
    d = wasm_v128_load(dist + b);
  } else {
    d = wasm_f32x4_make(dist[b], dist[(b + 1) & BIN_MASK], dist[(b + 2) & BIN_MASK], dist[(b + 3) & BIN_MASK]);
  }
  const v128_t nd = wasm_f32x4_sub(wasm_f32x4_mul(s, vexf), wasm_f32x4_mul(c, veyf));
  const v128_t un = wasm_f32x4_sub(wasm_f32x4_mul(vfyf, c), wasm_f32x4_mul(vfxf, s));
  const v128_t k4 = wasm_f32x4_splat(1e-4f);
  const v128_t u1 = wasm_f32x4_splat(1.0001f);
  v128_t m = wasm_f32x4_gt(nd, vNegMe);
  m = wasm_v128_and(m, wasm_f32x4_gt(wasm_f32x4_sub(vnFf, wasm_f32x4_mul(k4, nd)), vM2));
  m = wasm_v128_and(m, wasm_f32x4_ge(wasm_f32x4_add(un, wasm_f32x4_mul(k4, nd)), vM3));
  m = wasm_v128_and(m, wasm_f32x4_ge(wasm_f32x4_sub(wasm_f32x4_mul(u1, nd), un), vM4));
  /* d nd - nF > -(MnF + d Me) */
  m = wasm_v128_and(m, wasm_f32x4_gt(wasm_f32x4_sub(wasm_f32x4_mul(d, nd), vnFf),
                                     wasm_f32x4_neg(wasm_f32x4_add(vMnF, wasm_f32x4_mul(d, vMe)))));
  uint32_t lanes = wasm_i32x4_bitmask(m) & ((1u << len) - 1u);
  int stamped = 0;
  while (lanes) {
    const int32_t k = __builtin_ctz(lanes);
    lanes &= lanes - 1u;
    stamped |= stamp_js(dist, own, (b + k) & BIN_MASK, cosC, sinC, e->lx, e->ly, e->x0, e->y0, e->x1, e->y1, owner);
  }
  return stamped;
}

/* Bins v = start .. end (end < start + 512), b = v & 511. */
INLINE int stamp_span(int32_t start, int32_t end, const Edge *e, int32_t owner, float *dist, int32_t *own,
                      const double *cosC, const double *sinC, const float *cosF, const float *sinF,
                      const int mode) {
  int stamped = 0;
  if (mode == STAMP_JS) {
    for (int32_t v = start; v <= end; v++) {
      stamped |= stamp_js(dist, own, v & BIN_MASK, cosC, sinC, e->lx, e->ly, e->x0, e->y0, e->x1, e->y1, owner);
    }
  } else if (mode == STAMP_FILTER) {
    for (int32_t v = start; v <= end; v++) stamped |= stamp_filter(dist, own, v & BIN_MASK, cosC, sinC, e, owner);
  } else if (mode == STAMP_F64X2) {
    const v128_t vex = wasm_f64x2_splat(e->ex);
    const v128_t vey = wasm_f64x2_splat(e->ey);
    const v128_t vfx = wasm_f64x2_splat(e->fx);
    const v128_t vfy = wasm_f64x2_splat(e->fy);
    const v128_t vtnum = wasm_f64x2_splat(-e->nF);
    const v128_t vown = wasm_i32x4_splat(owner);
    int32_t v = start;
    for (; v < end; v += 2) {
      const int32_t b = v & BIN_MASK;
      if (b == BIN_MASK) {
        stamped |= stamp_js(dist, own, BIN_MASK, cosC, sinC, e->lx, e->ly, e->x0, e->y0, e->x1, e->y1, owner);
        stamped |= stamp_js(dist, own, 0, cosC, sinC, e->lx, e->ly, e->x0, e->y0, e->x1, e->y1, owner);
      } else {
        stamped |= stamp_pair_f64x2(dist, own, b, cosC, sinC, vex, vey, vfx, vfy, vtnum, vown);
      }
    }
    if (v == end) {
      stamped |= stamp_js(dist, own, v & BIN_MASK, cosC, sinC, e->lx, e->ly, e->x0, e->y0, e->x1, e->y1, owner);
    }
  } else {
    const double me = F32_MARGIN * (__builtin_fabs(e->ex) + __builtin_fabs(e->ey));
    const double mf = F32_MARGIN * (__builtin_fabs(e->fx) + __builtin_fabs(e->fy));
    const double mnF = F32_MARGIN * e->nF;
    const v128_t vexf = wasm_f32x4_splat((float)e->ex);
    const v128_t veyf = wasm_f32x4_splat((float)e->ey);
    const v128_t vfxf = wasm_f32x4_splat((float)e->fx);
    const v128_t vfyf = wasm_f32x4_splat((float)e->fy);
    const v128_t vnFf = wasm_f32x4_splat((float)e->nF);
    const v128_t vMe = wasm_f32x4_splat((float)me);
    const v128_t vNegMe = wasm_f32x4_splat((float)-me);
    const v128_t vM2 = wasm_f32x4_splat((float)-(mnF + 1e-4 * me));
    const v128_t vM3 = wasm_f32x4_splat((float)-(mf + 1e-4 * me));
    const v128_t vM4 = wasm_f32x4_splat((float)-(mf + (1 + 1e-4) * me));
    const v128_t vMnF = wasm_f32x4_splat((float)mnF);
    for (int32_t v = start; v <= end; v += 4) {
      const int32_t left = end - v + 1;
      stamped |= stamp_quad_f32x4(dist, own, v, left < 4 ? left : 4, cosF, sinF, cosC, sinC, e, owner, vexf, veyf,
                                  vfxf, vfyf, vnFf, vMe, vNegMe, vM2, vM3, vM4, vMnF);
    }
  }
  return stamped;
}

/* collectSolidSegments with table bins (pseudo_bin): see the header. */
INLINE int32_t collect_table(uint32_t ctxByte, uint32_t segByte, uint32_t chainByte, int32_t n, double entityX,
                             double entityY, double rotC, double rotS, double offX, double offY, double lightX,
                             double lightY, double radiusSq, int32_t owner, const int mode, const int fastRange) {
  if (n <= 0) return 0;
  const uint32_t *ctx = (const uint32_t *)(uintptr_t)ctxByte;
  const float *seg = (const float *)(uintptr_t)segByte;
  const uint32_t *segBits = (const uint32_t *)(uintptr_t)segByte;
  const int32_t *chain = (const int32_t *)(uintptr_t)chainByte;
  float *dist = (float *)(uintptr_t)ctx[C_DIST];
  int32_t *own = (int32_t *)(uintptr_t)ctx[C_OWNER];
  const double *cosC = (const double *)(uintptr_t)ctx[C_COS];
  const double *sinC = (const double *)(uintptr_t)ctx[C_SIN];
  const float *cosF = (const float *)(uintptr_t)ctx[C_COSF];
  const float *sinF = (const float *)(uintptr_t)ctx[C_SINF];
  const double *tanK = (const double *)(uintptr_t)ctx[C_TAN];
  const double originX = entityX + rotC * offX - rotS * offY;
  const double originY = entityY + rotS * offX + rotC * offY;
  int32_t hit = 0;
  int stamped = 0;
  /* The previous edge's far end: its float bits in seg, its world position, its bin (-1: not taken). */
  int havePrev = 0;
  uint32_t prevBitsX = 0;
  uint32_t prevBitsY = 0;
  double prevX = 0;
  double prevY = 0;
  int32_t prevBin = -1;
  Edge e;
  e.lx = lightX;
  e.ly = lightY;
  for (int32_t q = 0; q < n; q++) {
    const uint32_t o = (uint32_t)chain[q] * 4u;
    double x0;
    double y0;
    int32_t bin0 = -1;
    if (havePrev && segBits[o] == prevBitsX && segBits[o + 1] == prevBitsY) {
      x0 = prevX;
      y0 = prevY;
      bin0 = prevBin;
    } else {
      const double lx0 = seg[o];
      const double ly0 = seg[o + 1];
      x0 = originX + rotC * lx0 - rotS * ly0;
      y0 = originY + rotS * lx0 + rotC * ly0;
    }
    const double lx1 = seg[o + 2];
    const double ly1 = seg[o + 3];
    const double x1 = originX + rotC * lx1 - rotS * ly1;
    const double y1 = originY + rotS * lx1 + rotC * ly1;
    havePrev = 1;
    prevBitsX = segBits[o + 2];
    prevBitsY = segBits[o + 3];
    prevX = x1;
    prevY = y1;
    prevBin = -1;
    const double ex = x1 - x0;
    const double ey = y1 - y0;
    const double tx = lightX - x0;
    const double ty = lightY - y0;
    const double cross = ex * ty - ey * tx;
    const double bx = x1 - lightX;
    const double by = y1 - lightY;
    if (cross >= 0) {
      if (hit == 0 && in_range(lightX, lightY, x0, y0, x1, y1, tx, ty, bx, by, radiusSq, fastRange)) hit++;
      continue;
    }
    if (!in_range(lightX, lightY, x0, y0, x1, y1, tx, ty, bx, by, radiusSq, fastRange)) continue;
    hit++;
    /* The span from p1 counter-clockwise to p0 (the JS's swapped open and close), under pi: cross is
       (p0 - light) x (p1 - light). It is over 1e-4 rad when the ends are at least a right angle apart or
       -cross > tan(1e-4) dot. NaN fails, as the JS's !(span > 1e-4) does. p0 - light is (-tx, -ty) exactly. */
    const double dot = bx * -tx + by * -ty;
    if (!(dot <= 0 || -cross > TAN_SPAN_MIN * dot)) continue;
    if (bin0 < 0) bin0 = pseudo_bin(-tx, -ty, tanK);
    const int32_t bin1 = pseudo_bin(bx, by, tanK);
    prevBin = bin1;
    e.x0 = x0;
    e.y0 = y0;
    e.x1 = x1;
    e.y1 = y1;
    e.ex = ex;
    e.ey = ey;
    e.fx = x0 - lightX;
    e.fy = y0 - lightY;
    e.nF = -(e.fx * ey - e.fy * ex);
    stamped |= stamp_span(bin1, bin0 >= bin1 ? bin0 : bin0 + BINS, &e, owner, dist, own, cosC, sinC, cosF, sinF,
                          mode);
  }
  if (stamped) *(int32_t *)(uintptr_t)ctx[C_ACTIVE] = 1;
  return hit;
}

#define TABLE_EXPORT(name, mode, fastRange)                                                                      \
  __attribute__((export_name(#name)))                                                                          \
  int32_t name(uint32_t ctxByte, uint32_t segByte, uint32_t chainByte, int32_t n, double entityX, double entityY, \
               double rotC, double rotS, double offX, double offY, double lightX, double lightY, double radiusSq, \
               int32_t owner) {                                                                                \
    return collect_table(ctxByte, segByte, chainByte, n, entityX, entityY, rotC, rotS, offX, offY, lightX, lightY, \
                         radiusSq, owner, mode, fastRange);                                                    \
  }

TABLE_EXPORT(collect_solid_pseudo, STAMP_JS, 0)
TABLE_EXPORT(collect_solid_fast, STAMP_FILTER, 1)
TABLE_EXPORT(collect_solid_f64x2, STAMP_F64X2, 1)
TABLE_EXPORT(collect_solid_f32x4, STAMP_F32X4, 1)
