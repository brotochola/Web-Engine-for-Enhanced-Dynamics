/* Publish filtered neighbors. Same predicate as SpatialWorker._publishFilteredNeighbors, with the
   same arithmetic: the float32 inputs widened to double and every operation in double, so both
   paths publish the same set (E-76 W8a; in float32 they disagreed within ~3e-7 of the range edge).
   Scalar: on Predator's rows the loads dominate and an f32x4 form was no faster.
   Pointers are byte offsets into the imported shared memory. Entity ids are 16-bit, or 32-bit through
   publish_batch_u32 for a scene past 65 535 entities (W8b): the lists, the candidate rows and the neighbor
   rows hold ids of that width. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

INLINE void publish(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                    uint32_t neighborByte, uint32_t listByte, int wide) {
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  const uint16_t *cand16 = (const uint16_t *)(uintptr_t)candByte;
  const uint32_t *cand32 = (const uint32_t *)(uintptr_t)candByte;
  uint16_t *neighbor16 = (uint16_t *)(uintptr_t)neighborByte;
  uint32_t *neighbor32 = (uint32_t *)(uintptr_t)neighborByte;
  const uint16_t *list16 = (const uint16_t *)(uintptr_t)listByte;
  const uint32_t *list32 = (const uint32_t *)(uintptr_t)listByte;
  uint32_t stride = 1u + maxNeighbors;

  for (uint32_t n = 0; n < batchCount; n++) {
    uint32_t entityA = wide ? list32[n] : list16[n];
    double myX = pos[entityA * 4u];
    double myY = pos[entityA * 4u + 1u];
    double myRange = range[entityA];
    uint32_t base = entityA * stride;
    uint32_t candCount = wide ? cand32[base] : cand16[base];
    uint32_t published = 0;
    for (uint32_t i = 0; i < candCount && published < maxNeighbors; i++) {
      uint32_t b = wide ? cand32[base + 1u + i] : cand16[base + 1u + i];
      double dx = (double)pos[b * 4u] - myX;
      double dy = (double)pos[b * 4u + 1u] - myY;
      double er = myRange + (double)pos[b * 4u + 2u];
      if (dx * dx + dy * dy < er * er) {
        if (wide) neighbor32[base + 1u + published] = b;
        else neighbor16[base + 1u + published] = (uint16_t)b;
        published++;
      }
    }
    if (wide) neighbor32[base] = published;
    else neighbor16[base] = (uint16_t)published;
  }
}

__attribute__((export_name("publish_batch")))
void publish_batch(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                   uint32_t neighborByte, uint32_t listByte) {
  publish(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, 0);
}

__attribute__((export_name("publish_batch_u32")))
void publish_batch_u32(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                       uint32_t neighborByte, uint32_t listByte) {
  publish(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, 1);
}
