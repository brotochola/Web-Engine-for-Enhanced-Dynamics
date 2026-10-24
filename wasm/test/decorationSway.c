/* Decoration sway (E-76 W22, a candidate kernel): the per-decoration loop of
   ParticleWorker._updateDecorationSwayBuckets (src/workers/particleWorker.js) over the frame's active
   snapshot, with its bucket cache (bucketFromSwayFrequency on a miss) and the impulse phase step
   (advanceImpulsePhase). Every array is a byte offset into the imported shared memory, read from a table
   of u32 offsets (SWAY_SLOTS in tests/bench/decorationSwayWasmMicrobench.mjs): the DecorationComponent
   columns, which the product keeps in a region of the render-queue memory (E-112), and the particle
   worker's snapshot, phase tables, bucket tables and cache. What stays JS: the frame's per-bucket
   Math.sin / Math.cos and the cache reset when the bucket count changes (before the call), and every
   Math.sin / Math.cos the loop takes per decoration (after it). Those decorations come back in the trig
   list with their angle, and the kernel writes neither rotC nor rotS for them: an impulse with a finite,
   non-zero phase, and a sway angle of 0.08 rad or more. Predator's grass (SWAY_LOOP_SKEW) needs none.
   Arithmetic as the JS does it: float32 columns widened to double, every operation in double in the JS
   order, a Float32Array store a (float) conversion, Math.round as V8 rounds (the ceiling, less one when
   that is more than half above), a Uint16Array store ToUint16. The snapshot holds each live decoration
   once (DecorationPool's active list), so the decorations of the trig list can be finished after the
   call. The four early continues run first, without a branch, over a chunk of the snapshot at a time: in
   Predator about half the blades are on screen, and their flags in snapshot order are as random as their
   positions, which no branch predictor learns (a choice not yet timed against the plain loop). Returns
   the length of the trig list. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

/* decorationSway.js */
#define SWAY_OFF 0u
#define SWAY_LOOP 1u
#define SWAY_IMPULSE 2u
#define SWAY_LOOP_SKEW 3u
#define SWAY_SKEW_C 1.5f
#define SWAY_ANGLE_PER_MS 0.002
#define IMPULSE_DONE (-1.0)
#define JS_PI 0x1.921fb54442d18p+1 /* Math.PI */
/* Below this |angle| the JS takes 1 for its cosine and the angle for its sine. */
#define SMALL_ANGLE 0.08

/* A trig-list entry: the decoration's index (the snapshot is u16), with this bit for an impulse, whose
   Math.sin(phase) * swayAmplitude the JS takes first. Without it the value is the sway angle. */
#define TRIG_IMPULSE 0x10000u

enum {
  T_SNAPSHOT,    /* u16: the frame's active snapshot (DecorationPool.copyActiveSnapshot) */
  T_ACTIVE,      /* u8 */
  T_PARENT,      /* u16, or u32 with T_PARENT_WIDE (entityIdWidth 32) */
  T_PARENT_WIDE,
  T_NO_PARENT,   /* entityIdNone */
  T_ON_SCREEN,   /* u8 */
  T_SWAY,        /* u8: SWAY_OFF is written when an impulse ends */
  T_AMPLITUDE,   /* f32 */
  T_FREQUENCY,   /* f32 */
  T_PHASE,       /* f32: an impulse's phase */
  T_ROT_C, T_ROT_S, T_BASE_ROT_C, T_BASE_ROT_S, /* f32 */
  T_PHASE_SIN, T_PHASE_COS,   /* f32 per decoration: sin and cos of i * 0.1 */
  T_BUCKET_SIN, T_BUCKET_COS, /* f32 per bucket, this frame's */
  T_BUCKET_OF,   /* u16 cache: the bucket last derived for each decoration */
  T_BUCKET_FREQ, /* f32 cache: the frequency it was derived from (-1 when none) */
  T_LIST,        /* u16 scratch: the decorations of one chunk that pass the early continues */
  T_LIST_CAP,    /* its length, which is the chunk (at least 1) */
  T_TRIG,        /* u32 out: index | TRIG_IMPULSE */
  T_TRIG_VALUE,  /* f64 out: the impulse's phase, or the sway angle */
  SLOT_COUNT
};

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* The early continues of snapshot[begin, end) without a branch: the decorations that are active,
   unparented, on screen and swaying, in snapshot order. Called with a constant `wide`, so each width
   gets its own loop. */
INLINE uint32_t let_through(const uint16_t *snapshot, uint32_t begin, uint32_t end, const uint8_t *active,
                            const uint16_t *parent16, const uint32_t *parent32, int wide, uint32_t noParent,
                            const uint8_t *onScreen, const uint8_t *sway, uint16_t *list) {
  uint32_t n = 0;
  for (uint32_t idx = begin; idx < end; idx++) {
    const uint32_t i = snapshot[idx];
    const uint32_t p = wide ? parent32[i] : (uint32_t)parent16[i];
    list[n] = (uint16_t)i;
    n += (uint32_t)(active[i] != 0) & (uint32_t)(p == noParent) & (uint32_t)(onScreen[i] != 0) &
         (uint32_t)(sway[i] != SWAY_OFF);
  }
  return n;
}

__attribute__((export_name("sway_decorations")))
uint32_t sway_decorations(uint32_t table, uint32_t count, uint32_t k, double deltaTime) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every pointer is read once: the stores below may alias the table as far as the compiler knows. */
  const uint16_t *snapshot = PTR(const uint16_t, T_SNAPSHOT);
  const uint8_t *active = PTR(const uint8_t, T_ACTIVE);
  const uint16_t *parent16 = PTR(const uint16_t, T_PARENT);
  const uint32_t *parent32 = PTR(const uint32_t, T_PARENT);
  const int wide = t[T_PARENT_WIDE] != 0;
  const uint32_t noParent = t[T_NO_PARENT];
  const uint8_t *onScreen = PTR(const uint8_t, T_ON_SCREEN);
  uint8_t *sway = PTR(uint8_t, T_SWAY);
  const float *amplitude = PTR(const float, T_AMPLITUDE);
  const float *frequency = PTR(const float, T_FREQUENCY);
  float *phase = PTR(float, T_PHASE);
  float *rotC = PTR(float, T_ROT_C);
  float *rotS = PTR(float, T_ROT_S);
  const float *baseRotC = PTR(const float, T_BASE_ROT_C);
  const float *baseRotS = PTR(const float, T_BASE_ROT_S);
  const float *phaseSin = PTR(const float, T_PHASE_SIN);
  const float *phaseCos = PTR(const float, T_PHASE_COS);
  const float *bucketSin = PTR(const float, T_BUCKET_SIN);
  const float *bucketCos = PTR(const float, T_BUCKET_COS);
  uint16_t *bucketOf = PTR(uint16_t, T_BUCKET_OF);
  float *bucketFreq = PTR(float, T_BUCKET_FREQ);
  uint16_t *list = PTR(uint16_t, T_LIST);
  const uint32_t cap = t[T_LIST_CAP];
  uint32_t *trig = PTR(uint32_t, T_TRIG);
  double *trigValue = PTR(double, T_TRIG_VALUE);

  /* bucketFromSwayFrequency's step and last bucket, advanceImpulsePhase's deltaTimeMs * SWAY_ANGLE_PER_MS:
     the same operations on the same values as in each call. */
  const double step = 2.0 / (double)(k - 1);
  const double last = (double)(k - 1);
  const double dtAngle = deltaTime * SWAY_ANGLE_PER_MS;
  uint32_t nTrig = 0;

  for (uint32_t begin = 0; begin < count; begin += cap) {
    const uint32_t end = count - begin > cap ? begin + cap : count;
    const uint32_t n = wide
      ? let_through(snapshot, begin, end, active, parent16, parent32, 1, noParent, onScreen, sway, list)
      : let_through(snapshot, begin, end, active, parent16, parent32, 0, noParent, onScreen, sway, list);
    for (uint32_t e = 0; e < n; e++) {
      const uint32_t i = list[e];
      const uint32_t mode = sway[i];
      double delta = 0.0;
      if (mode == SWAY_LOOP || mode == SWAY_LOOP_SKEW) {
        const float f = frequency[i];
        double sa;
        double ca;
        if (bucketFreq[i] != f) {
          /* A miss: bucketFromSwayFrequency(f, k), whose bucket is an integer in [0, k - 1], -0 or (for a
             NaN f) NaN. bucketSin[NaN] is undefined in the JS, which makes the angle NaN. */
          const double x = ((double)f - 1.0) / step;
          double b = __builtin_ceil(x);
          if (b - 0.5 > x) b -= 1.0;
          if (b < 0.0) b = 0.0;
          if (b > last) b = last;
          const uint32_t bi = b == b ? (uint32_t)b : 0u;
          bucketOf[i] = (uint16_t)bi; /* ToUint16: NaN and -0 store 0, a bucket past 65535 wraps */
          bucketFreq[i] = f;
          if (b == b) {
            sa = bucketSin[bi];
            ca = bucketCos[bi];
          } else {
            sa = b;
            ca = b;
          }
        } else {
          /* A hit. The JS resets bucketFreq to -1 when k changes but keeps bucketOf, so a frequency of -1
             hits a bucket of the old grid, which past the new one is undefined (NaN) in the JS. */
          const uint32_t bi = bucketOf[i];
          if (bi < k) {
            sa = bucketSin[bi];
            ca = bucketCos[bi];
          } else {
            sa = __builtin_nan("");
            ca = sa;
          }
        }
        delta = (sa * (double)phaseCos[i] + ca * (double)phaseSin[i]) * (double)amplitude[i];
        if (mode == SWAY_LOOP_SKEW) {
          rotC[i] = SWAY_SKEW_C;
          rotS[i] = (float)delta;
          continue;
        }
      } else if (mode == SWAY_IMPULSE) {
        /* advanceImpulsePhase, then the JS's test against IMPULSE_DONE (which a phase of -1 also meets). */
        const double next = (double)phase[i] + dtAngle * (double)frequency[i];
        if (next >= JS_PI || next == IMPULSE_DONE) {
          sway[i] = SWAY_OFF;
          phase[i] = 0.0f;
          rotC[i] = baseRotC[i];
          rotS[i] = baseRotS[i];
          continue;
        }
        phase[i] = (float)next;
        if (next != 0.0 && next - next == 0.0) {
          trig[nTrig] = i | TRIG_IMPULSE;
          trigValue[nTrig] = next;
          nTrig++;
          continue;
        }
        /* Math.sin of +-0 is that zero, of NaN or -Infinity NaN. */
        delta = (next == 0.0 ? next : next - next) * (double)amplitude[i];
      }
      if (delta != 0.0) {
        const double ad = delta < 0.0 ? -delta : delta;
        double dc;
        double ds;
        if (ad < SMALL_ANGLE) {
          dc = 1.0;
          ds = delta;
        } else if (ad - ad == 0.0) {
          trig[nTrig] = i;
          trigValue[nTrig] = delta;
          nTrig++;
          continue;
        } else {
          /* Math.cos and Math.sin of NaN or +-Infinity are NaN. */
          dc = delta - delta;
          ds = dc;
        }
        const double bc = baseRotC[i];
        const double bs = baseRotS[i];
        rotC[i] = (float)(bc * dc - bs * ds);
        rotS[i] = (float)(bs * dc + bc * ds);
      } else {
        rotC[i] = baseRotC[i];
        rotS[i] = baseRotS[i];
      }
    }
  }
  return nTrig;
}
