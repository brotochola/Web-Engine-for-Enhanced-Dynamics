/* Particle list build (E-76 W13, E-80): buildActiveAndVisibleListBuffers and
   buildActiveAndVisibleListBuffersTurned (src/util/particleIntegrate.js) for the whole pool, with
   their arithmetic: each position widened to double and tested in double, as JS tests it. The
   active column is read 16 slots at a time: a block with no live particle is skipped, a full block
   is tested two particles per operation (f64x2, the same doubles) and its flags and active indices
   are stored as vectors, and a partial block visits its live slots in order. Each list is u16
   [count, index, ...] and may hold one index past its count (the visible index is written before
   the test decides whether it counts). isItOnScreen is written for live particles only, as JS
   writes it. Pointers are byte offsets into the imported shared memory. */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))

/* The 16-bit mask of the live slots in active[i .. i + 15]. */
INLINE uint32_t live_mask(const uint8_t *active, uint32_t i) {
  const v128_t a = wasm_v128_load(active + i);
  return wasm_i8x16_bitmask(wasm_i8x16_ne(a, wasm_i8x16_splat(0)));
}

/* One live particle against the screen box. */
INLINE uint32_t on_box(const float *x, const float *y, uint32_t k, double zoom, double offX, double offY,
                       double minX, double maxX, double minY, double maxY) {
  const double sx = (double)x[k] * zoom - offX;
  const double sy = (double)y[k] * zoom - offY;
  return (uint32_t)(sx > minX) & (uint32_t)(sx < maxX) & (uint32_t)(sy > minY) & (uint32_t)(sy < maxY);
}

/* One live particle in the turned view: (u, v) about the canvas centre against the view plus margin. */
INLINE uint32_t on_turned(const float *x, const float *y, uint32_t k, double zoom, double offX, double offY,
                          double halfCw, double halfCh, double rc, double rs, double limW, double limH) {
  const double dx = (double)x[k] * zoom - offX - halfCw;
  const double dy = (double)y[k] * zoom - offY - halfCh;
  const double u = rc * dx - rs * dy;
  const double v = rs * dx + rc * dy;
  return (uint32_t)(u > -limW) & (uint32_t)(u < limW) & (uint32_t)(v > -limH) & (uint32_t)(v < limH);
}

/* The i32x4 lanes of two f64x2 masks (lanes 0 and 1 of each). */
INLINE v128_t narrow64(v128_t lo, v128_t hi) { return wasm_i32x4_shuffle(lo, hi, 0, 2, 4, 6); }

INLINE v128_t promote_hi(v128_t v) { return wasm_f64x2_promote_low_f32x4(wasm_i32x4_shuffle(v, v, 2, 3, 0, 1)); }

INLINE v128_t in_range(v128_t a, v128_t lo, v128_t hi) {
  return wasm_v128_and(wasm_f64x2_gt(a, lo), wasm_f64x2_lt(a, hi));
}

/* Four particles from k against the screen box: i32x4 lanes of 0 or -1. */
INLINE v128_t box_mask4(const float *x, const float *y, uint32_t k, v128_t zoom, v128_t offX, v128_t offY,
                        v128_t minX, v128_t maxX, v128_t minY, v128_t maxY) {
  const v128_t x4 = wasm_v128_load(x + k), y4 = wasm_v128_load(y + k);
  const v128_t sxl = wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(x4), zoom), offX);
  const v128_t sxh = wasm_f64x2_sub(wasm_f64x2_mul(promote_hi(x4), zoom), offX);
  const v128_t syl = wasm_f64x2_sub(wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(y4), zoom), offY);
  const v128_t syh = wasm_f64x2_sub(wasm_f64x2_mul(promote_hi(y4), zoom), offY);
  return narrow64(wasm_v128_and(in_range(sxl, minX, maxX), in_range(syl, minY, maxY)),
                  wasm_v128_and(in_range(sxh, minX, maxX), in_range(syh, minY, maxY)));
}

/* Four particles from k in the turned view. */
INLINE v128_t turned_mask4(const float *x, const float *y, uint32_t k, v128_t zoom, v128_t offX, v128_t offY,
                           v128_t halfCw, v128_t halfCh, v128_t rc, v128_t rs, v128_t limW, v128_t limH,
                           v128_t nlimW, v128_t nlimH) {
  const v128_t x4 = wasm_v128_load(x + k), y4 = wasm_v128_load(y + k);
  v128_t m[2];
  for (int h = 0; h < 2; h++) {
    const v128_t xs = h ? promote_hi(x4) : wasm_f64x2_promote_low_f32x4(x4);
    const v128_t ys = h ? promote_hi(y4) : wasm_f64x2_promote_low_f32x4(y4);
    const v128_t dx = wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(xs, zoom), offX), halfCw);
    const v128_t dy = wasm_f64x2_sub(wasm_f64x2_sub(wasm_f64x2_mul(ys, zoom), offY), halfCh);
    const v128_t u = wasm_f64x2_sub(wasm_f64x2_mul(rc, dx), wasm_f64x2_mul(rs, dy));
    const v128_t v = wasm_f64x2_add(wasm_f64x2_mul(rs, dx), wasm_f64x2_mul(rc, dy));
    m[h] = wasm_v128_and(in_range(u, nlimW, limW), in_range(v, nlimH, limH));
  }
  return narrow64(m[0], m[1]);
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

/* buildActiveAndVisibleListBuffers. Returns the active count; lists are u16 [count, ...]. */
__attribute__((export_name("build_lists")))
uint32_t build_lists(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                     uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                     double minX, double maxX, double minY, double maxY) {
  const uint8_t *active = (const uint8_t *)activeByte;
  const float *x = (const float *)xByte;
  const float *y = (const float *)yByte;
  uint8_t *on = (uint8_t *)onScreenByte;
  uint16_t *al = (uint16_t *)activeListByte;
  uint16_t *vl = (uint16_t *)visibleListByte;
  const v128_t Z = wasm_f64x2_splat(zoom), OX = wasm_f64x2_splat(offX), OY = wasm_f64x2_splat(offY);
  const v128_t X0 = wasm_f64x2_splat(minX), X1 = wasm_f64x2_splat(maxX);
  const v128_t Y0 = wasm_f64x2_splat(minY), Y1 = wasm_f64x2_splat(maxY);
  uint32_t ac = 0, vc = 0, i = 0;
  for (; i + 16 <= n; i += 16) {
    uint32_t mask = live_mask(active, i);
    if (mask == 0) continue;
    if (mask == 0xffff) {
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
      const uint32_t v = on_box(x, y, k, zoom, offX, offY, minX, maxX, minY, maxY);
      al[1 + ac++] = (uint16_t)k;
      on[k] = (uint8_t)v;
      vl[1 + vc] = (uint16_t)k;
      vc += v;
    } while (mask);
  }
  for (; i < n; i++) {
    if (!active[i]) continue;
    const uint32_t v = on_box(x, y, i, zoom, offX, offY, minX, maxX, minY, maxY);
    al[1 + ac++] = (uint16_t)i;
    on[i] = (uint8_t)v;
    vl[1 + vc] = (uint16_t)i;
    vc += v;
  }
  al[0] = (uint16_t)ac;
  vl[0] = (uint16_t)vc;
  return ac;
}

/* buildActiveAndVisibleListBuffersTurned: rc, rs, limW and limH as JS computes them. */
__attribute__((export_name("build_lists_turned")))
uint32_t build_lists_turned(uint32_t activeByte, uint32_t xByte, uint32_t yByte, uint32_t onScreenByte, uint32_t n,
                            uint32_t activeListByte, uint32_t visibleListByte, double zoom, double offX, double offY,
                            double halfCw, double halfCh, double rc, double rs, double limW, double limH) {
  const uint8_t *active = (const uint8_t *)activeByte;
  const float *x = (const float *)xByte;
  const float *y = (const float *)yByte;
  uint8_t *on = (uint8_t *)onScreenByte;
  uint16_t *al = (uint16_t *)activeListByte;
  uint16_t *vl = (uint16_t *)visibleListByte;
  const v128_t Z = wasm_f64x2_splat(zoom), OX = wasm_f64x2_splat(offX), OY = wasm_f64x2_splat(offY);
  const v128_t HW = wasm_f64x2_splat(halfCw), HH = wasm_f64x2_splat(halfCh);
  const v128_t RC = wasm_f64x2_splat(rc), RS = wasm_f64x2_splat(rs);
  const v128_t LW = wasm_f64x2_splat(limW), LH = wasm_f64x2_splat(limH);
  const v128_t NW = wasm_f64x2_splat(-limW), NH = wasm_f64x2_splat(-limH);
  uint32_t ac = 0, vc = 0, i = 0;
  for (; i + 16 <= n; i += 16) {
    uint32_t mask = live_mask(active, i);
    if (mask == 0) continue;
    if (mask == 0xffff) {
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
      const uint32_t v = on_turned(x, y, k, zoom, offX, offY, halfCw, halfCh, rc, rs, limW, limH);
      al[1 + ac++] = (uint16_t)k;
      on[k] = (uint8_t)v;
      vl[1 + vc] = (uint16_t)k;
      vc += v;
    } while (mask);
  }
  for (; i < n; i++) {
    if (!active[i]) continue;
    const uint32_t v = on_turned(x, y, i, zoom, offX, offY, halfCw, halfCh, rc, rs, limW, limH);
    al[1 + ac++] = (uint16_t)i;
    on[i] = (uint8_t)v;
    vl[1 + vc] = (uint16_t)i;
    vc += v;
  }
  al[0] = (uint16_t)ac;
  vl[0] = (uint16_t)vc;
  return ac;
}

/* buildActiveListBuffers (no camera yet): the active list only; the visible count is set to 0. */
__attribute__((export_name("build_active")))
uint32_t build_active(uint32_t activeByte, uint32_t n, uint32_t activeListByte, uint32_t visibleListByte) {
  const uint8_t *active = (const uint8_t *)activeByte;
  uint16_t *al = (uint16_t *)activeListByte;
  uint32_t ac = 0, i = 0;
  for (; i + 16 <= n; i += 16) {
    uint32_t mask = live_mask(active, i);
    while (mask) {
      al[1 + ac++] = (uint16_t)(i + (uint32_t)__builtin_ctz(mask));
      mask &= mask - 1;
    }
  }
  for (; i < n; i++) {
    if (active[i]) al[1 + ac++] = (uint16_t)i;
  }
  al[0] = (uint16_t)ac;
  ((uint16_t *)visibleListByte)[0] = 0;
  return ac;
}
