/* Test kernel for the coexistence test (E-76 T8), not shipped: counts u16 ids into binCount u32
   bins (zeroed first), a scatter of read-modify-writes. Pointers are byte offsets into the
   imported shared memory. */
#include <stdint.h>

__attribute__((export_name("histogram_u16")))
void histogram_u16(uint32_t idsByte, uint32_t count, uint32_t binsByte, uint32_t binCount) {
  const uint16_t *ids = (const uint16_t *)(uintptr_t)idsByte;
  uint32_t *bins = (uint32_t *)(uintptr_t)binsByte;
  for (uint32_t i = 0; i < binCount; i++) bins[i] = 0;
  for (uint32_t i = 0; i < count; i++) bins[ids[i] % binCount]++;
}
