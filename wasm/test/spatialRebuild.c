/* Row rebuild of one spatial worker (E-76 W6, a candidate kernel): SpatialWorker.rebuildOwnedRows
   with getColliderBounds and getCellRange inlined, the same arithmetic (float32 columns widened to
   double, every operation in double, in the JS order) and the same insertion order, so it writes the
   cells, poses and owned list the JS writes. Every input and output is a byte offset into the
   imported shared memory, read from a table of u32 offsets (REBUILD_*). Returns the owned count; the
   bodiless-sprite count (collectDetailedStats) goes to the table's result slot. */
#include <stdint.h>

#define SHAPE_CIRCLE 1
#define SHAPE_POLYGON 2
#define SHAPE_CHAIN 3
#define MAX_POLYGON_VERTICES 8

/* u32 slots of the table (spatialRebuildClient lays them out in the same order). */
enum {
  T_ACTIVE,          /* u16 [count, id …] */
  T_COLLIDER_ACTIVE, /* u8 */
  T_SPRITE_ACTIVE,   /* u8 */
  T_RIGID_ACTIVE,    /* u8, 0 when there is no RigidBody */
  T_SHAPE,           /* u8 */
  T_X, T_Y, T_ROT_C, T_ROT_S,      /* f32 */
  T_OFFSET_X, T_OFFSET_Y, T_RADIUS, T_WIDTH, T_HEIGHT, T_CENTROID_X, T_CENTROID_Y, /* f32 */
  T_FIXTURE_COUNT,   /* u16 */
  T_POLY_COUNT,      /* u8 */
  T_VERTEX_X, T_VERTEX_Y,          /* f32, MAX_POLYGON_VERTICES per entity */
  T_ROW_OWNERSHIP,   /* u8 per row */
  T_OWNED_ROWS,      /* i32 */
  T_OWNED_ROW_COUNT,
  T_GRID_WIDTH,
  T_GRID_HEIGHT,
  T_WORKER_ID,
  T_GRID,            /* cells of cellByteSize: u8 count at byte 0, u16 ids from byte 4 */
  T_CELL_BYTES,
  T_MAX_PER_CELL,
  T_LOCAL_COUNTS,    /* u8 per cell */
  T_OWNED_LIST,      /* u16 */
  T_POS,             /* f32 [x, y, halfExtent, pad] per entity */
  T_COUNT_NO_BODY,
  T_RESULT_NO_BODY,
  T_SLOTS
};

/* JS `(v || 0)` for a float32 read: NaN and either zero give +0. */
static inline double or0(float v) {
  return (v != v || v == 0.0f) ? 0.0 : (double)v;
}

/* JS `(v | 0)` then clamped to [0, max]: truncation toward zero, and 0 for NaN or a negative v.
   (JS wraps a v past 2^31; positions and radii here are far below it.) */
static inline int32_t clamp_index(double v, int32_t max) {
  if (!(v >= 0.0)) return 0;
  if (v >= (double)max) return max;
  return (int32_t)v;
}

/* JS `c < 0 ? -c : c`: keeps -0, as the JS does. */
static inline double js_abs(double c) {
  return c < 0.0 ? -c : c;
}

__attribute__((export_name("rebuild_rows")))
uint32_t rebuild_rows(uint32_t tableByte, double invCellSize) {
  uint32_t *t = (uint32_t *)(uintptr_t)tableByte;
  const uint16_t *active = (const uint16_t *)(uintptr_t)t[T_ACTIVE];
  const uint8_t *colliderActive = (const uint8_t *)(uintptr_t)t[T_COLLIDER_ACTIVE];
  const uint8_t *spriteActive = (const uint8_t *)(uintptr_t)t[T_SPRITE_ACTIVE];
  const uint8_t *rigidActive = (const uint8_t *)(uintptr_t)t[T_RIGID_ACTIVE];
  const uint8_t *shapeType = (const uint8_t *)(uintptr_t)t[T_SHAPE];
  const float *x = (const float *)(uintptr_t)t[T_X];
  const float *y = (const float *)(uintptr_t)t[T_Y];
  const float *rotC = (const float *)(uintptr_t)t[T_ROT_C];
  const float *rotS = (const float *)(uintptr_t)t[T_ROT_S];
  const float *offsetX = (const float *)(uintptr_t)t[T_OFFSET_X];
  const float *offsetY = (const float *)(uintptr_t)t[T_OFFSET_Y];
  const float *radius = (const float *)(uintptr_t)t[T_RADIUS];
  const float *width = (const float *)(uintptr_t)t[T_WIDTH];
  const float *height = (const float *)(uintptr_t)t[T_HEIGHT];
  const float *centroidX = (const float *)(uintptr_t)t[T_CENTROID_X];
  const float *centroidY = (const float *)(uintptr_t)t[T_CENTROID_Y];
  const uint16_t *fixtureCount = (const uint16_t *)(uintptr_t)t[T_FIXTURE_COUNT];
  const uint8_t *polyCount = (const uint8_t *)(uintptr_t)t[T_POLY_COUNT];
  const float *vertexX = (const float *)(uintptr_t)t[T_VERTEX_X];
  const float *vertexY = (const float *)(uintptr_t)t[T_VERTEX_Y];
  const uint8_t *rowOwnership = (const uint8_t *)(uintptr_t)t[T_ROW_OWNERSHIP];
  const int32_t *ownedRows = (const int32_t *)(uintptr_t)t[T_OWNED_ROWS];
  const uint32_t ownedRowCount = t[T_OWNED_ROW_COUNT];
  const int32_t gridWidth = (int32_t)t[T_GRID_WIDTH];
  const int32_t gridHeight = (int32_t)t[T_GRID_HEIGHT];
  const uint8_t workerId = (uint8_t)t[T_WORKER_ID];
  uint8_t *grid = (uint8_t *)(uintptr_t)t[T_GRID];
  const uint32_t cellBytes = t[T_CELL_BYTES];
  const uint32_t maxPerCell = t[T_MAX_PER_CELL];
  uint8_t *localCounts = (uint8_t *)(uintptr_t)t[T_LOCAL_COUNTS];
  uint16_t *ownedList = (uint16_t *)(uintptr_t)t[T_OWNED_LIST];
  float *pos = (float *)(uintptr_t)t[T_POS];
  const uint32_t countNoBody = t[T_COUNT_NO_BODY];

  const int32_t maxCol = gridWidth - 1;
  const int32_t maxRow = gridHeight - 1;
  uint32_t ownedCount = 0;
  uint32_t noBody = 0;

  for (uint32_t r = 0; r < ownedRowCount; r++) {
    uint8_t *row = localCounts + ownedRows[r] * gridWidth;
    for (int32_t col = 0; col < gridWidth; col++) row[col] = 0;
  }

  const uint32_t total = active[0];
  for (uint32_t a = 0; a < total; a++) {
    const uint32_t i = active[1 + a];
    const uint8_t hasCollider = colliderActive[i];
    if (!hasCollider && !spriteActive[i]) continue;
    if (countNoBody && spriteActive[i] && !hasCollider && !(rigidActive && rigidActive[i])) noBody++;

    double posX;
    double posY;
    double halfW = 0.0;
    double halfH = 0.0;
    const uint8_t shape = shapeType[i];
    if (hasCollider && shape == SHAPE_CIRCLE) {
      posX = (double)x[i] + or0(offsetX[i]);
      posY = (double)y[i] + or0(offsetY[i]);
      halfW = or0(radius[i]);
      halfH = halfW;
    } else if (hasCollider) {
      const double tx = x[i];
      const double ty = y[i];
      const double ox = or0(offsetX[i]);
      const double oy = or0(offsetY[i]);
      const double c = rotC[i];
      const double s = rotS[i];
      const double ac = js_abs(c);
      const double as = js_abs(s);
      if (shape == SHAPE_CHAIN) {
        const double originX = tx + c * ox - s * oy;
        const double originY = ty + s * ox + c * oy;
        const double lcx = centroidX[i];
        const double lcy = centroidY[i];
        posX = originX + c * lcx - s * lcy;
        posY = originY + s * lcx + c * lcy;
        const double hw = or0(width[i]) * 0.5;
        const double hh = or0(height[i]) * 0.5;
        halfW = ac * hw + as * hh;
        halfH = as * hw + ac * hh;
      } else if (shape == SHAPE_POLYGON) {
        const double originX = tx + c * ox - s * oy;
        const double originY = ty + s * ox + c * oy;
        const double skin = or0(radius[i]);
        if (fixtureCount[i] > 0) {
          const double lcx = centroidX[i];
          const double lcy = centroidY[i];
          posX = originX + c * lcx - s * lcy;
          posY = originY + s * lcx + c * lcy;
          const double hw = or0(width[i]) * 0.5;
          const double hh = or0(height[i]) * 0.5;
          halfW = ac * hw + as * hh + skin;
          halfH = as * hw + ac * hh + skin;
        } else {
          const uint32_t count = polyCount[i];
          if (count >= 3) {
            const float *vx = vertexX + i * MAX_POLYGON_VERTICES;
            const float *vy = vertexY + i * MAX_POLYGON_VERTICES;
            double minX = __builtin_inf();
            double maxX = -__builtin_inf();
            double minY = __builtin_inf();
            double maxY = -__builtin_inf();
            for (uint32_t k = 0; k < count; k++) {
              const double lx = vx[k];
              const double ly = vy[k];
              const double wx = originX + c * lx - s * ly;
              const double wy = originY + s * lx + c * ly;
              if (wx < minX) minX = wx;
              if (wx > maxX) maxX = wx;
              if (wy < minY) minY = wy;
              if (wy > maxY) maxY = wy;
            }
            posX = (minX + maxX) * 0.5;
            posY = (minY + maxY) * 0.5;
            halfW = (maxX - minX) * 0.5 + skin;
            halfH = (maxY - minY) * 0.5 + skin;
          } else {
            posX = originX;
            posY = originY;
            const double hw = or0(width[i]) * 0.5;
            const double hh = or0(height[i]) * 0.5;
            halfW = ac * hw + as * hh + skin;
            halfH = as * hw + ac * hh + skin;
          }
        }
      } else {
        posX = tx + c * ox - s * oy;
        posY = ty + s * ox + c * oy;
        const double hw = or0(width[i]) * 0.5;
        const double hh = or0(height[i]) * 0.5;
        halfW = ac * hw + as * hh;
        halfH = as * hw + ac * hh;
      }
    } else {
      posX = (double)x[i] + (double)offsetX[i];
      posY = (double)y[i] + (double)offsetY[i];
    }

    if (posX != posX || posY != posY) continue;

    const double maxHalfExtent = halfW > halfH ? halfW : halfH;
    const int32_t homeRow = clamp_index((double)(float)posY * invCellSize, maxRow);
    if (rowOwnership[homeRow] == workerId) ownedList[ownedCount++] = (uint16_t)i;

    const int32_t minCol = clamp_index((posX - halfW) * invCellSize, maxCol);
    const int32_t maxColBB = clamp_index((posX + halfW) * invCellSize, maxCol);
    const int32_t minRow = clamp_index((posY - halfH) * invCellSize, maxRow);
    const int32_t maxRowBB = clamp_index((posY + halfH) * invCellSize, maxRow);

    uint32_t wrotePos = 0;
    for (int32_t row = minRow; row <= maxRowBB; row++) {
      if (rowOwnership[row] != workerId) continue;
      if (!wrotePos) {
        float *p = pos + i * 4u;
        p[0] = (float)posX;
        p[1] = (float)posY;
        p[2] = (float)maxHalfExtent;
        wrotePos = 1;
      }
      const int32_t rowBase = row * gridWidth;
      for (int32_t col = minCol; col <= maxColBB; col++) {
        const int32_t cell = rowBase + col;
        const uint32_t localCount = localCounts[cell];
        if (localCount < maxPerCell) {
          uint16_t *ids = (uint16_t *)(grid + (uint32_t)cell * cellBytes + 4u);
          ids[localCount] = (uint16_t)i;
          localCounts[cell] = (uint8_t)(localCount + 1u);
        }
      }
    }
  }

  for (uint32_t r = 0; r < ownedRowCount; r++) {
    const int32_t rowBase = ownedRows[r] * gridWidth;
    for (int32_t col = 0; col < gridWidth; col++) {
      const int32_t cell = rowBase + col;
      grid[(uint32_t)cell * cellBytes] = localCounts[cell];
    }
  }
  t[T_RESULT_NO_BODY] = noBody;
  return ownedCount;
}
