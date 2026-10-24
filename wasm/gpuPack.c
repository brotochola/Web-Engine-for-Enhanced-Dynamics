/* The instanced-row pack (E-76 W9): packInstancedRows (src/render/gpuQueueLayout.js) on its two fast
   paths, world space, no pixel snap, no type filter: sprite rows (15 floats) and caster rows (22), and
   sprite rows split into a pose stream and a static stream (E-82b, packSplitRows).
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

/* W9b. The same rows through the inverse of the index list: inv[queue row] = output slot, then the
   queue read in order and each listed row written to its slot. The reads go in order instead of
   jumping across the queue; the writes jump instead. The output is the gather's when every listed row
   is listed once and below rowCount; otherwise nothing is written and 0xffffffff comes back, and the
   caller gathers. inv holds rowCount u32. */
INLINE uint32_t pack_scatter(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                             float *dst, uint32_t typeByte, uint32_t *particles, uint32_t invByte, uint32_t rowCount,
                             int caster) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  uint32_t *inv = (uint32_t *)(uintptr_t)invByte;
  const uint32_t n = count < cap ? count : cap;
  const uint32_t stride = caster ? 22 : 15;
  for (uint32_t i = 0; i < rowCount; i++) inv[i] = 0xffffffffu;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t r = idx[k];
    if (r >= rowCount || inv[r] != 0xffffffffu) return 0xffffffffu;
    inv[r] = k;
  }
  uint32_t p = 0;
  for (uint32_t i = 0; i < rowCount; i++) {
    const uint32_t k = inv[i];
    if (k == 0xffffffffu) continue;
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

/* E-82b. A plain sprite's row in two streams: the pose (x, y, rotC, rotS), written every frame, and the
   statics (scale, anchor, depth, packed tint, texture, tile terms, in E-82's static order:
   instancedSpriteBatch.js POSE_STATIC_FLOATS), written only when they changed. The values are
   sprite_row's. */
#define POSE_FLOATS 4
#define STATIC_FLOATS 11

INLINE void sprite_pose(const uint32_t *t, uint32_t i, float *d) {
  d[0] = F32(t, COL_X)[i];
  d[1] = F32(t, COL_Y)[i];
  d[2] = F32(t, COL_ROT_C)[i];
  d[3] = F32(t, COL_ROT_S)[i];
}

INLINE void sprite_static(const uint32_t *t, uint32_t i, float *d, double depth) {
  const double inv65535 = 1.0 / 65535.0;
  d[0] = F32(t, COL_SCALE_X)[i];
  d[1] = F32(t, COL_SCALE_Y)[i];
  d[2] = F32(t, COL_ANCHOR_X)[i];
  d[3] = F32(t, COL_ANCHOR_Y)[i];
  d[4] = (float)depth;
  ((uint32_t *)d)[5] = packed_tint((double)F32(t, COL_ALPHA)[i], ((const uint32_t *)(uintptr_t)t[COL_TINT])[i]);
  d[6] = (float)U16(t, COL_TEXTURE)[i];
  d[7] = F32(t, COL_TILE_MUL_X)[i];
  d[8] = F32(t, COL_TILE_MUL_Y)[i];
  d[9] = (float)((double)U16(t, COL_TILE_OFF_U)[i] * inv65535);
  d[10] = (float)((double)U16(t, COL_TILE_OFF_V)[i] * inv65535);
}

/* pack() for the two streams; statics 0 writes the pose alone. */
INLINE uint32_t pack_split(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                           float *pose, float *stat, uint32_t typeByte, uint32_t *particles, int statics) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t n = count < cap ? count : cap;
  uint32_t p = 0;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (type) p += type[i] == 1;
    sprite_pose(t, i, pose + k * POSE_FLOATS);
    if (statics) sprite_static(t, i, stat + k * STATIC_FLOATS, 1.0 - (double)(k + 1) * invDepthDenom);
  }
  *particles = p;
  return n;
}

/* pack_scatter() for the two streams, with both always: a listed frame's order may have moved, so its
   statics are never known to be current. */
INLINE uint32_t pack_split_scatter(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap,
                                   double invDepthDenom, float *pose, float *stat, uint32_t typeByte,
                                   uint32_t *particles, uint32_t invByte, uint32_t rowCount) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  uint32_t *inv = (uint32_t *)(uintptr_t)invByte;
  const uint32_t n = count < cap ? count : cap;
  for (uint32_t i = 0; i < rowCount; i++) inv[i] = 0xffffffffu;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t r = idx[k];
    if (r >= rowCount || inv[r] != 0xffffffffu) return 0xffffffffu;
    inv[r] = k;
  }
  uint32_t p = 0;
  for (uint32_t i = 0; i < rowCount; i++) {
    const uint32_t k = inv[i];
    if (k == 0xffffffffu) continue;
    if (type) p += type[i] == 1;
    sprite_pose(t, i, pose + k * POSE_FLOATS);
    sprite_static(t, i, stat + k * STATIC_FLOATS, 1.0 - (double)(k + 1) * invDepthDenom);
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

__attribute__((export_name("pack_sprites_scatter")))
uint32_t pack_sprites_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 0);
}

__attribute__((export_name("pack_casters_scatter")))
uint32_t pack_casters_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 1);
}

/* E-82b: the pose stream at dstPose, and the statics at dstStatic unless it is 0. */
__attribute__((export_name("pack_sprites_split")))
uint32_t pack_sprites_split(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                            uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte, uint32_t particlesOut) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  if (dstStatic) return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 1);
  return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 0);
}

__attribute__((export_name("pack_sprites_split_scatter")))
uint32_t pack_sprites_split_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap,
                                    double invDepthDenom, uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte,
                                    uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_split_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                            (float *)(uintptr_t)dstPose, (float *)(uintptr_t)dstStatic, typeByte,
                            (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount);
}
