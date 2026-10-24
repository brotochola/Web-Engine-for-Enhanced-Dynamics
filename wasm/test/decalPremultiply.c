/* Decal tile premultiply (E-76 W21c), a test module: copyPremultiplyRgba (src/render/webgpu/pinGpuTexture.js), the
   straight-to-premultiplied copy Pixi makes of each dirty decal tile before its upload, for a run of pixels of
   the decal memory. Bit for bit the JS: every colour byte is (c * a * 257 + 32896) >> 16 and the alpha byte is a.
   That formula gives c itself at a = 255 and 0 at a = 0, so the JS's two fast cases are the general one, and
   the vector loop needs no branch. In 16-bit lanes, with x = c * a (at most 65 025) and t = x + 128,
   (x * 257 + 32896) >> 16 is (t + (t >> 8)) >> 8: equal for every c and a in 0..255 (checked exhaustively),
   and t + (t >> 8) stays under 65 536. */
#include <stdint.h>
#include <wasm_simd128.h>

/* The JS line for line: the u32 word moves as is at a = 255, is 0 at a = 0, else the per-channel math. */
__attribute__((export_name("premultiply_scalar")))
void premultiply_scalar(uint32_t src, uint32_t dst, uint32_t pixels) {
  const uint32_t *s = (const uint32_t *)(uintptr_t)src;
  uint32_t *d = (uint32_t *)(uintptr_t)dst;
  for (uint32_t p = 0; p < pixels; p++) {
    const uint32_t v = s[p];
    const uint32_t a = v >> 24;
    if (a == 255u) {
      d[p] = v;
    } else if (a == 0u) {
      d[p] = 0u;
    } else {
      const uint32_t r = ((v & 0xffu) * a * 257u + 32896u) >> 16;
      const uint32_t g = (((v >> 8) & 0xffu) * a * 257u + 32896u) >> 16;
      const uint32_t b = (((v >> 16) & 0xffu) * a * 257u + 32896u) >> 16;
      d[p] = r | (g << 8) | (b << 16) | (a << 24);
    }
  }
}

/* Four pixels a vector, no branch: each colour byte times its pixel's alpha in 16-bit lanes, the alpha byte
   kept from the source. A tail of fewer than four pixels takes the scalar loop. */
__attribute__((export_name("premultiply_simd")))
void premultiply_simd(uint32_t src, uint32_t dst, uint32_t pixels) {
  const uint8_t *s = (const uint8_t *)(uintptr_t)src;
  uint8_t *d = (uint8_t *)(uintptr_t)dst;
  const v128_t alphaOf = wasm_i8x16_make(3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15);
  const v128_t alphaByte = wasm_i32x4_splat((int32_t)0xff000000u);
  const v128_t round = wasm_i16x8_splat(128);
  uint32_t p = 0;
  for (; p + 4u <= pixels; p += 4u) {
    const v128_t v = wasm_v128_load(s + p * 4u);
    const v128_t a = wasm_i8x16_swizzle(v, alphaOf);
    v128_t lo = wasm_i16x8_add(wasm_i16x8_mul(wasm_u16x8_extend_low_u8x16(v), wasm_u16x8_extend_low_u8x16(a)), round);
    v128_t hi = wasm_i16x8_add(wasm_i16x8_mul(wasm_u16x8_extend_high_u8x16(v), wasm_u16x8_extend_high_u8x16(a)), round);
    lo = wasm_u16x8_shr(wasm_i16x8_add(lo, wasm_u16x8_shr(lo, 8)), 8);
    hi = wasm_u16x8_shr(wasm_i16x8_add(hi, wasm_u16x8_shr(hi, 8)), 8);
    const v128_t premultiplied = wasm_u8x16_narrow_i16x8(lo, hi);
    wasm_v128_store(d + p * 4u, wasm_v128_bitselect(v, premultiplied, alphaByte));
  }
  if (p < pixels) premultiply_scalar(src + p * 4u, dst + p * 4u, pixels - p);
}
