/* Float32 variants of the candidate gather (wasm/spatialGather.c, E-76 W5, E-78), a test module for the
   float32 pass (WASM_HYPOTHESES "Open decisions" 5). The per-entity setup stays in double, as shipped (the
   home cell, the search range and its radius in cells), so every variant walks the same cells in the same
   order and counts the same cells. The per-candidate range test is float32: the search range rounded to
   float once per entity, dx and dy from the float32 positions, the effective range (that search range plus
   the candidate's half extent) and dx * dx + dy * dy < er * er, all in float. Q5 measured where float32 and
   double disagree on this predicate: within ~3e-7 relative of the range edge.
     gather_batch_f32    the range test in scalar float32
     gather_batch_f32x4  a cell's ids four at a time: the self test and the dedup marks lane by lane, in the
                         order the scalar loop takes them; each candidate's x, y and half extent from one v128
                         load of its 4-float pose row, a 4 x 4 transpose, the range test in f32x4, the kept
                         ids appended in lane order (one 64-bit store when all four are kept). A block runs only
                         while four more candidates fit the row, so a row truncates where the scalar loop
                         truncates it. Bit-identical to gather_batch_f32 (the candidates, their counts, the
                         truncation flags and the cells checked).
   Same arguments and memory contract as gather_batch; this module also exports the shipped gather_batch and
   order_batch_by_cell (included). */
#include <wasm_simd128.h>

#include "../spatialGather.c"

/* gather_batch with the float32 range test (simd: 0 scalar, 1 f32x4; a constant once inlined). */
static inline __attribute__((always_inline)) uint32_t gather_batch_with(
    uint32_t batchCount, uint32_t listByte, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
    uint32_t maxNeighbors, uint32_t gridByte, uint32_t cellByteSize, uint32_t cellIdStride, uint32_t cellHeaderIds,
    int32_t gridWidth, int32_t gridHeight, double invCellSize, double skinFrac, int32_t maxCellRadius,
    uint32_t patternByte, uint32_t patternIndexByte, uint32_t markerByte, uint32_t stampFrame, uint32_t truncatedByte,
    const int simd) {
  const uint16_t *list = (const uint16_t *)(uintptr_t)listByte;
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  uint16_t *cand = (uint16_t *)(uintptr_t)candByte;
  const uint8_t *gridCounts = (const uint8_t *)(uintptr_t)gridByte;
  const uint16_t *gridEntities = (const uint16_t *)(uintptr_t)gridByte;
  const int32_t *pattern = (const int32_t *)(uintptr_t)patternByte;
  const int32_t *patternIndex = (const int32_t *)(uintptr_t)patternIndexByte;
  uint32_t *marker = (uint32_t *)(uintptr_t)markerByte;
  uint8_t *truncatedOf = (uint8_t *)(uintptr_t)truncatedByte;
  const uint32_t stride = 1u + maxNeighbors;
  const int32_t maxRow = gridHeight - 1;
  const int32_t maxCol = gridWidth - 1;
  const uint32_t frameBits = (stampFrame & 0x1fffu) << 19;
  uint32_t cellsChecked = 0;

  for (uint32_t n = 0; n < batchCount; n++) {
    const uint32_t entityA = list[n];
    const double myX = pos[entityA * 4u];
    const double myY = pos[entityA * 4u + 1u];
    const double myVisualRange = range[entityA];
    const int32_t homeRow = clamp_index(myY * invCellSize, maxRow);
    const int32_t homeCol = clamp_index(myX * invCellSize, maxCol);
    const double skin = myVisualRange * skinFrac;
    const double searchRange = myVisualRange + 2.0 * skin;
    int32_t cellRadius = trunc_cells(searchRange * invCellSize) + 1;
    if (cellRadius > maxCellRadius) cellRadius = maxCellRadius;
    const uint32_t stampedA = frameBits | (entityA & 0x7ffffu);
    const uint32_t candBase = entityA * stride;
    const int32_t first = patternIndex[cellRadius * 2];
    const int32_t pairs = patternIndex[cellRadius * 2 + 1];
    /* The float32 test's inputs: the positions are float already, the search range is rounded once. */
    const float ax = pos[entityA * 4u];
    const float ay = pos[entityA * 4u + 1u];
    const float sr = (float)searchRange;
    const v128_t ax4 = wasm_f32x4_splat(ax);
    const v128_t ay4 = wasm_f32x4_splat(ay);
    const v128_t sr4 = wasm_f32x4_splat(sr);
    uint16_t *row = cand + candBase + 1u;
    uint32_t candCount = 0;
    uint8_t truncated = 0;

    for (int32_t p = 0; p < pairs; p++) {
      const int32_t cr = homeRow + pattern[(first + p) * 2];
      const int32_t cc = homeCol + pattern[(first + p) * 2 + 1];
      if (cr < 0 || cr >= gridHeight || cc < 0 || cc >= gridWidth) continue;
      const uint32_t cell = (uint32_t)(cr * gridWidth + cc);
      const uint32_t count = gridCounts[cell * cellByteSize];
      if (count == 0) continue;
      cellsChecked++;
      const uint16_t *ids = gridEntities + cell * cellIdStride + cellHeaderIds;
      uint32_t j = 0;
      if (simd) {
        for (; j + 4 <= count && candCount + 4 <= maxNeighbors; j += 4) {
          const v128_t ids16 = wasm_v128_load64_zero(ids + j);
          const uint32_t b0 = ids[j];
          const uint32_t b1 = ids[j + 1];
          const uint32_t b2 = ids[j + 2];
          const uint32_t b3 = ids[j + 3];
          /* The marks in the scalar loop's order (a repeated id in a cell is skipped the second time). */
          uint32_t live = 0;
          if (b0 != entityA && marker[b0] != stampedA) { marker[b0] = stampedA; live |= 1u; }
          if (b1 != entityA && marker[b1] != stampedA) { marker[b1] = stampedA; live |= 2u; }
          if (b2 != entityA && marker[b2] != stampedA) { marker[b2] = stampedA; live |= 4u; }
          if (b3 != entityA && marker[b3] != stampedA) { marker[b3] = stampedA; live |= 8u; }
          if (live == 0) continue;
          const v128_t r0 = wasm_v128_load(pos + b0 * 4u);
          const v128_t r1 = wasm_v128_load(pos + b1 * 4u);
          const v128_t r2 = wasm_v128_load(pos + b2 * 4u);
          const v128_t r3 = wasm_v128_load(pos + b3 * 4u);
          const v128_t t0 = wasm_i32x4_shuffle(r0, r1, 0, 4, 1, 5); /* x0 x1 y0 y1 */
          const v128_t t1 = wasm_i32x4_shuffle(r2, r3, 0, 4, 1, 5); /* x2 x3 y2 y3 */
          const v128_t t2 = wasm_i32x4_shuffle(r0, r1, 2, 6, 2, 6); /* h0 h1 */
          const v128_t t3 = wasm_i32x4_shuffle(r2, r3, 2, 6, 2, 6); /* h2 h3 */
          const v128_t dx = wasm_f32x4_sub(wasm_i32x4_shuffle(t0, t1, 0, 1, 4, 5), ax4);
          const v128_t dy = wasm_f32x4_sub(wasm_i32x4_shuffle(t0, t1, 2, 3, 6, 7), ay4);
          const v128_t er = wasm_f32x4_add(sr4, wasm_i32x4_shuffle(t2, t3, 0, 1, 4, 5));
          const v128_t in = wasm_f32x4_lt(wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dy, dy)),
                                          wasm_f32x4_mul(er, er));
          const uint32_t kept = (uint32_t)wasm_i32x4_bitmask(in) & live;
          if (kept == 15u) {
            wasm_v128_store64_lane(row + candCount, ids16, 0);
            candCount += 4;
            continue;
          }
          /* In lane order; a lane not kept is written at the count and overwritten or left past it. */
          row[candCount] = (uint16_t)b0;
          candCount += kept & 1u;
          row[candCount] = (uint16_t)b1;
          candCount += (kept >> 1) & 1u;
          row[candCount] = (uint16_t)b2;
          candCount += (kept >> 2) & 1u;
          row[candCount] = (uint16_t)b3;
          candCount += (kept >> 3) & 1u;
        }
      }
      for (; j < count; j++) {
        const uint32_t entityB = ids[j];
        if (entityA == entityB) continue;
        if (marker[entityB] == stampedA) continue;
        marker[entityB] = stampedA;
        const float dx = pos[entityB * 4u] - ax;
        const float dy = pos[entityB * 4u + 1u] - ay;
        const float er = sr + pos[entityB * 4u + 2u];
        if (dx * dx + dy * dy < er * er) {
          if (candCount < maxNeighbors) {
            row[candCount] = (uint16_t)entityB;
            candCount++;
          } else {
            truncated = 1;
            break;
          }
        }
      }
      if (truncated) break;
    }
    cand[candBase] = (uint16_t)candCount;
    truncatedOf[entityA] = truncated;
  }
  return cellsChecked;
}

__attribute__((export_name("gather_batch_f32")))
uint32_t gather_batch_f32(uint32_t batchCount, uint32_t listByte, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                          uint32_t maxNeighbors, uint32_t gridByte, uint32_t cellByteSize, uint32_t cellIdStride,
                          uint32_t cellHeaderIds, int32_t gridWidth, int32_t gridHeight, double invCellSize,
                          double skinFrac, int32_t maxCellRadius, uint32_t patternByte, uint32_t patternIndexByte,
                          uint32_t markerByte, uint32_t stampFrame, uint32_t truncatedByte) {
  return gather_batch_with(batchCount, listByte, posByte, rangeByte, candByte, maxNeighbors, gridByte, cellByteSize,
                           cellIdStride, cellHeaderIds, gridWidth, gridHeight, invCellSize, skinFrac, maxCellRadius,
                           patternByte, patternIndexByte, markerByte, stampFrame, truncatedByte, 0);
}

__attribute__((export_name("gather_batch_f32x4")))
uint32_t gather_batch_f32x4(uint32_t batchCount, uint32_t listByte, uint32_t posByte, uint32_t rangeByte,
                            uint32_t candByte, uint32_t maxNeighbors, uint32_t gridByte, uint32_t cellByteSize,
                            uint32_t cellIdStride, uint32_t cellHeaderIds, int32_t gridWidth, int32_t gridHeight,
                            double invCellSize, double skinFrac, int32_t maxCellRadius, uint32_t patternByte,
                            uint32_t patternIndexByte, uint32_t markerByte, uint32_t stampFrame,
                            uint32_t truncatedByte) {
  return gather_batch_with(batchCount, listByte, posByte, rangeByte, candByte, maxNeighbors, gridByte, cellByteSize,
                           cellIdStride, cellHeaderIds, gridWidth, gridHeight, invCellSize, skinFrac, maxCellRadius,
                           patternByte, patternIndexByte, markerByte, stampFrame, truncatedByte, 1);
}
