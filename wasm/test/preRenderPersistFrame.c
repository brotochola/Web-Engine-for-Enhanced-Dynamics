/* E-116 and E-117, kernel variants of W4c's persist path (a test module): the shipped preRenderEmit.c and
   one more export, persist_frame, which is persist_check and persist_poses in one walk.

   persist_poses' pose writes (the rotation of a sprite drawn with its own facing, the sort key, the shadow
   terms) go out as the walk checks each row: on a miss the full emit that follows rewrites every one of
   them, so the final state is the two-call path's. Only the animation clocks, which that full emit would
   advance a second time, wait until the walk has passed every row: the animated sprites' rows are listed
   in R_FOREIGN (unused on a persist frame) and advanced in row order after it, as persist_poses advances
   them after persist_check's repairs.

   F_NO_CASTERS (E-117): the scene has no ShadowCaster, so every sprite row's shadow terms are the zeros
   the full emit wrote when this buffer last held these rows; the walk leaves them.

   Returns PERSIST_MISS or the rows of other types; R_COUNTS gets [play-once ends, frames moved, repairs]. */
#include "../preRenderEmit.c"

#define F_NO_CASTERS 16u

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
  const int inQueue = stX == qX;
  const uint32_t n = count < maxItems ? count : maxItems;
  uint32_t others = count - n;
  uint32_t repaired = 0;
  uint32_t nAnimated = 0;
  for (uint32_t i = 0; i < n; i++) {
    const uint32_t ty = cType[i];
    const int32_t idx = cIndex[i];
    /* persist_check */
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
    /* persist_poses' writes that a full emit would make again */
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

  /* Every row passed: the clocks, in row order (persist_poses' _advancePersistFrame). */
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
    pFrame[i] = (uint16_t)frame;
    if (bounds) {
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
