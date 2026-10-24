/* Pre-render's emit (E-76 W4a, E-112): the full emit of PreRenderWorker.emitSpriteQueue
   (src/workers/preRenderWorker.js) for sprite rows (type 0) and decoration rows (type 2), poses taken from
   the collector's stash, on a frame the persist check missed. Every column is a byte offset into the
   render-queue memory (src/workers/preRenderEmitClient.js writes the table); 0 marks a column the worker
   does not have. Arithmetic as the JS does it: the sort key and the animation clock in double, each value
   stored as the typed array would store it. Row i is queue row i (no row expands without an Adobe root), so
   rows of other types (particles, glows, bullets) are listed and left for the JS to write; a frame with an
   Adobe root or a LiquidFun row is declined (0xffffffff) before anything is written. Play-once ends and
   missing animations come back as lists too: the end message, its entity-type filter and the warnings
   stay JS.
   W4c: the persist path of the entity queue, from the same table. persist_frame is _type0PersistHit (with
   _repairPersistFrame) and _writeType0PosesOnly (with _writeQueueShadow and _advancePersistFrame) in one
   walk (E-116), persist_remember is _rememberType0Set; the rows a queue buffer last held are the P_
   columns, the slots of that buffer. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))
#define INVALID_TEXTURE 0xffffu
#define DECLINED 0xffffffffu
#define TILE_MODE_LOCAL 2u
/* proxyToGlobalAnim[sheetId][animationState] flattened: both are u8, so 256 states per sheet. */
#define PROXY_STATES 256u

enum {
  C_TYPE, C_INDEX, C_Y, C_STASH_X, C_STASH_Y, C_STASH_RC, C_STASH_RS,
  S_SCALE_X, S_SCALE_Y, S_ALPHA, S_TINT, S_ANCHOR_X, S_ANCHOR_Y, S_INHERIT, S_ROT_C, S_ROT_S,
  S_REPEAT_X, S_REPEAT_Y, S_TILE_MODE, S_TILE_OFF_U, S_TILE_OFF_V, S_HALF_W, S_HALF_H,
  S_SHEET, S_ANIM, S_ANIMATED, S_SPEED, S_LOOP, S_Z,
  SC_ACTIVE, SC_H, SC_OFF_X, SC_OFF_Y,
  D_SCALE_X, D_SCALE_Y, D_ALPHA, D_TINT, D_TEXTURE, D_ANCHOR_X, D_ANCHOR_Y,
  A_FRAME, A_ACCUM, A_LAST_TEX,
  T_PROXY, T_SHEETS, T_FRAME_COUNT, T_FRAME_START, T_ANIMS, T_FRAME_W, T_FRAME_H, T_FRAMES,
  Q_X, Q_Y, Q_SCALE_X, Q_SCALE_Y, Q_ROT_C, Q_ROT_S, Q_ALPHA, Q_TINT, Q_TEXTURE, Q_ANCHOR_X, Q_ANCHOR_Y,
  Q_TYPE, Q_SORT_KEY, Q_REPEAT_X, Q_REPEAT_Y, Q_TILE_MODE, Q_TILE_OFF_U, Q_TILE_OFF_V, Q_TILE_MUL_X,
  Q_TILE_MUL_Y, Q_SHADOW_H, Q_SHADOW_OFF_X, Q_SHADOW_OFF_Y,
  R_ENDS, R_WARNS, R_FOREIGN, R_COUNTS,
  /* W4c: the sprites' dirty flags, the rows of the queue buffer being written as it last held them
     (type, entity, frame, animation state) and the length of the frame column (a value, not an offset). */
  S_DIRTY, P_TYPE, P_ENTITY, P_FRAME, P_ANIM, A_ENTITIES,
  SLOT_COUNT
};

/* emitSpriteQueue's loop-invariant switches. */
#define F_SORT_KEY 1u    /* rqSortKey && source.hasOrder */
#define F_Y_SORT 2u      /* source.ySort */
#define F_TILES_DIRTY 4u /* a repeating sprite wrote this queue's tile columns before */
#define F_BOUNDS 8u      /* frameWidth, frameHeight, boundsHalfW and boundsHalfH all exist */

/* Warning kinds, for the JS to replay with its own keys. */
#define WARN_NO_ANIM 0u    /* sprite: no global animation for (sheet, state), sheet set */
#define WARN_NO_START 1u   /* sprite: the global animation has no first frame */
#define WARN_DECO_START 2u /* decoration: its animation has no first frame */

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* `v || 0` on a number: 0, -0 and NaN become 0. */
INLINE float or0(float v) { return (v == 0.0f || v != v) ? 0.0f : v; }
INLINE double fabs_d(double v) { return __builtin_fabs(v); }

__attribute__((export_name("emit_rows")))
uint32_t emit_rows(uint32_t table, uint32_t count, uint32_t maxItems, uint32_t flags,
                   double deltaSeconds, double zoomAlpha, double band) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every pointer is read once: the stores below may alias the table as far as the compiler knows. */
  const uint8_t *cType = PTR(const uint8_t, C_TYPE);
  const int32_t *cIndex = PTR(const int32_t, C_INDEX);
  const float *cY = PTR(const float, C_Y);
  const float *stX = PTR(const float, C_STASH_X);
  const float *stY = PTR(const float, C_STASH_Y);
  const float *stRc = PTR(const float, C_STASH_RC);
  const float *stRs = PTR(const float, C_STASH_RS);

  const float *sScaleX = PTR(const float, S_SCALE_X);
  const float *sScaleY = PTR(const float, S_SCALE_Y);
  const float *sAlpha = PTR(const float, S_ALPHA);
  const uint32_t *sTint = PTR(const uint32_t, S_TINT);
  const float *sAnchorX = PTR(const float, S_ANCHOR_X);
  const float *sAnchorY = PTR(const float, S_ANCHOR_Y);
  const uint8_t *sInherit = PTR(const uint8_t, S_INHERIT);
  const float *sRotC = PTR(const float, S_ROT_C);
  const float *sRotS = PTR(const float, S_ROT_S);
  const uint16_t *sRepeatX = PTR(const uint16_t, S_REPEAT_X);
  const uint16_t *sRepeatY = PTR(const uint16_t, S_REPEAT_Y);
  const uint8_t *sTileMode = PTR(const uint8_t, S_TILE_MODE);
  const uint16_t *sTileOffU = PTR(const uint16_t, S_TILE_OFF_U);
  const uint16_t *sTileOffV = PTR(const uint16_t, S_TILE_OFF_V);
  float *sHalfW = PTR(float, S_HALF_W);
  float *sHalfH = PTR(float, S_HALF_H);
  const uint8_t *sSheet = PTR(const uint8_t, S_SHEET);
  const uint8_t *sAnim = PTR(const uint8_t, S_ANIM);
  const uint8_t *sAnimated = PTR(const uint8_t, S_ANIMATED);
  const float *sSpeed = PTR(const float, S_SPEED);
  const uint8_t *sLoop = PTR(const uint8_t, S_LOOP);
  const int16_t *sZ = PTR(const int16_t, S_Z);

  const uint8_t *scActive = PTR(const uint8_t, SC_ACTIVE);
  const float *scH = PTR(const float, SC_H);
  const float *scOx = PTR(const float, SC_OFF_X);
  const float *scOy = PTR(const float, SC_OFF_Y);

  const float *dScaleX = PTR(const float, D_SCALE_X);
  const float *dScaleY = PTR(const float, D_SCALE_Y);
  const float *dAlpha = PTR(const float, D_ALPHA);
  const uint32_t *dTint = PTR(const uint32_t, D_TINT);
  const uint16_t *dTexture = PTR(const uint16_t, D_TEXTURE);
  const float *dAnchorX = PTR(const float, D_ANCHOR_X);
  const float *dAnchorY = PTR(const float, D_ANCHOR_Y);

  uint16_t *aFrame = PTR(uint16_t, A_FRAME);
  float *aAccum = PTR(float, A_ACCUM);
  uint16_t *aLastTex = PTR(uint16_t, A_LAST_TEX);

  const int32_t *proxy = PTR(const int32_t, T_PROXY);
  const uint32_t nSheets = t[T_SHEETS];
  const int32_t *frameCount = PTR(const int32_t, T_FRAME_COUNT);
  const int32_t *frameStart = PTR(const int32_t, T_FRAME_START);
  const uint32_t nAnims = t[T_ANIMS];
  const uint16_t *frameW = PTR(const uint16_t, T_FRAME_W);
  const uint16_t *frameH = PTR(const uint16_t, T_FRAME_H);
  const uint32_t nFrames = t[T_FRAMES];

  float *qX = PTR(float, Q_X);
  float *qY = PTR(float, Q_Y);
  float *qScaleX = PTR(float, Q_SCALE_X);
  float *qScaleY = PTR(float, Q_SCALE_Y);
  float *qRotC = PTR(float, Q_ROT_C);
  float *qRotS = PTR(float, Q_ROT_S);
  float *qAlpha = PTR(float, Q_ALPHA);
  uint32_t *qTint = PTR(uint32_t, Q_TINT);
  uint16_t *qTexture = PTR(uint16_t, Q_TEXTURE);
  float *qAnchorX = PTR(float, Q_ANCHOR_X);
  float *qAnchorY = PTR(float, Q_ANCHOR_Y);
  uint8_t *qType = PTR(uint8_t, Q_TYPE);
  float *qSortKey = PTR(float, Q_SORT_KEY);
  uint16_t *qRepeatX = PTR(uint16_t, Q_REPEAT_X);
  uint16_t *qRepeatY = PTR(uint16_t, Q_REPEAT_Y);
  uint8_t *qTileMode = PTR(uint8_t, Q_TILE_MODE);
  uint16_t *qTileOffU = PTR(uint16_t, Q_TILE_OFF_U);
  uint16_t *qTileOffV = PTR(uint16_t, Q_TILE_OFF_V);
  float *qTileMulX = PTR(float, Q_TILE_MUL_X);
  float *qTileMulY = PTR(float, Q_TILE_MUL_Y);
  float *qShadowH = PTR(float, Q_SHADOW_H);
  float *qShadowOffX = PTR(float, Q_SHADOW_OFF_X);
  float *qShadowOffY = PTR(float, Q_SHADOW_OFF_Y);

  uint32_t *ends = PTR(uint32_t, R_ENDS);
  uint32_t *warns = PTR(uint32_t, R_WARNS);
  uint32_t *foreign = PTR(uint32_t, R_FOREIGN);
  uint32_t *counts = PTR(uint32_t, R_COUNTS);

  /* The loop below visits min(count, maxItems) rows, each writing one. */
  const uint32_t n = count < maxItems ? count : maxItems;
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t ty = cType[i];
    if (ty == 6 || ty == 7) return DECLINED;
  }

  const int sortKey = (flags & F_SORT_KEY) != 0;
  const int ySort = (flags & F_Y_SORT) != 0;
  const int tilesDirty = (flags & F_TILES_DIRTY) != 0;
  const int bounds = (flags & F_BOUNDS) != 0;
  uint32_t nEnds = 0;
  uint32_t nWarns = 0;
  uint32_t nForeign = 0;
  uint32_t tiled = 0;

  for (uint32_t i = 0; i < n; i++) {
    const uint8_t ty = cType[i];
    if (ty != 0 && ty != 2) {
      foreign[nForeign++] = i;
      continue;
    }
    const int32_t idx = cIndex[i];
    const uint32_t out = i;
    if (ty == 0) {
      if (sortKey) {
        /* orderSortKey(yKey, zIndex | 0, ySort, band) */
        const double z = sZ ? (double)sZ[idx] : 0.0;
        qSortKey[out] = (float)(ySort ? z * band + (double)cY[i] : z);
      }
      const float x = stX[i];
      const float y = stY[i];
      float rc;
      float rs;
      if (sInherit[idx]) {
        rc = stRc[i];
        rs = stRs[i];
      } else {
        rc = sRotC[idx];
        rs = sRotS[idx];
      }
      qAlpha[out] = sAlpha[idx];
      if (qShadowH) {
        /* _writeQueueShadow */
        const int cast = scActive && scActive[idx];
        qShadowH[out] = cast ? (scH ? or0(scH[idx]) : 0.0f) : 0.0f;
        if (qShadowOffX) qShadowOffX[out] = cast ? (scOx ? or0(scOx[idx]) : 0.0f) : 0.0f;
        if (qShadowOffY) qShadowOffY[out] = cast ? (scOy ? or0(scOy[idx]) : 0.0f) : 0.0f;
      }
      const uint32_t rx = sRepeatX[idx];
      const uint32_t ry = sRepeatY[idx];
      if (rx != 0 || ry != 0) {
        tiled = 1;
        if (qRepeatX) qRepeatX[out] = (uint16_t)rx;
        if (qRepeatY) qRepeatY[out] = (uint16_t)ry;
        /* writeEntityTileFields */
        const uint32_t mode = sTileMode[idx];
        if (qTileMode) qTileMode[out] = (uint8_t)mode;
        if (qTileOffU) qTileOffU[out] = sTileOffU[idx];
        if (qTileOffV) qTileOffV[out] = sTileOffV[idx];
        double mx = 0.0;
        double my = 0.0;
        if (rx > 0) mx = mode == TILE_MODE_LOCAL ? -((double)sHalfW[idx] * 2.0) / (double)rx : 1.0 / (double)rx;
        if (ry > 0) my = mode == TILE_MODE_LOCAL ? -((double)sHalfH[idx] * 2.0) / (double)ry : 1.0 / (double)ry;
        if (qTileMulX) qTileMulX[out] = (float)mx;
        if (qTileMulY) qTileMulY[out] = (float)my;
      } else if (tilesDirty) {
        if (qRepeatX) qRepeatX[out] = 0;
        if (qRepeatY) qRepeatY[out] = 0;
        if (qTileMulX) qTileMulX[out] = 0.0f;
        if (qTileMulY) qTileMulY[out] = 0.0f;
      }
      qX[out] = x;
      qY[out] = y;
      qScaleX[out] = sScaleX[idx];
      qScaleY[out] = sScaleY[idx];
      qRotC[out] = rc;
      qRotS[out] = rs;
      qTint[out] = sTint[idx];
      qAnchorX[out] = sAnchorX[idx];
      qAnchorY[out] = sAnchorY[idx];
      if (qType) qType[out] = 0;

      const uint32_t sheet = sSheet[idx];
      const uint32_t anim = sAnim[idx];
      const int32_t g = sheet < nSheets ? proxy[sheet * PROXY_STATES + anim] : -1;
      uint32_t tex = INVALID_TEXTURE;
      if (g >= 0) {
        const int known = (uint32_t)g < nAnims;
        const int32_t fc = known ? frameCount[g] : 1;
        if ((int32_t)aFrame[idx] >= fc) aFrame[idx] = 0;
        if (sAnimated[idx] && fc > 1) {
          const float acc = (float)((double)aAccum[idx] + deltaSeconds);
          aAccum[idx] = acc;
          const double duration = 1.0 / ((double)sSpeed[idx] * 60.0);
          if ((double)acc >= duration) {
            aAccum[idx] = (float)((double)acc - duration);
            const int32_t cur = aFrame[idx];
            if (sLoop[idx] != 1 && cur >= fc - 1) {
              /* The last frame of a play-once animation finished showing. */
              ends[2 * nEnds] = (uint32_t)idx;
              ends[2 * nEnds + 1] = anim;
              nEnds++;
            } else {
              aFrame[idx] = (uint16_t)((cur + 1) % fc);
              if (bounds) {
                /* Bounds may change (variable frame sizes). */
                const int32_t texId = (known ? frameStart[g] : 0) + (int32_t)aFrame[idx];
                const int inRange = texId >= 0 && (uint32_t)texId < nFrames;
                const double w = inRange ? (double)frameW[texId] : 0.0;
                const double h = inRange ? (double)frameH[texId] : 0.0;
                double ax = fabs_d((double)sScaleX[idx]);
                double ay = fabs_d((double)sScaleY[idx]);
                if (ax == 0.0 || ax != ax) ax = 1.0;
                if (ay == 0.0 || ay != ay) ay = 1.0;
                sHalfW[idx] = (float)((w * ax) * 0.5);
                sHalfH[idx] = (float)((h * ay) * 0.5);
              }
            }
          }
        }
        if (known) {
          tex = (uint32_t)(frameStart[g] + (int32_t)aFrame[idx]);
          if (aLastTex) aLastTex[idx] = (uint16_t)tex;
        } else {
          warns[2 * nWarns] = (uint32_t)idx;
          warns[2 * nWarns + 1] = WARN_NO_START;
          nWarns++;
        }
      } else {
        /* Never reuse a stale last texture (pool recycle, spawn before setSprite). */
        if (aLastTex) aLastTex[idx] = INVALID_TEXTURE;
        if (sheet) {
          warns[2 * nWarns] = (uint32_t)idx;
          warns[2 * nWarns + 1] = WARN_NO_ANIM;
          nWarns++;
        }
      }
      qTexture[out] = (uint16_t)tex;
    } else {
      if (sortKey) qSortKey[out] = (float)(ySort ? 0.0 * band + (double)cY[i] : 0.0);
      if (tilesDirty) {
        if (qRepeatX) qRepeatX[out] = 0;
        if (qRepeatY) qRepeatY[out] = 0;
        if (qTileMode) qTileMode[out] = 0;
        if (qTileOffU) qTileOffU[out] = 0;
        if (qTileOffV) qTileOffV[out] = 0;
        if (qTileMulX) qTileMulX[out] = 0.0f;
        if (qTileMulY) qTileMulY[out] = 0.0f;
      }
      if (qShadowH) qShadowH[out] = 0.0f;
      if (qShadowOffX) qShadowOffX[out] = 0.0f;
      if (qShadowOffY) qShadowOffY[out] = 0.0f;
      const float x = stX[i];
      const float y = stY[i];
      const float rc = stRc[i];
      const float rs = stRs[i];
      qX[out] = x;
      qY[out] = y;
      qScaleX[out] = dScaleX[idx];
      qScaleY[out] = dScaleY[idx];
      qRotC[out] = rc;
      qRotS[out] = rs;
      qAlpha[out] = (float)((double)dAlpha[idx] * zoomAlpha);
      qTint[out] = dTint[idx];
      const uint32_t a = dTexture[idx];
      uint32_t tex = INVALID_TEXTURE;
      if (a < nAnims) {
        tex = (uint32_t)frameStart[a];
      } else {
        warns[2 * nWarns] = (uint32_t)idx;
        warns[2 * nWarns + 1] = WARN_DECO_START;
        nWarns++;
      }
      qTexture[out] = (uint16_t)tex;
      qAnchorX[out] = dAnchorX[idx];
      qAnchorY[out] = dAnchorY[idx];
      if (qType) qType[out] = 2;
    }
  }
  counts[0] = nEnds;
  counts[1] = nWarns;
  counts[2] = tiled;
  counts[3] = nForeign;
  return n;
}

/* What persist_check returns when the rows are not the ones this buffer last held. */
#define PERSIST_MISS 0xffffffffu

/* The global animation of (sheet, state), or -1: proxyToGlobalAnim?.[sheet]?.[state]. */
INLINE int32_t global_anim(const int32_t *proxy, uint32_t nSheets, uint32_t sheet, uint32_t anim) {
  return sheet < nSheets ? proxy[sheet * PROXY_STATES + anim] : -1;
}

/* _type0PersistHit and _writeType0PosesOnly in one walk (W4c, E-116), once the JS has matched the buffer's
   count. A row misses when its type or entity is not the one this buffer last held, when it is an Adobe
   root, or when a sprite is dirty or changed its animation; a sprite whose frame moved since gets its
   current frame's texture (_repairPersistFrame, which misses when that frame has none). As the walk passes
   a sprite it writes what _writeType0PosesOnly writes but the clock: the rotation of a sprite drawn with
   its own facing (the pose too when the collect did not write it into the queue), the sort key and the
   shadow terms (_writeQueueShadow). On a miss the full emit that follows rewrites every one of those, so
   the frame ends as the two JS passes leave it. The clocks, which that full emit would advance a second
   time, wait until every row has passed: the animated sprites' rows are listed in R_FOREIGN (unused on a
   persist frame) and advanced in row order after it (_advancePersistFrame, which advances on
   !(clock < duration), where the full emit advances on clock >= duration).
   Returns PERSIST_MISS or the rows of other types; R_COUNTS gets [play-once ends ([entity, state] pairs in
   R_ENDS), sprites whose frame moved, repairs]. */
__attribute__((export_name("persist_frame")))
uint32_t persist_frame(uint32_t table, uint32_t count, uint32_t maxItems, uint32_t flags,
                       double deltaSeconds, double band) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const uint8_t *cType = PTR(const uint8_t, C_TYPE);
  const int32_t *cIndex = PTR(const int32_t, C_INDEX);
  const float *cY = PTR(const float, C_Y);
  const float *stX = PTR(const float, C_STASH_X);
  const float *stY = PTR(const float, C_STASH_Y);
  const float *stRc = PTR(const float, C_STASH_RC);
  const float *stRs = PTR(const float, C_STASH_RS);
  const float *sScaleX = PTR(const float, S_SCALE_X);
  const float *sScaleY = PTR(const float, S_SCALE_Y);
  const uint8_t *sInherit = PTR(const uint8_t, S_INHERIT);
  const float *sRotC = PTR(const float, S_ROT_C);
  const float *sRotS = PTR(const float, S_ROT_S);
  float *sHalfW = PTR(float, S_HALF_W);
  float *sHalfH = PTR(float, S_HALF_H);
  const uint8_t *sSheet = PTR(const uint8_t, S_SHEET);
  const uint8_t *sAnim = PTR(const uint8_t, S_ANIM);
  const uint8_t *sAnimated = PTR(const uint8_t, S_ANIMATED);
  const float *sSpeed = PTR(const float, S_SPEED);
  const uint8_t *sLoop = PTR(const uint8_t, S_LOOP);
  const int16_t *sZ = PTR(const int16_t, S_Z);
  const uint8_t *sDirty = PTR(const uint8_t, S_DIRTY);
  const uint8_t *scActive = PTR(const uint8_t, SC_ACTIVE);
  const float *scH = PTR(const float, SC_H);
  const float *scOx = PTR(const float, SC_OFF_X);
  const float *scOy = PTR(const float, SC_OFF_Y);
  uint16_t *aFrame = PTR(uint16_t, A_FRAME);
  float *aAccum = PTR(float, A_ACCUM);
  uint16_t *aLastTex = PTR(uint16_t, A_LAST_TEX);
  const int32_t *proxy = PTR(const int32_t, T_PROXY);
  const uint32_t nSheets = t[T_SHEETS];
  const int32_t *frameCount = PTR(const int32_t, T_FRAME_COUNT);
  const int32_t *frameStart = PTR(const int32_t, T_FRAME_START);
  const uint32_t nAnims = t[T_ANIMS];
  const uint16_t *frameW = PTR(const uint16_t, T_FRAME_W);
  const uint16_t *frameH = PTR(const uint16_t, T_FRAME_H);
  const uint32_t nFrames = t[T_FRAMES];
  float *qX = PTR(float, Q_X);
  float *qY = PTR(float, Q_Y);
  float *qRotC = PTR(float, Q_ROT_C);
  float *qRotS = PTR(float, Q_ROT_S);
  uint16_t *qTexture = PTR(uint16_t, Q_TEXTURE);
  float *qSortKey = PTR(float, Q_SORT_KEY);
  float *qShadowH = PTR(float, Q_SHADOW_H);
  float *qShadowOffX = PTR(float, Q_SHADOW_OFF_X);
  float *qShadowOffY = PTR(float, Q_SHADOW_OFF_Y);
  const uint8_t *pType = PTR(const uint8_t, P_TYPE);
  const int32_t *pEntity = PTR(const int32_t, P_ENTITY);
  uint16_t *pFrame = PTR(uint16_t, P_FRAME);
  const uint16_t *pAnim = PTR(const uint16_t, P_ANIM);
  uint32_t *ends = PTR(uint32_t, R_ENDS);
  uint32_t *animated = PTR(uint32_t, R_FOREIGN);
  uint32_t *counts = PTR(uint32_t, R_COUNTS);

  const int sortKey = (flags & F_SORT_KEY) != 0;
  const int ySort = (flags & F_Y_SORT) != 0;
  const int bounds = (flags & F_BOUNDS) != 0;
  const int shadows = qShadowH != 0;
  /* E-98d: the collect wrote the poses into this queue's columns. */
  const int inQueue = stX == qX;
  /* Rows past the buffer pass the check (the JS reads undefined on both sides of each comparison there)
     and count as other types (their type reads undefined). */
  const uint32_t n = count < maxItems ? count : maxItems;
  uint32_t others = count - n;
  uint32_t repaired = 0;
  uint32_t nAnimated = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t ty = cType[i];
    const int32_t idx = cIndex[i];
    if (pType[i] != ty || pEntity[i] != idx) return PERSIST_MISS;
    if (ty == 6) return PERSIST_MISS;
    if (ty != 0) {
      others++;
      continue;
    }
    if (sDirty && sDirty[idx]) return PERSIST_MISS;
    const uint32_t anim = sAnim[idx];
    if (pAnim[i] != anim) return PERSIST_MISS;
    const uint32_t frame = aFrame[idx];
    if (pFrame[i] != frame) {
      const int32_t g = global_anim(proxy, nSheets, sSheet[idx], anim);
      if (g < 0 || (uint32_t)g >= nAnims) return PERSIST_MISS;
      if ((int32_t)frame >= frameCount[g]) return PERSIST_MISS;
      const uint32_t tex = (uint32_t)(frameStart[g] + (int32_t)frame);
      qTexture[i] = (uint16_t)tex;
      if (aLastTex) aLastTex[idx] = (uint16_t)tex;
      pFrame[i] = (uint16_t)frame;
      repaired++;
    }
    if (inQueue) {
      if (!sInherit[idx]) {
        qRotC[i] = sRotC[idx];
        qRotS[i] = sRotS[idx];
      }
    } else {
      qX[i] = stX[i];
      qY[i] = stY[i];
      if (sInherit[idx]) {
        qRotC[i] = stRc[i];
        qRotS[i] = stRs[i];
      } else {
        qRotC[i] = sRotC[idx];
        qRotS[i] = sRotS[idx];
      }
    }
    if (sortKey) {
      const double z = sZ ? (double)sZ[idx] : 0.0;
      qSortKey[i] = (float)(ySort ? z * band + (double)cY[i] : z);
    }
    if (shadows) {
      const int cast = scActive && scActive[idx];
      qShadowH[i] = cast ? (scH ? or0(scH[idx]) : 0.0f) : 0.0f;
      if (qShadowOffX) qShadowOffX[i] = cast ? (scOx ? or0(scOx[idx]) : 0.0f) : 0.0f;
      if (qShadowOffY) qShadowOffY[i] = cast ? (scOy ? or0(scOy[idx]) : 0.0f) : 0.0f;
    }
    if (sAnimated[idx]) animated[nAnimated++] = i;
  }

  /* Every row passed: the clocks, in row order. */
  uint32_t moved = 0;
  uint32_t nEnds = 0;
  for (uint32_t a = 0; a < nAnimated; a++) {
    const uint32_t i = animated[a];
    const int32_t idx = cIndex[i];
    const uint32_t anim = sAnim[idx];
    const int32_t g = global_anim(proxy, nSheets, sSheet[idx], anim);
    if (g < 0) continue;
    const int32_t fc = (uint32_t)g < nAnims ? frameCount[g] : 1;
    if (fc <= 1) continue;
    const float acc = (float)((double)aAccum[idx] + deltaSeconds);
    aAccum[idx] = acc;
    const double duration = 1.0 / ((double)sSpeed[idx] * 60.0);
    if ((double)acc < duration) continue;
    aAccum[idx] = (float)((double)acc - duration);
    const int32_t cur = aFrame[idx];
    if (sLoop[idx] != 1 && cur >= fc - 1) {
      /* The last frame of a play-once animation finished showing. */
      ends[2 * nEnds] = (uint32_t)idx;
      ends[2 * nEnds + 1] = anim;
      nEnds++;
      continue;
    }
    aFrame[idx] = (uint16_t)((cur + 1) % fc);
    const uint32_t frame = aFrame[idx];
    const int32_t tex = frameStart[g] + (int32_t)frame;
    qTexture[i] = (uint16_t)tex;
    if (aLastTex) aLastTex[idx] = (uint16_t)tex;
    /* This buffer now shows the new frame: its next check needs no repair (E-98g). */
    pFrame[i] = (uint16_t)frame;
    if (bounds) {
      /* Bounds may change (variable frame sizes). */
      const int inRange = tex >= 0 && (uint32_t)tex < nFrames;
      const double w = inRange ? (double)frameW[tex] : 0.0;
      const double h = inRange ? (double)frameH[tex] : 0.0;
      double ax = fabs_d((double)sScaleX[idx]);
      double ay = fabs_d((double)sScaleY[idx]);
      if (ax == 0.0 || ax != ax) ax = 1.0;
      if (ay == 0.0 || ay != ay) ay = 1.0;
      sHalfW[idx] = (float)((w * ax) * 0.5);
      sHalfH[idx] = (float)((h * ay) * 0.5);
    }
    moved++;
  }
  counts[0] = nEnds;
  counts[1] = moved;
  counts[2] = repaired;
  return others;
}

/* _rememberType0Set after a full emit: the rows this buffer now holds, and the dirty flags of its sprites
   cleared. Returns 1 when it cleared one (the other buffer then still shows the old columns). */
__attribute__((export_name("persist_remember")))
uint32_t persist_remember(uint32_t table, uint32_t count, uint32_t maxItems) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const uint8_t *cType = PTR(const uint8_t, C_TYPE);
  const int32_t *cIndex = PTR(const int32_t, C_INDEX);
  uint8_t *pType = PTR(uint8_t, P_TYPE);
  int32_t *pEntity = PTR(int32_t, P_ENTITY);
  uint16_t *pFrame = PTR(uint16_t, P_FRAME);
  uint16_t *pAnim = PTR(uint16_t, P_ANIM);
  uint8_t *sDirty = PTR(uint8_t, S_DIRTY);
  const uint8_t *sAnim = PTR(const uint8_t, S_ANIM);
  const uint16_t *aFrame = PTR(const uint16_t, A_FRAME);
  const uint32_t nEntities = t[A_ENTITIES];

  /* Stores past the buffer are dropped, as the JS's are. */
  const uint32_t n = count < maxItems ? count : maxItems;
  uint32_t cleared = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t ty = cType[i];
    const int32_t idx = cIndex[i];
    pType[i] = (uint8_t)ty;
    pEntity[i] = idx;
    /* frameIndex[idx] | 0 for every row; past the column it reads undefined. */
    pFrame[i] = (uint32_t)idx < nEntities ? aFrame[idx] : 0;
    pAnim[i] = ty == 0 ? sAnim[idx] : 0;
    if (ty == 0 && sDirty && sDirty[idx]) {
      sDirty[idx] = 0;
      cleared = 1;
    }
  }
  return cleared;
}
