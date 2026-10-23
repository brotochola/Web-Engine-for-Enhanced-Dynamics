/* Publish filtered neighbors. Same predicate as SpatialWorker._publishFilteredNeighbors.
   Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>
#include <wasm_simd128.h>

__attribute__((export_name("publish_batch")))
void publish_batch(
    uint32_t batchCount,
    uint32_t maxNeighbors,
    uint32_t posByte,
    uint32_t rangeByte,
    uint32_t candByte,
    uint32_t neighborByte,
    uint32_t listByte) {
  float *pos = (float *)(uintptr_t)posByte;
  float *range = (float *)(uintptr_t)rangeByte;
  uint16_t *cand = (uint16_t *)(uintptr_t)candByte;
  uint16_t *neighbor = (uint16_t *)(uintptr_t)neighborByte;
  uint16_t *list = (uint16_t *)(uintptr_t)listByte;
  uint32_t stride = 1u + maxNeighbors;

  for (uint32_t n = 0; n < batchCount; n++) {
    uint32_t entityA = list[n];
    float myX = pos[entityA * 4u];
    float myY = pos[entityA * 4u + 1u];
    float myRange = range[entityA];
    uint32_t base = entityA * stride;
    uint32_t candCount = cand[base];
    uint32_t published = 0;
    uint32_t i = 0;

    while (i + 4u <= candCount && published + 4u <= maxNeighbors) {
      uint32_t b0 = cand[base + 1u + i];
      uint32_t b1 = cand[base + 1u + i + 1u];
      uint32_t b2 = cand[base + 1u + i + 2u];
      uint32_t b3 = cand[base + 1u + i + 3u];
      float x0 = pos[b0 * 4u];
      float y0 = pos[b0 * 4u + 1u];
      float h0 = pos[b0 * 4u + 2u];
      float x1 = pos[b1 * 4u];
      float y1 = pos[b1 * 4u + 1u];
      float h1 = pos[b1 * 4u + 2u];
      float x2 = pos[b2 * 4u];
      float y2 = pos[b2 * 4u + 1u];
      float h2 = pos[b2 * 4u + 2u];
      float x3 = pos[b3 * 4u];
      float y3 = pos[b3 * 4u + 1u];
      float h3 = pos[b3 * 4u + 2u];
      v128_t dx = wasm_f32x4_sub(wasm_f32x4_make(x0, x1, x2, x3), wasm_f32x4_splat(myX));
      v128_t dy = wasm_f32x4_sub(wasm_f32x4_make(y0, y1, y2, y3), wasm_f32x4_splat(myY));
      v128_t er = wasm_f32x4_add(wasm_f32x4_splat(myRange), wasm_f32x4_make(h0, h1, h2, h3));
      v128_t d2 = wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dy, dy));
      v128_t lim = wasm_f32x4_mul(er, er);
      int mask = wasm_i32x4_bitmask(wasm_f32x4_lt(d2, lim));
      uint32_t ids0 = b0, ids1 = b1, ids2 = b2, ids3 = b3;
      if ((mask & 1) && published < maxNeighbors) neighbor[base + 1u + published++] = ids0;
      if ((mask & 2) && published < maxNeighbors) neighbor[base + 1u + published++] = ids1;
      if ((mask & 4) && published < maxNeighbors) neighbor[base + 1u + published++] = ids2;
      if ((mask & 8) && published < maxNeighbors) neighbor[base + 1u + published++] = ids3;
      i += 4u;
    }

    for (; i < candCount && published < maxNeighbors; i++) {
      uint32_t b = cand[base + 1u + i];
      float dx = pos[b * 4u] - myX;
      float dy = pos[b * 4u + 1u] - myY;
      float er = myRange + pos[b * 4u + 2u];
      if (dx * dx + dy * dy < er * er) {
        neighbor[base + 1u + published] = b;
        published++;
      }
    }
    neighbor[base] = published;
  }
}
