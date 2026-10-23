/* Test kernels for Q4 (E-76), not shipped: what one JS -> WASM call costs, by argument count and
   type. Each does almost nothing, so a call's time is the boundary's. */
#include <stdint.h>

__attribute__((export_name("nop0")))
void nop0(void) {}

__attribute__((export_name("sum4i")))
int32_t sum4i(int32_t a, int32_t b, int32_t c, int32_t d) { return a + b + c + d; }

__attribute__((export_name("sum8i")))
int32_t sum8i(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e, int32_t f, int32_t g, int32_t h) {
  return a + b + c + d + e + f + g + h;
}

__attribute__((export_name("sum4d")))
double sum4d(double a, double b, double c, double d) { return a + b + c + d; }

__attribute__((export_name("sum8d")))
double sum8d(double a, double b, double c, double d, double e, double f, double g, double h) {
  return a + b + c + d + e + f + g + h;
}

/* One i32 load at a byte offset: a call that touches the shared memory. */
__attribute__((export_name("load1")))
int32_t load1(uint32_t byteOffset) { return *(const int32_t *)(uintptr_t)byteOffset; }
