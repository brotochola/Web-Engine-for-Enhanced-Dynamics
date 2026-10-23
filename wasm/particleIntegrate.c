/* Particle integrate (E-76 W12, a candidate kernel): updateParticlePhysicsBuffers
   (src/util/particleIntegrate.js) for the active list, with its arithmetic: every input widened to
   double, every operation in double, each result stored at its column's type the way a typed-array
   store converts it (float32 rounding, ToUint16, ...). What JS does outside the loop stays in JS:
   ParticleEmitter.returnToPool for each index in the dead list (in the order JS would have called
   it), Math.cos / Math.sin for an angle past fdlibm's medium reduction (the trig list), and reading
   renderOnlyLive. Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>

#include "fdlibmSincos.h"

/* Column order of the table JS writes at columnsByte: one u32 byte offset per column. */
enum {
  ACTIVE, X, Y, Z, VX, VY, VZ, LIFESPAN, CURRENT_LIFE, GRAVITY, SCALE_X, SCALE_Y, ALPHA, TINT,
  BASE_TINT, TEXTURE_ID, ROT_C, ROT_S, FADE_ON_FLOOR, TIME_ON_FLOOR, INITIAL_ALPHA, STAY_ON_FLOOR,
  DESPAWN_ON_GROUND, TWEEN_MASK, EASE_ID, ALPHA_FROM, ALPHA_TO, SCALE_X_FROM, SCALE_X_TO,
  SCALE_Y_FROM, SCALE_Y_TO, TINT_FROM, TINT_TO, ROT_FROM, ROT_TO, ANG_FROM, ANG_TO, HAS_ANG,
  ANIM_COUNT, ANIM_MODE, ANIM_FRAMES, FLAT, RENDER_ONLY, COLUMN_COUNT
};

/* PARTICLE_TWEEN bits. */
#define TWEEN_ALPHA 1u
#define TWEEN_SCALEX 2u
#define TWEEN_SCALEY 4u
#define TWEEN_TINT 8u
#define TWEEN_ROT 16u

/* A Uint16Array store of v: ToUint16 (truncation, then the low 16 bits; NaN and +-Inf give 0). */
static inline uint16_t to_u16(double v) {
  if (!(v > -9.0e15 && v < 9.0e15)) return 0;
  return (uint16_t)(int64_t)v;
}

/* `v | 0` for the small finite values the tint lerp and frame index take; NaN gives 0. */
static inline int32_t to_i32(double v) {
  if (!(v > -2147483648.0 && v < 2147483648.0)) return 0;
  return (int32_t)v;
}

static inline double sample_lut(const float *lut, double t, uint32_t size) {
  const double x = t * (double)size;
  const int32_t i = (int32_t)x;
  const double f = x - i;
  return (double)lut[i] + ((double)lut[i + 1] - (double)lut[i]) * f;
}

/* applyParticleEase with applyRareEase (src/util/particleTween.js); the EXPO tables come from JS. */
static inline double apply_ease(double t, uint32_t easeId, const float *lut, uint32_t lutSize) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easeId) {
    case 0: return t;
    case 1: return t * t;
    case 2: return t * (2 - t);
    case 3: return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 4: return t * t * t;
    case 5: { const double u = t - 1; return u * u * u + 1; }
    case 6: {
      if (t < 0.5) return 4 * t * t * t;
      const double u = 2 * t - 2;
      return (t - 1) * u * u + 1;
    }
    case 7: return sample_lut(lut, t, lutSize);
    case 8: return sample_lut(lut + (lutSize + 1), t, lutSize);
    case 9: return sample_lut(lut + 2 * (lutSize + 1), t, lutSize);
    case 10: { const double s = 1.70158; return t * t * ((s + 1) * t - s); }
    case 11: { const double s = 1.70158; const double u = t - 1; return u * u * ((s + 1) * u + s) + 1; }
    case 12: {
      const double s = 1.70158 * 1.525;
      if (t < 0.5) { const double u = t * 2; return 0.5 * (u * u * ((s + 1) * u - s)); }
      const double u = t * 2 - 2;
      return 0.5 * (u * u * ((s + 1) * u + s) + 2);
    }
    case 13: {
      const double n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) { const double u = t - 1.5 / d1; return n1 * u * u + 0.75; }
      if (t < 2.5 / d1) { const double u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
      const double u = t - 2.625 / d1;
      return n1 * u * u + 0.984375;
    }
    default: return t;
  }
}

/* lerpRgb: each 0xRRGGBB channel lerped, rounded by `+ 0.5 | 0`, clamped to 0..255. */
static inline uint32_t lerp_rgb(uint32_t from, uint32_t to, double t) {
  const int32_t fr = (int32_t)((from >> 16) & 0xff), fg = (int32_t)((from >> 8) & 0xff), fb = (int32_t)(from & 0xff);
  const int32_t tr = (int32_t)((to >> 16) & 0xff), tg = (int32_t)((to >> 8) & 0xff), tb = (int32_t)(to & 0xff);
  int32_t r = to_i32(fr + (tr - fr) * t + 0.5);
  int32_t g = to_i32(fg + (tg - fg) * t + 0.5);
  int32_t b = to_i32(fb + (tb - fb) * t + 0.5);
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

#define COL(T, k) ((T *)(uintptr_t)cols[k])

__attribute__((export_name("integrate_batch")))
void integrate_batch(
    uint32_t columnsByte,    /* u32 per column, the enum's order */
    uint32_t indicesByte,    /* u16 active list */
    uint32_t count,
    double deltaTime,
    double dtRatio,
    uint32_t stampEnabled,   /* decalsEnabled && particlesToStamp */
    uint32_t skipRenderOnly, /* renderOnlyLive > 0 */
    uint32_t stampByte,      /* u16 out: stayOnTheFloor stamps */
    uint32_t flatByte,       /* u16 scratch */
    uint32_t heightedByte,   /* u16 scratch */
    uint32_t deadByte,       /* u16 out: returnToPool, in order */
    uint32_t trigByte,       /* u16 out: indices whose angle needs Math.cos / Math.sin */
    uint32_t trigAngleByte,  /* f64 out: those angles */
    uint32_t lutByte,        /* f32: EXPO_IN, EXPO_OUT, EXPO_INOUT, lutSize + 1 entries each */
    uint32_t lutSize,
    uint32_t resultsByte) {  /* i32 out: activeCount, stampedCount, deadCount, trigCount */
  const uint32_t *cols = (const uint32_t *)(uintptr_t)columnsByte;
  const uint16_t *indices = (const uint16_t *)(uintptr_t)indicesByte;
  uint8_t *active = COL(uint8_t, ACTIVE);
  float *x = COL(float, X), *y = COL(float, Y), *z = COL(float, Z);
  float *vx = COL(float, VX), *vy = COL(float, VY), *vz = COL(float, VZ);
  const uint16_t *lifespan = COL(uint16_t, LIFESPAN);
  uint16_t *currentLife = COL(uint16_t, CURRENT_LIFE);
  const float *gravity = COL(float, GRAVITY);
  float *scaleX = COL(float, SCALE_X), *scaleY = COL(float, SCALE_Y), *alpha = COL(float, ALPHA);
  uint32_t *tint = COL(uint32_t, TINT), *baseTint = COL(uint32_t, BASE_TINT);
  uint16_t *textureId = COL(uint16_t, TEXTURE_ID);
  float *rotC = COL(float, ROT_C), *rotS = COL(float, ROT_S);
  const uint16_t *fadeOnTheFloor = COL(uint16_t, FADE_ON_FLOOR);
  uint16_t *timeOnFloor = COL(uint16_t, TIME_ON_FLOOR);
  float *initialAlpha = COL(float, INITIAL_ALPHA);
  const uint8_t *stayOnTheFloor = COL(uint8_t, STAY_ON_FLOOR);
  const uint8_t *despawnOnGroundContact = COL(uint8_t, DESPAWN_ON_GROUND);
  const uint16_t *tweenMask = COL(uint16_t, TWEEN_MASK);
  const uint8_t *easeId = COL(uint8_t, EASE_ID);
  const float *alphaFrom = COL(float, ALPHA_FROM), *alphaTo = COL(float, ALPHA_TO);
  const float *scaleXFrom = COL(float, SCALE_X_FROM), *scaleXTo = COL(float, SCALE_X_TO);
  const float *scaleYFrom = COL(float, SCALE_Y_FROM), *scaleYTo = COL(float, SCALE_Y_TO);
  const uint32_t *tintFrom = COL(uint32_t, TINT_FROM), *tintTo = COL(uint32_t, TINT_TO);
  const float *rotFrom = COL(float, ROT_FROM), *rotTo = COL(float, ROT_TO);
  const float *angFrom = COL(float, ANG_FROM), *angTo = COL(float, ANG_TO);
  const uint8_t *hasAngularVel = COL(uint8_t, HAS_ANG);
  const uint8_t *animCount = COL(uint8_t, ANIM_COUNT), *animMode = COL(uint8_t, ANIM_MODE);
  const uint16_t *animFrames = COL(uint16_t, ANIM_FRAMES);
  const uint8_t *flat = COL(uint8_t, FLAT);
  const uint8_t *renderOnly = COL(uint8_t, RENDER_ONLY);
  uint16_t *stamp = (uint16_t *)(uintptr_t)stampByte;
  uint16_t *flatList = (uint16_t *)(uintptr_t)flatByte;
  uint16_t *heightedList = (uint16_t *)(uintptr_t)heightedByte;
  uint16_t *dead = (uint16_t *)(uintptr_t)deadByte;
  uint16_t *trig = (uint16_t *)(uintptr_t)trigByte;
  double *trigAngle = (double *)(uintptr_t)trigAngleByte;
  const float *lut = (const float *)(uintptr_t)lutByte;
  int32_t *results = (int32_t *)(uintptr_t)resultsByte;

  uint32_t flatCount = 0, heightedCount = 0, stampedCount = 0, deadCount = 0, trigCount = 0;

  for (uint32_t idx = 0; idx < count; idx++) {
    const uint32_t i = indices[idx];
    const uint16_t life = to_u16((double)currentLife[i] + deltaTime);
    currentLife[i] = life;
    if (lifespan[i] > 0 && life >= lifespan[i]) {
      active[i] = 0;
      dead[deadCount++] = (uint16_t)i;
      continue;
    }
    if (skipRenderOnly && renderOnly[i]) continue;

    const uint32_t mask = tweenMask[i];
    const int spinning = hasAngularVel[i] != 0;
    const int cycling = animMode[i] != 0;
    if (mask || spinning || cycling) {
      const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
      const double eased = mask || spinning ? apply_ease(lifeProgress, easeId[i], lut, lutSize) : lifeProgress;
      if (mask & TWEEN_ALPHA) alpha[i] = (float)((double)alphaFrom[i] + ((double)alphaTo[i] - (double)alphaFrom[i]) * eased);
      if (mask & TWEEN_SCALEX) scaleX[i] = (float)((double)scaleXFrom[i] + ((double)scaleXTo[i] - (double)scaleXFrom[i]) * eased);
      if (mask & TWEEN_SCALEY) scaleY[i] = (float)((double)scaleYFrom[i] + ((double)scaleYTo[i] - (double)scaleYFrom[i]) * eased);
      if (mask & TWEEN_TINT) {
        const uint32_t c = lerp_rgb(tintFrom[i], tintTo[i], eased);
        tint[i] = c;
        baseTint[i] = c;
      }
      double angle = (double)rotFrom[i];
      if (mask & TWEEN_ROT) angle = (double)rotFrom[i] + ((double)rotTo[i] - (double)rotFrom[i]) * eased;
      if (spinning) {
        const double av = (double)angFrom[i] + ((double)angTo[i] - (double)angFrom[i]) * eased;
        angle += av * (double)currentLife[i];
      }
      if ((mask & TWEEN_ROT) || spinning) {
        double s, c;
        if (weed_sincos(angle, &s, &c)) {
          rotC[i] = (float)c;
          rotS[i] = (float)s;
        } else {
          trig[trigCount] = (uint16_t)i;
          trigAngle[trigCount] = angle;
          trigCount++;
        }
      }
      if (cycling && animMode[i] == 1 && animCount[i] > 0) {
        const int32_t n = animCount[i];
        int32_t fi = to_i32(lifeProgress * n);
        if (fi >= n) fi = n - 1;
        textureId[i] = animFrames[i * 8u + (uint32_t)fi];
      }
    }
    if (flat[i]) flatList[flatCount++] = (uint16_t)i;
    else heightedList[heightedCount++] = (uint16_t)i;
  }

  /* Flat pass: XY + gravity on vy. */
  for (uint32_t k = 0; k < flatCount; k++) {
    const uint32_t i = flatList[k];
    vy[i] = (float)((double)vy[i] + (double)gravity[i] * dtRatio);
    x[i] = (float)((double)x[i] + (double)vx[i] * dtRatio);
    y[i] = (float)((double)y[i] + (double)vy[i] * dtRatio);
  }

  /* Heighted pass: gravity + air / ground / floor fade / despawn. */
  uint32_t survivors = 0;
  for (uint32_t k = 0; k < heightedCount; k++) {
    const uint32_t i = heightedList[k];
    vz[i] = (float)((double)vz[i] + (double)gravity[i] * dtRatio);
    if (z[i] < 0) {
      x[i] = (float)((double)x[i] + (double)vx[i] * dtRatio);
      y[i] = (float)((double)y[i] + (double)vy[i] * dtRatio);
      z[i] = (float)((double)z[i] + (double)vz[i] * dtRatio);
      survivors++;
      continue;
    }
    z[i] = 0;
    vx[i] = 0;
    vy[i] = 0;
    vz[i] = 0;
    if (despawnOnGroundContact[i]) {
      active[i] = 0;
      dead[deadCount++] = (uint16_t)i;
      continue;
    }
    if (stayOnTheFloor[i]) {
      active[i] = 0;
      if (stampEnabled) stamp[stampedCount++] = (uint16_t)i;
      else dead[deadCount++] = (uint16_t)i;
      continue;
    }
    if (fadeOnTheFloor[i] > 0) {
      if (timeOnFloor[i] == 0) initialAlpha[i] = alpha[i];
      const uint16_t onFloor = to_u16((double)timeOnFloor[i] + deltaTime);
      timeOnFloor[i] = onFloor;
      double fadeProgress = (double)onFloor / (double)fadeOnTheFloor[i];
      if (fadeProgress > 1) fadeProgress = 1;
      alpha[i] = (float)((double)initialAlpha[i] * (1 - fadeProgress));
      if (alpha[i] <= 0) {
        active[i] = 0;
        dead[deadCount++] = (uint16_t)i;
        continue;
      }
    }
    survivors++;
  }

  results[0] = (int32_t)(flatCount + survivors);
  results[1] = (int32_t)stampedCount;
  results[2] = (int32_t)deadCount;
  results[3] = (int32_t)trigCount;
}
