/* The instanced-row pack (E-76 W9): packInstancedRows (src/render/gpuQueueLayout.js) on its two fast
   paths, world space, no pixel snap, no type filter: sprite rows (15 floats) and caster rows (22).
   The render-queue columns and the destination are byte offsets into the imported shared memory, the
   columns through a table written once per queue (src/render/gpuPackClient.js). Arithmetic as JS
   does it: alpha clamped and rounded in double, depth and the tile-offset scale in double, each
   stored as float. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

/* Column table: byte offsets of the queue columns, one u32 each, in this order. */
enum {
  COL_X, COL_Y, COL_SCALE_X, COL_SCALE_Y, COL_ROT_C, COL_ROT_S, COL_ALPHA, COL_TINT, COL_TEXTURE,
  COL_ANCHOR_X, COL_ANCHOR_Y, COL_TILE_MUL_X, COL_TILE_MUL_Y, COL_TILE_OFF_U, COL_TILE_OFF_V,
  COL_SHADOW_H, COL_SHADOW_OFF_X, COL_SHADOW_OFF_Y, COL_COUNT
};

#define F32(t, c) ((const float *)(uintptr_t)(t)[c])
#define U16(t, c) ((const uint16_t *)(uintptr_t)(t)[c])

INLINE uint32_t packed_tint(double a, uint32_t tint) {
  if (!(a >= 0)) a = 0; /* NaN too: JS clamps nothing, then `| 0` makes it 0 */
  else if (a > 1) a = 1;
  const int32_t a8 = (int32_t)(a * 255.0 + 0.5);
  return ((uint32_t)(a8 & 255) << 24) | (tint & 0xffffff);
}

/* One row's first 15 floats. */
INLINE void sprite_row(const uint32_t *t, uint32_t i, float *d, double depth) {
  const double inv65535 = 1.0 / 65535.0;
  d[0] = F32(t, COL_X)[i];
  d[1] = F32(t, COL_Y)[i];
  d[2] = F32(t, COL_SCALE_X)[i];
  d[3] = F32(t, COL_SCALE_Y)[i];
  d[4] = F32(t, COL_ANCHOR_X)[i];
  d[5] = F32(t, COL_ANCHOR_Y)[i];
  d[6] = F32(t, COL_ROT_C)[i];
  d[7] = F32(t, COL_ROT_S)[i];
  d[8] = (float)depth;
  ((uint32_t *)d)[9] = packed_tint((double)F32(t, COL_ALPHA)[i], ((const uint32_t *)(uintptr_t)t[COL_TINT])[i]);
  d[10] = (float)U16(t, COL_TEXTURE)[i];
  d[11] = F32(t, COL_TILE_MUL_X)[i];
  d[12] = F32(t, COL_TILE_MUL_Y)[i];
  d[13] = (float)((double)U16(t, COL_TILE_OFF_U)[i] * inv65535);
  d[14] = (float)((double)U16(t, COL_TILE_OFF_V)[i] * inv65535);
}

/* Writes min(count, cap) rows, row k from queue row indices[k] (or k when indices is 0), at dst.
   The rows whose type is 1 are counted into *particles when type is not 0. caster: 22-float rows. */
INLINE uint32_t pack(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                     float *dst, uint32_t typeByte, uint32_t *particles, int caster) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t n = count < cap ? count : cap;
  const uint32_t stride = caster ? 22 : 15;
  uint32_t p = 0;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (type) p += type[i] == 1;
    float *d = dst + k * stride;
    sprite_row(t, i, d, 1.0 - (double)(k + 1) * invDepthDenom);
    if (caster) {
      d[15] = F32(t, COL_SHADOW_H)[i];
      d[16] = F32(t, COL_SHADOW_OFF_X)[i];
      d[17] = F32(t, COL_SHADOW_OFF_Y)[i];
      d[18] = 0;
      d[19] = 0;
      d[20] = 0;
      d[21] = 0;
    }
  }
  *particles = p;
  return n;
}

__attribute__((export_name("pack_sprites")))
uint32_t pack_sprites(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                      uint32_t dst, uint32_t typeByte, uint32_t particlesOut) {
  return pack((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
              (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, 0);
}

__attribute__((export_name("pack_casters")))
uint32_t pack_casters(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                      uint32_t dst, uint32_t typeByte, uint32_t particlesOut) {
  return pack((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
              (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, 1);
}
