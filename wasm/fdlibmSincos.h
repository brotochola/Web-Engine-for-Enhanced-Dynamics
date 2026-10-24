/* sin and cos of one argument for engine kernels (E-76): musl's FreeBSD-derived fdlibm code
 * (__sin, __cos, the small and medium cases of __rem_pio2, and sin's and cos's own small-|x|
 * cutoffs), every function inlined so no array escapes and the kernel needs no stack (the T6
 * rules forbid one). An argument with |x| >= 2^20 * pi/2 needs the large reduction, which passes
 * an array by address: weed_sincos returns 0 for it and the caller computes it in JS. For every
 * other argument the results are musl's sin(x) and cos(x) bit for bit; tests/bench/trigPremise
 * compares those with Math.* (Chrome 155: equal after rounding to float32, 0 of 102 M).
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 * The medium reduction is Bruce D. Evans's (FreeBSD). musl libc is MIT licensed.
 */
#ifndef WEED_FDLIBM_SINCOS_H
#define WEED_FDLIBM_SINCOS_H
#include <stdint.h>

#define WEED_INLINE static inline __attribute__((always_inline))

WEED_INLINE uint64_t weed_bits(double x) {
  union { double f; uint64_t i; } u;
  u.f = x;
  return u.i;
}

/* __sin: sin on [-pi/4, pi/4]; y is the tail of x, iy says whether y is 0. */
WEED_INLINE double weed_k_sin(double x, double y, int iy) {
  const double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
               S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
               S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  double z = x * x;
  double w = z * z;
  double r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  double v = z * x;
  if (iy == 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

/* __cos: cos on [-pi/4, pi/4]. */
WEED_INLINE double weed_k_cos(double x, double y) {
  const double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
               C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
               C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  double z = x * x;
  double w = z * z;
  double r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  double hz = 0.5 * z;
  w = 1.0 - hz;
  return w + (((1.0 - w) - hz) + (z * r - x * y));
}

/* __rem_pio2 for |x| < 2^20 * pi/2 (the caller checks): x = n * pi/2 + (*y0 + *y1). */
WEED_INLINE int weed_rem_pio2(double x, double *y0, double *y1) {
  const double toint = 1.5 / 2.22044604925031308085e-16, pio4 = 0x1.921fb54442d18p-1,
               invpio2 = 6.36619772367581382433e-01, pio2_1 = 1.57079632673412561417e+00,
               pio2_1t = 6.07710050650619224932e-11, pio2_2 = 6.07710050630396597660e-11,
               pio2_2t = 2.02226624879595063154e-21, pio2_3 = 2.02226624871116645580e-21,
               pio2_3t = 8.47842766036889956997e-32;
  uint64_t ux = weed_bits(x);
  int sign = (int)(ux >> 63);
  uint32_t ix = (uint32_t)(ux >> 32) & 0x7fffffffu;
  double z, w, t, r, fn;
  int n, ex, ey;
  if (ix <= 0x400f6a7a) {           /* |x| ~<= 5pi/4 */
    if ((ix & 0xfffff) == 0x921fb) goto medium; /* |x| ~= pi/2 or 2pi/2 */
    if (ix <= 0x4002d97c) {         /* |x| ~<= 3pi/4 */
      if (!sign) {
        z = x - pio2_1;
        *y0 = z - pio2_1t;
        *y1 = (z - *y0) - pio2_1t;
        return 1;
      }
      z = x + pio2_1;
      *y0 = z + pio2_1t;
      *y1 = (z - *y0) + pio2_1t;
      return -1;
    }
    if (!sign) {
      z = x - 2 * pio2_1;
      *y0 = z - 2 * pio2_1t;
      *y1 = (z - *y0) - 2 * pio2_1t;
      return 2;
    }
    z = x + 2 * pio2_1;
    *y0 = z + 2 * pio2_1t;
    *y1 = (z - *y0) + 2 * pio2_1t;
    return -2;
  }
  if (ix <= 0x401c463b) {           /* |x| ~<= 9pi/4 */
    if (ix <= 0x4015fdbc) {         /* |x| ~<= 7pi/4 */
      if (ix == 0x4012d97c) goto medium; /* |x| ~= 3pi/2 */
      if (!sign) {
        z = x - 3 * pio2_1;
        *y0 = z - 3 * pio2_1t;
        *y1 = (z - *y0) - 3 * pio2_1t;
        return 3;
      }
      z = x + 3 * pio2_1;
      *y0 = z + 3 * pio2_1t;
      *y1 = (z - *y0) + 3 * pio2_1t;
      return -3;
    }
    if (ix == 0x401921fb) goto medium; /* |x| ~= 4pi/2 */
    if (!sign) {
      z = x - 4 * pio2_1;
      *y0 = z - 4 * pio2_1t;
      *y1 = (z - *y0) - 4 * pio2_1t;
      return 4;
    }
    z = x + 4 * pio2_1;
    *y0 = z + 4 * pio2_1t;
    *y1 = (z - *y0) + 4 * pio2_1t;
    return -4;
  }
medium:
  fn = x * invpio2 + toint - toint; /* rint(x / (pi/2)) */
  n = (int32_t)fn;
  r = x - fn * pio2_1;
  w = fn * pio2_1t; /* 1st round, good to 85 bits */
  if (__builtin_expect(r - w < -pio4, 0)) { /* matters with directed rounding */
    n--;
    fn--;
    r = x - fn * pio2_1;
    w = fn * pio2_1t;
  } else if (__builtin_expect(r - w > pio4, 0)) {
    n++;
    fn++;
    r = x - fn * pio2_1;
    w = fn * pio2_1t;
  }
  *y0 = r - w;
  ey = (int)(weed_bits(*y0) >> 52 & 0x7ff);
  ex = (int)(ix >> 20);
  if (ex - ey > 16) { /* 2nd round, good to 118 bits */
    t = r;
    w = fn * pio2_2;
    r = t - w;
    w = fn * pio2_2t - ((t - r) - w);
    *y0 = r - w;
    ey = (int)(weed_bits(*y0) >> 52 & 0x7ff);
    if (ex - ey > 49) { /* 3rd round, good to 151 bits, covers all cases */
      t = r;
      w = fn * pio2_3;
      r = t - w;
      w = fn * pio2_3t - ((t - r) - w);
      *y0 = r - w;
    }
  }
  *y1 = (r - *y0) - w;
  return n;
}

/* *s = sin(x), *c = cos(x) as musl's sin() and cos() give them; 0 when |x| >= 2^20 * pi/2. */
WEED_INLINE int weed_sincos(double x, double *s, double *c) {
  uint32_t ix = (uint32_t)(weed_bits(x) >> 32) & 0x7fffffffu;
  if (ix <= 0x3fe921fb) {           /* |x| ~< pi/4 */
    *s = ix < 0x3e500000 ? x : weed_k_sin(x, 0.0, 0);   /* sin: |x| < 2^-26 */
    *c = ix < 0x3e46a09e ? 1.0 : weed_k_cos(x, 0.0);     /* cos: |x| < 2^-27 * sqrt(2) */
    return 1;
  }
  if (ix >= 0x7ff00000) {           /* Inf or NaN */
    *s = *c = x - x;
    return 1;
  }
  if (ix >= 0x413921fb) return 0;   /* the large reduction: the caller's fallback */
  double y0, y1;
  int n = weed_rem_pio2(x, &y0, &y1);
  double sy = weed_k_sin(y0, y1, 1);
  double cy = weed_k_cos(y0, y1);
  switch (n & 3) {
    case 0: *s = sy; *c = cy; break;
    case 1: *s = cy; *c = -sy; break;
    case 2: *s = -sy; *c = -cy; break;
    default: *s = -cy; *c = sy; break;
  }
  return 1;
}

#endif
