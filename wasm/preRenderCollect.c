/* Pre-render's collect (E-76 W4b): the per-entity loop of PreRenderWorker.collectVisibleEntities
   (src/workers/preRenderWorker.js), written into the main collector as the JS writes it (E-98c/e/f): the sort
   key, type 0, the entity, and the display pose into the collector's pose columns. Every column is a byte offset
   into one shared memory, from the table; 0 marks a column the scene does not have. Arithmetic as the JS does
   it: the cull in double from float32 inputs, the pose in double as _displayPoseOut holds it, each value stored
   as the typed array would store it (`v || 0` is +0 for 0, -0 and NaN).
   `mode` picks a compiled copy of the loop, so the plain walk carries no test it does not need:
   - MODE_BODIES: a sprite with a body takes the published pose (Phase 4: the pose buffers are regions of Box2D's
     block), interpolated toward the latched frame as _displayPose does;
   - MODE_SORT_Y: the sort key is the sprite's foot line (_storeEntitySortY), from the emit's copy of the frame
     sizes and the last texture each sprite drew with.
   A sprite with a layer mask goes through collectRenderable, which stays JS, and so does one whose sort line needs
   a frame that is not resolved yet: the walk stops there and returns its position, the JS collects that one
   sprite and calls again from the next. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

enum {
  L_LIST,      /* the sprite query's entity list, or 0 for a scan of every index */
  L_LIST_U32,  /* a value: 1 when the list holds 32-bit ids, 0 for 16-bit */
  T_ACTIVE, T_X, T_Y, T_ROT_C, T_ROT_S,
  S_ACTIVE, S_VISIBLE, S_HALF_W, S_HALF_H, S_SHEET, S_MASK,
  C_VISUAL_RANGE,
  O_Y, O_TYPE, O_INDEX, O_X, O_PY, O_ROT_C, O_ROT_S,
  R_RESULTS,   /* i32: [0] the collector's count, [1] sprites queued or full, [2] 1 once the collector was full */
  /* MODE_BODIES: RigidBody.active, the latched pose (x, y, rotC, rotS) and the one before it (0 when none) */
  B_ACTIVE, P_X, P_Y, P_ROT_C, P_ROT_S, Q_X, Q_Y, Q_ROT_C, Q_ROT_S,
  B_INTERPOLATE, /* a value: 1 when pre-render interpolates the physics pose */
  /* MODE_SORT_Y: SpriteRenderer's anchor, scale and own facing, the last texture, the frame sizes */
  S_ANCHOR_X, S_ANCHOR_Y, S_SCALE_X, S_SCALE_Y, S_INHERIT, S_FACE_C, S_FACE_S,
  E_LAST_TEXTURE, E_FRAME_W, E_FRAME_H,
  E_FRAMES,    /* a value: the frame sizes' length */
  SLOT_COUNT
};

enum { MODE_BODIES = 1, MODE_SORT_Y = 2 };

#define INVALID_TEXTURE_ID 0xFFFFu

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* `v || 0` on a number: 0, -0 and NaN become +0. */
INLINE float or0(float v) { return (v == 0.0f || v != v) ? 0.0f : v; }

/* Math.round: the nearest integer, halves toward +Infinity, -0 for [-0.5, -0]. */
INLINE double js_round(double v) {
  double r = __builtin_floor(v);
  if (v - r >= 0.5) r += 1.0;
  if (r == 0.0 && v < 0.0) r = -0.0;
  return r;
}

typedef struct {
  const uint16_t *list16;
  const uint32_t *list32;
  uint32_t wide;
  const uint8_t *tActive;
  const float *x, *y, *rotC, *rotS;
  const uint8_t *sActive, *sVisible;
  const float *halfW, *halfH;
  const uint8_t *sSheet;
  const uint16_t *sMask;
  const float *visualRange;
  float *oY;
  uint8_t *oType;
  int32_t *oIndex;
  float *oX, *oPy, *oRc, *oRs;
  int32_t *res;
  const uint8_t *rb;
  const float *px, *py, *pc, *ps;
  const float *qx, *qy, *qc, *qs;
  uint32_t interpolate;
  const float *anchorX, *anchorY, *scaleX, *scaleY;
  const uint8_t *inherit;
  const float *faceC, *faceS;
  const uint16_t *lastTexture, *frameW, *frameH;
  uint32_t frames;
} cols_t;

INLINE cols_t columns(uint32_t table) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  cols_t k;
  k.list16 = PTR(const uint16_t, L_LIST);
  k.list32 = PTR(const uint32_t, L_LIST);
  k.wide = t[L_LIST_U32];
  k.tActive = PTR(const uint8_t, T_ACTIVE);
  k.x = PTR(const float, T_X);
  k.y = PTR(const float, T_Y);
  k.rotC = PTR(const float, T_ROT_C);
  k.rotS = PTR(const float, T_ROT_S);
  k.sActive = PTR(const uint8_t, S_ACTIVE);
  k.sVisible = PTR(const uint8_t, S_VISIBLE);
  k.halfW = PTR(const float, S_HALF_W);
  k.halfH = PTR(const float, S_HALF_H);
  k.sSheet = PTR(const uint8_t, S_SHEET);
  k.sMask = PTR(const uint16_t, S_MASK);
  k.visualRange = PTR(const float, C_VISUAL_RANGE);
  k.oY = PTR(float, O_Y);
  k.oType = PTR(uint8_t, O_TYPE);
  k.oIndex = PTR(int32_t, O_INDEX);
  k.oX = PTR(float, O_X);
  k.oPy = PTR(float, O_PY);
  k.oRc = PTR(float, O_ROT_C);
  k.oRs = PTR(float, O_ROT_S);
  k.res = PTR(int32_t, R_RESULTS);
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
  k.anchorX = PTR(const float, S_ANCHOR_X);
  k.anchorY = PTR(const float, S_ANCHOR_Y);
  k.scaleX = PTR(const float, S_SCALE_X);
  k.scaleY = PTR(const float, S_SCALE_Y);
  k.inherit = PTR(const uint8_t, S_INHERIT);
  k.faceC = PTR(const float, S_FACE_C);
  k.faceS = PTR(const float, S_FACE_S);
  k.lastTexture = PTR(const uint16_t, E_LAST_TEXTURE);
  k.frameW = PTR(const uint16_t, E_FRAME_W);
  k.frameH = PTR(const uint16_t, E_FRAME_H);
  k.frames = t[E_FRAMES];
  return k;
}

/* The half extent the cull pads the view with: the larger cached half bound, else the collider's visual range. */
INLINE double half_extent(const cols_t *k, uint32_t i) {
  float e = 0.0f;
  if (k->halfW) {
    const float w = or0(k->halfW[i]);
    const float h = k->halfH ? or0(k->halfH[i]) : 0.0f;
    if (w > h) e = w;
    else if (h > 0.0f) e = h;
  }
  if (e <= 0.0f && k->visualRange) e = or0(k->visualRange[i]);
  return (double)e;
}

/* A pose in double, as _displayPoseOut holds it (a value, so it lives in locals: the kernels have no stack). */
typedef struct { double x, y, c, s; } pose_t;

/* The display pose (_displayPose): a body's published pose when it is live, lerped from the one before it when
   pre-render interpolates, else Transform's. */
INLINE pose_t display_pose(const cols_t *k, uint32_t i, int bodies, double alpha) {
  pose_t p;
  if (bodies && k->rb[i]) {
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

/* spriteSortFootY (src/util/sortIndexByKey.js) for a sprite that is not feet-anchored. */
INLINE double foot_y(const cols_t *k, uint32_t i, double poseY, double rc, double rs, double w, double h) {
  const double ax = k->anchorX[i];
  const double ay = k->anchorY[i];
  const double sy = k->scaleY[i];
  const double ox = (0.5 - ax) * w * (double)k->scaleX[i];
  const double oy = sy < 0 ? -ay * h * sy : (1 - ay) * h * sy;
  if (k->inherit && !k->inherit[i]) {
    rc = k->faceC[i];
    rs = k->faceS[i];
  }
  return poseY + ox * rs + oy * rc;
}

/* The shared tail: queue an on-screen sprite. Returns 0 when it must go through collectRenderable instead. */
INLINE int queue_sprite(const cols_t *k, uint32_t i, float keyY, uint32_t maxItems, double alpha, double sortK,
                        int bodies, int sortY) {
  if (!k->sVisible[i] || !k->sSheet || !k->sSheet[i]) return 1;
  if (k->sMask && k->sMask[i] != 0) return 0;
  int32_t *res = k->res;
  const int32_t n = res[0];
  if ((uint32_t)n < maxItems) {
    float key = keyY;
    if (bodies || sortY) {
      const pose_t p = display_pose(k, i, bodies, alpha);
      if (sortY) {
        double footY = p.y;
        if (!(k->anchorX[i] == 0.5f && k->anchorY[i] == 1.0f)) {
          const uint32_t tex = k->lastTexture[i];
          if (tex == INVALID_TEXTURE_ID) return 0; /* the JS resolves the frame */
          const double w = tex < k->frames ? (double)k->frameW[tex] : 0.0;
          const double h = tex < k->frames ? (double)k->frameH[tex] : 0.0;
          footY = foot_y(k, i, p.y, p.c, p.s, w, h);
        }
        key = (float)(js_round(footY) * sortK);
      }
      k->oX[n] = (float)p.x;
      k->oPy[n] = (float)p.y;
      k->oRc[n] = (float)p.c;
      k->oRs[n] = (float)p.s;
    } else {
      k->oX[n] = k->x[i];
      k->oPy[n] = k->y[i];
      k->oRc[n] = k->rotC ? k->rotC[i] : 1.0f;
      k->oRs[n] = k->rotS ? or0(k->rotS[i]) : 0.0f;
    }
    k->oY[n] = key;
    k->oType[n] = 0;
    k->oIndex[n] = (int32_t)i;
    res[0] = n + 1;
  } else {
    res[2] = 1;
  }
  res[1]++;
  return 1;
}

#define ENTITY(idx) (k.list16 ? (k.wide ? k.list32[idx] : (uint32_t)k.list16[idx]) : (uint32_t)(idx))

/* collectVisibleEntities' loop, camera not turned. */
INLINE uint32_t walk(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems, uint32_t skipCull,
                     double keyYd, double zoom, double offX, double offY, double minX, double maxX, double minY,
                     double maxY, double alpha, double sortK, int bodies, int sortY) {
  const cols_t k = columns(table);
  const float keyY = (float)keyYd;
  for (uint32_t idx = from; idx < count; idx++) {
    const uint32_t i = ENTITY(idx);
    if (!k.tActive[i] || !k.sActive[i]) continue;
    if (!skipCull) {
      const double sx = (double)k.x[i] * zoom - offX;
      const double sy = (double)k.y[i] * zoom - offY;
      const double extent = half_extent(&k, i) * zoom;
      if (!(sx >= minX - extent && sx <= maxX + extent && sy >= minY - extent && sy <= maxY + extent)) continue;
    }
    if (!queue_sprite(&k, i, keyY, maxItems, alpha, sortK, bodies, sortY)) return idx;
  }
  return count;
}

/* The turned camera's copy (E-51): each point turns into view space and is tested against the view plus the
   margin, limW and limH as the JS computes them. */
INLINE uint32_t walk_turned(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems, double keyYd,
                            double zoom, double offX, double offY, double halfCw, double halfCh, double rc,
                            double rs, double limW, double limH, double alpha, double sortK, int bodies,
                            int sortY) {
  const cols_t k = columns(table);
  const float keyY = (float)keyYd;
  for (uint32_t idx = from; idx < count; idx++) {
    const uint32_t i = ENTITY(idx);
    if (!k.tActive[i] || !k.sActive[i]) continue;
    const double dx = (double)k.x[i] * zoom - offX - halfCw;
    const double dy = (double)k.y[i] * zoom - offY - halfCh;
    const double extent = half_extent(&k, i) * zoom;
    const double u = rc * dx - rs * dy;
    const double v = rs * dx + rc * dy;
    const double w = limW + extent;
    const double h = limH + extent;
    if (u < -w || u > w || v < -h || v > h) continue;
    if (!queue_sprite(&k, i, keyY, maxItems, alpha, sortK, bodies, sortY)) return idx;
  }
  return count;
}

/* From list position `from` to `count`; returns `count` when it walked them all, or the position of a sprite the
   JS must collect. skipCull queues without the test. alpha and sortK serve MODE_BODIES and MODE_SORT_Y. */
__attribute__((export_name("collect_sprites")))
uint32_t collect_sprites(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems, uint32_t skipCull,
                         double keyYd, double zoom, double offX, double offY,
                         double minX, double maxX, double minY, double maxY,
                         uint32_t mode, double alpha, double sortK) {
#define WALK(B, S) walk(table, from, count, maxItems, skipCull, keyYd, zoom, offX, offY, minX, maxX, minY, maxY, \
                        alpha, sortK, B, S)
  switch (mode & 3) {
    case MODE_BODIES: return WALK(1, 0);
    case MODE_SORT_Y: return WALK(0, 1);
    case MODE_BODIES | MODE_SORT_Y: return WALK(1, 1);
    default: return WALK(0, 0);
  }
#undef WALK
}

__attribute__((export_name("collect_sprites_turned")))
uint32_t collect_sprites_turned(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems,
                                double keyYd, double zoom, double offX, double offY,
                                double halfCw, double halfCh, double rc, double rs, double limW, double limH,
                                uint32_t mode, double alpha, double sortK) {
#define WALK(B, S) walk_turned(table, from, count, maxItems, keyYd, zoom, offX, offY, halfCw, halfCh, rc, rs, \
                               limW, limH, alpha, sortK, B, S)
  switch (mode & 3) {
    case MODE_BODIES: return WALK(1, 0);
    case MODE_SORT_Y: return WALK(0, 1);
    case MODE_BODIES | MODE_SORT_Y: return WALK(1, 1);
    default: return WALK(0, 0);
  }
#undef WALK
}
