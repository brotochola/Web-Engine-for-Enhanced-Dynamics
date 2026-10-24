/* Pre-render's visibility gather (E-76 W2b): one light's neighbour loop of
   PreRenderWorker._buildVisibilityPolygonsSwept (src/workers/preRenderWorker.js). It walks the light's neighbour
   row, skips what does not block light, takes each occluder's display pose (_displayPose: a body's published pose,
   interpolated, else Transform's), culls it against the light's reach, and packs circles, boxes and convex
   polygons into the visibility memory's gather scratch, as writeOrientedBoxVerts and writePolygonVerts do
   (src/render/visibility/angularSweep.js), for visibilitySweep.wasm to sweep.
   What stays JS comes back as an ordered event list, one 48-byte record for each:
   - a compound solid (a collider with fixtures) in reach: the JS rasters it into the polar bins (W1) and keeps it
     as a self-lit item when it hit a bin;
   - an occluder packed while the self-lit list is on: the JS writes its self-lit item.
   The records keep the neighbour order, so the JS writes the bins and the self-lit list in the order its loop does.
   Every column is a byte offset into one shared memory (Phase 4: Box2D's block), from the table; 0 marks a column
   the scene does not have. Arithmetic as the JS does it: in double from the float32 columns, each value stored as
   the typed array stores it (`v || 0` is +0 for 0, -0 and NaN). */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

enum {
  N_ROWS,        /* Grid's neighbour rows: the light's row is [count, ids...] at light * stride */
  N_STRIDE,      /* a value: the row stride, in ids */
  T_ACTIVE, T_X, T_Y, T_ROT_C, T_ROT_S,
  O_ACTIVE, O_BLOCK,  /* LightOccluder */
  C_ACTIVE, C_SHAPE, C_RADIUS, C_WIDTH, C_HEIGHT, C_OFF_X, C_OFF_Y, C_POLY_COUNT, C_POLY_X, C_POLY_Y,
  C_CENTROID_X, C_CENTROID_Y, C_FIXTURES,
  F_HEADS,       /* a value: ColliderFixture.head's length (0: no fixture pool); an entity past it has no solid */
  B_ACTIVE, P_X, P_Y, P_ROT_C, P_ROT_S, Q_X, Q_Y, Q_ROT_C, Q_ROT_S,
  B_INTERPOLATE, /* a value: 1 when pre-render interpolates the physics pose */
  V_KIND, V_CX, V_CY, V_CR, V_VERT_START, V_VERT_COUNT, V_VERTS_X, V_VERTS_Y,  /* the gather scratch */
  V_MAX_OCCLUDERS, /* a value: the scratch's occluder cap */
  E_EVENTS,      /* the event records */
  E_SELF_LIT,    /* a value: 1 when the light's packed occluders are self-lit candidates */
  R_RESULTS,     /* i32: [0] occluders packed, [1] vertices packed, [2] events, [3] 1 when the cap stopped the walk */
  SLOT_COUNT
};

/* Collider.shapeType (src/box2d/box2dConstantsImpl.js ShapeType; visibilityGatherClient.js checks them). */
enum { SHAPE_BOX = 0, SHAPE_CIRCLE = 1, SHAPE_POLYGON = 2, SHAPE_CHAIN = 3 };
/* angularSweep.js OCC_CIRCLE / OCC_POLY. */
enum { OCC_CIRCLE = 0, OCC_POLY = 1 };
/* Event kinds. */
enum { EV_OCCLUDER = 0, EV_SOLID = 1 };
#define MAX_POLYGON_VERTICES 8
#define EVENT_BYTES 48

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* `v || 0` on a number: 0, -0 and NaN become +0. */
INLINE float or0(float v) { return (v == 0.0f || v != v) ? 0.0f : v; }

typedef struct {
  const uint16_t *rows16;
  const uint32_t *rows32;
  uint32_t stride;
  const uint8_t *tActive;
  const float *x, *y, *rotC, *rotS;
  const uint8_t *oActive;
  const float *oBlock;
  const uint8_t *cActive, *shape;
  const float *radius, *width, *height, *offX, *offY;
  const uint8_t *polyCount;
  const float *polyX, *polyY, *centX, *centY;
  const uint16_t *fixtures;
  uint32_t heads;
  const uint8_t *rb;
  const float *px, *py, *pc, *ps;
  const float *qx, *qy, *qc, *qs;
  uint32_t interpolate;
  uint8_t *kind;
  float *cx, *cy, *cr;
  int32_t *vertStart;
  uint8_t *vertCount;
  float *vertsX, *vertsY;
  uint32_t maxOccluders;
  uint8_t *events;
  uint32_t selfLit;
  int32_t *res;
} cols_t;

INLINE cols_t columns(uint32_t table) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  cols_t k;
  k.rows16 = PTR(const uint16_t, N_ROWS);
  k.rows32 = PTR(const uint32_t, N_ROWS);
  k.stride = t[N_STRIDE];
  k.tActive = PTR(const uint8_t, T_ACTIVE);
  k.x = PTR(const float, T_X);
  k.y = PTR(const float, T_Y);
  k.rotC = PTR(const float, T_ROT_C);
  k.rotS = PTR(const float, T_ROT_S);
  k.oActive = PTR(const uint8_t, O_ACTIVE);
  k.oBlock = PTR(const float, O_BLOCK);
  k.cActive = PTR(const uint8_t, C_ACTIVE);
  k.shape = PTR(const uint8_t, C_SHAPE);
  k.radius = PTR(const float, C_RADIUS);
  k.width = PTR(const float, C_WIDTH);
  k.height = PTR(const float, C_HEIGHT);
  k.offX = PTR(const float, C_OFF_X);
  k.offY = PTR(const float, C_OFF_Y);
  k.polyCount = PTR(const uint8_t, C_POLY_COUNT);
  k.polyX = PTR(const float, C_POLY_X);
  k.polyY = PTR(const float, C_POLY_Y);
  k.centX = PTR(const float, C_CENTROID_X);
  k.centY = PTR(const float, C_CENTROID_Y);
  k.fixtures = PTR(const uint16_t, C_FIXTURES);
  k.heads = t[F_HEADS];
  k.rb = PTR(const uint8_t, B_ACTIVE);
  k.px = PTR(const float, P_X);
  k.py = PTR(const float, P_Y);
  k.pc = PTR(const float, P_ROT_C);
  k.ps = PTR(const float, P_ROT_S);
  k.qx = PTR(const float, Q_X);
  k.qy = PTR(const float, Q_Y);
  k.qc = PTR(const float, Q_ROT_C);
  k.qs = PTR(const float, Q_ROT_S);
  k.interpolate = t[B_INTERPOLATE];
  k.kind = PTR(uint8_t, V_KIND);
  k.cx = PTR(float, V_CX);
  k.cy = PTR(float, V_CY);
  k.cr = PTR(float, V_CR);
  k.vertStart = PTR(int32_t, V_VERT_START);
  k.vertCount = PTR(uint8_t, V_VERT_COUNT);
  k.vertsX = PTR(float, V_VERTS_X);
  k.vertsY = PTR(float, V_VERTS_Y);
  k.maxOccluders = t[V_MAX_OCCLUDERS];
  k.events = PTR(uint8_t, E_EVENTS);
  k.selfLit = t[E_SELF_LIT];
  k.res = PTR(int32_t, R_RESULTS);
  return k;
}

/* A pose in double, as _displayPoseOut holds it (a value, so it lives in locals: the kernels have no stack). */
typedef struct { double x, y, c, s; } pose_t;

/* _displayPose, as preRenderCollect.c's display_pose: a body's published pose when it is live, lerped from the one
   before it when pre-render interpolates, else Transform's. */
INLINE pose_t display_pose(const cols_t *k, uint32_t i, double alpha) {
  pose_t p;
  if (k->px && k->rb && k->rb[i]) {
    const double c = k->pc[i];
    const double s = k->ps[i];
    if (c * c + s * s > 0.25) {
      if (k->interpolate && k->qx) {
        const double c0 = k->qc[i];
        const double s0 = k->qs[i];
        if (c0 * c0 + s0 * s0 > 0.25) {
          const double x0 = k->qx[i];
          const double y0 = k->qy[i];
          p.x = x0 + ((double)k->px[i] - x0) * alpha;
          p.y = y0 + ((double)k->py[i] - y0) * alpha;
          if (c0 == c && s0 == s) {
            p.c = c;
            p.s = s;
            return p;
          }
          const double rc = c0 + (c - c0) * alpha;
          const double rs = s0 + (s - s0) * alpha;
          double len = __builtin_sqrt(rc * rc + rs * rs);
          if (!(len != 0.0)) len = 1.0; /* `|| 1`: 0 and NaN */
          p.c = rc / len;
          p.s = rs / len;
          return p;
        }
      }
      p.x = k->px[i];
      p.y = k->py[i];
      p.c = c;
      p.s = s;
      return p;
    }
  }
  p.x = k->x[i];
  p.y = k->y[i];
  p.c = k->rotC ? (double)k->rotC[i] : 1.0;
  p.s = k->rotS ? (double)or0(k->rotS[i]) : 0.0;
  return p;
}

/* One event record: kind, entity, occluder slot, the display pose. */
INLINE void put_event(const cols_t *k, uint32_t e, int32_t kind, uint32_t entity, int32_t occ, pose_t p) {
  uint8_t *r = k->events + e * EVENT_BYTES;
  int32_t *w = (int32_t *)r;
  w[0] = kind;
  w[1] = (int32_t)entity;
  w[2] = occ;
  w[3] = 0;
  double *d = (double *)(r + 16);
  d[0] = p.x;
  d[1] = p.y;
  d[2] = p.c;
  d[3] = p.s;
}

/* writeOrientedBoxVerts. */
INLINE void box_verts(const cols_t *k, uint32_t at, pose_t p, double width, double height, double ox, double oy) {
  const double c = p.c, s = p.s;
  const double hw = width * 0.5;
  const double hh = height * 0.5;
  const double wx = p.x + c * ox - s * oy;
  const double wy = p.y + s * ox + c * oy;
  float *X = k->vertsX + at;
  float *Y = k->vertsY + at;
  X[0] = (float)(wx + c * -hw - s * -hh);
  Y[0] = (float)(wy + s * -hw + c * -hh);
  X[1] = (float)(wx + c * hw - s * -hh);
  Y[1] = (float)(wy + s * hw + c * -hh);
  X[2] = (float)(wx + c * hw - s * hh);
  Y[2] = (float)(wy + s * hw + c * hh);
  X[3] = (float)(wx + c * -hw - s * hh);
  Y[3] = (float)(wy + s * -hw + c * hh);
}

/* writePolygonVerts. */
INLINE void polygon_verts(const cols_t *k, uint32_t at, pose_t p, double ox, double oy, uint32_t base, uint32_t count) {
  const double c = p.c, s = p.s;
  const double wx = p.x + c * ox - s * oy;
  const double wy = p.y + s * ox + c * oy;
  for (uint32_t v = 0; v < count; v++) {
    const double lx = k->polyX[base + v];
    const double ly = k->polyY[base + v];
    k->vertsX[at + v] = (float)(wx + c * lx - s * ly);
    k->vertsY[at + v] = (float)(wy + s * lx + c * ly);
  }
}

INLINE uint32_t neighbour(const cols_t *k, uint32_t at, int wide) {
  return wide ? k->rows32[at] : (uint32_t)k->rows16[at];
}

INLINE int32_t gather(uint32_t table, uint32_t light, double lx, double ly, double radius, double alpha, int wide) {
  const cols_t k = columns(table);
  const uint32_t offset = light * k.stride;
  const uint32_t count = neighbour(&k, offset, wide);
  uint32_t occ = 0, pool = 0, events = 0;
  int32_t limitHit = 0;
  for (uint32_t n = 0; n < count; n++) {
    if (occ >= k.maxOccluders) {
      limitHit = 1;
      break;
    }
    const uint32_t i = neighbour(&k, offset + 1 + n, wide);
    if (!k.tActive[i] || !k.oActive[i] || !k.cActive[i]) continue;
    if (k.oBlock && !(k.oBlock[i] > 0.0f)) continue;
    const pose_t p = display_pose(&k, i, alpha);
    const uint32_t shape = k.shape[i];
    if (shape == SHAPE_CHAIN) continue;
    const double ox = or0(k.offX[i]);
    const double oy = or0(k.offY[i]);
    const uint32_t fixtures = k.fixtures ? k.fixtures[i] : 0;
    if (fixtures > 0 && k.heads && i < k.heads) {
      /* A compound solid: cull its centroid against the light's reach; the JS rasters it. */
      const double lcx = k.centX ? (double)k.centX[i] : 0.0;
      const double lcy = k.centY ? (double)k.centY[i] : 0.0;
      const double centX = p.x + p.c * (ox + lcx) - p.s * (oy + lcy);
      const double centY = p.y + p.s * (ox + lcx) + p.c * (oy + lcy);
      const double hw = (double)or0(k.width[i]) * 0.5;
      const double hh = (double)or0(k.height[i]) * 0.5;
      const double reach = __builtin_sqrt(hw * hw + hh * hh);
      const double cdx = centX - lx;
      const double cdy = centY - ly;
      const double bound = radius + reach;
      if (cdx * cdx + cdy * cdy > bound * bound) continue;
      put_event(&k, events++, EV_SOLID, i, -1, p);
      continue;
    }
    const double dx = (p.x + ox) - lx;
    const double dy = (p.y + oy) - ly;
    double reach;
    if (shape == SHAPE_CIRCLE) {
      reach = or0(k.radius[i]);
    } else {
      const double hw = (double)or0(k.width[i]) * 0.5;
      const double hh = (double)or0(k.height[i]) * 0.5;
      reach = __builtin_sqrt(hw * hw + hh * hh);
    }
    const double maxReach = radius + reach;
    if (dx * dx + dy * dy > maxReach * maxReach) continue;
    if (shape == SHAPE_CIRCLE) {
      const float r = k.radius[i];
      if (!(r > 0.0f)) continue;
      k.kind[occ] = OCC_CIRCLE;
      k.cx[occ] = (float)(p.x + ox);
      k.cy[occ] = (float)(p.y + oy);
      k.cr[occ] = r;
      k.vertStart[occ] = 0;
      k.vertCount[occ] = 0;
    } else if (shape == SHAPE_BOX || shape == SHAPE_POLYGON) {
      const uint32_t pc = shape == SHAPE_POLYGON ? k.polyCount[i] : 0;
      if (pc >= 3) {
        k.kind[occ] = OCC_POLY;
        k.vertStart[occ] = (int32_t)pool;
        polygon_verts(&k, pool, p, ox, oy, i * MAX_POLYGON_VERTICES, pc);
        k.vertCount[occ] = (uint8_t)pc;
        pool += pc;
      } else {
        /* A box, or a polygon whose vertices are not filled: its box extents. */
        const float w = k.width[i];
        const float h = k.height[i];
        if (!(w > 0.0f) || !(h > 0.0f)) continue;
        k.kind[occ] = OCC_POLY;
        k.vertStart[occ] = (int32_t)pool;
        box_verts(&k, pool, p, w, h, ox, oy);
        k.vertCount[occ] = 4;
        pool += 4;
      }
    } else {
      continue;
    }
    if (k.selfLit) put_event(&k, events++, EV_OCCLUDER, i, (int32_t)occ, p);
    occ++;
  }
  k.res[0] = (int32_t)occ;
  k.res[1] = (int32_t)pool;
  k.res[2] = (int32_t)events;
  k.res[3] = limitHit;
  return (int32_t)occ;
}

__attribute__((export_name("gather_light")))
int32_t gather_light(uint32_t table, uint32_t light, double lx, double ly, double radius, double alpha) {
  return gather(table, light, lx, ly, radius, alpha, 0);
}

__attribute__((export_name("gather_light_u32")))
int32_t gather_light_u32(uint32_t table, uint32_t light, double lx, double ly, double radius, double alpha) {
  return gather(table, light, lx, ly, radius, alpha, 1);
}
