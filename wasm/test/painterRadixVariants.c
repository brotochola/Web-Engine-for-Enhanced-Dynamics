/* The painter's variants the shipped simd_inplace beat (E-76 W10), a test module (N-303 CR-11): the scalar, kv8, kv11
   and adaptive radix cores with their order and reinsert, the simd core's own reinsert, and the scalar in-place
   merge, beside the shipped exports (included). Every variant writes the same bytes (tests/node/painterRadixWasm.test.js). */
#include "../painterRadix.c"

PAINTER_EXPORTS(scalar, CORE_SCALAR)
PAINTER_EXPORTS(kv8, CORE_KV8)
PAINTER_EXPORTS(kv11, CORE_KV11)
PAINTER_EXPORTS(adaptive, CORE_ADAPTIVE)

__attribute__((export_name("reinsert_simd")))
int32_t reinsert_simd(uint32_t table, uint32_t n, uint32_t keys) {
  return reinsert(T(table), n, T(keys), CORE_SIMD, 0);
}

__attribute__((export_name("reinsert_inplace")))
int32_t reinsert_inplace(uint32_t table, uint32_t n, uint32_t keys) {
  return reinsert(T(table), n, T(keys), CORE_SCALAR, 1);
}
