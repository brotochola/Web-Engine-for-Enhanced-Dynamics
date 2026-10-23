/* Test kernel for the coexistence test (E-76 T8), not shipped: out[i] = in[i] * k + b in float32,
   four lanes at a time, then the tail. Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>
#include <wasm_simd128.h>

__attribute__((export_name("scale_f32")))
void scale_f32(uint32_t inByte, uint32_t outByte, uint32_t count, float k, float b) {
  const float *in = (const float *)(uintptr_t)inByte;
  float *out = (float *)(uintptr_t)outByte;
  v128_t vk = wasm_f32x4_splat(k);
  v128_t vb = wasm_f32x4_splat(b);
  uint32_t i = 0;
  for (; i + 4u <= count; i += 4u) {
    v128_t v = wasm_v128_load(in + i);
    wasm_v128_store(out + i, wasm_f32x4_add(wasm_f32x4_mul(v, vk), vb));
  }
  for (; i < count; i++) out[i] = in[i] * k + b;
}
