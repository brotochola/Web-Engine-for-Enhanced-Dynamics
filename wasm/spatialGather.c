/* Candidate gather for a batch of entities (E-76 W5, a candidate kernel): the cell walk of
   SpatialWorker.findNeighborsForOwnedEntities with the same arithmetic (the float32 inputs widened
   to double, every operation in double, as JS does it) and the same cell order (the worker's circle
   patterns, copied into the memory by JS), so it stores the candidates the JS gather stores.
   Pointers are byte offsets into the imported shared memory. Returns the number of non-empty cells
   visited (cellsCheckedThisFrame). */
#include <stdint.h>

/* JS `(v | 0)` then clamped to [0, max]: truncation toward zero, and 0 for NaN or a negative v.
   (JS wraps a v past 2^31; positions and radii here are far below it.) */
static inline int32_t clamp_index(double v, int32_t max) {
  if (!(v >= 0.0)) return 0;
  if (v >= (double)max) return max;
  return (int32_t)v;
}

/* JS `(v | 0)` for the non-negative values a search radius in cells takes; NaN gives 0. */
static inline int32_t trunc_cells(double v) {
  if (!(v >= 0.0)) return 0;
  if (v >= 2147483647.0) return 2147483647;
  return (int32_t)v;
}

/* Reorders a rebuild list by home cell, stably, so the entities that walk the same cells run one
   after another and find those cells' ids and positions still in cache. What the gather and the
   publish store for an entity does not depend on the order. Two LSD radix passes on the 16-bit cell
   index (the cell gather_batch computes); a grid of more than 65 536 cells keeps its order.
   scratch: u32 histogram[256], then u16 keys, keys2 and list2 of batchCount each. Returns 1 when
   it reordered. */
__attribute__((export_name("order_batch_by_cell")))
uint32_t order_batch_by_cell(uint32_t batchCount, uint32_t listByte, uint32_t posByte, double invCellSize,
                             int32_t gridWidth, int32_t gridHeight, uint32_t scratchByte) {
  if (batchCount < 2 || (uint64_t)(uint32_t)gridWidth * (uint64_t)(uint32_t)gridHeight > 65536u) return 0;
  uint16_t *list = (uint16_t *)(uintptr_t)listByte;
  const float *pos = (const float *)(uintptr_t)posByte;
  uint32_t *hist = (uint32_t *)(uintptr_t)scratchByte;
  uint16_t *keys = (uint16_t *)(uintptr_t)(scratchByte + 1024u);
  uint16_t *keys2 = keys + batchCount;
  uint16_t *list2 = keys2 + batchCount;
  const int32_t maxRow = gridHeight - 1;
  const int32_t maxCol = gridWidth - 1;
  for (uint32_t n = 0; n < batchCount; n++) {
    const uint32_t e = list[n];
    const int32_t row = clamp_index((double)pos[e * 4u + 1u] * invCellSize, maxRow);
    const int32_t col = clamp_index((double)pos[e * 4u] * invCellSize, maxCol);
    keys[n] = (uint16_t)(row * gridWidth + col);
  }
  for (uint32_t b = 0; b < 256u; b++) hist[b] = 0;
  for (uint32_t n = 0; n < batchCount; n++) hist[keys[n] & 255u]++;
  uint32_t sum = 0;
  for (uint32_t b = 0; b < 256u; b++) {
    const uint32_t c = hist[b];
    hist[b] = sum;
    sum += c;
  }
  for (uint32_t n = 0; n < batchCount; n++) {
    const uint32_t d = hist[keys[n] & 255u]++;
    list2[d] = list[n];
    keys2[d] = keys[n];
  }
  for (uint32_t b = 0; b < 256u; b++) hist[b] = 0;
  for (uint32_t n = 0; n < batchCount; n++) hist[keys2[n] >> 8]++;
  sum = 0;
  for (uint32_t b = 0; b < 256u; b++) {
    const uint32_t c = hist[b];
    hist[b] = sum;
    sum += c;
  }
  for (uint32_t n = 0; n < batchCount; n++) list[hist[keys2[n] >> 8]++] = list2[n];
  return 1;
}

__attribute__((export_name("gather_batch")))
uint32_t gather_batch(
    uint32_t batchCount,
    uint32_t listByte,          /* u16 entity ids to rebuild */
    uint32_t posByte,           /* f32 [x, y, halfExtent, pad] per entity */
    uint32_t rangeByte,         /* f32 visual range per entity */
    uint32_t candByte,          /* u16 rows of 1 + maxNeighbors: count, then candidates */
    uint32_t maxNeighbors,
    uint32_t gridByte,          /* the grid cells: u8 count at each cell's first byte, u16 ids after */
    uint32_t cellByteSize,
    uint32_t cellIdStride,      /* u16 slots per cell */
    uint32_t cellHeaderIds,     /* u16 slots before a cell's first id */
    int32_t gridWidth,
    int32_t gridHeight,
    double invCellSize,
    double skinFrac,
    int32_t maxCellRadius,
    uint32_t patternByte,       /* i32 [dr, dc] pairs, every radius in turn */
    uint32_t patternIndexByte,  /* i32 [first pair, pair count] per radius 0..maxCellRadius */
    uint32_t markerByte,        /* i32 per entity: this worker's dedup stamps */
    uint32_t stampFrame,
    uint32_t truncatedByte) {   /* u8 per entity: 1 when the row hit maxNeighbors */
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
  /* packSpatialPairStamp: 13 frame bits over 19 id bits. */
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
    uint32_t candCount = 0;
    uint8_t truncated = 0;

    for (int32_t p = 0; p < pairs; p++) {
      const int32_t row = homeRow + pattern[(first + p) * 2];
      const int32_t col = homeCol + pattern[(first + p) * 2 + 1];
      if (row < 0 || row >= gridHeight || col < 0 || col >= gridWidth) continue;
      const uint32_t cell = (uint32_t)(row * gridWidth + col);
      const uint32_t count = gridCounts[cell * cellByteSize];
      if (count == 0) continue;
      cellsChecked++;
      const uint16_t *ids = gridEntities + cell * cellIdStride + cellHeaderIds;
      for (uint32_t j = 0; j < count; j++) {
        const uint32_t entityB = ids[j];
        if (entityA == entityB) continue;
        if (marker[entityB] == stampedA) continue;
        marker[entityB] = stampedA;
        const double dx = (double)pos[entityB * 4u] - myX;
        const double dy = (double)pos[entityB * 4u + 1u] - myY;
        const double effectiveRange = searchRange + (double)pos[entityB * 4u + 2u];
        if (dx * dx + dy * dy < effectiveRange * effectiveRange) {
          if (candCount < maxNeighbors) {
            cand[candBase + 1u + candCount] = (uint16_t)entityB;
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
