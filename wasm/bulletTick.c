/* The bullet tick (E-76 W19): BulletPool.tick (src/core/bulletPool.js) with its Ray.linecastDir
   (src/core/ray.js: _traverseGrid, _checkCellEntities, the circle, box and single-polygon tests) in one call per
   frame. Each live bullet moves, casts its step through the spatial grid against the colliders there, and either
   hits (an impact record, the bullet off, its slot on the returned list for the JS's returnToPool) or stays (the
   active list). Every column is a byte offset into one shared memory, from the table: Phase 4 lays the bullets,
   Transform, Collider and the grid in Box2D's block, where Transform's pose already is.
   Arithmetic as the JS does it: doubles from float32 inputs, each value stored as the typed array stores it.
   A bullet whose cast meets a compound polygon or a chain goes back to the JS (its fixtures and chain points
   stay there): the tick stops before writing anything for it and returns its position; the JS ticks that one
   bullet and calls again from the next. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

enum {
  B_ACTIVE, B_X, B_Y, B_PREV_X, B_PREV_Y, B_VX, B_VY, B_SPEED, B_ROT_C, B_ROT_S, B_DAMAGE, B_OWNER, B_SHOOTER,
  O_ACTIVE,    /* the active list, u16: [0] the count, then the bullets that stay */
  O_IMPACTS,   /* f32 × 6 per impact: entity, damage, x, y, owner, shooter type */
  O_RETURNED,  /* u32: the bullets that hit, in the walk's order, for returnToPool */
  R_RESULTS,   /* i32: [0] the active list's next slot, [1] impacts written, [2] their cap, [3] returned */
  T_ACTIVE, T_X, T_Y, T_ROT_C, T_ROT_S,
  C_ACTIVE, C_SHAPE, C_LAYER, C_OFF_X, C_OFF_Y, C_RADIUS, C_WIDTH, C_HEIGHT,
  C_POLY_COUNT, C_FIXTURE_COUNT, C_PVX, C_PVY, C_PNX, C_PNY,
  G_GRID,      /* the grid's first cell: [count:u8, pad:3, ids:u16 × maxEntitiesPerCell] per cell */
  G_STAMP,     /* u32 per entity: the ray that last tested it (Ray._rayGenStamp's role) */
  G_GEN,       /* a value: the last ray's number, kept here between calls */
  SLOT_COUNT
};

/* ShapeType (src/box2d/box2dConstantsImpl.js); the client checks these. */
enum { SHAPE_BOX = 0, SHAPE_CIRCLE = 1, SHAPE_POLYGON = 2, SHAPE_CHAIN = 3 };
#define MAX_POLYGON_VERTICES 8

#define PTR(T, c) ((T *)(uintptr_t)t[c])

static const double INF = __builtin_inf();

/* `v || 0` on a number: 0, -0 and NaN become +0. */
INLINE double or0(float v) { return (v == 0.0f || v != v) ? 0.0 : (double)v; }

/* Math.min and Math.max: NaN if either is, and -0 below +0. */
INLINE double js_min(double a, double b) {
  if (a != a || b != b) return __builtin_nan("");
  if (a == b) return __builtin_signbit(a) ? a : b;
  return a < b ? a : b;
}
INLINE double js_max(double a, double b) {
  if (a != a || b != b) return __builtin_nan("");
  if (a == b) return __builtin_signbit(a) ? b : a;
  return a > b ? a : b;
}

typedef struct {
  uint32_t *t;
  const uint8_t *tActive;
  const float *x, *y, *rotC, *rotS;
  const uint8_t *cActive, *cShape, *cLayer;
  const float *offX, *offY, *radius, *width, *height;
  const uint8_t *polyCount;
  const uint16_t *fixtureCount;
  const float *pvx, *pvy, *pnx, *pny;
  const uint8_t *grid;
  uint32_t *stamp;
  int32_t rayMask;
  double invCellSize, cellSize;
  int32_t gridCols, gridRows;
  uint32_t cellByteSize;
} world_t;

/* The ray's state as RAY holds it: origin, unit direction, length. */
typedef struct { double x, y, dx, dy, len; } ray_t;

/* rayPolygonIntersect (src/util/utils.js) on an entity's own vertices. */
INLINE double ray_polygon(const ray_t *r, double polyX, double polyY, double cs, double sn, const float *vx,
                          const float *vy, const float *nx, const float *ny, uint32_t count, uint32_t base,
                          double maxDist) {
  if (count < 3) return -1;
  const double dx = r->x - polyX;
  const double dy = r->y - polyY;
  const double ox = cs * dx + sn * dy;
  const double oy = -sn * dx + cs * dy;
  const double rdx = cs * r->dx + sn * r->dy;
  const double rdy = -sn * r->dx + cs * r->dy;
  double tEnter = 0;
  double tExit = maxDist;
  for (uint32_t i = 0; i < count; i++) {
    const double px = vx[base + i];
    const double py = vy[base + i];
    const double nnx = nx[base + i];
    const double nny = ny[base + i];
    const double denom = rdx * nnx + rdy * nny;
    const double numer = (ox - px) * nnx + (oy - py) * nny;
    if (denom > 1e-12) {
      const double tt = -numer / denom;
      if (tt < tExit) tExit = tt;
    } else if (denom < -1e-12) {
      const double tt = -numer / denom;
      if (tt > tEnter) tEnter = tt;
    } else if (numer > 0) {
      return -1;
    }
    if (tEnter > tExit) return -1;
  }
  if (tEnter < 0) return -1;
  return tEnter <= tExit ? tEnter : -1;
}

/* _shapeRayDistance for one entity: the distance, -1 for a miss, or -2 when the shape stays JS. */
INLINE double shape_distance(const world_t *w, const ray_t *r, uint32_t e, double maxDist) {
  const uint32_t shape = w->cShape[e];
  if (shape == SHAPE_CIRCLE) {
    const double circleX = (double)w->x[e] + or0(w->offX[e]);
    const double circleY = (double)w->y[e] + or0(w->offY[e]);
    const double radius = w->radius[e];
    const double toX = circleX - r->x;
    const double toY = circleY - r->y;
    const double distSq0 = toX * toX + toY * toY;
    const double maxPossible = maxDist + radius;
    if (distSq0 > maxPossible * maxPossible) return -1;
    const double projection = toX * r->dx + toY * r->dy;
    if (projection < 0) return -1;
    const double closestX = r->x + r->dx * projection;
    const double closestY = r->y + r->dy * projection;
    const double distX = circleX - closestX;
    const double distY = circleY - closestY;
    const double distSq = distX * distX + distY * distY;
    const double radiusSq = radius * radius;
    if (distSq > radiusSq) return -1;
    const double distance = projection - __builtin_sqrt(radiusSq - distSq);
    if (distance > maxDist || distance < 0) return -1;
    return distance;
  }
  if (shape == SHAPE_BOX) {
    const double boxX = (double)w->x[e] + or0(w->offX[e]);
    const double boxY = (double)w->y[e] + or0(w->offY[e]);
    const double halfW = (double)w->width[e] * 0.5;
    const double halfH = (double)w->height[e] * 0.5;
    const double minX = boxX - halfW;
    const double maxX = boxX + halfW;
    const double minY = boxY - halfH;
    const double maxY = boxY + halfH;
    const double invDirX = r->dx != 0 ? 1 / r->dx : INF;
    const double invDirY = r->dy != 0 ? 1 / r->dy : INF;
    const double t1 = (minX - r->x) * invDirX;
    const double t2 = (maxX - r->x) * invDirX;
    const double t3 = (minY - r->y) * invDirY;
    const double t4 = (maxY - r->y) * invDirY;
    const double tmin = js_max(js_min(t1, t2), js_min(t3, t4));
    const double tmax = js_min(js_max(t1, t2), js_max(t3, t4));
    if (tmax < 0 || tmin > tmax) return -1;
    const double distance = tmin >= 0 ? tmin : tmax;
    if (distance > maxDist || distance < 0) return -1;
    return distance;
  }
  if (shape == SHAPE_POLYGON) {
    if (w->fixtureCount && w->fixtureCount[e] > 0) return -2;
    const double ox = or0(w->offX[e]);
    const double oy = or0(w->offY[e]);
    const double c = w->rotC ? (double)w->rotC[e] : 1;
    const double s = w->rotS ? (double)w->rotS[e] : 0;
    const double entityX = (double)w->x[e] + c * ox - s * oy;
    const double entityY = (double)w->y[e] + s * ox + c * oy;
    const uint32_t count = w->polyCount[e];
    if (count < 3) return -1;
    return ray_polygon(r, entityX, entityY, c, s, w->pvx, w->pvy, w->pnx, w->pny, count, e * MAX_POLYGON_VERTICES,
                       maxDist);
  }
  if (shape == SHAPE_CHAIN) return -2;
  return -1;
}

/* _traverseGrid with _checkCellEntities: the closest hit's entity (-1 for none, -2 when the JS must cast) and its
   distance in *dist. */
INLINE int32_t cast(const world_t *w, const ray_t *r, int32_t excludeA, double *dist) {
  uint32_t gen = w->t[G_GEN] + 1;
  if (gen == 0) {
    /* Ray._beginRayGen's wrap: the stamps are cleared by the client before a call that would wrap. */
    gen = 1;
  }
  w->t[G_GEN] = gen;
  const double xTo = r->x + r->dx * r->len;
  const double yTo = r->y + r->dy * r->len;
  const double inv = w->invCellSize;
  const double cell = w->cellSize;
  const int32_t cols = w->gridCols;
  const int32_t rows = w->gridRows;
  const double fx = __builtin_floor(r->x * inv);
  const double fy = __builtin_floor(r->y * inv);
  const double ex = __builtin_floor(xTo * inv);
  const double ey = __builtin_floor(yTo * inv);
  const int32_t stepX = r->dx >= 0 ? 1 : -1;
  const int32_t stepY = r->dy >= 0 ? 1 : -1;
  double tMaxX, tMaxY;
  if (r->dx != 0) {
    const double nb = (stepX > 0 ? fx + 1 : __builtin_ceil(r->x * inv) - 1) * cell;
    tMaxX = __builtin_fabs((nb - r->x) / r->dx);
  } else {
    tMaxX = INF;
  }
  if (r->dy != 0) {
    const double nb = (stepY > 0 ? fy + 1 : __builtin_ceil(r->y * inv) - 1) * cell;
    tMaxY = __builtin_fabs((nb - r->y) / r->dy);
  } else {
    tMaxY = INF;
  }
  const double tDeltaX = r->dx != 0 ? cell / __builtin_fabs(r->dx) : INF;
  const double tDeltaY = r->dy != 0 ? cell / __builtin_fabs(r->dy) : INF;
  /* The cell coordinates as doubles, as the JS keeps them (they can sit outside the grid, or past 2^31). */
  double cx = fx;
  double cy = fy;
  int32_t closestHit = -1;
  double closestDist = r->len;
  const int32_t maxSteps = cols + rows;
  int32_t steps = 0;
  while (steps++ < maxSteps) {
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
      const uint32_t cellIndex = (uint32_t)cy * (uint32_t)cols + (uint32_t)cx;
      const uint8_t *c = w->grid + (uintptr_t)cellIndex * w->cellByteSize;
      const uint32_t count = c[0];
      const uint16_t *ids = (const uint16_t *)(c + 4);
      int32_t cellHit = -1;
      double cellDist = closestDist;
      for (uint32_t k = 0; k < count; k++) {
        const uint32_t e = ids[k];
        if (w->stamp[e] == gen) continue;
        w->stamp[e] = gen;
        if ((int32_t)e == excludeA) continue;
        if (!w->tActive[e]) continue;
        if (!w->cActive[e]) continue;
        if (!((1u << (w->cLayer[e] & 31)) & (uint32_t)w->rayMask)) continue;
        const double shapeMax = cellDist < r->len ? cellDist : r->len;
        const double d = shape_distance(w, r, e, shapeMax);
        if (d == -2) return -2;
        if (d >= 0 && d < cellDist) {
          cellDist = d;
          cellHit = (int32_t)e;
        }
      }
      if (cellHit != -1) {
        closestHit = cellHit;
        closestDist = cellDist;
      }
    }
    if (closestDist <= (tMaxX < tMaxY ? tMaxX : tMaxY)) break;
    if (cx == ex && cy == ey) break;
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      tMaxY += tDeltaY;
    }
  }
  *dist = closestDist;
  return closestHit;
}

/* BulletPool.tick's loop from bullet `from` to `count`: returns `count` when it ticked them all, or the position of
   a bullet the JS must tick. dt is dtRatio / 60 as the JS computes it. */
__attribute__((export_name("bullet_tick")))
uint32_t bullet_tick(uint32_t table, uint32_t from, uint32_t count, double dt, double invCellSize, double cellSize,
                     int32_t gridCols, int32_t gridRows, uint32_t cellByteSize, int32_t rayMask) {
  uint32_t *t = (uint32_t *)(uintptr_t)table;
  uint8_t *active = PTR(uint8_t, B_ACTIVE);
  float *x = PTR(float, B_X);
  float *y = PTR(float, B_Y);
  float *prevX = PTR(float, B_PREV_X);
  float *prevY = PTR(float, B_PREV_Y);
  const float *vx = PTR(const float, B_VX);
  const float *vy = PTR(const float, B_VY);
  const float *speed = PTR(const float, B_SPEED);
  const float *rotC = PTR(const float, B_ROT_C);
  const float *rotS = PTR(const float, B_ROT_S);
  const float *damage = PTR(const float, B_DAMAGE);
  const uint16_t *owner = PTR(const uint16_t, B_OWNER);
  const uint8_t *shooter = PTR(const uint8_t, B_SHOOTER);
  uint16_t *activeOut = PTR(uint16_t, O_ACTIVE);
  float *impacts = PTR(float, O_IMPACTS);
  uint32_t *returned = PTR(uint32_t, O_RETURNED);
  int32_t *res = PTR(int32_t, R_RESULTS);
  world_t w;
  w.t = t;
  w.tActive = PTR(const uint8_t, T_ACTIVE);
  w.x = PTR(const float, T_X);
  w.y = PTR(const float, T_Y);
  w.rotC = PTR(const float, T_ROT_C);
  w.rotS = PTR(const float, T_ROT_S);
  w.cActive = PTR(const uint8_t, C_ACTIVE);
  w.cShape = PTR(const uint8_t, C_SHAPE);
  w.cLayer = PTR(const uint8_t, C_LAYER);
  w.offX = PTR(const float, C_OFF_X);
  w.offY = PTR(const float, C_OFF_Y);
  w.radius = PTR(const float, C_RADIUS);
  w.width = PTR(const float, C_WIDTH);
  w.height = PTR(const float, C_HEIGHT);
  w.polyCount = PTR(const uint8_t, C_POLY_COUNT);
  w.fixtureCount = PTR(const uint16_t, C_FIXTURE_COUNT);
  w.pvx = PTR(const float, C_PVX);
  w.pvy = PTR(const float, C_PVY);
  w.pnx = PTR(const float, C_PNX);
  w.pny = PTR(const float, C_PNY);
  w.grid = PTR(const uint8_t, G_GRID);
  w.stamp = PTR(uint32_t, G_STAMP);
  w.rayMask = rayMask;
  w.invCellSize = invCellSize;
  w.cellSize = cellSize;
  w.gridCols = gridCols;
  w.gridRows = gridRows;
  w.cellByteSize = cellByteSize;
  int32_t activeWrite = res[0];
  int32_t impactWrite = res[1];
  const int32_t impactCap = res[2];
  int32_t back = res[3];
  for (uint32_t i = from; i < count; i++) {
    if (!active[i]) continue;
    const double px = x[i];
    const double py = y[i];
    const double dx = (double)vx[i] * dt;
    const double dy = (double)vy[i] * dt;
    const double len = (double)speed[i] * dt;
    int32_t hit = -1;
    double distance = INF;
    if (len > 1e-6) {
      ray_t r = { px, py, rotC[i], rotS[i], len };
      hit = cast(&w, &r, owner[i], &distance);
      if (hit == -2) {
        res[0] = activeWrite;
        res[1] = impactWrite;
        res[3] = back;
        return i;
      }
    }
    prevX[i] = (float)px;
    prevY[i] = (float)py;
    x[i] = (float)(px + dx);
    y[i] = (float)(py + dy);
    if (hit >= 0) {
      const double tt = js_min(distance / len, 1);
      if (impactWrite < impactCap) {
        float *o = impacts + impactWrite * 6;
        o[0] = (float)hit;
        o[1] = damage[i];
        o[2] = (float)(px + dx * tt);
        o[3] = (float)(py + dy * tt);
        o[4] = (float)owner[i];
        o[5] = (float)shooter[i];
        impactWrite++;
      }
      active[i] = 0;
      returned[back++] = i;
      continue;
    }
    activeOut[activeWrite++] = (uint16_t)i;
  }
  res[0] = activeWrite;
  res[1] = impactWrite;
  res[3] = back;
  return count;
}
