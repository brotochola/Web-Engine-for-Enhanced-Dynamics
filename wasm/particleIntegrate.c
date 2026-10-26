/* Particle integrate (E-76 W12, a candidate kernel): updateParticlePhysicsBuffers
   (src/util/particleIntegrate.js) for the active list, with its arithmetic: every input widened to
   double, every operation in double, each result stored at its column's type the way a typed-array
   store converts it (float32 rounding, ToUint16, ...). What JS does outside the loop stays in JS:
   ParticleEmitter.returnToPool for each index in the dead list (in the order JS would have called
   it), Math.cos / Math.sin for an angle past fdlibm's medium reduction (the trig list), and reading
   renderOnlyLive. Pointers are byte offsets into the imported shared memory. integrate_batch_f32x4, at
   the end, is the same integrate in float32 where a stated tolerance allows it. */
#include <stdint.h>
#include <wasm_simd128.h>

#include "fdlibmSincos.h"

/* Column order of the table JS writes at columnsByte: one u32 byte offset per column. */
enum {
  ACTIVE, X, Y, Z, VX, VY, VZ, LIFESPAN, CURRENT_LIFE, GRAVITY, SCALE_X, SCALE_Y, ALPHA, TINT,
  BASE_TINT, TEXTURE_ID, ROT_C, ROT_S, FADE_ON_FLOOR, TIME_ON_FLOOR, INITIAL_ALPHA, STAY_ON_FLOOR,
  DESPAWN_ON_GROUND, TWEEN_MASK, EASE_ID, ALPHA_FROM, ALPHA_TO, SCALE_X_FROM, SCALE_X_TO,
  SCALE_Y_FROM, SCALE_Y_TO, TINT_FROM, TINT_TO, ROT_FROM, ROT_TO, ANG_FROM, ANG_TO, HAS_ANG,
  ANIM_COUNT, ANIM_MODE, ANIM_FRAMES, FLAT, RENDER_ONLY, BOUNCES, BOUNCINESS, BOUNCE_FRICTION,
  COLUMN_COUNT
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
  uint8_t *bounces = COL(uint8_t, BOUNCES);
  const float *bounciness = COL(float, BOUNCINESS), *bounceFriction = COL(float, BOUNCE_FRICTION);
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

  /* Heighted pass: gravity + air / ground (bounce) / floor fade / despawn. */
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
    if (bounces[i] > 0 && vz[i] > 0) {
      /* Floor bounce: the rebound must beat two frames of gravity (0.05 px/frame when gravity is
         tiny), or the particle lands as it would without bounces. */
      const double rebound = (double)vz[i] * (double)bounciness[i];
      const double g = (double)gravity[i];
      const double minRebound = g > 0.025 ? g * 2 : 0.05;
      if (rebound > minRebound) {
        bounces[i] = (uint8_t)(bounces[i] - 1u);
        const double keep = (double)bounceFriction[i];
        vx[i] = (float)((double)vx[i] * keep);
        vy[i] = (float)((double)vy[i] * keep);
        vz[i] = (float)(-rebound);
        x[i] = (float)((double)x[i] + (double)vx[i] * dtRatio);
        y[i] = (float)((double)y[i] + (double)vy[i] * dtRatio);
        z[i] = (float)((double)vz[i] * dtRatio);
        survivors++;
        continue;
      }
      bounces[i] = 0;
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

/* The float32 integrate (E-76 W12, the float32 pass; the client binds it when wasm.particleIntegrateF32 is
   on): integrate_batch_f32x4 takes integrate_batch's arguments and keeps its memory contract: the same column
   table, lists, scratch and outputs, and the same JS work after the call (the dead list back to the pool in
   order, Math.cos / Math.sin for the trig list). What changes is the arithmetic, within the tolerance
   tests/node/particleIntegrateF32.test.js states:

   - Integers stay exact: currentLife and timeOnFloor (a double sum and ToUint16, as JS), every death, the
     dead, stamp and trig lists, the animation frame (from lifeProgress in double).
   - Positions and velocities in float32, dtRatio rounded to float once per call. With a dtRatio of 1 every
     sum is the double sum rounded once, so bit-identical to integrate_batch.
   - Alpha, scale and tint lerps in float32, and the floor fade. The ease in float32 for a particle that does
     not rotate.
   - A rotating particle (a rotation tween or an angular velocity) keeps lifeProgress, the ease and its angle
     in double, as integrate_batch: `angle += av * currentLife` multiplies an error in the ease by up to
     65 535 ms (the spin case reaches 3e4 rad). Its sine and cosine: x - n * pi/2 in double (fdlibm's first
     medium round, good to about 85 bits), then float polynomials of degree 7 and 8 (Cephes sinf / cosf) on
     the reduced argument, where fdlibm takes degree 13 and 14 in double and up to three reduction rounds.
     The angles integrate_batch sends to the trig list (|x| from 2^20 * pi/2) go there here too.

   Four particles per vector where the loop allows it:
   - the flat and heighted passes take four list entries at once when they are four consecutive slots (the
     active list is in slot order, and a dense pool is mostly runs) and, heighted, all four are in the air;
     anything else takes the scalar step for one entry, with the same float operations;
   - the first loop stays scalar (a gather with a branch per tween bit, an ease per particle and deaths in
     list order), but it only stages a rotating particle: its index and angle go into the trig and trigAngle
     regions from the top (count - 1 down; the trig list grows from 0 and the two hold at most count
     entries together), and after the loop the staged angles take the reduction in f64x2 and the
     polynomials in f32x4, four at a time. Entries of trig and trigAngle past the trig count are scratch.
   Its helpers are its own (always inlined), so integrate_batch compiles as it did without it. */
#define INLINE static inline __attribute__((always_inline))

/* fdlibm's __rem_pio2 constants: pio2_1 has 33 bits, so n * pio2_1 is exact for |n| < 2^20. */
#define INVPIO2 6.36619772367581382433e-01
#define PIO2_1 1.57079632673412561417e+00
#define PIO2_1T 6.07710050650619224932e-11
/* Cephes sinf and cosf on [-pi/4, pi/4]. */
#define SIN_C1 (-1.6666654611e-1f)
#define SIN_C2 8.3321608736e-3f
#define SIN_C3 (-1.9515295891e-4f)
#define COS_C1 4.166664568298827e-2f
#define COS_C2 (-1.388731625493765e-3f)
#define COS_C3 2.443315711809948e-5f

/* A Uint16Array store of v: ToUint16 (truncation, then the low 16 bits; NaN and +-Inf give 0). */
INLINE uint16_t to_u16_x4(double v) {
  if (!(v > -9.0e15 && v < 9.0e15)) return 0;
  return (uint16_t)(int64_t)v;
}

/* `v | 0` for the small finite values the frame index takes; NaN gives 0. */
INLINE int32_t to_i32_x4(double v) {
  if (!(v > -2147483648.0 && v < 2147483648.0)) return 0;
  return (int32_t)v;
}

INLINE int32_t to_i32f(float v) {
  if (!(v > -2147483648.0f && v < 2147483648.0f)) return 0;
  return (int32_t)v;
}

INLINE uint32_t hi_bits(double x) {
  union { double f; uint64_t i; } u;
  u.f = x;
  return (uint32_t)(u.i >> 32) & 0x7fffffffu;
}

/* integrate_batch's ease, in double: for rotating particles. */
INLINE double sample_lut_x4(const float *lut, double t, uint32_t size) {
  const double x = t * (double)size;
  const int32_t i = (int32_t)x;
  const double f = x - i;
  return (double)lut[i] + ((double)lut[i + 1] - (double)lut[i]) * f;
}

INLINE double ease_f64(double t, uint32_t easeId, const float *lut, uint32_t lutSize) {
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
    case 7: return sample_lut_x4(lut, t, lutSize);
    case 8: return sample_lut_x4(lut + (lutSize + 1), t, lutSize);
    case 9: return sample_lut_x4(lut + 2 * (lutSize + 1), t, lutSize);
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

/* The same eases in float32. t * size can round up to size in float: the last interval takes it. */
INLINE float sample_lut_f32(const float *lut, float t, uint32_t size) {
  const float x = t * (float)size;
  int32_t i = (int32_t)x;
  if (i >= (int32_t)size) i = (int32_t)size - 1;
  const float f = x - (float)i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

INLINE float ease_f32(float t, uint32_t easeId, const float *lut, uint32_t lutSize) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easeId) {
    case 0: return t;
    case 1: return t * t;
    case 2: return t * (2 - t);
    case 3: return t < 0.5f ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 4: return t * t * t;
    case 5: { const float u = t - 1; return u * u * u + 1; }
    case 6: {
      if (t < 0.5f) return 4 * t * t * t;
      const float u = 2 * t - 2;
      return (t - 1) * u * u + 1;
    }
    case 7: return sample_lut_f32(lut, t, lutSize);
    case 8: return sample_lut_f32(lut + (lutSize + 1), t, lutSize);
    case 9: return sample_lut_f32(lut + 2 * (lutSize + 1), t, lutSize);
    case 10: { const float s = 1.70158f; return t * t * ((s + 1) * t - s); }
    case 11: { const float s = 1.70158f; const float u = t - 1; return u * u * ((s + 1) * u + s) + 1; }
    case 12: {
      const float s = (float)(1.70158 * 1.525);
      if (t < 0.5f) { const float u = t * 2; return 0.5f * (u * u * ((s + 1) * u - s)); }
      const float u = t * 2 - 2;
      return 0.5f * (u * u * ((s + 1) * u + s) + 2);
    }
    case 13: {
      const float n1 = 7.5625f;
      if (t < (float)(1 / 2.75)) return n1 * t * t;
      if (t < (float)(2 / 2.75)) { const float u = t - (float)(1.5 / 2.75); return n1 * u * u + 0.75f; }
      if (t < (float)(2.5 / 2.75)) { const float u = t - (float)(2.25 / 2.75); return n1 * u * u + 0.9375f; }
      const float u = t - (float)(2.625 / 2.75);
      return n1 * u * u + 0.984375f;
    }
    default: return t;
  }
}

/* lerpRgb in float32: each 0xRRGGBB channel lerped, rounded by `+ 0.5 | 0`, clamped to 0..255. */
INLINE uint32_t lerp_rgb_f32(uint32_t from, uint32_t to, float t) {
  const int32_t fr = (int32_t)((from >> 16) & 0xff), fg = (int32_t)((from >> 8) & 0xff), fb = (int32_t)(from & 0xff);
  const int32_t tr = (int32_t)((to >> 16) & 0xff), tg = (int32_t)((to >> 8) & 0xff), tb = (int32_t)(to & 0xff);
  int32_t r = to_i32f((float)fr + (float)(tr - fr) * t + 0.5f);
  int32_t g = to_i32f((float)fg + (float)(tg - fg) * t + 0.5f);
  int32_t b = to_i32f((float)fb + (float)(tb - fb) * t + 0.5f);
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

/* The sine and cosine polynomials on a reduced argument r, and the quadrant n. */
INLINE void sincos_poly(float r, int32_t n, float *s, float *c) {
  const float z = r * r;
  const float sp = ((SIN_C3 * z + SIN_C2) * z + SIN_C1) * z * r + r;
  const float cp = ((COS_C3 * z + COS_C2) * z + COS_C1) * z * z - 0.5f * z + 1.0f;
  switch (n & 3) {
    case 0: *s = sp; *c = cp; break;
    case 1: *s = cp; *c = -sp; break;
    case 2: *s = -sp; *c = -cp; break;
    default: *s = -cp; *c = sp; break;
  }
}

/* x = n * pi/2 + y for a finite |x| < 2^20 * pi/2: fdlibm's first medium round. */
INLINE void reduce(double x, float *r, int32_t *n) {
  const double fn = __builtin_rint(x * INVPIO2);
  *r = (float)((x - fn * PIO2_1) - fn * PIO2_1T);
  *n = (int32_t)fn;
}

/* sin and cos of x in float; 0 for an angle integrate_batch sends to the trig list. */
INLINE int sincos_f32(double x, float *s, float *c) {
  const uint32_t ix = hi_bits(x);
  if (ix >= 0x7ff00000u) {          /* Inf or NaN */
    *s = *c = (float)(x - x);
    return 1;
  }
  if (ix >= 0x413921fbu) return 0;  /* the large reduction: the caller's fallback */
  float r;
  int32_t n;
  reduce(x, &r, &n);
  sincos_poly(r, n, s, c);
  return 1;
}

/* Four staged angles (two f64x2) to their sines and cosines, the same operations as sincos_f32. */
INLINE void sincos4(v128_t a01, v128_t a23, v128_t *s, v128_t *c) {
  const v128_t inv = wasm_f64x2_splat(INVPIO2), p1 = wasm_f64x2_splat(PIO2_1), p1t = wasm_f64x2_splat(PIO2_1T);
  const v128_t fn01 = wasm_f64x2_nearest(wasm_f64x2_mul(a01, inv));
  const v128_t fn23 = wasm_f64x2_nearest(wasm_f64x2_mul(a23, inv));
  const v128_t y01 = wasm_f64x2_sub(wasm_f64x2_sub(a01, wasm_f64x2_mul(fn01, p1)), wasm_f64x2_mul(fn01, p1t));
  const v128_t y23 = wasm_f64x2_sub(wasm_f64x2_sub(a23, wasm_f64x2_mul(fn23, p1)), wasm_f64x2_mul(fn23, p1t));
  const v128_t n = wasm_i32x4_shuffle(wasm_i32x4_trunc_sat_f64x2_zero(fn01), wasm_i32x4_trunc_sat_f64x2_zero(fn23), 0, 1, 4, 5);
  const v128_t r = wasm_i32x4_shuffle(wasm_f32x4_demote_f64x2_zero(y01), wasm_f32x4_demote_f64x2_zero(y23), 0, 1, 4, 5);
  const v128_t z = wasm_f32x4_mul(r, r);
  v128_t sp = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(SIN_C3), z), wasm_f32x4_splat(SIN_C2));
  sp = wasm_f32x4_add(wasm_f32x4_mul(sp, z), wasm_f32x4_splat(SIN_C1));
  sp = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_mul(sp, z), r), r);
  v128_t cp = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(COS_C3), z), wasm_f32x4_splat(COS_C2));
  cp = wasm_f32x4_add(wasm_f32x4_mul(cp, z), wasm_f32x4_splat(COS_C1));
  cp = wasm_f32x4_sub(wasm_f32x4_mul(wasm_f32x4_mul(cp, z), z), wasm_f32x4_mul(wasm_f32x4_splat(0.5f), z));
  cp = wasm_f32x4_add(cp, wasm_f32x4_splat(1.0f));
  /* Quadrant 1 and 3 swap the two; 2 and 3 negate the sine, 1 and 2 the cosine. */
  const v128_t one = wasm_i32x4_splat(1), two = wasm_i32x4_splat(2);
  const v128_t swap = wasm_i32x4_ne(wasm_v128_and(n, one), wasm_i32x4_splat(0));
  const v128_t sv = wasm_v128_bitselect(cp, sp, swap);
  const v128_t cv = wasm_v128_bitselect(sp, cp, swap);
  *s = wasm_v128_xor(sv, wasm_i32x4_shl(wasm_v128_and(n, two), 30));
  *c = wasm_v128_xor(cv, wasm_i32x4_shl(wasm_v128_and(wasm_i32x4_add(n, one), two), 30));
}

/* Four entries of a u16 list from k that are four consecutive slots. */
INLINE int run_of_four(const uint16_t *list, uint32_t k) {
  const v128_t got = wasm_v128_load64_zero(list + k);
  const v128_t want = wasm_i16x8_add(wasm_i16x8_splat((int16_t)list[k]), wasm_i16x8_make(0, 1, 2, 3, 0, 0, 0, 0));
  return (wasm_i16x8_bitmask(wasm_i16x8_eq(got, want)) & 0xfu) == 0xfu;
}

/* integrate_batch with the float32 arithmetic above. */
__attribute__((export_name("integrate_batch_f32x4")))
void integrate_batch_f32x4(
    uint32_t columnsByte, uint32_t indicesByte, uint32_t count, double deltaTime, double dtRatio,
    uint32_t stampEnabled, uint32_t skipRenderOnly, uint32_t stampByte, uint32_t flatByte,
    uint32_t heightedByte, uint32_t deadByte, uint32_t trigByte, uint32_t trigAngleByte, uint32_t lutByte,
    uint32_t lutSize, uint32_t resultsByte) {
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
  uint8_t *bounces = COL(uint8_t, BOUNCES);
  const float *bounciness = COL(float, BOUNCINESS), *bounceFriction = COL(float, BOUNCE_FRICTION);
  uint16_t *stamp = (uint16_t *)(uintptr_t)stampByte;
  uint16_t *flatList = (uint16_t *)(uintptr_t)flatByte;
  uint16_t *heightedList = (uint16_t *)(uintptr_t)heightedByte;
  uint16_t *dead = (uint16_t *)(uintptr_t)deadByte;
  uint16_t *trig = (uint16_t *)(uintptr_t)trigByte;
  double *trigAngle = (double *)(uintptr_t)trigAngleByte;
  const float *lut = (const float *)(uintptr_t)lutByte;
  int32_t *results = (int32_t *)(uintptr_t)resultsByte;
  const float dt = (float)dtRatio;

  uint32_t flatCount = 0, heightedCount = 0, stampedCount = 0, deadCount = 0, trigCount = 0;
  uint32_t staged = count; /* the staged rotations are trig[staged, count) */

  for (uint32_t idx = 0; idx < count; idx++) {
    const uint32_t i = indices[idx];
    const uint16_t life = to_u16_x4((double)currentLife[i] + deltaTime);
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
      const int rotates = (mask & TWEEN_ROT) || spinning;
      double eased = 0;
      float easedF;
      if (rotates) {
        const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
        eased = ease_f64(lifeProgress, easeId[i], lut, lutSize);
        easedF = (float)eased;
      } else {
        const float lifeProgress = lifespan[i] > 0 ? (float)life / (float)lifespan[i] : 1.0f;
        easedF = mask ? ease_f32(lifeProgress, easeId[i], lut, lutSize) : lifeProgress;
      }
      if (mask & TWEEN_ALPHA) alpha[i] = alphaFrom[i] + (alphaTo[i] - alphaFrom[i]) * easedF;
      if (mask & TWEEN_SCALEX) scaleX[i] = scaleXFrom[i] + (scaleXTo[i] - scaleXFrom[i]) * easedF;
      if (mask & TWEEN_SCALEY) scaleY[i] = scaleYFrom[i] + (scaleYTo[i] - scaleYFrom[i]) * easedF;
      if (mask & TWEEN_TINT) {
        const uint32_t c = lerp_rgb_f32(tintFrom[i], tintTo[i], easedF);
        tint[i] = c;
        baseTint[i] = c;
      }
      if (rotates) {
        double angle = (double)rotFrom[i];
        if (mask & TWEEN_ROT) angle = (double)rotFrom[i] + ((double)rotTo[i] - (double)rotFrom[i]) * eased;
        if (spinning) {
          const double av = (double)angFrom[i] + ((double)angTo[i] - (double)angFrom[i]) * eased;
          angle += av * (double)currentLife[i];
        }
        const uint32_t ix = hi_bits(angle);
        if (ix < 0x413921fbu) {
          staged--;
          trig[staged] = (uint16_t)i;
          trigAngle[staged] = angle;
        } else {
          float s, c;
          if (sincos_f32(angle, &s, &c)) {
            rotC[i] = c;
            rotS[i] = s;
          } else {
            trig[trigCount] = (uint16_t)i;
            trigAngle[trigCount] = angle;
            trigCount++;
          }
        }
      }
      if (cycling && animMode[i] == 1 && animCount[i] > 0) {
        const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
        const int32_t n = animCount[i];
        int32_t fi = to_i32_x4(lifeProgress * n);
        if (fi >= n) fi = n - 1;
        textureId[i] = animFrames[i * 8u + (uint32_t)fi];
      }
    }
    if (flat[i]) flatList[flatCount++] = (uint16_t)i;
    else heightedList[heightedCount++] = (uint16_t)i;
  }

  /* The staged rotations, four at a time, then the rest one by one. */
  uint32_t e = staged;
  for (; e + 4 <= count; e += 4) {
    v128_t s, c;
    sincos4(wasm_v128_load(trigAngle + e), wasm_v128_load(trigAngle + e + 2), &s, &c);
    const uint32_t i0 = trig[e], i1 = trig[e + 1], i2 = trig[e + 2], i3 = trig[e + 3];
    rotC[i0] = wasm_f32x4_extract_lane(c, 0);
    rotS[i0] = wasm_f32x4_extract_lane(s, 0);
    rotC[i1] = wasm_f32x4_extract_lane(c, 1);
    rotS[i1] = wasm_f32x4_extract_lane(s, 1);
    rotC[i2] = wasm_f32x4_extract_lane(c, 2);
    rotS[i2] = wasm_f32x4_extract_lane(s, 2);
    rotC[i3] = wasm_f32x4_extract_lane(c, 3);
    rotS[i3] = wasm_f32x4_extract_lane(s, 3);
  }
  for (; e < count; e++) {
    float s, c;
    sincos_f32(trigAngle[e], &s, &c);
    rotC[trig[e]] = c;
    rotS[trig[e]] = s;
  }

  /* Flat pass: XY + gravity on vy. */
  const v128_t dt4 = wasm_f32x4_splat(dt);
  for (uint32_t k = 0; k < flatCount;) {
    if (k + 4 <= flatCount && run_of_four(flatList, k)) {
      const uint32_t i = flatList[k];
      const v128_t vy4 = wasm_f32x4_add(wasm_v128_load(vy + i), wasm_f32x4_mul(wasm_v128_load(gravity + i), dt4));
      wasm_v128_store(vy + i, vy4);
      wasm_v128_store(x + i, wasm_f32x4_add(wasm_v128_load(x + i), wasm_f32x4_mul(wasm_v128_load(vx + i), dt4)));
      wasm_v128_store(y + i, wasm_f32x4_add(wasm_v128_load(y + i), wasm_f32x4_mul(vy4, dt4)));
      k += 4;
      continue;
    }
    const uint32_t i = flatList[k++];
    vy[i] = vy[i] + gravity[i] * dt;
    x[i] = x[i] + vx[i] * dt;
    y[i] = y[i] + vy[i] * dt;
  }

  /* Heighted pass: gravity + air / ground (bounce) / floor fade / despawn. */
  uint32_t survivors = 0;
  for (uint32_t k = 0; k < heightedCount;) {
    if (k + 4 <= heightedCount && run_of_four(heightedList, k)) {
      const uint32_t i = heightedList[k];
      const v128_t z4 = wasm_v128_load(z + i);
      if (wasm_i32x4_all_true(wasm_f32x4_lt(z4, wasm_f32x4_splat(0.0f)))) {
        const v128_t vz4 = wasm_f32x4_add(wasm_v128_load(vz + i), wasm_f32x4_mul(wasm_v128_load(gravity + i), dt4));
        wasm_v128_store(vz + i, vz4);
        wasm_v128_store(x + i, wasm_f32x4_add(wasm_v128_load(x + i), wasm_f32x4_mul(wasm_v128_load(vx + i), dt4)));
        wasm_v128_store(y + i, wasm_f32x4_add(wasm_v128_load(y + i), wasm_f32x4_mul(wasm_v128_load(vy + i), dt4)));
        wasm_v128_store(z + i, wasm_f32x4_add(z4, wasm_f32x4_mul(vz4, dt4)));
        survivors += 4;
        k += 4;
        continue;
      }
    }
    const uint32_t i = heightedList[k++];
    vz[i] = vz[i] + gravity[i] * dt;
    if (z[i] < 0) {
      x[i] = x[i] + vx[i] * dt;
      y[i] = y[i] + vy[i] * dt;
      z[i] = z[i] + vz[i] * dt;
      survivors++;
      continue;
    }
    if (bounces[i] > 0 && vz[i] > 0) {
      /* integrate_batch's floor bounce. The decision in double, as there, so both bounce on the same frame;
         a float32 product of two floats is the double one rounded once. */
      const double rebound = (double)vz[i] * (double)bounciness[i];
      const double g = (double)gravity[i];
      const double minRebound = g > 0.025 ? g * 2 : 0.05;
      if (rebound > minRebound) {
        bounces[i] = (uint8_t)(bounces[i] - 1u);
        const float keep = bounceFriction[i];
        vx[i] = vx[i] * keep;
        vy[i] = vy[i] * keep;
        vz[i] = (float)(-rebound);
        x[i] = x[i] + vx[i] * dt;
        y[i] = y[i] + vy[i] * dt;
        z[i] = vz[i] * dt;
        survivors++;
        continue;
      }
      bounces[i] = 0;
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
      const uint16_t onFloor = to_u16_x4((double)timeOnFloor[i] + deltaTime);
      timeOnFloor[i] = onFloor;
      float fadeProgress = (float)onFloor / (float)fadeOnTheFloor[i];
      if (fadeProgress > 1) fadeProgress = 1;
      alpha[i] = initialAlpha[i] * (1 - fadeProgress);
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

/* E-129: the same integrates for a pool past 65 535 slots, whose lists are u32 (the particle memory lays the
   active list, the stamp, dead and trig lists and the flat and heighted scratch out at 4 bytes a slot; the
   client binds these exports when it does). Copies of integrate_batch and integrate_batch_f32x4 with the slot
   lists widened: the same arithmetic, the same writes, each list entry a uint32. The u16 columns (lifetimes,
   floor times, texture ids, tween masks, animation frames) are not slot ids and stay u16. integrate_batch_u32
   takes the always-inlined helpers of the float32 section (to_u16_x4, to_i32_x4 and ease_f64, the same
   functions as to_u16, to_i32 and apply_ease), so integrate_batch's own helpers keep one caller and it
   compiles as it did. */

/* lerp_rgb, always inlined. */
INLINE uint32_t lerp_rgb_x4(uint32_t from, uint32_t to, double t) {
  const int32_t fr = (int32_t)((from >> 16) & 0xff), fg = (int32_t)((from >> 8) & 0xff), fb = (int32_t)(from & 0xff);
  const int32_t tr = (int32_t)((to >> 16) & 0xff), tg = (int32_t)((to >> 8) & 0xff), tb = (int32_t)(to & 0xff);
  int32_t r = to_i32_x4(fr + (tr - fr) * t + 0.5);
  int32_t g = to_i32_x4(fg + (tg - fg) * t + 0.5);
  int32_t b = to_i32_x4(fb + (tb - fb) * t + 0.5);
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

/* Four entries of a u32 list from k that are four consecutive slots. */
INLINE int run_of_four_u32(const uint32_t *list, uint32_t k) {
  const v128_t got = wasm_v128_load(list + k);
  const v128_t want = wasm_i32x4_add(wasm_i32x4_splat((int32_t)list[k]), wasm_i32x4_make(0, 1, 2, 3));
  return wasm_i32x4_all_true(wasm_i32x4_eq(got, want));
}

/* integrate_batch on u32 slot lists. */
__attribute__((export_name("integrate_batch_u32")))
void integrate_batch_u32(
    uint32_t columnsByte,    /* u32 per column, the enum's order */
    uint32_t indicesByte,    /* u32 active list */
    uint32_t count,
    double deltaTime,
    double dtRatio,
    uint32_t stampEnabled,   /* decalsEnabled && particlesToStamp */
    uint32_t skipRenderOnly, /* renderOnlyLive > 0 */
    uint32_t stampByte,      /* u32 out: stayOnTheFloor stamps */
    uint32_t flatByte,       /* u32 scratch */
    uint32_t heightedByte,   /* u32 scratch */
    uint32_t deadByte,       /* u32 out: returnToPool, in order */
    uint32_t trigByte,       /* u32 out: indices whose angle needs Math.cos / Math.sin */
    uint32_t trigAngleByte,  /* f64 out: those angles */
    uint32_t lutByte,        /* f32: EXPO_IN, EXPO_OUT, EXPO_INOUT, lutSize + 1 entries each */
    uint32_t lutSize,
    uint32_t resultsByte) {  /* i32 out: activeCount, stampedCount, deadCount, trigCount */
  const uint32_t *cols = (const uint32_t *)(uintptr_t)columnsByte;
  const uint32_t *indices = (const uint32_t *)(uintptr_t)indicesByte;
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
  uint8_t *bounces = COL(uint8_t, BOUNCES);
  const float *bounciness = COL(float, BOUNCINESS), *bounceFriction = COL(float, BOUNCE_FRICTION);
  uint32_t *stamp = (uint32_t *)(uintptr_t)stampByte;
  uint32_t *flatList = (uint32_t *)(uintptr_t)flatByte;
  uint32_t *heightedList = (uint32_t *)(uintptr_t)heightedByte;
  uint32_t *dead = (uint32_t *)(uintptr_t)deadByte;
  uint32_t *trig = (uint32_t *)(uintptr_t)trigByte;
  double *trigAngle = (double *)(uintptr_t)trigAngleByte;
  const float *lut = (const float *)(uintptr_t)lutByte;
  int32_t *results = (int32_t *)(uintptr_t)resultsByte;

  uint32_t flatCount = 0, heightedCount = 0, stampedCount = 0, deadCount = 0, trigCount = 0;

  for (uint32_t idx = 0; idx < count; idx++) {
    const uint32_t i = indices[idx];
    const uint16_t life = to_u16_x4((double)currentLife[i] + deltaTime);
    currentLife[i] = life;
    if (lifespan[i] > 0 && life >= lifespan[i]) {
      active[i] = 0;
      dead[deadCount++] = i;
      continue;
    }
    if (skipRenderOnly && renderOnly[i]) continue;

    const uint32_t mask = tweenMask[i];
    const int spinning = hasAngularVel[i] != 0;
    const int cycling = animMode[i] != 0;
    if (mask || spinning || cycling) {
      const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
      const double eased = mask || spinning ? ease_f64(lifeProgress, easeId[i], lut, lutSize) : lifeProgress;
      if (mask & TWEEN_ALPHA) alpha[i] = (float)((double)alphaFrom[i] + ((double)alphaTo[i] - (double)alphaFrom[i]) * eased);
      if (mask & TWEEN_SCALEX) scaleX[i] = (float)((double)scaleXFrom[i] + ((double)scaleXTo[i] - (double)scaleXFrom[i]) * eased);
      if (mask & TWEEN_SCALEY) scaleY[i] = (float)((double)scaleYFrom[i] + ((double)scaleYTo[i] - (double)scaleYFrom[i]) * eased);
      if (mask & TWEEN_TINT) {
        const uint32_t c = lerp_rgb_x4(tintFrom[i], tintTo[i], eased);
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
          trig[trigCount] = i;
          trigAngle[trigCount] = angle;
          trigCount++;
        }
      }
      if (cycling && animMode[i] == 1 && animCount[i] > 0) {
        const int32_t n = animCount[i];
        int32_t fi = to_i32_x4(lifeProgress * n);
        if (fi >= n) fi = n - 1;
        textureId[i] = animFrames[i * 8u + (uint32_t)fi];
      }
    }
    if (flat[i]) flatList[flatCount++] = i;
    else heightedList[heightedCount++] = i;
  }

  /* Flat pass: XY + gravity on vy. */
  for (uint32_t k = 0; k < flatCount; k++) {
    const uint32_t i = flatList[k];
    vy[i] = (float)((double)vy[i] + (double)gravity[i] * dtRatio);
    x[i] = (float)((double)x[i] + (double)vx[i] * dtRatio);
    y[i] = (float)((double)y[i] + (double)vy[i] * dtRatio);
  }

  /* Heighted pass: gravity + air / ground (bounce) / floor fade / despawn. */
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
    if (bounces[i] > 0 && vz[i] > 0) {
      /* Floor bounce: the rebound must beat two frames of gravity (0.05 px/frame when gravity is
         tiny), or the particle lands as it would without bounces. */
      const double rebound = (double)vz[i] * (double)bounciness[i];
      const double g = (double)gravity[i];
      const double minRebound = g > 0.025 ? g * 2 : 0.05;
      if (rebound > minRebound) {
        bounces[i] = (uint8_t)(bounces[i] - 1u);
        const double keep = (double)bounceFriction[i];
        vx[i] = (float)((double)vx[i] * keep);
        vy[i] = (float)((double)vy[i] * keep);
        vz[i] = (float)(-rebound);
        x[i] = (float)((double)x[i] + (double)vx[i] * dtRatio);
        y[i] = (float)((double)y[i] + (double)vy[i] * dtRatio);
        z[i] = (float)((double)vz[i] * dtRatio);
        survivors++;
        continue;
      }
      bounces[i] = 0;
    }
    z[i] = 0;
    vx[i] = 0;
    vy[i] = 0;
    vz[i] = 0;
    if (despawnOnGroundContact[i]) {
      active[i] = 0;
      dead[deadCount++] = i;
      continue;
    }
    if (stayOnTheFloor[i]) {
      active[i] = 0;
      if (stampEnabled) stamp[stampedCount++] = i;
      else dead[deadCount++] = i;
      continue;
    }
    if (fadeOnTheFloor[i] > 0) {
      if (timeOnFloor[i] == 0) initialAlpha[i] = alpha[i];
      const uint16_t onFloor = to_u16_x4((double)timeOnFloor[i] + deltaTime);
      timeOnFloor[i] = onFloor;
      double fadeProgress = (double)onFloor / (double)fadeOnTheFloor[i];
      if (fadeProgress > 1) fadeProgress = 1;
      alpha[i] = (float)((double)initialAlpha[i] * (1 - fadeProgress));
      if (alpha[i] <= 0) {
        active[i] = 0;
        dead[deadCount++] = i;
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

/* integrate_batch_f32x4 on u32 slot lists. */
__attribute__((export_name("integrate_batch_f32x4_u32")))
void integrate_batch_f32x4_u32(
    uint32_t columnsByte, uint32_t indicesByte, uint32_t count, double deltaTime, double dtRatio,
    uint32_t stampEnabled, uint32_t skipRenderOnly, uint32_t stampByte, uint32_t flatByte,
    uint32_t heightedByte, uint32_t deadByte, uint32_t trigByte, uint32_t trigAngleByte, uint32_t lutByte,
    uint32_t lutSize, uint32_t resultsByte) {
  const uint32_t *cols = (const uint32_t *)(uintptr_t)columnsByte;
  const uint32_t *indices = (const uint32_t *)(uintptr_t)indicesByte;
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
  uint8_t *bounces = COL(uint8_t, BOUNCES);
  const float *bounciness = COL(float, BOUNCINESS), *bounceFriction = COL(float, BOUNCE_FRICTION);
  uint32_t *stamp = (uint32_t *)(uintptr_t)stampByte;
  uint32_t *flatList = (uint32_t *)(uintptr_t)flatByte;
  uint32_t *heightedList = (uint32_t *)(uintptr_t)heightedByte;
  uint32_t *dead = (uint32_t *)(uintptr_t)deadByte;
  uint32_t *trig = (uint32_t *)(uintptr_t)trigByte;
  double *trigAngle = (double *)(uintptr_t)trigAngleByte;
  const float *lut = (const float *)(uintptr_t)lutByte;
  int32_t *results = (int32_t *)(uintptr_t)resultsByte;
  const float dt = (float)dtRatio;

  uint32_t flatCount = 0, heightedCount = 0, stampedCount = 0, deadCount = 0, trigCount = 0;
  uint32_t staged = count; /* the staged rotations are trig[staged, count) */

  for (uint32_t idx = 0; idx < count; idx++) {
    const uint32_t i = indices[idx];
    const uint16_t life = to_u16_x4((double)currentLife[i] + deltaTime);
    currentLife[i] = life;
    if (lifespan[i] > 0 && life >= lifespan[i]) {
      active[i] = 0;
      dead[deadCount++] = i;
      continue;
    }
    if (skipRenderOnly && renderOnly[i]) continue;

    const uint32_t mask = tweenMask[i];
    const int spinning = hasAngularVel[i] != 0;
    const int cycling = animMode[i] != 0;
    if (mask || spinning || cycling) {
      const int rotates = (mask & TWEEN_ROT) || spinning;
      double eased = 0;
      float easedF;
      if (rotates) {
        const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
        eased = ease_f64(lifeProgress, easeId[i], lut, lutSize);
        easedF = (float)eased;
      } else {
        const float lifeProgress = lifespan[i] > 0 ? (float)life / (float)lifespan[i] : 1.0f;
        easedF = mask ? ease_f32(lifeProgress, easeId[i], lut, lutSize) : lifeProgress;
      }
      if (mask & TWEEN_ALPHA) alpha[i] = alphaFrom[i] + (alphaTo[i] - alphaFrom[i]) * easedF;
      if (mask & TWEEN_SCALEX) scaleX[i] = scaleXFrom[i] + (scaleXTo[i] - scaleXFrom[i]) * easedF;
      if (mask & TWEEN_SCALEY) scaleY[i] = scaleYFrom[i] + (scaleYTo[i] - scaleYFrom[i]) * easedF;
      if (mask & TWEEN_TINT) {
        const uint32_t c = lerp_rgb_f32(tintFrom[i], tintTo[i], easedF);
        tint[i] = c;
        baseTint[i] = c;
      }
      if (rotates) {
        double angle = (double)rotFrom[i];
        if (mask & TWEEN_ROT) angle = (double)rotFrom[i] + ((double)rotTo[i] - (double)rotFrom[i]) * eased;
        if (spinning) {
          const double av = (double)angFrom[i] + ((double)angTo[i] - (double)angFrom[i]) * eased;
          angle += av * (double)currentLife[i];
        }
        const uint32_t ix = hi_bits(angle);
        if (ix < 0x413921fbu) {
          staged--;
          trig[staged] = i;
          trigAngle[staged] = angle;
        } else {
          float s, c;
          if (sincos_f32(angle, &s, &c)) {
            rotC[i] = c;
            rotS[i] = s;
          } else {
            trig[trigCount] = i;
            trigAngle[trigCount] = angle;
            trigCount++;
          }
        }
      }
      if (cycling && animMode[i] == 1 && animCount[i] > 0) {
        const double lifeProgress = lifespan[i] > 0 ? (double)life / (double)lifespan[i] : 1;
        const int32_t n = animCount[i];
        int32_t fi = to_i32_x4(lifeProgress * n);
        if (fi >= n) fi = n - 1;
        textureId[i] = animFrames[i * 8u + (uint32_t)fi];
      }
    }
    if (flat[i]) flatList[flatCount++] = i;
    else heightedList[heightedCount++] = i;
  }

  /* The staged rotations, four at a time, then the rest one by one. */
  uint32_t e = staged;
  for (; e + 4 <= count; e += 4) {
    v128_t s, c;
    sincos4(wasm_v128_load(trigAngle + e), wasm_v128_load(trigAngle + e + 2), &s, &c);
    const uint32_t i0 = trig[e], i1 = trig[e + 1], i2 = trig[e + 2], i3 = trig[e + 3];
    rotC[i0] = wasm_f32x4_extract_lane(c, 0);
    rotS[i0] = wasm_f32x4_extract_lane(s, 0);
    rotC[i1] = wasm_f32x4_extract_lane(c, 1);
    rotS[i1] = wasm_f32x4_extract_lane(s, 1);
    rotC[i2] = wasm_f32x4_extract_lane(c, 2);
    rotS[i2] = wasm_f32x4_extract_lane(s, 2);
    rotC[i3] = wasm_f32x4_extract_lane(c, 3);
    rotS[i3] = wasm_f32x4_extract_lane(s, 3);
  }
  for (; e < count; e++) {
    float s, c;
    sincos_f32(trigAngle[e], &s, &c);
    rotC[trig[e]] = c;
    rotS[trig[e]] = s;
  }

  /* Flat pass: XY + gravity on vy. */
  const v128_t dt4 = wasm_f32x4_splat(dt);
  for (uint32_t k = 0; k < flatCount;) {
    if (k + 4 <= flatCount && run_of_four_u32(flatList, k)) {
      const uint32_t i = flatList[k];
      const v128_t vy4 = wasm_f32x4_add(wasm_v128_load(vy + i), wasm_f32x4_mul(wasm_v128_load(gravity + i), dt4));
      wasm_v128_store(vy + i, vy4);
      wasm_v128_store(x + i, wasm_f32x4_add(wasm_v128_load(x + i), wasm_f32x4_mul(wasm_v128_load(vx + i), dt4)));
      wasm_v128_store(y + i, wasm_f32x4_add(wasm_v128_load(y + i), wasm_f32x4_mul(vy4, dt4)));
      k += 4;
      continue;
    }
    const uint32_t i = flatList[k++];
    vy[i] = vy[i] + gravity[i] * dt;
    x[i] = x[i] + vx[i] * dt;
    y[i] = y[i] + vy[i] * dt;
  }

  /* Heighted pass: gravity + air / ground (bounce) / floor fade / despawn. */
  uint32_t survivors = 0;
  for (uint32_t k = 0; k < heightedCount;) {
    if (k + 4 <= heightedCount && run_of_four_u32(heightedList, k)) {
      const uint32_t i = heightedList[k];
      const v128_t z4 = wasm_v128_load(z + i);
      if (wasm_i32x4_all_true(wasm_f32x4_lt(z4, wasm_f32x4_splat(0.0f)))) {
        const v128_t vz4 = wasm_f32x4_add(wasm_v128_load(vz + i), wasm_f32x4_mul(wasm_v128_load(gravity + i), dt4));
        wasm_v128_store(vz + i, vz4);
        wasm_v128_store(x + i, wasm_f32x4_add(wasm_v128_load(x + i), wasm_f32x4_mul(wasm_v128_load(vx + i), dt4)));
        wasm_v128_store(y + i, wasm_f32x4_add(wasm_v128_load(y + i), wasm_f32x4_mul(wasm_v128_load(vy + i), dt4)));
        wasm_v128_store(z + i, wasm_f32x4_add(z4, wasm_f32x4_mul(vz4, dt4)));
        survivors += 4;
        k += 4;
        continue;
      }
    }
    const uint32_t i = heightedList[k++];
    vz[i] = vz[i] + gravity[i] * dt;
    if (z[i] < 0) {
      x[i] = x[i] + vx[i] * dt;
      y[i] = y[i] + vy[i] * dt;
      z[i] = z[i] + vz[i] * dt;
      survivors++;
      continue;
    }
    if (bounces[i] > 0 && vz[i] > 0) {
      /* integrate_batch's floor bounce. The decision in double, as there, so both bounce on the same frame;
         a float32 product of two floats is the double one rounded once. */
      const double rebound = (double)vz[i] * (double)bounciness[i];
      const double g = (double)gravity[i];
      const double minRebound = g > 0.025 ? g * 2 : 0.05;
      if (rebound > minRebound) {
        bounces[i] = (uint8_t)(bounces[i] - 1u);
        const float keep = bounceFriction[i];
        vx[i] = vx[i] * keep;
        vy[i] = vy[i] * keep;
        vz[i] = (float)(-rebound);
        x[i] = x[i] + vx[i] * dt;
        y[i] = y[i] + vy[i] * dt;
        z[i] = vz[i] * dt;
        survivors++;
        continue;
      }
      bounces[i] = 0;
    }
    z[i] = 0;
    vx[i] = 0;
    vy[i] = 0;
    vz[i] = 0;
    if (despawnOnGroundContact[i]) {
      active[i] = 0;
      dead[deadCount++] = i;
      continue;
    }
    if (stayOnTheFloor[i]) {
      active[i] = 0;
      if (stampEnabled) stamp[stampedCount++] = i;
      else dead[deadCount++] = i;
      continue;
    }
    if (fadeOnTheFloor[i] > 0) {
      if (timeOnFloor[i] == 0) initialAlpha[i] = alpha[i];
      const uint16_t onFloor = to_u16_x4((double)timeOnFloor[i] + deltaTime);
      timeOnFloor[i] = onFloor;
      float fadeProgress = (float)onFloor / (float)fadeOnTheFloor[i];
      if (fadeProgress > 1) fadeProgress = 1;
      alpha[i] = initialAlpha[i] * (1 - fadeProgress);
      if (alpha[i] <= 0) {
        active[i] = 0;
        dead[deadCount++] = i;
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
