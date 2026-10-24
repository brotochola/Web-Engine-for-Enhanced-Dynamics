/* Pre-render's collect (E-76 W4b, screen): the per-entity loop of PreRenderWorker.collectVisibleEntities
   (src/workers/preRenderWorker.js) for sprites with no body in a scene without physics, written into the main
   collector as the JS writes it (E-98c/e/f): the sort key, type 0, the entity, and the Transform pose into the
   collector's pose columns. Every column is a byte offset into one shared memory, from the table; 0 marks a
   column the scene does not have. Arithmetic as the JS does it: the cull in double from float32 inputs, each
   value stored as the typed array would store it (`v || 0` is +0 for 0, -0 and NaN).
   A sprite with a layer mask goes through collectRenderable, which stays JS: the walk stops there and
   returns its position, the JS collects that one sprite and calls again from the next. */
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
  SLOT_COUNT
};

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* `v || 0` on a number: 0, -0 and NaN become +0. */
INLINE float or0(float v) { return (v == 0.0f || v != v) ? 0.0f : v; }

/* The half extent the cull pads the view with: the larger cached half bound, else the collider's visual range. */
INLINE double half_extent(const float *halfW, const float *halfH, const float *visualRange, uint32_t i) {
  float e = 0.0f;
  if (halfW) {
    const float w = or0(halfW[i]);
    const float h = halfH ? or0(halfH[i]) : 0.0f;
    if (w > h) e = w;
    else if (h > 0.0f) e = h;
  }
  if (e <= 0.0f && visualRange) e = or0(visualRange[i]);
  return (double)e;
}

/* The shared tail: queue an on-screen sprite. Returns 0 when it must go through collectRenderable instead. */
INLINE int queue_sprite(const uint32_t *t, uint32_t i, int32_t *res, float keyY, uint32_t maxItems,
                        const uint8_t *sVisible, const uint8_t *sSheet, const uint16_t *sMask,
                        const float *x, const float *y, const float *rotC, const float *rotS,
                        float *oY, uint8_t *oType, int32_t *oIndex, float *oX, float *oPy, float *oRc, float *oRs) {
  if (!sVisible[i] || !sSheet || !sSheet[i]) return 1;
  if (sMask && sMask[i] != 0) return 0;
  const int32_t n = res[0];
  if ((uint32_t)n < maxItems) {
    oY[n] = keyY;
    oType[n] = 0;
    oIndex[n] = (int32_t)i;
    oX[n] = x[i];
    oPy[n] = y[i];
    oRc[n] = rotC ? rotC[i] : 1.0f;
    oRs[n] = rotS ? or0(rotS[i]) : 0.0f;
    res[0] = n + 1;
  } else {
    res[2] = 1;
  }
  res[1]++;
  return 1;
}

#define COLUMNS                                                         \
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;               \
  const uint16_t *list16 = PTR(const uint16_t, L_LIST);                 \
  const uint32_t *list32 = PTR(const uint32_t, L_LIST);                 \
  const uint32_t wide = t[L_LIST_U32];                                  \
  const uint8_t *tActive = PTR(const uint8_t, T_ACTIVE);                \
  const float *x = PTR(const float, T_X);                               \
  const float *y = PTR(const float, T_Y);                               \
  const float *rotC = PTR(const float, T_ROT_C);                        \
  const float *rotS = PTR(const float, T_ROT_S);                        \
  const uint8_t *sActive = PTR(const uint8_t, S_ACTIVE);                \
  const uint8_t *sVisible = PTR(const uint8_t, S_VISIBLE);              \
  const float *halfW = PTR(const float, S_HALF_W);                      \
  const float *halfH = PTR(const float, S_HALF_H);                      \
  const uint8_t *sSheet = PTR(const uint8_t, S_SHEET);                  \
  const uint16_t *sMask = PTR(const uint16_t, S_MASK);                  \
  const float *visualRange = PTR(const float, C_VISUAL_RANGE);          \
  float *oY = PTR(float, O_Y);                                          \
  uint8_t *oType = PTR(uint8_t, O_TYPE);                                \
  int32_t *oIndex = PTR(int32_t, O_INDEX);                              \
  float *oX = PTR(float, O_X);                                          \
  float *oPy = PTR(float, O_PY);                                        \
  float *oRc = PTR(float, O_ROT_C);                                     \
  float *oRs = PTR(float, O_ROT_S);                                     \
  int32_t *res = PTR(int32_t, R_RESULTS);                               \
  const float keyY = (float)keyYd

#define ENTITY(idx) (list16 ? (wide ? list32[idx] : (uint32_t)list16[idx]) : (uint32_t)(idx))

#define QUEUE()                                                                                          \
  if (!queue_sprite(t, i, res, keyY, maxItems, sVisible, sSheet, sMask, x, y, rotC, rotS,               \
                    oY, oType, oIndex, oX, oPy, oRc, oRs))                                               \
    return idx

/* collectVisibleEntities' loop, camera not turned. From list position `from` to `count`; returns `count` when
   it walked them all, or the position of a sprite the JS must collect. skipCull queues without the test. */
__attribute__((export_name("collect_sprites")))
uint32_t collect_sprites(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems, uint32_t skipCull,
                         double keyYd, double zoom, double offX, double offY,
                         double minX, double maxX, double minY, double maxY) {
  COLUMNS;
  for (uint32_t idx = from; idx < count; idx++) {
    const uint32_t i = ENTITY(idx);
    if (!tActive[i] || !sActive[i]) continue;
    if (!skipCull) {
      const double sx = (double)x[i] * zoom - offX;
      const double sy = (double)y[i] * zoom - offY;
      const double extent = half_extent(halfW, halfH, visualRange, i) * zoom;
      if (!(sx >= minX - extent && sx <= maxX + extent && sy >= minY - extent && sy <= maxY + extent)) continue;
    }
    QUEUE();
  }
  return count;
}

/* The turned camera's copy (E-51): each point turns into view space and is tested against the view plus the
   margin, limW and limH as the JS computes them. */
__attribute__((export_name("collect_sprites_turned")))
uint32_t collect_sprites_turned(uint32_t table, uint32_t from, uint32_t count, uint32_t maxItems,
                                double keyYd, double zoom, double offX, double offY,
                                double halfCw, double halfCh, double rc, double rs, double limW, double limH) {
  COLUMNS;
  for (uint32_t idx = from; idx < count; idx++) {
    const uint32_t i = ENTITY(idx);
    if (!tActive[i] || !sActive[i]) continue;
    const double dx = (double)x[i] * zoom - offX - halfCw;
    const double dy = (double)y[i] * zoom - offY - halfCh;
    const double extent = half_extent(halfW, halfH, visualRange, i) * zoom;
    const double u = rc * dx - rs * dy;
    const double v = rs * dx + rc * dy;
    const double w = limW + extent;
    const double h = limH + extent;
    if (u < -w || u > w || v < -h || v > h) continue;
    QUEUE();
  }
  return count;
}
