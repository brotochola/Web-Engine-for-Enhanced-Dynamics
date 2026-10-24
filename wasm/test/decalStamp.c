/* Decal stamping (E-76 W26), a test module: Decal.stampToTileBuffers (src/core/decal.js) for a batch of
   stamps in one call, the pixel loop four pixels per vector. Every array is a byte offset into the decal
   memory, through the table: the RGBA tiles, their dirty flags, the stamp records the caller writes from
   the drained ring, the textures they name, and a clip's column map as scratch. Arithmetic as the JS does
   it: the world and pixel geometry in double, its `| 0` as ToInt32, the sample positions accumulated in
   the same order (a clip's columns once, then each row), and each tile's dirty flag stored atomically
   after its pixels, once per stamp and tile as the JS stores it.

   The blend is exact in 16-bit lanes. Normal: dst + (((f - dst) * a + 127) >> 8) is
   (dst * (256 - a) + f * a + 127) >> 8, and a + ((dstA * (255 - a) + 127) >> 8) is
   (dstA * (255 - a) + 256 * a + 127) >> 8. Multiply: (dst * inv + 127) >> 8, and
   e + ((dstA * inv + 127) >> 8) is (dstA * inv + 256 * e + 127) >> 8, inv = 255 - e. Every term is
   non-negative and each sum is at most 65 407 while a and e stay in 0..255, so no lane wraps and no store
   clamps; they stay there for an alpha in (0, 256/255). srcA = (texAlpha * alpha) | 0 needs no double
   either: a float32 alpha (the ring and the particle columns hold float32) is m * 2^-s with m below 2^24,
   so the double product is exact and its truncation is (texAlpha * m) >> s, a u32 multiply and a shift.
   Any other alpha (a double from a local Decal.stamp, zero or negative, NaN, past 256/255 where the
   stores clamp) takes the scalar loop, which is the JS line for line. Returns the tiles stamped (one per
   stamp and tile whose clip region is valid: the dirty-flag stores). */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))

enum {
  T_TILES,       /* the RGBA tiles, tile after tile, tilePixels * tilePixels pixels each */
  T_DIRTY,       /* a byte per tile, 1 once a stamp reached it */
  T_TILES_X,
  T_TILES_Y,
  T_TILE_PIXELS,
  T_STAMPS,      /* the stamp records */
  T_COLUMNS,     /* scratch: a clip's column map, two arrays of column_stride(T_COLUMNS_CAP) u32 */
  T_COLUMNS_CAP, /* the widest clip the map holds (tilePixels holds every clip); wider ones go scalar */
  T_FLAGS,
  SLOT_COUNT
};

/* T_FLAGS: every stamp through the scalar loop (the bench's wasm-scalar variant). */
#define F_SCALAR 1u

/* One stamp, 64 bytes: f64 x, y, scaleX, scaleY, alpha; u32 tint, blendMode (1 = multiply, the JS
   `blendMode === 1`), the texture's byte offset, its width and height in pixels, and a pad. */
typedef struct {
  double x, y, scaleX, scaleY, alpha;
  uint32_t tint, blendMode, tex, texW, texH, pad;
} Stamp;
_Static_assert(sizeof(Stamp) == 64, "a stamp record is 64 bytes");

/* ECMAScript ToInt32 (V8's DoubleToInt32): in range a truncation, else the low 32 bits. */
INLINE int32_t js_to_int32(double x) {
  if (x >= -2147483648.0 && x <= 2147483647.0) return (int32_t)x;
  union { double d; uint64_t u; } b = { .d = x };
  const int biased = (int)((b.u >> 52) & 0x7ff);
  if (biased == 0x7ff) return 0;
  const int exponent = biased - 1075;
  const uint64_t sig = (b.u & 0xfffffffffffffull) | 0x10000000000000ull;
  uint64_t bits;
  if (exponent < 0) {
    if (exponent <= -53) return 0;
    bits = sig >> -exponent;
  } else {
    if (exponent > 31) return 0;
    bits = sig << exponent;
  }
  const uint64_t v = (b.u >> 63) ? (uint64_t)(-(int64_t)bits) : bits;
  return (int32_t)(uint32_t)v;
}

/* JS `v >> 8` on a sum whose exact value is below 2^53: ToInt32 keeps its low 32 bits, which u32
   arithmetic on the same terms gives. */
INLINE int32_t js_shr8(uint32_t v) { return (int32_t)v >> 8; }

/* A Uint8ClampedArray store of an integer. */
INLINE uint8_t clamp_u8(int64_t v) { return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v); }

/* u32 entries in each column-map array: the widest clip and the three zero entries after it, in vectors. */
INLINE uint32_t column_stride(uint32_t cap) { return (cap + 6u) & ~3u; }

/* The JS pixel loop for one clip, line for line, for any alpha. */
static void clip_scalar(const uint8_t *tex, int32_t texW, int32_t texH, uint8_t *tiles, uint32_t tileByteOffset,
                        uint32_t tilePixels, int32_t dstStartX, int32_t dstStartY, int32_t dstEndX, int32_t dstEndY,
                        double srcXStart, double srcYStart, double stepX, double stepY, int32_t tintR,
                        int32_t tintG, int32_t tintB, double alpha, uint32_t multiply) {
  double srcYAccum = srcYStart;
  for (int32_t dstY = dstStartY; dstY < dstEndY; dstY++, srcYAccum += stepY) {
    const int32_t srcY = js_to_int32(srcYAccum);
    if (srcY < 0 || srcY >= texH) continue;
    const int32_t srcRowOffset = srcY * texW;
    const uint32_t dstRowOffset = tileByteOffset + (uint32_t)dstY * tilePixels * 4;
    double srcXAccum = srcXStart;
    for (int32_t dstX = dstStartX; dstX < dstEndX; dstX++, srcXAccum += stepX) {
      const int32_t srcX = js_to_int32(srcXAccum);
      if (srcX < 0 || srcX >= texW) continue;
      const uint8_t *src = tex + (uint32_t)(srcRowOffset + srcX) * 4;
      const int32_t texAlpha = src[3];
      if (texAlpha < 1) continue;
      uint8_t *dst = tiles + dstRowOffset + (uint32_t)dstX * 4;
      if (multiply) {
        const int32_t tintedR = (src[0] * tintR + 127) >> 8;
        const int32_t tintedG = (src[1] * tintG + 127) >> 8;
        const int32_t tintedB = (src[2] * tintB + 127) >> 8;
        const int32_t luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;
        const int32_t darkness = 255 - luminance;
        const int32_t effectiveAlpha = js_to_int32((double)((texAlpha * darkness) >> 8) * alpha);
        if (effectiveAlpha < 2) continue;
        const uint32_t inv = 255u - (uint32_t)effectiveAlpha;
        const uint32_t dstA = dst[3];
        dst[0] = clamp_u8(js_shr8(dst[0] * inv + 127u));
        dst[1] = clamp_u8(js_shr8(dst[1] * inv + 127u));
        dst[2] = clamp_u8(js_shr8(dst[2] * inv + 127u));
        dst[3] = clamp_u8((int64_t)effectiveAlpha + js_shr8(dstA * inv + 127u));
      } else {
        const int32_t srcA = js_to_int32((double)texAlpha * alpha);
        if (srcA < 1) continue;
        const int32_t finalR = (src[0] * tintR + 127) >> 8;
        const int32_t finalG = (src[1] * tintG + 127) >> 8;
        const int32_t finalB = (src[2] * tintB + 127) >> 8;
        const uint32_t invSrcA = 255u - (uint32_t)srcA;
        const int32_t dstR = dst[0];
        const int32_t dstG = dst[1];
        const int32_t dstB = dst[2];
        const uint32_t dstA = dst[3];
        dst[0] = clamp_u8(dstR + js_shr8((uint32_t)(finalR - dstR) * (uint32_t)srcA + 127u));
        dst[1] = clamp_u8(dstG + js_shr8((uint32_t)(finalG - dstG) * (uint32_t)srcA + 127u));
        dst[2] = clamp_u8(dstB + js_shr8((uint32_t)(finalB - dstB) * (uint32_t)srcA + 127u));
        dst[3] = clamp_u8((int64_t)srcA + js_shr8(dstA * invSrcA + 127u));
      }
    }
  }
}

/* A clip's column map: each column's sample as a byte offset into its texture row, and a lane mask, 0
   where the sample falls outside the texture (the JS skips it); three zero entries after the last. */
INLINE void build_columns(int32_t *off, uint32_t *mask, int32_t n, double srcXAccum, double stepX, int32_t texW) {
  for (int32_t c = 0; c < n; c++, srcXAccum += stepX) {
    const int32_t srcX = js_to_int32(srcXAccum);
    const int in = srcX >= 0 && srcX < texW;
    off[c] = in ? srcX * 4 : 0;
    mask[c] = in ? 0xffffffffu : 0u;
  }
  for (int32_t c = n; c < n + 3; c++) {
    off[c] = 0;
    mask[c] = 0;
  }
}

/* Four texels of a row through the column map, 0 in the masked lanes. */
INLINE v128_t gather4(const uint8_t *row, const int32_t *off, const uint32_t *mask) {
  v128_t v = wasm_v128_load32_zero(row + off[0]);
  v = wasm_v128_load32_lane(row + off[1], v, 1);
  v = wasm_v128_load32_lane(row + off[2], v, 2);
  v = wasm_v128_load32_lane(row + off[3], v, 3);
  return wasm_v128_and(v, wasm_v128_load(mask));
}

/* The first r (1..3) pixels at d, the other lanes 0; and their store. */
INLINE v128_t load_part(const uint8_t *d, int32_t r) {
  if (r == 1) return wasm_v128_load32_zero(d);
  const v128_t v = wasm_v128_load64_zero(d);
  return r == 2 ? v : wasm_v128_load32_lane(d + 8, v, 2);
}

INLINE void store_part(uint8_t *d, v128_t v, int32_t r) {
  if (r == 1) {
    wasm_v128_store32_lane(d, v, 0);
    return;
  }
  wasm_v128_store64_lane(d, v, 0);
  if (r == 3) wasm_v128_store32_lane(d + 8, v, 2);
}

/* (v * alpha) | 0 per lane for v in 0..255 and a float32 alpha = m * 2^-s. */
INLINE v128_t times_alpha(v128_t v, v128_t m, uint32_t s) { return wasm_u32x4_shr(wasm_i32x4_mul(v, m), s); }

/* Lanes 0, 1 (lo) or 2, 3 (hi) of an i32x4 below 2^16, each over its pixel's four u16 lanes. */
INLINE v128_t spread_lo(v128_t v) { return wasm_i8x16_shuffle(v, v, 0, 1, 0, 1, 0, 1, 0, 1, 4, 5, 4, 5, 4, 5, 4, 5); }
INLINE v128_t spread_hi(v128_t v) { return wasm_i8x16_shuffle(v, v, 8, 9, 8, 9, 8, 9, 8, 9, 12, 13, 12, 13, 12, 13, 12, 13); }

/* (src * tint + 127) >> 8 per u16 lane; 0 in the alpha lanes, whose tint lane is 0. */
INLINE v128_t tinted(v128_t src, v128_t tint) {
  return wasm_u16x8_shr(wasm_i16x8_add(wasm_i16x8_mul(src, tint), wasm_i16x8_splat(127)), 8);
}

/* (d * wd + s * ws + 127) >> 8 per u16 lane; the callers keep the sum below 2^16. */
INLINE v128_t mix(v128_t d, v128_t wd, v128_t s, v128_t ws) {
  const v128_t sum = wasm_i16x8_add(wasm_i16x8_mul(d, wd), wasm_i16x8_mul(s, ws));
  return wasm_u16x8_shr(wasm_i16x8_add(sum, wasm_i16x8_splat(127)), 8);
}

/* Normal blend of four texels over four pixels, srcA in a (1..255 where it draws). */
INLINE v128_t blend_normal(v128_t texel, v128_t old, v128_t a, v128_t tint) {
  const v128_t keep = wasm_i16x8_make(256, 256, 256, 255, 256, 256, 256, 255);
  const v128_t alpha256 = wasm_i16x8_make(0, 0, 0, 256, 0, 0, 0, 256);
  const v128_t a01 = spread_lo(a);
  const v128_t a23 = spread_hi(a);
  const v128_t s01 = wasm_v128_or(tinted(wasm_u16x8_extend_low_u8x16(texel), tint), alpha256);
  const v128_t s23 = wasm_v128_or(tinted(wasm_u16x8_extend_high_u8x16(texel), tint), alpha256);
  const v128_t o01 = mix(wasm_u16x8_extend_low_u8x16(old), wasm_i16x8_sub(keep, a01), s01, a01);
  const v128_t o23 = mix(wasm_u16x8_extend_high_u8x16(old), wasm_i16x8_sub(keep, a23), s23, a23);
  return wasm_u8x16_narrow_i16x8(o01, o23);
}

/* Multiply's effectiveAlpha for four texels: ((texAlpha * (255 - luminance)) >> 8) * alpha, | 0. */
INLINE v128_t multiply_alpha(v128_t texel, v128_t tint, v128_t m, uint32_t s) {
  const v128_t weights = wasm_i16x8_make(77, 150, 29, 0, 77, 150, 29, 0);
  const v128_t p01 = wasm_i32x4_dot_i16x8(tinted(wasm_u16x8_extend_low_u8x16(texel), tint), weights);
  const v128_t p23 = wasm_i32x4_dot_i16x8(tinted(wasm_u16x8_extend_high_u8x16(texel), tint), weights);
  const v128_t luminance = wasm_u32x4_shr(wasm_i32x4_add(wasm_i32x4_shuffle(p01, p23, 0, 2, 4, 6),
                                                         wasm_i32x4_shuffle(p01, p23, 1, 3, 5, 7)), 8);
  const v128_t darkness = wasm_i32x4_sub(wasm_i32x4_splat(255), luminance);
  return times_alpha(wasm_u32x4_shr(wasm_i32x4_mul(wasm_u32x4_shr(texel, 24), darkness), 8), m, s);
}

/* Multiply blend over four pixels, effectiveAlpha in e (2..254 where it draws). */
INLINE v128_t blend_multiply(v128_t old, v128_t e) {
  const v128_t alpha256 = wasm_i16x8_make(0, 0, 0, 256, 0, 0, 0, 256);
  const v128_t c255 = wasm_i16x8_splat(255);
  const v128_t e01 = spread_lo(e);
  const v128_t e23 = spread_hi(e);
  const v128_t o01 = mix(wasm_u16x8_extend_low_u8x16(old), wasm_i16x8_sub(c255, e01), alpha256, e01);
  const v128_t o23 = mix(wasm_u16x8_extend_high_u8x16(old), wasm_i16x8_sub(c255, e23), alpha256, e23);
  return wasm_u8x16_narrow_i16x8(o01, o23);
}

/* Four pixels from column c, n - c of them when fewer are left; lanes that do not draw keep their bytes. */
INLINE void group(const uint8_t *row, uint8_t *dst, const int32_t *off, const uint32_t *mask, int32_t c, int32_t n,
                  v128_t tint, v128_t m, uint32_t s, int multiply) {
  const v128_t texel = gather4(row, off + c, mask + c);
  const v128_t a = multiply ? multiply_alpha(texel, tint, m, s) : times_alpha(wasm_u32x4_shr(texel, 24), m, s);
  const v128_t draw = wasm_i32x4_gt(a, wasm_i32x4_splat(multiply ? 1 : 0));
  if (!wasm_v128_any_true(draw)) return;
  uint8_t *d = dst + c * 4;
  const int32_t r = n - c;
  const v128_t old = r >= 4 ? wasm_v128_load(d) : load_part(d, r);
  const v128_t out = wasm_v128_bitselect(multiply ? blend_multiply(old, a) : blend_normal(texel, old, a, tint), old, draw);
  if (r >= 4) wasm_v128_store(d, out);
  else store_part(d, out, r);
}

/* One clip four pixels at a time: the column map once, then each row whose sample row is in the texture. */
INLINE void clip_simd(const uint8_t *tex, int32_t texW, int32_t texH, uint8_t *tiles, uint32_t tileByteOffset,
                      uint32_t tilePixels, int32_t dstStartX, int32_t dstStartY, int32_t n, int32_t dstEndY,
                      double srcXStart, double srcYStart, double stepX, double stepY, int32_t *off, uint32_t *mask,
                      v128_t tint, v128_t m, uint32_t s, int multiply) {
  build_columns(off, mask, n, srcXStart, stepX, texW);
  double srcYAccum = srcYStart;
  for (int32_t dstY = dstStartY; dstY < dstEndY; dstY++, srcYAccum += stepY) {
    const int32_t srcY = js_to_int32(srcYAccum);
    if (srcY < 0 || srcY >= texH) continue;
    const uint8_t *row = tex + (uint32_t)(srcY * texW) * 4;
    uint8_t *dst = tiles + tileByteOffset + ((uint32_t)dstY * tilePixels + (uint32_t)dstStartX) * 4;
    int32_t c = 0;
    for (; c + 4 <= n; c += 4) group(row, dst, off, mask, c, n, tint, m, s, multiply);
    if (c < n) group(row, dst, off, mask, c, n, tint, m, s, multiply);
  }
}

__attribute__((export_name("stamp_tiles")))
uint32_t stamp_tiles(uint32_t table, uint32_t count, double tileSize, double resolution) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  uint8_t *tiles = (uint8_t *)(uintptr_t)t[T_TILES];
  uint8_t *dirty = (uint8_t *)(uintptr_t)t[T_DIRTY];
  const int32_t tilesX = (int32_t)t[T_TILES_X];
  const int32_t tilesY = (int32_t)t[T_TILES_Y];
  const uint32_t tilePixels = t[T_TILE_PIXELS];
  const Stamp *rec = (const Stamp *)(uintptr_t)t[T_STAMPS];
  const uint32_t cap = t[T_COLUMNS_CAP];
  int32_t *off = (int32_t *)(uintptr_t)t[T_COLUMNS];
  uint32_t *mask = (uint32_t *)(uintptr_t)(t[T_COLUMNS] + column_stride(cap) * 4);
  const uint32_t scalarOnly = t[T_FLAGS] & F_SCALAR;
  const double worldToPixel = (double)tilePixels / tileSize;
  uint32_t stamped = 0;

  for (uint32_t k = 0; k < count; k++) {
    const Stamp *s = rec + k;
    const double worldX = s->x;
    const double worldY = s->y;
    const int32_t texW = (int32_t)s->texW;
    const int32_t texH = (int32_t)s->texH;
    const double alpha = s->alpha;
    const uint32_t multiply = s->blendMode == 1;
    const uint8_t *tex = (const uint8_t *)(uintptr_t)s->tex;

    const double scaledWidthWorld = (double)texW * s->scaleX;
    const double scaledHeightWorld = (double)texH * s->scaleY;
    const double halfWidthWorld = scaledWidthWorld / 2;
    const double halfHeightWorld = scaledHeightWorld / 2;
    const int32_t scaledWidthPixels = js_to_int32(scaledWidthWorld * resolution + 0.999);
    const int32_t scaledHeightPixels = js_to_int32(scaledHeightWorld * resolution + 0.999);

    /* calculateDecalTileBounds */
    const double decalMinWorldX = worldX - halfWidthWorld;
    const double decalMaxWorldX = worldX + halfWidthWorld;
    const double decalMinWorldY = worldY - halfHeightWorld;
    const double decalMaxWorldY = worldY + halfHeightWorld;
    int32_t minTileX = js_to_int32(decalMinWorldX / tileSize);
    int32_t maxTileX = js_to_int32(decalMaxWorldX / tileSize);
    int32_t minTileY = js_to_int32(decalMinWorldY / tileSize);
    int32_t maxTileY = js_to_int32(decalMaxWorldY / tileSize);
    minTileX = minTileX < 0 ? 0 : minTileX;
    maxTileX = maxTileX >= tilesX ? tilesX - 1 : maxTileX;
    minTileY = minTileY < 0 ? 0 : minTileY;
    maxTileY = maxTileY >= tilesY ? tilesY - 1 : maxTileY;
    if (!(minTileX <= maxTileX && minTileY <= maxTileY)) continue;

    const int32_t tintR = (int32_t)((s->tint >> 16) & 0xff);
    const int32_t tintG = (int32_t)((s->tint >> 8) & 0xff);
    const int32_t tintB = (int32_t)(s->tint & 0xff);
    const double invScaledWidth = (double)texW / (double)scaledWidthPixels;
    const double invScaledHeight = (double)texH / (double)scaledHeightPixels;

    /* The vector loop's alpha: a float32 in (0, 256/255) (tested before the cast), as m * 2^-shift. */
    const int simd = !scalarOnly && alpha > 0.0 && alpha * 255.0 < 256.0 && (double)(float)alpha == alpha;
    uint32_t alphaM = 0;
    uint32_t shift = 0;
    if (simd) {
      union { float f; uint32_t u; } fb = { .f = (float)alpha };
      const uint32_t biased = fb.u >> 23;
      alphaM = biased ? (fb.u & 0x7fffffu) | 0x800000u : fb.u;
      shift = biased ? 150u - biased : 149u;
      if (shift > 31u) {
        /* alpha below 2^-8: every srcA and effectiveAlpha is 0 */
        alphaM = 0;
        shift = 0;
      }
    }
    const v128_t tint = wasm_i16x8_make((int16_t)tintR, (int16_t)tintG, (int16_t)tintB, 0, (int16_t)tintR,
                                        (int16_t)tintG, (int16_t)tintB, 0);
    const v128_t m = wasm_i32x4_splat((int32_t)alphaM);

    for (int32_t ty = minTileY; ty <= maxTileY; ty++) {
      for (int32_t tx = minTileX; tx <= maxTileX; tx++) {
        /* calculateTileClipRegion */
        const double tileMinWorldX = (double)tx * tileSize;
        const double tileMaxWorldX = (double)(tx + 1) * tileSize;
        const double tileMinWorldY = (double)ty * tileSize;
        const double tileMaxWorldY = (double)(ty + 1) * tileSize;
        const double clipMinWorldX = decalMinWorldX > tileMinWorldX ? decalMinWorldX : tileMinWorldX;
        const double clipMaxWorldX = decalMaxWorldX < tileMaxWorldX ? decalMaxWorldX : tileMaxWorldX;
        const double clipMinWorldY = decalMinWorldY > tileMinWorldY ? decalMinWorldY : tileMinWorldY;
        const double clipMaxWorldY = decalMaxWorldY < tileMaxWorldY ? decalMaxWorldY : tileMaxWorldY;
        if (clipMinWorldX >= clipMaxWorldX || clipMinWorldY >= clipMaxWorldY) continue;
        const int32_t dstStartX = js_to_int32((clipMinWorldX - tileMinWorldX) * worldToPixel);
        const int32_t dstStartY = js_to_int32((clipMinWorldY - tileMinWorldY) * worldToPixel);
        const int32_t dstEndX = js_to_int32((clipMaxWorldX - tileMinWorldX) * worldToPixel);
        const int32_t dstEndY = js_to_int32((clipMaxWorldY - tileMinWorldY) * worldToPixel);
        const double decalWidthWorld = halfWidthWorld * 2;
        const double decalHeightWorld = halfHeightWorld * 2;
        const double srcOffsetX = ((clipMinWorldX - decalMinWorldX) / decalWidthWorld) * (double)scaledWidthPixels;
        const double srcOffsetY = ((clipMinWorldY - decalMinWorldY) / decalHeightWorld) * (double)scaledHeightPixels;
        const double uvScaleX = (double)scaledWidthPixels / (decalWidthWorld * worldToPixel);
        const double uvScaleY = (double)scaledHeightPixels / (decalHeightWorld * worldToPixel);

        const uint32_t tileIndex = (uint32_t)(tx + ty * tilesX);
        const uint32_t tileByteOffset = tileIndex * tilePixels * tilePixels * 4;
        const double stepX = uvScaleX * invScaledWidth;
        const double stepY = uvScaleY * invScaledHeight;
        const double srcXStart = srcOffsetX * invScaledWidth;
        const double srcYStart = srcOffsetY * invScaledHeight;
        const int32_t n = dstEndX - dstStartX;

        if (n > 0 && dstEndY > dstStartY) {
          if (simd && (uint32_t)n <= cap) {
            if (multiply) {
              clip_simd(tex, texW, texH, tiles, tileByteOffset, tilePixels, dstStartX, dstStartY, n, dstEndY, srcXStart,
                        srcYStart, stepX, stepY, off, mask, tint, m, shift, 1);
            } else {
              clip_simd(tex, texW, texH, tiles, tileByteOffset, tilePixels, dstStartX, dstStartY, n, dstEndY, srcXStart,
                        srcYStart, stepX, stepY, off, mask, tint, m, shift, 0);
            }
          } else {
            clip_scalar(tex, texW, texH, tiles, tileByteOffset, tilePixels, dstStartX, dstStartY, dstEndX, dstEndY,
                        srcXStart, srcYStart, stepX, stepY, tintR, tintG, tintB, alpha, multiply);
          }
        }
        /* B-03: after every pixel of this tile, a single atomic step (Atomics.store in the JS). */
        __atomic_store_n(dirty + tileIndex, (uint8_t)1, __ATOMIC_SEQ_CST);
        stamped++;
      }
    }
  }
  return stamped;
}
