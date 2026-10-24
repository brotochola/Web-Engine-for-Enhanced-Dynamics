/* Publish filtered neighbors. Same predicate as SpatialWorker._publishFilteredNeighbors, with the
   same arithmetic: the float32 inputs widened to double and every operation in double, so both
   paths publish the same set (E-76 W8a; in float32 they disagreed within ~3e-7 of the range edge).
   Scalar: on Predator's rows the loads dominate and an f32x4 form was no faster.
   Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>

__attribute__((export_name("publish_batch")))
void publish_batch(
    uint32_t batchCount,
    uint32_t maxNeighbors,
    uint32_t posByte,
    uint32_t rangeByte,
    uint32_t candByte,
    uint32_t neighborByte,
    uint32_t listByte) {
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  const uint16_t *cand = (const uint16_t *)(uintptr_t)candByte;
  uint16_t *neighbor = (uint16_t *)(uintptr_t)neighborByte;
  const uint16_t *list = (const uint16_t *)(uintptr_t)listByte;
  uint32_t stride = 1u + maxNeighbors;

  for (uint32_t n = 0; n < batchCount; n++) {
    uint32_t entityA = list[n];
    double myX = pos[entityA * 4u];
    double myY = pos[entityA * 4u + 1u];
    double myRange = range[entityA];
    uint32_t base = entityA * stride;
    uint32_t candCount = cand[base];
    uint32_t published = 0;
    for (uint32_t i = 0; i < candCount && published < maxNeighbors; i++) {
      uint32_t b = cand[base + 1u + i];
      double dx = (double)pos[b * 4u] - myX;
      double dy = (double)pos[b * 4u + 1u] - myY;
      double er = myRange + (double)pos[b * 4u + 2u];
      if (dx * dx + dy * dy < er * er) {
        neighbor[base + 1u + published] = (uint16_t)b;
        published++;
      }
    }
    neighbor[base] = (uint16_t)published;
  }
}
