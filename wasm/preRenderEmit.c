/* Pre-render's emit (E-76 W4a, E-112): the full emit of PreRenderWorker.emitSpriteQueue
   (src/workers/preRenderWorker.js) for sprite rows (type 0) and decoration rows (type 2), poses taken from
   the collector's stash, on a frame the persist check missed. Every column is a byte offset into the
   render-queue memory (src/workers/preRenderEmitClient.js writes the table); 0 marks a column the worker
   does not have. Arithmetic as the JS does it: the sort key and the animation clock in double, each value
   stored as the typed array would store it. W4d: bullet and trail rows (types 4 and 5) too, when
   BulletComponent is in the memory. Rows of other types (particles, glows; bullets whose component is
   elsewhere) are listed with the queue row they go to and left for the JS to write; a frame with a LiquidFun
   row is declined (0xffffffff) before anything is written. Play-once ends and missing animations come back as
   lists too:
   the end message, its entity-type filter and the warnings stay JS.
   W27: an Adobe Animate root (type 6) expands into its pieces as _emitAdobePieces expands it, the frame
   resolved as _resolveAdobeFrameIndex resolves it, from AdobeAnimComponent and the asset directory the JS
   copies the registry's assets into (AdobeAsset); rows after it move down. Without those tables, or with a
   root whose asset they do not hold, the frame is declined. adobe_advance is advanceAdobeAnimations.
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
  /* W27: AdobeAnimComponent's columns; the asset directory (0: no Adobe tables this frame, so a frame with a
     root is declined) and its records (a value); the frame's Adobe entities for adobe_advance. */
  AA_ACTIVE, AA_PLAYING, AA_RATE, AA_TIME, AA_LOOP, AA_ASSET, AA_CLIP,
  AA_SCALE_X, AA_SCALE_Y, AA_ANCHOR_X, AA_ANCHOR_Y, AA_ROT_C, AA_ROT_S, AA_ALPHA, AA_TINT,
  AD_DIR, AD_ASSETS, AD_LIST,
  /* W4d: BulletComponent's columns (B_ACTIVE 0: not in the memory, so bullet and trail rows are listed for
     the JS) and the trail's texture (a value: _resolveBuiltinTextureId('_bulletTrail')). */
  B_ACTIVE, B_X, B_Y, B_START_X, B_START_Y, B_OFFSET_Y, B_SCALE, B_ALPHA, B_TINT, B_TEXTURE,
  B_SPRITE_ROT_C, B_SPRITE_ROT_S, B_ROT_C, B_ROT_S, B_TRAIL_W, B_ANCHOR_X, B_ANCHOR_Y, B_TRAIL_TEX,
  SLOT_COUNT
};

/* emitSpriteQueue's loop-invariant switches. */
#define F_SORT_KEY 1u    /* rqSortKey && source.hasOrder */
#define F_Y_SORT 2u      /* source.ySort */
#define F_TILES_DIRTY 4u /* a repeating sprite wrote this queue's tile columns before */
#define F_BOUNDS 8u      /* frameWidth, frameHeight, boundsHalfW and boundsHalfH all exist */
/* persist_frame (E-117): the scene has no ShadowCaster, so a sprite row's shadow terms are the zeros the
   full emit wrote when this buffer last held the row, and the walk leaves them. */
#define F_NO_CASTERS 16u
/* E-138: the collector was sorted before the emit, so nothing reads this frame's sort keys (no painter) or shadow
   terms (no sun casters): emit_rows writes neither, for any row (fewer bytes stored per Adobe piece). */
#define F_PRESORTED 64u

/* Warning kinds, for the JS to replay with its own keys. */
#define WARN_NO_ANIM 0u    /* sprite: no global animation for (sheet, state), sheet set */
#define WARN_NO_START 1u   /* sprite: the global animation has no first frame */
#define WARN_DECO_START 2u /* decoration: its animation has no first frame */
#define WARN_BULLET_START 3u /* bullet: its animation has no first frame */

/* W27: an asset directory record (preRenderEmitClient.js writeEmitAdobeAssets). Each array is a byte offset
   with its length (an index past it reads as the JS reads undefined there); the piece arrays share one length,
   past every frame's last piece. The rotations are doubles: the asset's pieceRotC/pieceRotS widened, or
   Math.cos/Math.sin of pieceRotation as the JS computes them for an asset without them. */
#define ASSET_NONE 0u /* no asset at this id: its roots draw nothing */
#define ASSET_IN 1u   /* in the tables */
#define ASSET_JS 2u   /* registered, not in the tables (no room, or arrays the kernel cannot read exactly) */
typedef struct {
  uint32_t kind;
  uint32_t clipStartLen, clipStart;   /* clipFrameStart, u32 */
  uint32_t clipCountLen, clipCount;   /* clipFrameCount, u16 */
  uint32_t clipRateLen, clipRate;     /* clipFrameRate, f32 */
  uint32_t minXLen, minX, minYLen, minY, maxXLen, maxX, maxYLen, maxY; /* clipBounds*, f32 */
  uint32_t frames, frameStart, frameCount; /* framePieceStart u32, framePieceCount u16 */
  uint32_t pieces;
  uint32_t px, py, psx, psy, prc, prs, palpha, pax, pay, ptex; /* f32 x4, f64 x2, f32 x3, u16 */
  uint32_t pad[3];
  double assetMinX, assetMinY, assetMaxX, assetMaxY; /* assetBounds* ?? 0 */
} AdobeAsset;
_Static_assert(sizeof(AdobeAsset) == 160, "EMIT_ADOBE_ASSET_BYTES");

#define PTR(T, c) ((T *)(uintptr_t)t[c])
#define AT(T, byte) ((const T *)(uintptr_t)(byte))

/* `v || 0` on a number: 0, -0 and NaN become 0. */
INLINE float or0(float v) { return (v == 0.0f || v != v) ? 0.0f : v; }
INLINE double fabs_d(double v) { return __builtin_fabs(v); }

/* JS `x % y` on doubles: the exact remainder, the sign of x (musl's fmod, the normalisation by count). */
static double js_fmod(double x, double y) {
  union { double f; uint64_t i; } ux = {x}, uy = {y};
  int ex = (int)(ux.i >> 52 & 0x7ff);
  int ey = (int)(uy.i >> 52 & 0x7ff);
  const uint64_t sx = ux.i >> 63;
  uint64_t i;
  uint64_t uxi = ux.i;
  if (uy.i << 1 == 0 || y != y || ex == 0x7ff) return (x * y) / (x * y);
  if (uxi << 1 <= uy.i << 1) {
    if (uxi << 1 == uy.i << 1) return 0 * x;
    return x;
  }
  if (!ex) {
    for (i = uxi << 12; i >> 63 == 0; ex--, i <<= 1) {}
    uxi <<= -ex + 1;
  } else {
    uxi &= -1ULL >> 12;
    uxi |= 1ULL << 52;
  }
  if (!ey) {
    for (i = uy.i << 12; i >> 63 == 0; ey--, i <<= 1) {}
    uy.i <<= -ey + 1;
  } else {
    uy.i &= -1ULL >> 12;
    uy.i |= 1ULL << 52;
  }
  for (; ex > ey; ex--) {
    i = uxi - uy.i;
    if (i >> 63 == 0) {
      if (i == 0) return 0 * x;
      uxi = i;
    }
    uxi <<= 1;
  }
  i = uxi - uy.i;
  if (i >> 63 == 0) {
    if (i == 0) return 0 * x;
    uxi = i;
  }
  {
    const int sh = __builtin_clzll(uxi) - 11;
    uxi <<= sh;
    ex -= sh;
  }
  if (ex > 0) {
    uxi -= 1ULL << 52;
    uxi |= (uint64_t)ex << 52;
  } else {
    uxi >>= -ex + 1;
  }
  uxi |= sx << 63;
  ux.i = uxi;
  return ux.f;
}

/* JS `v | 0`: NaN and the infinities are 0, the rest truncated and wrapped to 32 bits. */
INLINE int32_t js_toint32(double v) {
  if (v != v || v - v != 0.0) return 0;
  const double r = __builtin_trunc(v);
  if (r >= -2147483648.0 && r <= 2147483647.0) return (int32_t)r;
  double m = js_fmod(r, 4294967296.0);
  if (m < 0.0) m += 4294967296.0;
  return (int32_t)(uint32_t)m;
}

/* Everything emit_rows reads, loaded from the table once (the stores may alias the table as far as the
   compiler knows); the row writers below are inlined into each of its loops. */
typedef struct {
  const uint8_t *cType;
  const int32_t *cIndex;
  const float *cY, *stX, *stY, *stRc, *stRs;
  const float *sScaleX, *sScaleY, *sAlpha;
  const uint32_t *sTint;
  const float *sAnchorX, *sAnchorY;
  const uint8_t *sInherit;
  const float *sRotC, *sRotS;
  const uint16_t *sRepeatX, *sRepeatY;
  const uint8_t *sTileMode;
  const uint16_t *sTileOffU, *sTileOffV;
  float *sHalfW, *sHalfH;
  const uint8_t *sSheet, *sAnim, *sAnimated;
  const float *sSpeed;
  const uint8_t *sLoop;
  const int16_t *sZ;
  const uint8_t *scActive;
  const float *scH, *scOx, *scOy;
  const float *dScaleX, *dScaleY, *dAlpha;
  const uint32_t *dTint;
  const uint16_t *dTexture;
  const float *dAnchorX, *dAnchorY;
  uint16_t *aFrame;
  float *aAccum;
  uint16_t *aLastTex;
  const int32_t *proxy;
  uint32_t nSheets;
  const int32_t *frameCount, *frameStart;
  uint32_t nAnims;
  const uint16_t *frameW, *frameH;
  uint32_t nFrames;
  float *qX, *qY, *qScaleX, *qScaleY, *qRotC, *qRotS, *qAlpha;
  uint32_t *qTint;
  uint16_t *qTexture;
  float *qAnchorX, *qAnchorY;
  uint8_t *qType;
  float *qSortKey;
  uint16_t *qRepeatX, *qRepeatY;
  uint8_t *qTileMode;
  uint16_t *qTileOffU, *qTileOffV;
  float *qTileMulX, *qTileMulY, *qShadowH, *qShadowOffX, *qShadowOffY;
  uint32_t *ends, *warns;
  const uint16_t *aaAsset, *aaClip;
  const float *aaTime;
  const uint8_t *aaLoop;
  const float *aaScaleX, *aaScaleY, *aaAnchorX, *aaAnchorY, *aaRotC, *aaRotS, *aaAlpha;
  const uint32_t *aaTint;
  const AdobeAsset *dir;
  uint32_t nAssets;
  const uint8_t *bActive;
  const float *bX, *bY, *bStartX, *bStartY, *bOffY, *bScale, *bAlpha;
  const uint32_t *bTint;
  const uint16_t *bTexture;
  const float *bSpriteRc, *bSpriteRs, *bRc, *bRs, *bTrailW, *bAnchorX, *bAnchorY;
  uint32_t bTrailTex;
  int sortKey, ySort, tilesDirty, bounds;
  double deltaSeconds, zoomAlpha, band;
  uint32_t nEnds, nWarns, tiled;
} Emit;

INLINE void load_emit(Emit *e, const uint32_t *t, uint32_t flags, double deltaSeconds, double zoomAlpha, double band) {
  e->cType = PTR(const uint8_t, C_TYPE);
  e->cIndex = PTR(const int32_t, C_INDEX);
  e->cY = PTR(const float, C_Y);
  e->stX = PTR(const float, C_STASH_X);
  e->stY = PTR(const float, C_STASH_Y);
  e->stRc = PTR(const float, C_STASH_RC);
  e->stRs = PTR(const float, C_STASH_RS);
  e->sScaleX = PTR(const float, S_SCALE_X);
  e->sScaleY = PTR(const float, S_SCALE_Y);
  e->sAlpha = PTR(const float, S_ALPHA);
  e->sTint = PTR(const uint32_t, S_TINT);
  e->sAnchorX = PTR(const float, S_ANCHOR_X);
  e->sAnchorY = PTR(const float, S_ANCHOR_Y);
  e->sInherit = PTR(const uint8_t, S_INHERIT);
  e->sRotC = PTR(const float, S_ROT_C);
  e->sRotS = PTR(const float, S_ROT_S);
  e->sRepeatX = PTR(const uint16_t, S_REPEAT_X);
  e->sRepeatY = PTR(const uint16_t, S_REPEAT_Y);
  e->sTileMode = PTR(const uint8_t, S_TILE_MODE);
  e->sTileOffU = PTR(const uint16_t, S_TILE_OFF_U);
  e->sTileOffV = PTR(const uint16_t, S_TILE_OFF_V);
  e->sHalfW = PTR(float, S_HALF_W);
  e->sHalfH = PTR(float, S_HALF_H);
  e->sSheet = PTR(const uint8_t, S_SHEET);
  e->sAnim = PTR(const uint8_t, S_ANIM);
  e->sAnimated = PTR(const uint8_t, S_ANIMATED);
  e->sSpeed = PTR(const float, S_SPEED);
  e->sLoop = PTR(const uint8_t, S_LOOP);
  e->sZ = PTR(const int16_t, S_Z);
  e->scActive = PTR(const uint8_t, SC_ACTIVE);
  e->scH = PTR(const float, SC_H);
  e->scOx = PTR(const float, SC_OFF_X);
  e->scOy = PTR(const float, SC_OFF_Y);
  e->dScaleX = PTR(const float, D_SCALE_X);
  e->dScaleY = PTR(const float, D_SCALE_Y);
  e->dAlpha = PTR(const float, D_ALPHA);
  e->dTint = PTR(const uint32_t, D_TINT);
  e->dTexture = PTR(const uint16_t, D_TEXTURE);
  e->dAnchorX = PTR(const float, D_ANCHOR_X);
  e->dAnchorY = PTR(const float, D_ANCHOR_Y);
  e->aFrame = PTR(uint16_t, A_FRAME);
  e->aAccum = PTR(float, A_ACCUM);
  e->aLastTex = PTR(uint16_t, A_LAST_TEX);
  e->proxy = PTR(const int32_t, T_PROXY);
  e->nSheets = t[T_SHEETS];
  e->frameCount = PTR(const int32_t, T_FRAME_COUNT);
  e->frameStart = PTR(const int32_t, T_FRAME_START);
  e->nAnims = t[T_ANIMS];
  e->frameW = PTR(const uint16_t, T_FRAME_W);
  e->frameH = PTR(const uint16_t, T_FRAME_H);
  e->nFrames = t[T_FRAMES];
  e->qX = PTR(float, Q_X);
  e->qY = PTR(float, Q_Y);
  e->qScaleX = PTR(float, Q_SCALE_X);
  e->qScaleY = PTR(float, Q_SCALE_Y);
  e->qRotC = PTR(float, Q_ROT_C);
  e->qRotS = PTR(float, Q_ROT_S);
  e->qAlpha = PTR(float, Q_ALPHA);
  e->qTint = PTR(uint32_t, Q_TINT);
  e->qTexture = PTR(uint16_t, Q_TEXTURE);
  e->qAnchorX = PTR(float, Q_ANCHOR_X);
  e->qAnchorY = PTR(float, Q_ANCHOR_Y);
  e->qType = PTR(uint8_t, Q_TYPE);
  e->qSortKey = PTR(float, Q_SORT_KEY);
  e->qRepeatX = PTR(uint16_t, Q_REPEAT_X);
  e->qRepeatY = PTR(uint16_t, Q_REPEAT_Y);
  e->qTileMode = PTR(uint8_t, Q_TILE_MODE);
  e->qTileOffU = PTR(uint16_t, Q_TILE_OFF_U);
  e->qTileOffV = PTR(uint16_t, Q_TILE_OFF_V);
  e->qTileMulX = PTR(float, Q_TILE_MUL_X);
  e->qTileMulY = PTR(float, Q_TILE_MUL_Y);
  e->qShadowH = PTR(float, Q_SHADOW_H);
  e->qShadowOffX = PTR(float, Q_SHADOW_OFF_X);
  e->qShadowOffY = PTR(float, Q_SHADOW_OFF_Y);
  e->ends = PTR(uint32_t, R_ENDS);
  e->warns = PTR(uint32_t, R_WARNS);
  e->aaAsset = PTR(const uint16_t, AA_ASSET);
  e->aaClip = PTR(const uint16_t, AA_CLIP);
  e->aaTime = PTR(const float, AA_TIME);
  e->aaLoop = PTR(const uint8_t, AA_LOOP);
  e->aaScaleX = PTR(const float, AA_SCALE_X);
  e->aaScaleY = PTR(const float, AA_SCALE_Y);
  e->aaAnchorX = PTR(const float, AA_ANCHOR_X);
  e->aaAnchorY = PTR(const float, AA_ANCHOR_Y);
  e->aaRotC = PTR(const float, AA_ROT_C);
  e->aaRotS = PTR(const float, AA_ROT_S);
  e->aaAlpha = PTR(const float, AA_ALPHA);
  e->aaTint = PTR(const uint32_t, AA_TINT);
  e->dir = PTR(const AdobeAsset, AD_DIR);
  e->nAssets = t[AD_ASSETS];
  e->bActive = PTR(const uint8_t, B_ACTIVE);
  e->bX = PTR(const float, B_X);
  e->bY = PTR(const float, B_Y);
  e->bStartX = PTR(const float, B_START_X);
  e->bStartY = PTR(const float, B_START_Y);
  e->bOffY = PTR(const float, B_OFFSET_Y);
  e->bScale = PTR(const float, B_SCALE);
  e->bAlpha = PTR(const float, B_ALPHA);
  e->bTint = PTR(const uint32_t, B_TINT);
  e->bTexture = PTR(const uint16_t, B_TEXTURE);
  e->bSpriteRc = PTR(const float, B_SPRITE_ROT_C);
  e->bSpriteRs = PTR(const float, B_SPRITE_ROT_S);
  e->bRc = PTR(const float, B_ROT_C);
  e->bRs = PTR(const float, B_ROT_S);
  e->bTrailW = PTR(const float, B_TRAIL_W);
  e->bAnchorX = PTR(const float, B_ANCHOR_X);
  e->bAnchorY = PTR(const float, B_ANCHOR_Y);
  e->bTrailTex = t[B_TRAIL_TEX];
  e->sortKey = (flags & F_SORT_KEY) != 0;
  e->ySort = (flags & F_Y_SORT) != 0;
  e->tilesDirty = (flags & F_TILES_DIRTY) != 0;
  e->bounds = (flags & F_BOUNDS) != 0;
  if (flags & F_PRESORTED) {
    e->sortKey = 0;
    e->qSortKey = 0;
    e->qShadowH = 0;
    e->qShadowOffX = 0;
    e->qShadowOffY = 0;
  }
  e->deltaSeconds = deltaSeconds;
  e->zoomAlpha = zoomAlpha;
  e->band = band;
  e->nEnds = 0;
  e->nWarns = 0;
  e->tiled = 0;
}

/* _writeQueueShadow: entity idx's shadow terms at row out. */
INLINE void queue_shadow(const Emit *e, uint32_t out, int32_t idx) {
  if (!e->qShadowH) return;
  const int cast = e->scActive && e->scActive[idx];
  e->qShadowH[out] = cast ? (e->scH ? or0(e->scH[idx]) : 0.0f) : 0.0f;
  if (e->qShadowOffX) e->qShadowOffX[out] = cast ? (e->scOx ? or0(e->scOx[idx]) : 0.0f) : 0.0f;
  if (e->qShadowOffY) e->qShadowOffY[out] = cast ? (e->scOy ? or0(e->scOy[idx]) : 0.0f) : 0.0f;
}

/* A row that is no tiled sprite, on a queue whose tile columns a repeating sprite wrote (E-102b). */
INLINE void clear_tiles(const Emit *e, uint32_t out) {
  if (e->qRepeatX) e->qRepeatX[out] = 0;
  if (e->qRepeatY) e->qRepeatY[out] = 0;
  if (e->qTileMode) e->qTileMode[out] = 0;
  if (e->qTileOffU) e->qTileOffU[out] = 0;
  if (e->qTileOffV) e->qTileOffV[out] = 0;
  if (e->qTileMulX) e->qTileMulX[out] = 0.0f;
  if (e->qTileMulY) e->qTileMulY[out] = 0.0f;
}

/* The sort key of a sprite or an Adobe root: orderSortKey(yKey, zIndex | 0, ySort, band). */
INLINE double order_key(const Emit *e, uint32_t i, int32_t idx) {
  const double z = e->sZ ? (double)e->sZ[idx] : 0.0;
  return e->ySort ? z * e->band + (double)e->cY[i] : z;
}

/* emitSpriteQueue's sprite branch: collector row i at queue row out. */
INLINE void sprite_row(Emit *e, uint32_t i, uint32_t out) {
  const int32_t idx = e->cIndex[i];
  if (e->sortKey) e->qSortKey[out] = (float)order_key(e, i, idx);
  const float x = e->stX[i];
  const float y = e->stY[i];
  float rc;
  float rs;
  if (e->sInherit[idx]) {
    rc = e->stRc[i];
    rs = e->stRs[i];
  } else {
    rc = e->sRotC[idx];
    rs = e->sRotS[idx];
  }
  e->qAlpha[out] = e->sAlpha[idx];
  queue_shadow(e, out, idx);
  const uint32_t rx = e->sRepeatX[idx];
  const uint32_t ry = e->sRepeatY[idx];
  if (rx != 0 || ry != 0) {
    e->tiled = 1;
    if (e->qRepeatX) e->qRepeatX[out] = (uint16_t)rx;
    if (e->qRepeatY) e->qRepeatY[out] = (uint16_t)ry;
    /* writeEntityTileFields */
    const uint32_t mode = e->sTileMode[idx];
    if (e->qTileMode) e->qTileMode[out] = (uint8_t)mode;
    if (e->qTileOffU) e->qTileOffU[out] = e->sTileOffU[idx];
    if (e->qTileOffV) e->qTileOffV[out] = e->sTileOffV[idx];
    double mx = 0.0;
    double my = 0.0;
    if (rx > 0) mx = mode == TILE_MODE_LOCAL ? -((double)e->sHalfW[idx] * 2.0) / (double)rx : 1.0 / (double)rx;
    if (ry > 0) my = mode == TILE_MODE_LOCAL ? -((double)e->sHalfH[idx] * 2.0) / (double)ry : 1.0 / (double)ry;
    if (e->qTileMulX) e->qTileMulX[out] = (float)mx;
    if (e->qTileMulY) e->qTileMulY[out] = (float)my;
  } else if (e->tilesDirty) {
    if (e->qRepeatX) e->qRepeatX[out] = 0;
    if (e->qRepeatY) e->qRepeatY[out] = 0;
    if (e->qTileMulX) e->qTileMulX[out] = 0.0f;
    if (e->qTileMulY) e->qTileMulY[out] = 0.0f;
  }
  e->qX[out] = x;
  e->qY[out] = y;
  e->qScaleX[out] = e->sScaleX[idx];
  e->qScaleY[out] = e->sScaleY[idx];
  e->qRotC[out] = rc;
  e->qRotS[out] = rs;
  e->qTint[out] = e->sTint[idx];
  e->qAnchorX[out] = e->sAnchorX[idx];
  e->qAnchorY[out] = e->sAnchorY[idx];
  if (e->qType) e->qType[out] = 0;

  const uint32_t sheet = e->sSheet[idx];
  const uint32_t anim = e->sAnim[idx];
  const int32_t g = sheet < e->nSheets ? e->proxy[sheet * PROXY_STATES + anim] : -1;
  uint32_t tex = INVALID_TEXTURE;
  if (g >= 0) {
    const int known = (uint32_t)g < e->nAnims;
    const int32_t fc = known ? e->frameCount[g] : 1;
    if ((int32_t)e->aFrame[idx] >= fc) e->aFrame[idx] = 0;
    if (e->sAnimated[idx] && fc > 1) {
      const float acc = (float)((double)e->aAccum[idx] + e->deltaSeconds);
      e->aAccum[idx] = acc;
      const double duration = 1.0 / ((double)e->sSpeed[idx] * 60.0);
      if ((double)acc >= duration) {
        e->aAccum[idx] = (float)((double)acc - duration);
        const int32_t cur = e->aFrame[idx];
        if (e->sLoop[idx] != 1 && cur >= fc - 1) {
          /* The last frame of a play-once animation finished showing. */
          e->ends[2 * e->nEnds] = (uint32_t)idx;
          e->ends[2 * e->nEnds + 1] = anim;
          e->nEnds++;
        } else {
          e->aFrame[idx] = (uint16_t)((cur + 1) % fc);
          if (e->bounds) {
            /* Bounds may change (variable frame sizes). */
            const int32_t texId = (known ? e->frameStart[g] : 0) + (int32_t)e->aFrame[idx];
            const int inRange = texId >= 0 && (uint32_t)texId < e->nFrames;
            const double w = inRange ? (double)e->frameW[texId] : 0.0;
            const double h = inRange ? (double)e->frameH[texId] : 0.0;
            double ax = fabs_d((double)e->sScaleX[idx]);
            double ay = fabs_d((double)e->sScaleY[idx]);
            if (ax == 0.0 || ax != ax) ax = 1.0;
            if (ay == 0.0 || ay != ay) ay = 1.0;
            e->sHalfW[idx] = (float)((w * ax) * 0.5);
            e->sHalfH[idx] = (float)((h * ay) * 0.5);
          }
        }
      }
    }
    if (known) {
      tex = (uint32_t)(e->frameStart[g] + (int32_t)e->aFrame[idx]);
      if (e->aLastTex) e->aLastTex[idx] = (uint16_t)tex;
    } else {
      e->warns[2 * e->nWarns] = (uint32_t)idx;
      e->warns[2 * e->nWarns + 1] = WARN_NO_START;
      e->nWarns++;
    }
  } else {
    /* Never reuse a stale last texture (pool recycle, spawn before setSprite). */
    if (e->aLastTex) e->aLastTex[idx] = INVALID_TEXTURE;
    if (sheet) {
      e->warns[2 * e->nWarns] = (uint32_t)idx;
      e->warns[2 * e->nWarns + 1] = WARN_NO_ANIM;
      e->nWarns++;
    }
  }
  e->qTexture[out] = (uint16_t)tex;
}

/* What emitSpriteQueue writes first on a row that is no sprite and casts no shadow (a decoration, a bullet, a
   trail): the sort key with z 0 (_orderKey), the tile columns cleared, the shadow terms zeroed. */
INLINE void plain_head(const Emit *e, uint32_t i, uint32_t out) {
  if (e->sortKey) e->qSortKey[out] = (float)(e->ySort ? 0.0 * e->band + (double)e->cY[i] : 0.0);
  if (e->tilesDirty) clear_tiles(e, out);
  if (e->qShadowH) e->qShadowH[out] = 0.0f;
  if (e->qShadowOffX) e->qShadowOffX[out] = 0.0f;
  if (e->qShadowOffY) e->qShadowOffY[out] = 0.0f;
}

/* emitSpriteQueue's decoration branch: collector row i at queue row out. */
INLINE void deco_row(Emit *e, uint32_t i, uint32_t out) {
  const int32_t idx = e->cIndex[i];
  plain_head(e, i, out);
  const float x = e->stX[i];
  const float y = e->stY[i];
  const float rc = e->stRc[i];
  const float rs = e->stRs[i];
  e->qX[out] = x;
  e->qY[out] = y;
  e->qScaleX[out] = e->dScaleX[idx];
  e->qScaleY[out] = e->dScaleY[idx];
  e->qRotC[out] = rc;
  e->qRotS[out] = rs;
  e->qAlpha[out] = (float)((double)e->dAlpha[idx] * e->zoomAlpha);
  e->qTint[out] = e->dTint[idx];
  const uint32_t a = e->dTexture[idx];
  uint32_t tex = INVALID_TEXTURE;
  if (a < e->nAnims) {
    tex = (uint32_t)e->frameStart[a];
  } else {
    e->warns[2 * e->nWarns] = (uint32_t)idx;
    e->warns[2 * e->nWarns + 1] = WARN_DECO_START;
    e->nWarns++;
  }
  e->qTexture[out] = (uint16_t)tex;
  e->qAnchorX[out] = e->dAnchorX[idx];
  e->qAnchorY[out] = e->dAnchorY[idx];
  if (e->qType) e->qType[out] = 2;
}

/* A bullet or trail row that draws nothing, parked off screen; its other columns keep what they held. */
INLINE void hide_row(const Emit *e, uint32_t out) {
  e->qAlpha[out] = 0.0f;
  e->qScaleX[out] = 0.0f;
  e->qScaleY[out] = 0.0f;
  e->qX[out] = -10000.0f;
  e->qY[out] = -10000.0f;
}

/* W4d. emitSpriteQueue's bullet branch (type 4): collector row i, bullet slot cIndex[i], at queue row out. */
INLINE void bullet_row(Emit *e, uint32_t i, uint32_t out) {
  const int32_t idx = e->cIndex[i];
  plain_head(e, i, out);
  if (!e->bActive[idx]) {
    hide_row(e, out);
  } else {
    const float s = e->bScale[idx];
    e->qX[out] = e->bX[idx];
    e->qY[out] = (float)((double)e->bY[idx] + (double)e->bOffY[idx]);
    e->qScaleX[out] = s;
    e->qScaleY[out] = s;
    e->qRotC[out] = e->bSpriteRc[idx];
    e->qRotS[out] = e->bSpriteRs[idx];
    e->qAlpha[out] = e->bAlpha[idx];
    e->qTint[out] = e->bTint[idx];
    const uint32_t a = e->bTexture[idx];
    uint32_t tex = INVALID_TEXTURE;
    if (a < e->nAnims) {
      tex = (uint32_t)e->frameStart[a];
    } else {
      e->warns[2 * e->nWarns] = (uint32_t)idx;
      e->warns[2 * e->nWarns + 1] = WARN_BULLET_START;
      e->nWarns++;
    }
    e->qTexture[out] = (uint16_t)tex;
    e->qAnchorX[out] = e->bAnchorX[idx];
    e->qAnchorY[out] = e->bAnchorY[idx];
  }
  if (e->qType) e->qType[out] = 4;
}

/* W4d. emitSpriteQueue's trail branch (type 5): the line from the bullet's start to where it is, in double as the
   JS computes it; shorter than 0.1 it is hidden. */
INLINE void trail_row(Emit *e, uint32_t i, uint32_t out) {
  const int32_t idx = e->cIndex[i];
  plain_head(e, i, out);
  if (!e->bActive[idx]) {
    hide_row(e, out);
  } else {
    const double off = (double)e->bOffY[idx];
    const double currX = (double)e->bX[idx];
    const double currY = (double)e->bY[idx] + off;
    const double startX = (double)e->bStartX[idx];
    const double startY = (double)e->bStartY[idx] + off;
    const double dx = currX - startX;
    const double dy = currY - startY;
    const double lenSq = dx * dx + dy * dy;
    if (lenSq < 0.01) {
      hide_row(e, out);
    } else {
      /* The JS's ternaries, not fabs: a -0 difference stays -0. */
      const double adx = dx < 0.0 ? -dx : dx;
      const double ady = dy < 0.0 ? -dy : dy;
      const double mx = adx > ady ? adx : ady;
      const double mn = adx > ady ? ady : adx;
      const double lengthApprox = 0.96 * mx + 0.4 * mn;
      e->qX[out] = (float)((startX + currX) * 0.5);
      e->qY[out] = (float)((startY + currY) * 0.5);
      e->qScaleX[out] = (float)(lengthApprox / 10.0);
      e->qScaleY[out] = e->bTrailW[idx];
      e->qRotC[out] = e->bRc[idx];
      e->qRotS[out] = e->bRs[idx];
      e->qAlpha[out] = (float)((double)e->bAlpha[idx] * 0.9);
      e->qTint[out] = 0xffffffu;
    }
  }
  e->qTexture[out] = (uint16_t)e->bTrailTex;
  e->qAnchorX[out] = 0.5f;
  e->qAnchorY[out] = 0.5f;
  if (e->qType) e->qType[out] = 5;
}

/* _resolveAdobeFrameIndex for an asset in the tables: the clip's frame at this time, or -1 when the root
   draws nothing (no frames, no frame rate). */
INLINE int32_t adobe_frame(const AdobeAsset *as, uint32_t clip, double time, int loop) {
  const int32_t frameCount = clip < as->clipCountLen ? (int32_t)AT(uint16_t, as->clipCount)[clip] : 0;
  const double frameRate = clip < as->clipRateLen ? (double)AT(float, as->clipRate)[clip] : 0.0;
  if (frameCount <= 0 || frameRate <= 0.0) return -1;
  const double duration = (double)frameCount / frameRate;
  if (duration > 0.0) {
    if (loop) time = js_fmod(js_fmod(time, duration) + duration, duration);
    else if (time >= duration) time = duration;
    else if (time < 0.0) time = 0.0;
  } else {
    time = 0.0;
  }
  int32_t frameIndex = frameCount > 1 ? js_toint32(time * frameRate) : 0;
  if (frameIndex >= frameCount) frameIndex = frameCount - 1;
  if (frameIndex < 0) frameIndex = 0;
  return frameIndex;
}

/* _emitAdobePieces: root collector row i, its pieces from queue row w while the queue has room (cap).
   Returns the next free row; *overflow is set when pieces did not fit. */
INLINE uint32_t adobe_root(Emit *e, uint32_t i, uint32_t w, uint32_t cap, double sortKey, uint32_t *overflow) {
  const int32_t idx = e->cIndex[i];
  const uint32_t id = e->aaAsset[idx];
  if (id >= e->nAssets) return w;
  const AdobeAsset *as = &e->dir[id];
  if (as->kind != ASSET_IN) return w;
  const uint32_t clip = e->aaClip[idx];
  const int32_t frameIndex = adobe_frame(as, clip, (double)e->aaTime[idx], e->aaLoop[idx] != 0);
  if (frameIndex < 0) return w;

  const double rootX = (double)e->stX[i];
  const double rootY = (double)e->stY[i];
  const double poseC = (double)e->stRc[i];
  const double poseS = (double)e->stRs[i];
  /* body pose CS x AdobeAnimComponent CS */
  const double ac = (double)e->aaRotC[idx];
  const double asn = (double)e->aaRotS[idx];
  const double rootC = poseC * ac - poseS * asn;
  const double rootS = poseS * ac + poseC * asn;
  const double rootScaleX = (double)e->aaScaleX[idx];
  const double rootScaleY = (double)e->aaScaleY[idx];
  const double rootAnchorX = (double)e->aaAnchorX[idx];
  const double rootAnchorY = (double)e->aaAnchorY[idx];
  const double rootAlpha = (double)e->aaAlpha[idx];
  const uint32_t rootTint = e->aaTint[idx];

  const uint64_t absoluteFrame = (uint64_t)(clip < as->clipStartLen ? AT(uint32_t, as->clipStart)[clip] : 0u)
    + (uint64_t)frameIndex;
  uint32_t start = 0;
  uint32_t end = 0;
  if (absoluteFrame < as->frames) {
    start = AT(uint32_t, as->frameStart)[absoluteFrame];
    end = start + AT(uint16_t, as->frameCount)[absoluteFrame];
  }
  const double minX = clip < as->minXLen ? (double)AT(float, as->minX)[clip] : as->assetMinX;
  const double minY = clip < as->minYLen ? (double)AT(float, as->minY)[clip] : as->assetMinY;
  const double maxX = clip < as->maxXLen ? (double)AT(float, as->maxX)[clip] : as->assetMaxX;
  const double maxY = clip < as->maxYLen ? (double)AT(float, as->maxY)[clip] : as->assetMaxY;
  const double pivotX = minX + (maxX - minX) * rootAnchorX;
  const double pivotY = minY + (maxY - minY) * rootAnchorY;
  /* -1 when exactly one of the root's scales is negative (a reflection): the pieces' rotations flip. */
  const double mirrorSign = ((rootScaleX < 0.0) != (rootScaleY < 0.0)) ? -1.0 : 1.0;

  const float *pieceX = AT(float, as->px);
  const float *pieceY = AT(float, as->py);
  const float *pieceScaleX = AT(float, as->psx);
  const float *pieceScaleY = AT(float, as->psy);
  const double *pieceRotC = AT(double, as->prc);
  const double *pieceRotS = AT(double, as->prs);
  const float *pieceAlpha = AT(float, as->palpha);
  const float *pieceAnchorX = AT(float, as->pax);
  const float *pieceAnchorY = AT(float, as->pay);
  const uint16_t *textureIds = AT(uint16_t, as->ptex);
  const float sk = (float)sortKey;

  int64_t feetSlot = -1;
  float feetY = 0.0f;
  uint32_t p = start;
  for (; p < end && w < cap; p++) {
    const double localX = ((double)pieceX[p] - pivotX) * rootScaleX;
    const double localY = ((double)pieceY[p] - pivotY) * rootScaleY;
    const float y = (float)(rootY + rootS * localX + rootC * localY);
    e->qX[w] = (float)(rootX + rootC * localX - rootS * localY);
    e->qY[w] = y;
    e->qScaleX[w] = (float)((double)pieceScaleX[p] * rootScaleX);
    e->qScaleY[w] = (float)((double)pieceScaleY[p] * rootScaleY);
    const double pc = pieceRotC[p];
    const double ps = pieceRotS[p] * mirrorSign;
    e->qRotC[w] = (float)(rootC * pc - rootS * ps);
    e->qRotS[w] = (float)(rootS * pc + rootC * ps);
    e->qAlpha[w] = (float)((double)pieceAlpha[p] * rootAlpha);
    e->qTint[w] = rootTint;
    e->qTexture[w] = textureIds[p];
    e->qAnchorX[w] = pieceAnchorX[p];
    e->qAnchorY[w] = pieceAnchorY[p];
    if (e->qType) e->qType[w] = 6;
    if (e->tilesDirty) clear_tiles(e, w);
    if (e->qSortKey) e->qSortKey[w] = sk;
    if (e->qShadowH) {
      e->qShadowH[w] = 0.0f;
      if (e->qShadowOffX) e->qShadowOffX[w] = 0.0f;
      if (e->qShadowOffY) e->qShadowOffY[w] = 0.0f;
    }
    /* The lowest piece on screen carries the root's shadow. */
    if (feetSlot < 0 || y >= feetY) {
      feetY = y;
      feetSlot = w;
    }
    w++;
  }
  if (feetSlot >= 0) queue_shadow(e, (uint32_t)feetSlot, idx);
  if (p < end) *overflow = 1;
  return w;
}

__attribute__((export_name("emit_rows")))
uint32_t emit_rows(uint32_t table, uint32_t count, uint32_t maxItems, uint32_t flags,
                   double deltaSeconds, double zoomAlpha, double band) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  Emit e;
  load_emit(&e, t, flags, deltaSeconds, zoomAlpha, band);
  uint32_t *foreign = PTR(uint32_t, R_FOREIGN);
  uint32_t *counts = PTR(uint32_t, R_COUNTS);
  const uint8_t *cType = e.cType;

  /* Without an Adobe root the loop visits min(count, maxItems) rows, each writing one: row i is queue row i. */
  const uint32_t n = count < maxItems ? count : maxItems;
  uint32_t roots = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint8_t ty = cType[i];
    if (ty == 7) return DECLINED;
    if (ty == 6) {
      if (!e.dir) return DECLINED;
      const uint32_t id = e.aaAsset[e.cIndex[i]];
      if (id < e.nAssets && e.dir[id].kind == ASSET_JS) return DECLINED;
      roots++;
    }
  }
  /* A collector longer than the queue past an expansion reads past its rows in the JS. */
  if (roots && count > maxItems) return DECLINED;

  uint32_t nForeign = 0;
  uint32_t overflow = 0;
  uint32_t w;
  if (!roots) {
    for (uint32_t i = 0; i < n; i++) {
      const uint8_t ty = cType[i];
      if (ty == 0) {
        sprite_row(&e, i, i);
      } else if (ty == 2) {
        deco_row(&e, i, i);
      } else if (ty == 4 && e.bActive) {
        bullet_row(&e, i, i);
      } else if (ty == 5 && e.bActive) {
        trail_row(&e, i, i);
      } else {
        foreign[2 * nForeign] = i;
        foreign[2 * nForeign + 1] = i;
        nForeign++;
      }
    }
    w = n;
  } else {
    /* emitSpriteQueue's loop: until the collector or the queue runs out. */
    w = 0;
    for (uint32_t i = 0; i < count && w < maxItems; i++) {
      const uint8_t ty = cType[i];
      if (ty == 6) {
        const double sk = e.sortKey ? order_key(&e, i, e.cIndex[i]) : (double)e.cY[i];
        w = adobe_root(&e, i, w, maxItems, sk, &overflow);
        continue;
      }
      if (ty == 0) {
        sprite_row(&e, i, w);
      } else if (ty == 2) {
        deco_row(&e, i, w);
      } else if (ty == 4 && e.bActive) {
        bullet_row(&e, i, w);
      } else if (ty == 5 && e.bActive) {
        trail_row(&e, i, w);
      } else {
        foreign[2 * nForeign] = i;
        foreign[2 * nForeign + 1] = w;
        nForeign++;
      }
      w++;
    }
  }
  counts[0] = e.nEnds;
  counts[1] = e.nWarns;
  counts[2] = e.tiled;
  counts[3] = nForeign;
  counts[4] = overflow;
  return w;
}

/* advanceAdobeAnimations: the clocks of the frame's Adobe entities (AD_LIST, listCount of them). Returns how
   many play-once clips ended, their entities listed in order at the start of the same list (for the JS's end
   message), or DECLINED, before anything is written, when a playing clock's asset is not in the tables. */
__attribute__((export_name("adobe_advance")))
uint32_t adobe_advance(uint32_t table, uint32_t listCount, double deltaSeconds) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const AdobeAsset *dir = PTR(const AdobeAsset, AD_DIR);
  const uint32_t nAssets = t[AD_ASSETS];
  uint32_t *list = PTR(uint32_t, AD_LIST);
  const uint8_t *active = PTR(const uint8_t, AA_ACTIVE);
  uint8_t *playing = PTR(uint8_t, AA_PLAYING);
  const float *rate = PTR(const float, AA_RATE);
  float *time = PTR(float, AA_TIME);
  const uint8_t *loop = PTR(const uint8_t, AA_LOOP);
  const uint16_t *asset = PTR(const uint16_t, AA_ASSET);
  const uint16_t *clip = PTR(const uint16_t, AA_CLIP);
  if (!dir) return DECLINED;
  for (uint32_t k = 0; k < listCount; k++) {
    const uint32_t i = list[k];
    if (!active[i] || !playing[i]) continue;
    const uint32_t id = asset[i];
    if (id < nAssets && dir[id].kind == ASSET_JS) return DECLINED;
  }
  uint32_t ended = 0;
  for (uint32_t k = 0; k < listCount; k++) {
    const uint32_t i = list[k];
    if (!active[i] || !playing[i]) continue;
    const uint32_t id = asset[i];
    if (id >= nAssets || dir[id].kind != ASSET_IN) continue;
    const AdobeAsset *as = &dir[id];
    const uint32_t c = clip[i];
    const int32_t frameCount = c < as->clipCountLen ? (int32_t)AT(uint16_t, as->clipCount)[c] : 0;
    const double frameRate = c < as->clipRateLen ? (double)AT(float, as->clipRate)[c] : 0.0;
    if (frameCount <= 0 || frameRate <= 0.0) continue;
    const double duration = (double)frameCount / frameRate;
    const double nextTime = (double)time[i] + deltaSeconds * (double)rate[i];
    if (loop[i]) {
      time[i] = (float)(duration > 0.0 ? js_fmod(js_fmod(nextTime, duration) + duration, duration) : 0.0);
    } else if (nextTime >= duration) {
      time[i] = (float)duration;
      playing[i] = 0;
      list[ended++] = i;
    } else if (nextTime <= 0.0) {
      time[i] = 0.0f;
      playing[i] = 0;
      list[ended++] = i;
    } else {
      time[i] = (float)nextTime;
    }
  }
  return ended;
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
   shadow terms (_writeQueueShadow; not with F_NO_CASTERS, E-117). On a miss the full emit that follows rewrites every one of those, so
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
  const int shadows = qShadowH != 0 && (flags & F_NO_CASTERS) == 0;
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
