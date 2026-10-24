/* Float32 variants of the particle list build (E-76 W13, E-80), a test module. build_lists_f32 and
   build_lists_turned_f32 (scalar), build_lists_f32x4 and build_lists_turned_f32x4 take build_lists' and
   build_lists_turned's arguments (wasm/particleLists.c) and write what they write: the same u16 lists
   [count, index, ...] (each may hold one index past its count), the same isItOnScreen bytes for live
   particles, nothing else. The active column is read 16 slots at a time as there, and an empty block is
   skipped. What changes is the screen test: the camera terms are rounded to float once per call and each
   position is tested in float32 (x * zoom - offX, and the turned view's rotation, in the JS order), where
   the shipped kernel widens it to double. So a particle can only change sides when its double coordinate
   is within a few float32 steps of a bound of the box (the bound tests/node/particleListsF32.test.js states);
   the box has the cull margin around the view, so such a particle is drawn outside the canvas either way.

   _f32: every live particle alone, a full block like a partial one. _f32x4: a full block four particles per
   f32x4 operation (the shipped kernel takes two per f64x2), its flags and active indices stored as vectors;
   a partial block and the tail alone, with the same float operations, so the two variants agree bit for bit.
   Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))

/* The 16-bit mask of the live slots in active[i .. i + 15]. */
INLINE uint32_t live_mask(const uint8_t *active, uint32_t i) {
  const v128_t a = wasm_v128_load(active + i);
  return wasm_i8x16_bitmask(wasm_i8x16_ne(a, wasm_i8x16_splat(0)));
}

/* The camera of one call, in float. */
typedef struct {
  float zoom, offX, offY, minX, maxX, minY, maxY;
} Box;

typedef struct {
  float zoom, offX, offY, halfCw, halfCh, rc, rs, limW, limH;
} Turned;

/* One particle against the screen box. */
INLINE uint32_t on_box(const float *x, const float *y, uint32_t k, Box c) {
  const float sx = x[k] * c.zoom - c.offX;
  const float sy = y[k] * c.zoom - c.offY;
  return (uint32_t)(sx > c.minX) & (uint32_t)(sx < c.maxX) & (uint32_t)(sy > c.minY) & (uint32_t)(sy < c.maxY);
}

/* One particle in the turned view: (u, v) about the canvas centre against the view plus margin. */
INLINE uint32_t on_turned(const float *x, const float *y, uint32_t k, Turned c) {
  const float dx = x[k] * c.zoom - c.offX - c.halfCw;
  const float dy = y[k] * c.zoom - c.offY - c.halfCh;
  const float u = c.rc * dx - c.rs * dy;
  const float v = c.rs * dx + c.rc * dy;
  return (uint32_t)(u > -c.limW) & (uint32_t)(u < c.limW) & (uint32_t)(v > -c.limH) & (uint32_t)(v < c.limH);
}

INLINE v128_t in_range(v128_t a, v128_t lo, v128_t hi) {
  return wasm_v128_and(wasm_f32x4_gt(a, lo), wasm_f32x4_lt(a, hi));
}

/* Four particles from k against the screen box: i32x4 lanes of 0 or -1. */
INLINE v128_t box_mask4(const float *x, const float *y, uint32_t k, v128_t zoom, v128_t offX, v128_t offY,
                        v128_t minX, v128_t maxX, v128_t minY, v128_t maxY) {
  const v128_t sx = wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(x + k), zoom), offX);
  const v128_t sy = wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(y + k), zoom), offY);
  return wasm_v128_and(in_range(sx, minX, maxX), in_range(sy, minY, maxY));
}

/* Four particles from k in the turned view. */
INLINE v128_t turned_mask4(const float *x, const float *y, uint32_t k, v128_t zoom, v128_t offX, v128_t offY,
                           v128_t halfCw, v128_t halfCh, v128_t rc, v128_t rs, v128_t limW, v128_t limH,
                           v128_t nlimW, v128_t nlimH) {
  const v128_t dx = wasm_f32x4_sub(wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(x + k), zoom), offX), halfCw);
  const v128_t dy = wasm_f32x4_sub(wasm_f32x4_sub(wasm_f32x4_mul(wasm_v128_load(y + k), zoom), offY), halfCh);
  const v128_t u = wasm_f32x4_sub(wasm_f32x4_mul(rc, dx), wasm_f32x4_mul(rs, dy));
  const v128_t v = wasm_f32x4_add(wasm_f32x4_mul(rs, dx), wasm_f32x4_mul(rc, dy));
  return wasm_v128_and(in_range(u, nlimW, limW), in_range(v, nlimH, limH));
}

INLINE v128_t to_m16(v128_t a, v128_t b, v128_t c, v128_t d) {
  return wasm_i8x16_narrow_i16x8(wasm_i16x8_narrow_i32x4(a, b), wasm_i16x8_narrow_i32x4(c, d));
}

/* A full block's lists and flags from its 16-lane mask (bytes of 0 or -1). */
INLINE void emit_full_block(uint32_t i, v128_t m16, uint8_t *on, uint16_t *al, uint16_t *vl, uint32_t *ac,
                            uint32_t *vc) {
  wasm_v128_store(on + i, wasm_v128_and(m16, wasm_i8x16_splat(1)));
  const v128_t base = wasm_i16x8_splat((int16_t)i);
  wasm_v128_store(al + 1 + *ac, wasm_i16x8_add(base, wasm_i16x8_make(0, 1, 2, 3, 4, 5, 6, 7)));
  wasm_v128_store(al + 1 + *ac + 8, wasm_i16x8_add(base, wasm_i16x8_make(8, 9, 10, 11, 12, 13, 14, 15)));
  *ac += 16;
  const uint32_t vm = wasm_i8x16_bitmask(m16);
  uint32_t c = *vc;
  for (uint32_t j = 0; j < 16; j++) {
    vl[1 + c] = (uint16_t)(i + j);
    c += (vm >> j) & 1u;
  }
  *vc = c;
}

/* The box build, `simd` a constant. */
INLINE uint32_t lists_box(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                          uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                          double minX, double maxX, double minY, double maxY, int simd) {
  const uint8_t *active = (const uint8_t *)activeByte;
  const float *x = (const float *)xByte;
  const float *y = (const float *)yByte;
  uint8_t *on = (uint8_t *)onScreenByte;
  uint16_t *al = (uint16_t *)activeListByte;
  uint16_t *vl = (uint16_t *)visibleListByte;
  const Box c = { (float)zoom, (float)offX, (float)offY, (float)minX, (float)maxX, (float)minY, (float)maxY };
  const v128_t Z = wasm_f32x4_splat(c.zoom), OX = wasm_f32x4_splat(c.offX), OY = wasm_f32x4_splat(c.offY);
  const v128_t X0 = wasm_f32x4_splat(c.minX), X1 = wasm_f32x4_splat(c.maxX);
  const v128_t Y0 = wasm_f32x4_splat(c.minY), Y1 = wasm_f32x4_splat(c.maxY);
  uint32_t ac = 0, vc = 0, i = 0;
  for (; i + 16 <= n; i += 16) {
    uint32_t mask = live_mask(active, i);
    if (mask == 0) continue;
    if (simd && mask == 0xffff) {
      const v128_t m16 = to_m16(box_mask4(x, y, i, Z, OX, OY, X0, X1, Y0, Y1),
                                box_mask4(x, y, i + 4, Z, OX, OY, X0, X1, Y0, Y1),
                                box_mask4(x, y, i + 8, Z, OX, OY, X0, X1, Y0, Y1),
                                box_mask4(x, y, i + 12, Z, OX, OY, X0, X1, Y0, Y1));
      emit_full_block(i, m16, on, al, vl, &ac, &vc);
      continue;
    }
    do {
      const uint32_t k = i + (uint32_t)__builtin_ctz(mask);
      mask &= mask - 1;
      const uint32_t v = on_box(x, y, k, c);
      al[1 + ac++] = (uint16_t)k;
      on[k] = (uint8_t)v;
      vl[1 + vc] = (uint16_t)k;
      vc += v;
    } while (mask);
  }
  for (; i < n; i++) {
    if (!active[i]) continue;
    const uint32_t v = on_box(x, y, i, c);
    al[1 + ac++] = (uint16_t)i;
    on[i] = (uint8_t)v;
    vl[1 + vc] = (uint16_t)i;
    vc += v;
  }
  al[0] = (uint16_t)ac;
  vl[0] = (uint16_t)vc;
  return ac;
}

/* The turned build, `simd` a constant. */
INLINE uint32_t lists_turned(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                             uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                             double halfCw, double halfCh, double rc, double rs, double limW, double limH, int simd) {
  const uint8_t *active = (const uint8_t *)activeByte;
  const float *x = (const float *)xByte;
  const float *y = (const float *)yByte;
  uint8_t *on = (uint8_t *)onScreenByte;
  uint16_t *al = (uint16_t *)activeListByte;
  uint16_t *vl = (uint16_t *)visibleListByte;
  const Turned c = { (float)zoom, (float)offX, (float)offY, (float)halfCw, (float)halfCh, (float)rc, (float)rs,
                     (float)limW, (float)limH };
  const v128_t Z = wasm_f32x4_splat(c.zoom), OX = wasm_f32x4_splat(c.offX), OY = wasm_f32x4_splat(c.offY);
  const v128_t HW = wasm_f32x4_splat(c.halfCw), HH = wasm_f32x4_splat(c.halfCh);
  const v128_t RC = wasm_f32x4_splat(c.rc), RS = wasm_f32x4_splat(c.rs);
  const v128_t LW = wasm_f32x4_splat(c.limW), LH = wasm_f32x4_splat(c.limH);
  const v128_t NW = wasm_f32x4_splat(-c.limW), NH = wasm_f32x4_splat(-c.limH);
  uint32_t ac = 0, vc = 0, i = 0;
  for (; i + 16 <= n; i += 16) {
    uint32_t mask = live_mask(active, i);
    if (mask == 0) continue;
    if (simd && mask == 0xffff) {
      const v128_t m16 = to_m16(turned_mask4(x, y, i, Z, OX, OY, HW, HH, RC, RS, LW, LH, NW, NH),
                                turned_mask4(x, y, i + 4, Z, OX, OY, HW, HH, RC, RS, LW, LH, NW, NH),
                                turned_mask4(x, y, i + 8, Z, OX, OY, HW, HH, RC, RS, LW, LH, NW, NH),
                                turned_mask4(x, y, i + 12, Z, OX, OY, HW, HH, RC, RS, LW, LH, NW, NH));
      emit_full_block(i, m16, on, al, vl, &ac, &vc);
      continue;
    }
    do {
      const uint32_t k = i + (uint32_t)__builtin_ctz(mask);
      mask &= mask - 1;
      const uint32_t v = on_turned(x, y, k, c);
      al[1 + ac++] = (uint16_t)k;
      on[k] = (uint8_t)v;
      vl[1 + vc] = (uint16_t)k;
      vc += v;
    } while (mask);
  }
  for (; i < n; i++) {
    if (!active[i]) continue;
    const uint32_t v = on_turned(x, y, i, c);
    al[1 + ac++] = (uint16_t)i;
    on[i] = (uint8_t)v;
    vl[1 + vc] = (uint16_t)i;
    vc += v;
  }
  al[0] = (uint16_t)ac;
  vl[0] = (uint16_t)vc;
  return ac;
}

__attribute__((export_name("build_lists_f32")))
uint32_t build_lists_f32(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                         uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                         double minX, double maxX, double minY, double maxY) {
  return lists_box(activeByte, xByte, yByte, onScreenByte, n, activeListByte, visibleListByte, zoom, offX, offY,
                   minX, maxX, minY, maxY, 0);
}

__attribute__((export_name("build_lists_f32x4")))
uint32_t build_lists_f32x4(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                           uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                           double minX, double maxX, double minY, double maxY) {
  return lists_box(activeByte, xByte, yByte, onScreenByte, n, activeListByte, visibleListByte, zoom, offX, offY,
                   minX, maxX, minY, maxY, 1);
}

__attribute__((export_name("build_lists_turned_f32")))
uint32_t build_lists_turned_f32(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                                uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                                double halfCw, double halfCh, double rc, double rs, double limW, double limH) {
  return lists_turned(activeByte, xByte, yByte, onScreenByte, n, activeListByte, visibleListByte, zoom, offX, offY,
                      halfCw, halfCh, rc, rs, limW, limH, 0);
}

__attribute__((export_name("build_lists_turned_f32x4")))
uint32_t build_lists_turned_f32x4(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                                  uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                                  double halfCw, double halfCh, double rc, double rs, double limW, double limH) {
  return lists_turned(activeByte, xByte, yByte, onScreenByte, n, activeListByte, visibleListByte, zoom, offX, offY,
                      halfCw, halfCh, rc, rs, limW, limH, 1);
}
