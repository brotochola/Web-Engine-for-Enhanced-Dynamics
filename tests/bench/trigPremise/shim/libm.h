/* Minimal stand-in for musl's internal libm.h, enough for the trig sources (Q2, E-76). */
#ifndef Q2_LIBM_H
#define Q2_LIBM_H
#include <stdint.h>
#define FLT_EVAL_METHOD 0
#define DBL_EPSILON 2.22044604925031308085e-16
typedef double double_t;
#define predict_true(x) __builtin_expect(!!(x), 1)
#define predict_false(x) __builtin_expect(x, 0)
/* musl stores into a volatile to raise FP exception flags; WebAssembly has none. */
#define FORCE_EVAL(x) ((void)(x))
#define EXTRACT_WORDS(hi, lo, d) do { union { double f; uint64_t i; } __u; __u.f = (d); (hi) = __u.i >> 32; (lo) = (uint32_t)__u.i; } while (0)
#define GET_HIGH_WORD(hi, d) do { union { double f; uint64_t i; } __u; __u.f = (d); (hi) = __u.i >> 32; } while (0)
#define GET_LOW_WORD(lo, d) do { union { double f; uint64_t i; } __u; __u.f = (d); (lo) = (uint32_t)__u.i; } while (0)
#define INSERT_WORDS(d, hi, lo) do { union { double f; uint64_t i; } __u; __u.i = ((uint64_t)(hi) << 32) | (uint32_t)(lo); (d) = __u.f; } while (0)
#define SET_HIGH_WORD(d, hi) INSERT_WORDS(d, hi, (uint32_t)((union { double f; uint64_t i; }){ d }).i)
#define SET_LOW_WORD(d, lo) do { union { double f; uint64_t i; } __u; __u.f = (d); __u.i &= 0xffffffff00000000ull; __u.i |= (uint32_t)(lo); (d) = __u.f; } while (0)
#define fabs(x) __builtin_fabs(x)
#define floor(x) __builtin_floor(x)
#define sqrt(x) __builtin_sqrt(x)
#define isnan(x) __builtin_isnan(x)
double scalbn(double x, int n);
double __sin(double x, double y, int iy);
double __cos(double x, double y);
int __rem_pio2(double x, double *y);
int __rem_pio2_large(double *x, double *y, int e0, int nx, int prec);
double atan(double x);
#endif
