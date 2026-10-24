/* Q2 (E-76): musl's FreeBSD-derived atan2, atan, sin, cos and asin in one freestanding module, to
   compare bit for bit with Math.*. Not a kernel: sin/cos need a stack (the reduction passes
   y[2] by address), so this builds outside the T6 rules. Built with -I shim -I <musl src/math>. */
#include "libm.h"

double scalbn(double x, int n) {
  union { double f; uint64_t i; } u;
  double_t y = x;
  if (n > 1023) { y *= 0x1p1023; n -= 1023; if (n > 1023) { y *= 0x1p1023; n -= 1023; if (n > 1023) n = 1023; } }
  else if (n < -1022) { y *= 0x1p-1022 * 0x1p53; n += 1022 - 53; if (n < -1022) { y *= 0x1p-1022 * 0x1p53; n += 1022 - 53; if (n < -1022) n = -1022; } }
  u.i = (uint64_t)(0x3ff + n) << 52;
  x = y * u.f;
  return x;
}

#include "atan.c"
/* atan2 as V8's ieee754::atan2 has it (FreeBSD e_atan2.c): musl moved the |y/x| > 2^60 shortcut to
   2^64 and drops "m &= 1" there, which differs by one ulp for 2^60 < |y/x| < 2^64 with x < 0. */
double atan2(double y, double x) {
  static const double tiny = 1.0e-300, pi_o_4 = 7.8539816339744827900e-01, pi_o_2 = 1.5707963267948965580e+00,
                      pi = 3.1415926535897931160e+00, pi_lo = 1.2246467991473531772e-16;
  double z;
  int32_t k, m, hx, hy, ix, iy;
  uint32_t lx, ly;
  EXTRACT_WORDS(hx, lx, x);
  ix = hx & 0x7fffffff;
  EXTRACT_WORDS(hy, ly, y);
  iy = hy & 0x7fffffff;
  if (((uint32_t)ix | ((lx | (0u - lx)) >> 31)) > 0x7ff00000u || ((uint32_t)iy | ((ly | (0u - ly)) >> 31)) > 0x7ff00000u)
    return x + y; /* x or y is NaN */
  if ((((uint32_t)hx - 0x3ff00000u) | lx) == 0) return atan(y); /* x = 1.0 */
  m = ((hy >> 31) & 1) | ((hx >> 30) & 2); /* 2*sign(x)+sign(y) */
  if ((iy | ly) == 0) {
    switch (m) {
      case 0: case 1: return y;
      case 2: return pi + tiny;
      default: return -pi - tiny;
    }
  }
  if ((ix | lx) == 0) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
  if (ix == 0x7ff00000) {
    if (iy == 0x7ff00000) {
      switch (m) {
        case 0: return pi_o_4 + tiny;
        case 1: return -pi_o_4 - tiny;
        case 2: return 3.0 * pi_o_4 + tiny;
        default: return -3.0 * pi_o_4 - tiny;
      }
    } else {
      switch (m) {
        case 0: return 0.0;
        case 1: return -0.0;
        case 2: return pi + tiny;
        default: return -pi - tiny;
      }
    }
  }
  if (iy == 0x7ff00000) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
  k = (iy - ix) >> 20;
  if (k > 60) { /* |y/x| > 2^60 */
    z = pi_o_2 + 0.5 * pi_lo;
    m &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0.0; /* 0 > |y|/x > -2^-60 */
  } else {
    z = atan(fabs(y / x));
  }
  switch (m) {
    case 0: return z;
    case 1: return -z;
    case 2: return pi - (z - pi_lo);
    default: return (z - pi_lo) - pi;
  }
}
#include "__sin.c"
#include "__cos.c"
#include "__rem_pio2_large.c"
#include "__rem_pio2.c"
#include "sin.c"
#include "cos.c"
#include "asin.c"

#define BATCH1(name, fn) \
  __attribute__((export_name(name))) void fn##_batch(uint32_t inByte, uint32_t outByte, uint32_t n) { \
    const double *in = (const double *)(uintptr_t)inByte; double *out = (double *)(uintptr_t)outByte; \
    for (uint32_t i = 0; i < n; i++) out[i] = fn(in[i]); }
BATCH1("sin_batch", sin)
BATCH1("cos_batch", cos)
BATCH1("asin_batch", asin)
BATCH1("atan_batch", atan)

__attribute__((export_name("atan2_batch")))
void atan2_batch(uint32_t yByte, uint32_t xByte, uint32_t outByte, uint32_t n) {
  const double *y = (const double *)(uintptr_t)yByte, *x = (const double *)(uintptr_t)xByte;
  double *out = (double *)(uintptr_t)outByte;
  for (uint32_t i = 0; i < n; i++) out[i] = atan2(y[i], x[i]);
}
