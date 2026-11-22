/* The decal premultiply's scalar loop as an export (E-76 W21c), a test module (N-303 CR-11): the shipped
   premultiply_simd's twin, which the parity test compares with it and with the JS. */
#include "../decalPremultiply.c"

__attribute__((export_name("premultiply_scalar")))
void premultiply_scalar(uint32_t src, uint32_t dst, uint32_t pixels) {
  premultiply_scalar_run(src, dst, pixels);
}
