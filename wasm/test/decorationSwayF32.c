/* Float32 variants of the decoration sway (E-76 W22), a test module: sway_decorations_f32 and
   sway_decorations_f32x4 take sway_decorations' arguments (wasm/decorationSway.c), read the same column table
   and write what it writes: the same columns, bucket cache and trig list, with the same JS before the call
   (the per-bucket Math.sin / Math.cos, the cache reset) and after it (Math.sin / Math.cos for the trig list).
   What changes is the arithmetic of the sway itself, within the tolerance
   tests/node/decorationSwayF32.test.js states:

   - A loop or skew decoration's angle, (sin a * cos p + cos a * sin p) * amplitude, in float32 from the
     float32 tables and columns (the shipped kernel widens each to double and rounds once at the end).
   - Its rotation under 0.08 rad, base composed with (1, delta), in float32. The 0.08 test reads the float
     angle: a decoration whose double angle is within a float32 rounding of 0.08 can take the other side of
     the JS's own step there (cos 0.08 against 1), into or out of the trig list.
   - Exact as shipped: the bucket a frequency falls in (a cache miss, in double: a bucket one off would be a
     different phase), an impulse's phase step and its end test (in double: a phase that ends a frame early
     would change the mode column), every early continue, the trig list's impulses and their phases.

   sway_decorations_f32 is the shipped loop with that arithmetic, one decoration at a time.
   sway_decorations_f32x4 takes four entries of the chunk's list at once when all four are skew decorations
   whose bucket the cache holds (Predator's grass, every frame after the first): the inputs are gathered lane
   by lane (the list is in snapshot order with gaps, so no column is contiguous), the angle is one f32x4
   expression, the stores go back lane by lane, so only decorations the JS would write are written. Anything
   else takes the scalar step for one entry; the two variants agree bit for bit. Returns the length of the
   trig list. */
#include <stdint.h>
#include <wasm_simd128.h>

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

/* A trig-list entry: the decoration's index, with this bit for an impulse (its value is the phase). */
#define TRIG_IMPULSE 0x10000u

/* wasm/decorationSway.c's column table, slot for slot. */
enum {
  T_SNAPSHOT, T_ACTIVE, T_PARENT, T_PARENT_WIDE, T_NO_PARENT, T_ON_SCREEN, T_SWAY, T_AMPLITUDE, T_FREQUENCY,
  T_PHASE, T_ROT_C, T_ROT_S, T_BASE_ROT_C, T_BASE_ROT_S, T_PHASE_SIN, T_PHASE_COS, T_BUCKET_SIN, T_BUCKET_COS,
  T_BUCKET_OF, T_BUCKET_FREQ, T_LIST, T_LIST_CAP, T_TRIG, T_TRIG_VALUE, SLOT_COUNT
};

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* The early continues of snapshot[begin, end) without a branch, as decorationSway.c. */
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

INLINE v128_t gather4(const float *a, uint32_t i0, uint32_t i1, uint32_t i2, uint32_t i3) {
  v128_t v = wasm_v128_load32_zero(a + i0);
  v = wasm_v128_load32_lane(a + i1, v, 1);
  v = wasm_v128_load32_lane(a + i2, v, 2);
  return wasm_v128_load32_lane(a + i3, v, 3);
}

/* The sway, `simd` a constant: 0 for sway_decorations_f32, 1 for sway_decorations_f32x4. */
INLINE uint32_t sway(uint32_t table, uint32_t count, uint32_t k, double deltaTime, int simd) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every pointer is read once: the stores below may alias the table as far as the compiler knows. */
  const uint16_t *snapshot = PTR(const uint16_t, T_SNAPSHOT);
  const uint8_t *active = PTR(const uint8_t, T_ACTIVE);
  const uint16_t *parent16 = PTR(const uint16_t, T_PARENT);
  const uint32_t *parent32 = PTR(const uint32_t, T_PARENT);
  const int wide = t[T_PARENT_WIDE] != 0;
  const uint32_t noParent = t[T_NO_PARENT];
  const uint8_t *onScreen = PTR(const uint8_t, T_ON_SCREEN);
  uint8_t *swayMode = PTR(uint8_t, T_SWAY);
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

  const double step = 2.0 / (double)(k - 1);
  const double last = (double)(k - 1);
  const double dtAngle = deltaTime * SWAY_ANGLE_PER_MS;
  uint32_t nTrig = 0;

  for (uint32_t begin = 0; begin < count; begin += cap) {
    const uint32_t end = count - begin > cap ? begin + cap : count;
    const uint32_t n = wide
      ? let_through(snapshot, begin, end, active, parent16, parent32, 1, noParent, onScreen, swayMode, list)
      : let_through(snapshot, begin, end, active, parent16, parent32, 0, noParent, onScreen, swayMode, list);
    for (uint32_t e = 0; e < n;) {
      if (simd && e + 4 <= n) {
        const uint32_t i0 = list[e], i1 = list[e + 1], i2 = list[e + 2], i3 = list[e + 3];
        if (swayMode[i0] == SWAY_LOOP_SKEW && swayMode[i1] == SWAY_LOOP_SKEW && swayMode[i2] == SWAY_LOOP_SKEW &&
            swayMode[i3] == SWAY_LOOP_SKEW) {
          const v128_t f4 = gather4(frequency, i0, i1, i2, i3);
          const uint32_t b0 = bucketOf[i0], b1 = bucketOf[i1], b2 = bucketOf[i2], b3 = bucketOf[i3];
          if (wasm_i32x4_all_true(wasm_f32x4_eq(gather4(bucketFreq, i0, i1, i2, i3), f4)) &&
              b0 < k && b1 < k && b2 < k && b3 < k) {
            const v128_t sa = gather4(bucketSin, b0, b1, b2, b3);
            const v128_t ca = gather4(bucketCos, b0, b1, b2, b3);
            const v128_t d = wasm_f32x4_mul(
                wasm_f32x4_add(wasm_f32x4_mul(sa, gather4(phaseCos, i0, i1, i2, i3)),
                               wasm_f32x4_mul(ca, gather4(phaseSin, i0, i1, i2, i3))),
                gather4(amplitude, i0, i1, i2, i3));
            rotC[i0] = SWAY_SKEW_C;
            rotS[i0] = wasm_f32x4_extract_lane(d, 0);
            rotC[i1] = SWAY_SKEW_C;
            rotS[i1] = wasm_f32x4_extract_lane(d, 1);
            rotC[i2] = SWAY_SKEW_C;
            rotS[i2] = wasm_f32x4_extract_lane(d, 2);
            rotC[i3] = SWAY_SKEW_C;
            rotS[i3] = wasm_f32x4_extract_lane(d, 3);
            e += 4;
            continue;
          }
        }
      }
      const uint32_t i = list[e++];
      const uint32_t mode = swayMode[i];
      float delta = 0.0f;
      if (mode == SWAY_LOOP || mode == SWAY_LOOP_SKEW) {
        const float f = frequency[i];
        float sa;
        float ca;
        if (bucketFreq[i] != f) {
          /* A miss: bucketFromSwayFrequency(f, k) in double, as decorationSway.c. */
          const double x = ((double)f - 1.0) / step;
          double b = __builtin_ceil(x);
          if (b - 0.5 > x) b -= 1.0;
          if (b < 0.0) b = 0.0;
          if (b > last) b = last;
          const uint32_t bi = b == b ? (uint32_t)b : 0u;
          bucketOf[i] = (uint16_t)bi;
          bucketFreq[i] = f;
          if (b == b) {
            sa = bucketSin[bi];
            ca = bucketCos[bi];
          } else {
            sa = (float)b;
            ca = sa;
          }
        } else {
          const uint32_t bi = bucketOf[i];
          if (bi < k) {
            sa = bucketSin[bi];
            ca = bucketCos[bi];
          } else {
            sa = __builtin_nanf("");
            ca = sa;
          }
        }
        delta = (sa * phaseCos[i] + ca * phaseSin[i]) * amplitude[i];
        if (mode == SWAY_LOOP_SKEW) {
          rotC[i] = SWAY_SKEW_C;
          rotS[i] = delta;
          continue;
        }
      } else if (mode == SWAY_IMPULSE) {
        /* advanceImpulsePhase and the test against IMPULSE_DONE, in double as decorationSway.c. */
        const double next = (double)phase[i] + dtAngle * (double)frequency[i];
        if (next >= JS_PI || next == IMPULSE_DONE) {
          swayMode[i] = SWAY_OFF;
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
        /* Math.sin of +-0 is that zero, of NaN or -Infinity NaN: a zero or NaN product, exact in float. */
        delta = (float)((next == 0.0 ? next : next - next) * (double)amplitude[i]);
      }
      if (delta != 0.0f) {
        const float ad = delta < 0.0f ? -delta : delta;
        float dc;
        float ds;
        if ((double)ad < SMALL_ANGLE) {
          dc = 1.0f;
          ds = delta;
        } else if (ad - ad == 0.0f) {
          trig[nTrig] = i;
          trigValue[nTrig] = (double)delta;
          nTrig++;
          continue;
        } else {
          dc = delta - delta;
          ds = dc;
        }
        const float bc = baseRotC[i];
        const float bs = baseRotS[i];
        rotC[i] = bc * dc - bs * ds;
        rotS[i] = bs * dc + bc * ds;
      } else {
        rotC[i] = baseRotC[i];
        rotS[i] = baseRotS[i];
      }
    }
  }
  return nTrig;
}

__attribute__((export_name("sway_decorations_f32")))
uint32_t sway_decorations_f32(uint32_t table, uint32_t count, uint32_t k, double deltaTime) {
  return sway(table, count, k, deltaTime, 0);
}

__attribute__((export_name("sway_decorations_f32x4")))
uint32_t sway_decorations_f32x4(uint32_t table, uint32_t count, uint32_t k, double deltaTime) {
  return sway(table, count, k, deltaTime, 1);
}
