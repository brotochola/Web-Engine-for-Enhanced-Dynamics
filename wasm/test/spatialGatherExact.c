/* E-147, not shipped: the gather with its range test in float32x4 and the double test on the edge band and past a
   cell's last block of four, so it keeps exactly what the shipped double gather keeps. Chrome replay (spatialGather
   ReplayKernel): +9.0 % on a frame that rebuilds every list, +12.2 % on Predator's; scenes: Predator spatial -1.8 %,
   orientedBoxScene -2.3 %, Boids +3.0 % (worse 4/4), so it stays a test module. */
/* Candidate gather for a batch of entities (E-76 W5, a candidate kernel): the cell walk of
   SpatialWorker.findNeighborsForOwnedEntities in the same cell order (the worker's circle patterns, copied
   into the memory by JS). The per-entity setup is in double as JS does it (the home cell, the search range,
   its radius in cells), so the same cells are walked and counted. The per-candidate range test is float32
   (E-147), a cell's ids four at a time where four more fit the row: the dedup marks lane by lane in the
   scalar order, each candidate's x, y and half extent from one load of its pose row, the test in f32x4, the
   kept ids appended in lane order. Float32 and the double test disagree only within about 5e-7 (relative,
   on the squared range) of the search edge (tests/bench/spatialGatherTolerance.mjs), so float32 decides only
   outside a band of 2^-19 around it (EDGE_LO, EDGE_HI); a candidate inside the band, almost never one, takes
   the double test, and so does every id past a cell's last block of four (a cell of three or fewer is all
   double, as in Boids' small cells). The gather keeps exactly what the double gather keeps. Chrome: +10.5 % on a frame that rebuilds every list, +8.1 % on
   Predator's (tests/bench/spatialGatherReplayKernel.mjs), no row different.
   Pointers are byte offsets into the imported shared memory. Returns the number of non-empty cells
   visited (cellsCheckedThisFrame). Entity ids are 16-bit, or 32-bit through the _u32 exports for a scene past
   65 535 entities (W8b): the lists, the candidate rows and the grid cells' ids hold ids of that width. */
#include <stdint.h>
#include <wasm_simd128.h>

/* 1 -/+ 2^-19 on the squared range: inside EDGE_LO float32 keeps, past EDGE_HI it drops, between the double
   test decides (see above). */
#define EDGE_LO 0.9999980926513672f
#define EDGE_HI 1.0000019073486328f

/* The double test, for a candidate float32 cannot place: JS's arithmetic, as the gather did before E-147. */
static inline int in_range_f64(const float *pos, uint32_t b, double myX, double myY, double searchRange) {
  const double dx = (double)pos[b * 4u] - myX;
  const double dy = (double)pos[b * 4u + 1u] - myY;
  const double er = searchRange + (double)pos[b * 4u + 2u];
  return dx * dx + dy * dy < er * er;
}

#define INLINE static inline __attribute__((always_inline))

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
   scratch: u32 histogram[256], then u16 keys and keys2 of batchCount each, then list2 of batchCount ids.
   Returns 1 when it reordered. */
INLINE uint32_t order_by_cell(uint32_t batchCount, uint32_t listByte, uint32_t posByte, double invCellSize,
                              int32_t gridWidth, int32_t gridHeight, uint32_t scratchByte, int wide) {
  if (batchCount < 2 || (uint64_t)(uint32_t)gridWidth * (uint64_t)(uint32_t)gridHeight > 65536u) return 0;
  uint16_t *list16 = (uint16_t *)(uintptr_t)listByte;
  uint32_t *list32 = (uint32_t *)(uintptr_t)listByte;
  const float *pos = (const float *)(uintptr_t)posByte;
  uint32_t *hist = (uint32_t *)(uintptr_t)scratchByte;
  uint16_t *keys = (uint16_t *)(uintptr_t)(scratchByte + 1024u);
  uint16_t *keys2 = keys + batchCount;
  uint16_t *list2_16 = keys2 + batchCount;
  uint32_t *list2_32 = (uint32_t *)(void *)(keys2 + batchCount);
  const int32_t maxRow = gridHeight - 1;
  const int32_t maxCol = gridWidth - 1;
  for (uint32_t n = 0; n < batchCount; n++) {
    const uint32_t e = wide ? list32[n] : list16[n];
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
    if (wide) list2_32[d] = list32[n];
    else list2_16[d] = list16[n];
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
  for (uint32_t n = 0; n < batchCount; n++) {
    const uint32_t d = hist[keys2[n] >> 8]++;
    if (wide) list32[d] = list2_32[n];
    else list16[d] = list2_16[n];
  }
  return 1;
}

__attribute__((export_name("order_batch_by_cell")))
uint32_t order_batch_by_cell(uint32_t batchCount, uint32_t listByte, uint32_t posByte, double invCellSize,
                             int32_t gridWidth, int32_t gridHeight, uint32_t scratchByte) {
  return order_by_cell(batchCount, listByte, posByte, invCellSize, gridWidth, gridHeight, scratchByte, 0);
}

__attribute__((export_name("order_batch_by_cell_u32")))
uint32_t order_batch_by_cell_u32(uint32_t batchCount, uint32_t listByte, uint32_t posByte, double invCellSize,
                                 int32_t gridWidth, int32_t gridHeight, uint32_t scratchByte) {
  return order_by_cell(batchCount, listByte, posByte, invCellSize, gridWidth, gridHeight, scratchByte, 1);
}

INLINE uint32_t gather(
    uint32_t batchCount,
    uint32_t listByte,          /* entity ids to rebuild */
    uint32_t posByte,           /* f32 [x, y, halfExtent, pad] per entity */
    uint32_t rangeByte,         /* f32 visual range per entity */
    uint32_t candByte,          /* rows of 1 + maxNeighbors ids: count, then candidates */
    uint32_t maxNeighbors,
    uint32_t gridByte,          /* the grid cells: u8 count at each cell's first byte, ids after */
    uint32_t cellByteSize,
    uint32_t cellIdStride,      /* id slots per cell */
    uint32_t cellHeaderIds,     /* id slots before a cell's first id */
    int32_t gridWidth,
    int32_t gridHeight,
    double invCellSize,
    double skinFrac,
    int32_t maxCellRadius,
    uint32_t patternByte,       /* i32 [dr, dc] pairs, every radius in turn */
    uint32_t patternIndexByte,  /* i32 [first pair, pair count] per radius 0..maxCellRadius */
    uint32_t markerByte,        /* i32 per entity: this worker's dedup stamps */
    uint32_t stampFrame,
    uint32_t truncatedByte,     /* u8 per entity: 1 when the row hit maxNeighbors */
    int wide) {
  const uint16_t *list16 = (const uint16_t *)(uintptr_t)listByte;
  const uint32_t *list32 = (const uint32_t *)(uintptr_t)listByte;
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  uint16_t *cand16 = (uint16_t *)(uintptr_t)candByte;
  uint32_t *cand32 = (uint32_t *)(uintptr_t)candByte;
  const uint8_t *gridCounts = (const uint8_t *)(uintptr_t)gridByte;
  const uint16_t *grid16 = (const uint16_t *)(uintptr_t)gridByte;
  const uint32_t *grid32 = (const uint32_t *)(uintptr_t)gridByte;
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
    const uint32_t entityA = wide ? list32[n] : list16[n];
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
    /* The float32 test's inputs: the positions are float already, the search range is rounded once. */
    const float ax = pos[entityA * 4u];
    const float ay = pos[entityA * 4u + 1u];
    const float sr = (float)searchRange;
    const v128_t ax4 = wasm_f32x4_splat(ax);
    const v128_t ay4 = wasm_f32x4_splat(ay);
    const v128_t sr4 = wasm_f32x4_splat(sr);
    const v128_t lo4 = wasm_f32x4_splat(EDGE_LO);
    const v128_t hi4 = wasm_f32x4_splat(EDGE_HI);
    uint16_t *row16 = cand16 + candBase + 1u;
    uint32_t *row32 = cand32 + candBase + 1u;

    for (int32_t p = 0; p < pairs; p++) {
      const int32_t row = homeRow + pattern[(first + p) * 2];
      const int32_t col = homeCol + pattern[(first + p) * 2 + 1];
      if (row < 0 || row >= gridHeight || col < 0 || col >= gridWidth) continue;
      const uint32_t cell = (uint32_t)(row * gridWidth + col);
      const uint32_t count = gridCounts[cell * cellByteSize];
      if (count == 0) continue;
      cellsChecked++;
      const uint32_t at = cell * cellIdStride + cellHeaderIds;
      uint32_t j = 0;
      /* Four ids a step while four more fit the row, so a row truncates where the scalar loop would. */
      for (; j + 4 <= count && candCount + 4 <= maxNeighbors; j += 4) {
        const uint32_t b0 = wide ? grid32[at + j] : grid16[at + j];
        const uint32_t b1 = wide ? grid32[at + j + 1] : grid16[at + j + 1];
        const uint32_t b2 = wide ? grid32[at + j + 2] : grid16[at + j + 2];
        const uint32_t b3 = wide ? grid32[at + j + 3] : grid16[at + j + 3];
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
        const v128_t d2 = wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dy, dy));
        const v128_t e2 = wasm_f32x4_mul(er, er);
        uint32_t kept = (uint32_t)wasm_i32x4_bitmask(wasm_f32x4_lt(d2, wasm_f32x4_mul(e2, lo4))) & live;
        /* The lanes on the edge band, which float32 cannot place: the double test. */
        const uint32_t band = (uint32_t)wasm_i32x4_bitmask(wasm_f32x4_lt(d2, wasm_f32x4_mul(e2, hi4))) & live & ~kept;
        if (band) {
          if ((band & 1u) && in_range_f64(pos, b0, myX, myY, searchRange)) kept |= 1u;
          if ((band & 2u) && in_range_f64(pos, b1, myX, myY, searchRange)) kept |= 2u;
          if ((band & 4u) && in_range_f64(pos, b2, myX, myY, searchRange)) kept |= 4u;
          if ((band & 8u) && in_range_f64(pos, b3, myX, myY, searchRange)) kept |= 8u;
        }
        /* In lane order; a lane not kept is written at the count and overwritten or left past it. */
        if (wide) {
          row32[candCount] = b0;
          candCount += kept & 1u;
          row32[candCount] = b1;
          candCount += (kept >> 1) & 1u;
          row32[candCount] = b2;
          candCount += (kept >> 2) & 1u;
          row32[candCount] = b3;
          candCount += (kept >> 3) & 1u;
        } else {
          row16[candCount] = (uint16_t)b0;
          candCount += kept & 1u;
          row16[candCount] = (uint16_t)b1;
          candCount += (kept >> 1) & 1u;
          row16[candCount] = (uint16_t)b2;
          candCount += (kept >> 2) & 1u;
          row16[candCount] = (uint16_t)b3;
          candCount += (kept >> 3) & 1u;
        }
      }
      for (; j < count; j++) {
        const uint32_t entityB = wide ? grid32[at + j] : grid16[at + j];
        if (entityA == entityB) continue;
        if (marker[entityB] == stampedA) continue;
        marker[entityB] = stampedA;
        /* One id at a time: the double test, which float32 would only match here (the blocks above are where
           four lanes pay). */
        if (in_range_f64(pos, entityB, myX, myY, searchRange)) {
          if (candCount < maxNeighbors) {
            if (wide) cand32[candBase + 1u + candCount] = entityB;
            else cand16[candBase + 1u + candCount] = (uint16_t)entityB;
            candCount++;
          } else {
            truncated = 1;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (wide) cand32[candBase] = candCount;
    else cand16[candBase] = (uint16_t)candCount;
    truncatedOf[entityA] = truncated;
  }
  return cellsChecked;
}

#define GATHER_ARGS uint32_t batchCount, uint32_t listByte, uint32_t posByte, uint32_t rangeByte, uint32_t candByte, \
    uint32_t maxNeighbors, uint32_t gridByte, uint32_t cellByteSize, uint32_t cellIdStride, uint32_t cellHeaderIds, \
    int32_t gridWidth, int32_t gridHeight, double invCellSize, double skinFrac, int32_t maxCellRadius, \
    uint32_t patternByte, uint32_t patternIndexByte, uint32_t markerByte, uint32_t stampFrame, uint32_t truncatedByte
#define GATHER_PASS batchCount, listByte, posByte, rangeByte, candByte, maxNeighbors, gridByte, cellByteSize, \
    cellIdStride, cellHeaderIds, gridWidth, gridHeight, invCellSize, skinFrac, maxCellRadius, patternByte, \
    patternIndexByte, markerByte, stampFrame, truncatedByte

__attribute__((export_name("gather_batch_exact")))
uint32_t gather_batch_exact(GATHER_ARGS) {
  return gather(GATHER_PASS, 0);
}

__attribute__((export_name("gather_batch_exact_u32")))
uint32_t gather_batch_exact_u32(GATHER_ARGS) {
  return gather(GATHER_PASS, 1);
}
