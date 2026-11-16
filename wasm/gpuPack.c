/* The instanced-row pack (E-76 W9): packInstancedRows (src/render/gpuQueueLayout.js) on its two fast
   paths, world space, no pixel snap, no type filter: sprite rows (15 floats) and caster rows (22), and
   sprite rows split into a pose stream and a static stream (E-82b, packSplitRows). Its slow path too (close-out
   group B): pack_sprites_general and pack_casters_general take a type filter, screen space (with the camera's turn)
   and pixel snap, from a block of doubles the client writes. And a pose batch's two streams (W9e, renderer.interpolation): pack_pose.
   E-444: pre-render's split and indexed packs with the instances' G-buffer words (the _gbuf exports, gbuf_cols).
   The render-queue columns and the destination are byte offsets into the imported shared memory, the
   columns through a table written once per queue (src/render/gpuPackClient.js). Arithmetic as JS
   does it: alpha clamped and rounded in double, depth and the tile-offset scale in double, each
   stored as float. */
#include <stdint.h>
#include <wasm_simd128.h>

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

/* E-394: the columns of E-372's sun frames' region a framed caster pack reads (sun_cols, defined with the region below),
   and a full caster row's sun frame and entity (full_row_sun_frame). */
typedef struct {
  const uint8_t *rowType;
  const int32_t *rowEntity;
  uint32_t entities;
  const uint8_t *active, *mode, *direction, *animation, *casts, *orient, *kind, *sheet;
  const uint16_t *frame;
  const uint32_t *sheets;
  uint32_t *list;
  uint32_t listCap;
} SunCols;
INLINE void sun_cols(const uint32_t *S, SunCols *c);
INLINE void full_row_sun_frame(float *d, uint32_t i, uint32_t k, const SunCols *c, uint32_t *listed);
INLINE void sun_cols_listed(uint32_t *S, uint32_t listed);

/* Writes min(count, cap) rows, row k from queue row indices[k] (or k when indices is 0), at dst.
   The rows whose type is 1 are counted into *particles when type is not 0. caster: 22-float rows. E-394: framed (a
   constant, so each form is a copy) writes each caster row's sun frame and entity from the region's block at S. */
INLINE uint32_t pack(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                     float *dst, uint32_t typeByte, uint32_t *particles, int caster, uint32_t *S, const int framed) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t n = count < cap ? count : cap;
  const uint32_t stride = caster ? 22 : 15;
  SunCols sc;
  uint32_t listed = 0;
  if (framed) sun_cols(S, &sc);
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
    if (framed) full_row_sun_frame(d, i, k, &sc, &listed);
  }
  if (framed) sun_cols_listed(S, listed);
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
                             int caster, uint32_t *S, const int framed) {
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
  SunCols sc;
  uint32_t listed = 0;
  if (framed) sun_cols(S, &sc);
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
    if (framed) full_row_sun_frame(d, i, k, &sc, &listed);
  }
  if (framed) sun_cols_listed(S, listed);
  *particles = p;
  return n;
}

/* E-82b. A plain sprite's row in two streams: the pose (x, y, rotC, rotS), written every frame, and the
   statics (scale, anchor, depth, packed tint, texture, tile terms, in E-82's static order:
   instancedSpriteBatch.js POSE_STATIC_FLOATS), written only when they changed. The values are
   sprite_row's. */
#define POSE_FLOATS 4
#define STATIC_FLOATS 11

/* The G-buffer words (E-387's keyed pack, E-444's split and indexed packs): with withGbuf (a constant, so each form is a
   copy), each drawn instance's words at its draw slot, as gbufWord.js writeGbufWords makes them: GBUF_FLOATS floats, the
   word and the zIndex band. The word is the entity's id in the G-buffer ((e % 65535) + 1), its SpriteRenderer.gbufFlags'
   6 bits << 16 and its ShadowCaster.selfShadow's 2 bits << 22 (none at or past the selfShadow column's length): an
   integer under 2^24, so an exact float. A row that is no entity has the word 0: for the keyed pack, which reads the
   entity from the key column, KEY_NONE or a key at or past the entity count (a decoration's, a LiquidFun particle's, one
   past keyBase); for pre-render's packs, gbuf_cols'. The band, with withBands (the painter orders zIndex first), counts
   the zIndex changes along the draw order up to GBUF_MAX_BANDS - 1, a row that is no entity at zIndex 0; 0 without. The
   block at G, GB_WORDS u32: the words' destination, the gbufFlags column, the selfShadow column (0: none) and its length,
   the zIndex column (0: no bands), the entity count; E-444: then the collector's row types (u8) and entities (i32) by
   queue row, which pre-render's split and indexed packs read the entities from instead of the key column (gbuf_cols).
   The keyed pack does not read those two. */
enum { GB_DST, GB_FLAGS, GB_SELF, GB_SELF_N, GB_ZINDEX, GB_ENTITIES, GB_ROW_TYPE, GB_ROW_ENTITY, GB_WORDS };
#define GBUF_FLOATS 2
#define GBUF_MAX_BANDS 8

/* E-444: the columns of pre-render's G-buffer words, from the block at G. Pre-render's frame (writeGbufWords with the
   collector's columns): queue row i is an entity's sprite when its row type is 0, its entity the collector's; a row of
   another type, or whose entity is at or past the entity count (none, in a frame whose queue rows are the collector's),
   has the word 0 and zIndex 0. */
typedef struct {
  float *dst;
  const uint8_t *flags, *self, *rowType;
  const int32_t *rowEntity;
  const int16_t *z;
  uint32_t selfN, entities;
} GbufCols;

INLINE void gbuf_cols(const uint32_t *G, GbufCols *c, const int withBands) {
  c->dst = (float *)(uintptr_t)G[GB_DST];
  c->flags = (const uint8_t *)(uintptr_t)G[GB_FLAGS];
  c->self = (const uint8_t *)(uintptr_t)G[GB_SELF];
  c->selfN = c->self ? G[GB_SELF_N] : 0;
  c->z = withBands ? (const int16_t *)(uintptr_t)G[GB_ZINDEX] : 0;
  c->entities = G[GB_ENTITIES];
  c->rowType = (const uint8_t *)(uintptr_t)G[GB_ROW_TYPE];
  c->rowEntity = (const int32_t *)(uintptr_t)G[GB_ROW_ENTITY];
}

/* Queue row i's word; with withBands its entity's zIndex in *z (left as it is for a row that is no entity). */
INLINE uint32_t gbuf_row_word(const GbufCols *c, uint32_t i, int32_t *z, const int withBands) {
  if (c->rowType[i] != 0) return 0;
  const uint32_t e = (uint32_t)c->rowEntity[i];
  if (e >= c->entities) return 0;
  if (withBands) *z = c->z[e];
  return e % 65535u + 1u + ((uint32_t)(c->flags[e] & 63u) << 16) + (e < c->selfN ? (uint32_t)(c->self[e] & 3u) << 22 : 0u);
}

/* The band along the draw order: a zIndex unlike the one before moves it on, up to GBUF_MAX_BANDS - 1. */
INLINE void gbuf_band(int32_t z, int32_t *lastZ, uint32_t *band) {
  if (z != *lastZ) {
    if (*lastZ != -32769 && *band < GBUF_MAX_BANDS - 1) (*band)++;
    *lastZ = z;
  }
}

/* A scatter visits the rows in the queue's order, not the draw order: it leaves each slot's zIndex in its band float
   (an int16, an exact float), and this pass over the slots in draw order makes the bands of them. */
INLINE void gbuf_bands_from_z(float *dst, uint32_t n) {
  uint32_t band = 0;
  int32_t lastZ = -32769;
  for (uint32_t k = 0; k < n; k++) {
    gbuf_band((int32_t)dst[k * GBUF_FLOATS + 1], &lastZ, &band);
    dst[k * GBUF_FLOATS + 1] = (float)(int32_t)band;
  }
}

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

/* pack() for the two streams; statics 0 writes the pose alone. E-444: withGbuf and withBands (constants, so each form is
   a copy) also write each slot's G-buffer words from the block at G (gbuf_cols), the bands along the draw order. */
INLINE uint32_t pack_split(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                           float *pose, float *stat, uint32_t typeByte, uint32_t *particles, int statics,
                           const uint32_t *G, const int withGbuf, const int withBands) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t n = count < cap ? count : cap;
  GbufCols gc;
  if (withGbuf) gbuf_cols(G, &gc, withBands);
  uint32_t band = 0;
  int32_t lastZ = -32769;
  uint32_t p = 0;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (type) p += type[i] == 1;
    sprite_pose(t, i, pose + k * POSE_FLOATS);
    if (statics) sprite_static(t, i, stat + k * STATIC_FLOATS, 1.0 - (double)(k + 1) * invDepthDenom);
    if (withGbuf) {
      int32_t z = 0;
      const uint32_t word = gbuf_row_word(&gc, i, &z, withBands);
      if (withBands) gbuf_band(z, &lastZ, &band);
      gc.dst[k * GBUF_FLOATS] = (float)(int32_t)word;
      gc.dst[k * GBUF_FLOATS + 1] = (float)(int32_t)band;
    }
  }
  *particles = p;
  return n;
}

/* pack_scatter() for the two streams, with both always: a listed frame's order may have moved, so its
   statics are never known to be current. E-444: withGbuf and withBands as pack_split's, the bands made after the
   scatter (gbuf_bands_from_z). */
INLINE uint32_t pack_split_scatter(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap,
                                   double invDepthDenom, float *pose, float *stat, uint32_t typeByte,
                                   uint32_t *particles, uint32_t invByte, uint32_t rowCount, const uint32_t *G,
                                   const int withGbuf, const int withBands) {
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
  GbufCols gc;
  if (withGbuf) gbuf_cols(G, &gc, withBands);
  uint32_t p = 0;
  for (uint32_t i = 0; i < rowCount; i++) {
    const uint32_t k = inv[i];
    if (k == 0xffffffffu) continue;
    if (type) p += type[i] == 1;
    sprite_pose(t, i, pose + k * POSE_FLOATS);
    sprite_static(t, i, stat + k * STATIC_FLOATS, 1.0 - (double)(k + 1) * invDepthDenom);
    if (withGbuf) {
      int32_t z = 0;
      gc.dst[k * GBUF_FLOATS] = (float)(int32_t)gbuf_row_word(&gc, i, &z, withBands);
      gc.dst[k * GBUF_FLOATS + 1] = (float)z;
    }
  }
  if (withBands) gbuf_bands_from_z(gc.dst, n);
  *particles = p;
  return n;
}

/* E-162: a painter-sorted frame whose order moved while its statics held. Each drawn row's pose goes to its draw
   slot, and its slot pair: the row, as a float (exact under 2^24), and the depth the split pack writes at that slot,
   the one static that follows the order. With statics set, every queue row's statics go to its row (the queue's
   order, not the draw order; drawn or not, so a row a later frame draws holds its own), INDEXED_STATIC_FLOATS a row:
   the 11 of sprite_static, their depth term 0, and a zero, so a row is three RGBA texels of the texture the vertex
   shader fetches them from. The draw slots' statics are statics[slots[2k]]. Refuses, as the scatter does, indices
   that are not distinct rows below rowCount. */
#define INDEXED_STATIC_FLOATS 12
/* E-186: a slot is its statics row alone. Every batch that reads the slot stream draws without a depth test, so the
   slot's depth was never read; invDepthDenom stays in the exports' signatures and goes unused. */
#define SLOT_FLOATS 1

/* E-444: withGbuf and withBands as pack_split_scatter's. */
INLINE uint32_t pack_indexed_scatter(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap,
                                     double invDepthDenom, float *pose, float *slots, float *stat, uint32_t typeByte,
                                     uint32_t *particles, uint32_t invByte, uint32_t rowCount, int statics,
                                     const uint32_t *G, const int withGbuf, const int withBands) {
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
  GbufCols gc;
  if (withGbuf) gbuf_cols(G, &gc, withBands);
  uint32_t p = 0;
  for (uint32_t i = 0; i < rowCount; i++) {
    if (statics) {
      float *d = stat + i * INDEXED_STATIC_FLOATS;
      sprite_static(t, i, d, 0.0);
      d[11] = 0;
    }
    const uint32_t k = inv[i];
    if (k == 0xffffffffu) continue;
    if (type) p += type[i] == 1;
    sprite_pose(t, i, pose + k * POSE_FLOATS);
    slots[k * SLOT_FLOATS] = (float)i;
    if (withGbuf) {
      int32_t z = 0;
      gc.dst[k * GBUF_FLOATS] = (float)(int32_t)gbuf_row_word(&gc, i, &z, withBands);
      gc.dst[k * GBUF_FLOATS + 1] = (float)z;
    }
  }
  if (withBands) gbuf_bands_from_z(gc.dst, n);
  (void)invDepthDenom;
  *particles = p;
  return n;
}

/* E-177: a split frame whose statics stay with their key, so only the ones that changed go to the GPU. Each drawn row's
   pose goes to its draw slot, and its slot pair: its key's row of the statics texture, as a float, and the depth the
   split pack writes at that slot. The key is the queue's key column: a sprite row's entity, with KEY_CHANGED when the emit
   found its statics changed since the emit before (preRenderEmit.c), so the renderer's copy needs them; the pass reads
   nothing per key. A row without one (KEY_NONE, or a key at or past keyBase) takes keyBase + its draw slot and always
   sends its statics.
   What goes up is the indexed frame's statics (INDEXED_STATIC_FLOATS: sprite_static's, the depth term 0, a zero), as an
   update of KEYED_ROW_WORDS u32 (the statics, then the key). results[0] is the particle count (type 1 rows), results[1]
   the update count. E-191: withShadow (a constant, so each form is a copy of its own) also writes each slot's shadow
   terms at shadow (shadowH, offX, offY; zeros for a glow row, which casts none), for the sun's pass over these
   instances. E-189: a key with KEY_TEX_ONLY too changed its texture alone (an animation's frame): with texUpdates it
   goes up as a texture update of KEYED_TEX_WORDS (its row, then the texture as the float bits the statics hold), the
   count at results[2]; without, as an update like any other. */
#define KEYED_ROW_WORDS 16
#define KEYED_TEX_WORDS 2
#define KEY_NONE 0xffffffffu
#define KEY_CHANGED 0x80000000u
#define KEY_TEX_ONLY 0x40000000u
#define KEY_FLAGS (KEY_CHANGED | KEY_TEX_ONLY)

/* E-387: with withGbuf, each drawn instance's G-buffer words from the key column and the block at G (GB_*, defined with
   the split pack above, whose E-444 forms write the same words from the collector's columns). */

/* E-201: byRow (a constant, so each form is a copy) writes each drawn instance's queue row at rows (as a float) instead
   of its pose: the shader fetches the pose from the queue's own pose columns by that row. */
INLINE uint32_t pack_keyed(const uint32_t *t, const uint32_t *key, uint32_t indices, uint32_t count, uint32_t cap,
                           double invDepthDenom, float *pose, float *slots, uint32_t keyBase, uint32_t *updates,
                           uint32_t typeByte, uint32_t *results, float *shadow, const int withShadow,
                           uint32_t *texUpdates, float *rows, const int byRow, const uint32_t *G, const int withGbuf,
                           const int withBands) {
  const double inv65535 = 1.0 / 65535.0;
  float *GW = withGbuf ? (float *)(uintptr_t)G[GB_DST] : 0;
  const uint8_t *GF = withGbuf ? (const uint8_t *)(uintptr_t)G[GB_FLAGS] : 0;
  const uint8_t *GS = withGbuf ? (const uint8_t *)(uintptr_t)G[GB_SELF] : 0;
  const uint32_t selfN = GS ? G[GB_SELF_N] : 0;
  const int16_t *GZ = withBands ? (const int16_t *)(uintptr_t)G[GB_ZINDEX] : 0;
  const uint32_t entities = withGbuf ? G[GB_ENTITIES] : 0;
  uint32_t band = 0;
  int32_t lastZ = -32769;
  const float *SH = withShadow ? F32(t, COL_SHADOW_H) : 0;
  const float *SOX = withShadow ? F32(t, COL_SHADOW_OFF_X) : 0;
  const float *SOY = withShadow ? F32(t, COL_SHADOW_OFF_Y) : 0;
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const float *SX = F32(t, COL_SCALE_X), *SY = F32(t, COL_SCALE_Y), *AX = F32(t, COL_ANCHOR_X), *AY = F32(t, COL_ANCHOR_Y);
  const float *A = F32(t, COL_ALPHA), *TMX = F32(t, COL_TILE_MUL_X), *TMY = F32(t, COL_TILE_MUL_Y);
  const uint32_t *TINT = (const uint32_t *)(uintptr_t)t[COL_TINT];
  const uint16_t *TEX = U16(t, COL_TEXTURE), *TOU = U16(t, COL_TILE_OFF_U), *TOV = U16(t, COL_TILE_OFF_V);
  const uint32_t n = count < cap ? count : cap;
  uint32_t p = 0;
  uint32_t u = 0;
  uint32_t tu = 0;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (type) p += type[i] == 1;
    if (byRow) rows[k] = (float)i;
    else sprite_pose(t, i, pose + k * POSE_FLOATS);
    const uint32_t raw = key[i];
    uint32_t s = raw & ~KEY_FLAGS;
    uint32_t send = raw >> 31;
    if (s >= keyBase) {
      s = keyBase + k;
      send = 1;
    } else if (send && texUpdates && (raw & KEY_TEX_ONLY)) {
      uint32_t *tx = texUpdates + tu * KEYED_TEX_WORDS;
      const float texF = (float)TEX[i];
      tx[0] = s;
      __builtin_memcpy(tx + 1, &texF, 4);
      tu++;
      send = 0;
    }
    if (send) {
      /* sprite_static's words in the indexed order: scale, anchor; the depth term 0, the packed tint, the texture, the
         tile multiplier's x; its y, the tile offsets, a zero. */
      uint32_t *up = updates + u * KEYED_ROW_WORDS;
      wasm_v128_store(up, wasm_f32x4_make(SX[i], SY[i], AX[i], AY[i]));
      wasm_v128_store(up + 4, wasm_i32x4_replace_lane(wasm_f32x4_make(0.0f, 0.0f, (float)TEX[i], TMX[i]), 1,
                                                       (int32_t)packed_tint((double)A[i], TINT[i])));
      wasm_v128_store(up + 8, wasm_f32x4_make(TMY[i], (float)((double)TOU[i] * inv65535), (float)((double)TOV[i] * inv65535), 0.0f));
      wasm_v128_store(up + 12, wasm_i32x4_make((int32_t)s, 0, 0, 0));
      u++;
    }
    slots[k * SLOT_FLOATS] = (float)s;
    if (withShadow) {
      float *sh = shadow + k * 3;
      const int glow = type && type[i] == 3;
      sh[0] = glow ? 0.0f : SH[i];
      sh[1] = glow ? 0.0f : SOX[i];
      sh[2] = glow ? 0.0f : SOY[i];
    }
    if (withGbuf) {
      const uint32_t e = raw & ~KEY_FLAGS;
      uint32_t word = 0;
      int32_t z = 0;
      if (raw != KEY_NONE && e < entities) {
        word = e % 65535u + 1u + ((uint32_t)(GF[e] & 63u) << 16) + (e < selfN ? (uint32_t)(GS[e] & 3u) << 22 : 0u);
        if (withBands) z = GZ[e];
      }
      if (withBands && z != lastZ) {
        if (lastZ != -32769 && band < GBUF_MAX_BANDS - 1) band++;
        lastZ = z;
      }
      GW[k * GBUF_FLOATS] = (float)word;
      GW[k * GBUF_FLOATS + 1] = (float)band;
    }
  }
  results[0] = p;
  results[1] = u;
  results[2] = tu;
  return n;
}

/* The keyed pack's forms without the G-buffer words, each a copy of its own: with the shadow terms (shadow) or without.
   E-387's forms with the words are other exports (pack_keyed_gbuf_forms): this one's code stays the two copies it was
   (with the words' four in the same export, the plain pack ran 7.8 % slower). */
INLINE uint32_t pack_keyed_forms(const uint32_t *t, const uint32_t *key, uint32_t indices, uint32_t count, uint32_t cap,
                                 double invDepthDenom, float *pose, float *slots, uint32_t keyBase, uint32_t *updates,
                                 uint32_t typeByte, uint32_t *results, float *shadow, uint32_t *texUpdates, float *rows,
                                 const int byRow) {
  if (shadow) {
    return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results,
                      shadow, 1, texUpdates, rows, byRow, 0, 0, 0);
  }
  return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results, 0, 0,
                    texUpdates, rows, byRow, 0, 0, 0);
}

/* E-387: the keyed pack's forms with the G-buffer words (the block at G), each a copy of its own: with the shadow terms
   or without, with the words' bands (a zIndex column in the block) or without. */
INLINE uint32_t pack_keyed_gbuf_forms(const uint32_t *t, const uint32_t *key, uint32_t indices, uint32_t count,
                                      uint32_t cap, double invDepthDenom, float *pose, float *slots, uint32_t keyBase,
                                      uint32_t *updates, uint32_t typeByte, uint32_t *results, float *shadow,
                                      uint32_t *texUpdates, float *rows, const int byRow, const uint32_t *G) {
  if (shadow) {
    if (G[GB_ZINDEX]) {
      return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results,
                        shadow, 1, texUpdates, rows, byRow, G, 1, 1);
    }
    return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results,
                      shadow, 1, texUpdates, rows, byRow, G, 1, 0);
  }
  if (G[GB_ZINDEX]) {
    return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results, 0, 0,
                      texUpdates, rows, byRow, G, 1, 1);
  }
  return pack_keyed(t, key, indices, count, cap, invDepthDenom, pose, slots, keyBase, updates, typeByte, results, 0, 0,
                    texUpdates, rows, byRow, G, 1, 0);
}

__attribute__((export_name("pack_sprites")))
uint32_t pack_sprites(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                      uint32_t dst, uint32_t typeByte, uint32_t particlesOut) {
  return pack((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
              (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, 0, 0, 0);
}

__attribute__((export_name("pack_casters")))
uint32_t pack_casters(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                      uint32_t dst, uint32_t typeByte, uint32_t particlesOut) {
  return pack((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
              (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, 1, 0, 0);
}

__attribute__((export_name("pack_sprites_scatter")))
uint32_t pack_sprites_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 0, 0, 0);
}

__attribute__((export_name("pack_casters_scatter")))
uint32_t pack_casters_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dst, typeByte, (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 1, 0, 0);
}

/* E-82b: the pose stream at dstPose, and the statics at dstStatic unless it is 0. */
__attribute__((export_name("pack_sprites_split")))
uint32_t pack_sprites_split(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                            uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte, uint32_t particlesOut) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  if (dstStatic) return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 1, 0, 0, 0);
  return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 0, 0, 0, 0);
}

/* E-444: pack_sprites_split with each drawn instance's G-buffer words too, the block at gbufByte (GB_WORDS u32), its
   forms each a copy: with the statics or without, with the bands (a zIndex column in the block) or without. Exports of
   their own, so the plain pack keeps the code it had (E-387: the keyed pack ran 7.8 % slower with its words' forms in
   the same export). */
__attribute__((export_name("pack_sprites_split_gbuf")))
uint32_t pack_sprites_split_gbuf(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                                 uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte, uint32_t particlesOut,
                                 uint32_t gbufByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  const uint32_t *G = (const uint32_t *)(uintptr_t)gbufByte;
  if (dstStatic) {
    if (G[GB_ZINDEX]) return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 1, G, 1, 1);
    return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 1, G, 1, 0);
  }
  if (G[GB_ZINDEX]) return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 0, G, 1, 1);
  return pack_split(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, 0, G, 1, 0);
}

__attribute__((export_name("pack_sprites_split_scatter")))
uint32_t pack_sprites_split_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap,
                                    double invDepthDenom, uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte,
                                    uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  return pack_split_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                            (float *)(uintptr_t)dstPose, (float *)(uintptr_t)dstStatic, typeByte,
                            (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 0, 0, 0);
}

/* E-444: pack_sprites_split_scatter with each drawn instance's G-buffer words too, the block at gbufByte; with the bands
   or without. */
__attribute__((export_name("pack_sprites_split_scatter_gbuf")))
uint32_t pack_sprites_split_scatter_gbuf(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap,
                                         double invDepthDenom, uint32_t dstPose, uint32_t dstStatic, uint32_t typeByte,
                                         uint32_t particlesOut, uint32_t invByte, uint32_t rowCount, uint32_t gbufByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  const uint32_t *G = (const uint32_t *)(uintptr_t)gbufByte;
  if (G[GB_ZINDEX]) {
    return pack_split_scatter(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, invByte, rowCount,
                              G, 1, 1);
  }
  return pack_split_scatter(t, indices, count, cap, invDepthDenom, pose, stat, typeByte, particles, invByte, rowCount, G,
                            1, 0);
}

/* E-162: the pose and slot streams at dstPose and dstSlots, and every row's statics in row order at dstStatic unless it
   is 0. */
__attribute__((export_name("pack_sprites_indexed_scatter")))
uint32_t pack_sprites_indexed_scatter(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap,
                                      double invDepthDenom, uint32_t dstPose, uint32_t dstSlots, uint32_t dstStatic,
                                      uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *slots = (float *)(uintptr_t)dstSlots;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  if (dstStatic)
    return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                                rowCount, 1, 0, 0, 0);
  return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                              rowCount, 0, 0, 0, 0);
}

/* E-444: pack_sprites_indexed_scatter with each drawn instance's G-buffer words too, the block at gbufByte; with the
   statics or without, with the bands or without. */
__attribute__((export_name("pack_sprites_indexed_scatter_gbuf")))
uint32_t pack_sprites_indexed_scatter_gbuf(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap,
                                           double invDepthDenom, uint32_t dstPose, uint32_t dstSlots, uint32_t dstStatic,
                                           uint32_t typeByte, uint32_t particlesOut, uint32_t invByte, uint32_t rowCount,
                                           uint32_t gbufByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *slots = (float *)(uintptr_t)dstSlots;
  float *stat = (float *)(uintptr_t)dstStatic;
  uint32_t *particles = (uint32_t *)(uintptr_t)particlesOut;
  const uint32_t *G = (const uint32_t *)(uintptr_t)gbufByte;
  if (dstStatic) {
    if (G[GB_ZINDEX]) {
      return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                                  rowCount, 1, G, 1, 1);
    }
    return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                                rowCount, 1, G, 1, 0);
  }
  if (G[GB_ZINDEX]) {
    return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                                rowCount, 0, G, 1, 1);
  }
  return pack_indexed_scatter(t, indices, count, cap, invDepthDenom, pose, slots, stat, typeByte, particles, invByte,
                              rowCount, 0, G, 1, 0);
}

/* E-177: the pose and slot streams at dstPose and dstSlots, the updates at updatesByte (room for cap), the results at
   resultsByte; the queue's key column at keyByte. E-189: the texture updates at texUpdatesByte (room for cap; 0: none). */
__attribute__((export_name("pack_sprites_keyed")))
uint32_t pack_sprites_keyed(uint32_t table, uint32_t keyByte, uint32_t indices, uint32_t count, uint32_t cap,
                            double invDepthDenom, uint32_t dstPose, uint32_t dstSlots, uint32_t keyBase,
                            uint32_t updatesByte, uint32_t typeByte, uint32_t resultsByte, uint32_t dstShadow,
                            uint32_t texUpdatesByte) {
  return pack_keyed_forms((const uint32_t *)(uintptr_t)table, (const uint32_t *)(uintptr_t)keyByte, indices, count, cap,
                          invDepthDenom, (float *)(uintptr_t)dstPose, (float *)(uintptr_t)dstSlots, keyBase,
                          (uint32_t *)(uintptr_t)updatesByte, typeByte, (uint32_t *)(uintptr_t)resultsByte,
                          (float *)(uintptr_t)dstShadow, (uint32_t *)(uintptr_t)texUpdatesByte, 0, 0);
}

/* E-387: pack_sprites_keyed with each drawn instance's G-buffer words too, the block at gbufByte (GB_WORDS u32). */
__attribute__((export_name("pack_sprites_keyed_gbuf")))
uint32_t pack_sprites_keyed_gbuf(uint32_t table, uint32_t keyByte, uint32_t indices, uint32_t count, uint32_t cap,
                                 double invDepthDenom, uint32_t dstPose, uint32_t dstSlots, uint32_t keyBase,
                                 uint32_t updatesByte, uint32_t typeByte, uint32_t resultsByte, uint32_t dstShadow,
                                 uint32_t texUpdatesByte, uint32_t gbufByte) {
  return pack_keyed_gbuf_forms((const uint32_t *)(uintptr_t)table, (const uint32_t *)(uintptr_t)keyByte, indices, count,
                               cap, invDepthDenom, (float *)(uintptr_t)dstPose, (float *)(uintptr_t)dstSlots, keyBase,
                               (uint32_t *)(uintptr_t)updatesByte, typeByte, (uint32_t *)(uintptr_t)resultsByte,
                               (float *)(uintptr_t)dstShadow, (uint32_t *)(uintptr_t)texUpdatesByte, 0, 0,
                               (const uint32_t *)(uintptr_t)gbufByte);
}

/* E-201: pack_sprites_keyed with each drawn instance's queue row at dstRows (a float) instead of its pose. */
__attribute__((export_name("pack_sprites_keyed_rows")))
uint32_t pack_sprites_keyed_rows(uint32_t table, uint32_t keyByte, uint32_t indices, uint32_t count, uint32_t cap,
                                 double invDepthDenom, uint32_t dstRows, uint32_t dstSlots, uint32_t keyBase,
                                 uint32_t updatesByte, uint32_t typeByte, uint32_t resultsByte, uint32_t dstShadow,
                                 uint32_t texUpdatesByte) {
  return pack_keyed_forms((const uint32_t *)(uintptr_t)table, (const uint32_t *)(uintptr_t)keyByte, indices, count, cap,
                          invDepthDenom, 0, (float *)(uintptr_t)dstSlots, keyBase, (uint32_t *)(uintptr_t)updatesByte,
                          typeByte, (uint32_t *)(uintptr_t)resultsByte, (float *)(uintptr_t)dstShadow,
                          (uint32_t *)(uintptr_t)texUpdatesByte, (float *)(uintptr_t)dstRows, 1);
}

/* E-387: pack_sprites_keyed_rows with each drawn instance's G-buffer words too, the block at gbufByte. */
__attribute__((export_name("pack_sprites_keyed_rows_gbuf")))
uint32_t pack_sprites_keyed_rows_gbuf(uint32_t table, uint32_t keyByte, uint32_t indices, uint32_t count, uint32_t cap,
                                      double invDepthDenom, uint32_t dstRows, uint32_t dstSlots, uint32_t keyBase,
                                      uint32_t updatesByte, uint32_t typeByte, uint32_t resultsByte, uint32_t dstShadow,
                                      uint32_t texUpdatesByte, uint32_t gbufByte) {
  return pack_keyed_gbuf_forms((const uint32_t *)(uintptr_t)table, (const uint32_t *)(uintptr_t)keyByte, indices, count,
                               cap, invDepthDenom, 0, (float *)(uintptr_t)dstSlots, keyBase,
                               (uint32_t *)(uintptr_t)updatesByte, typeByte, (uint32_t *)(uintptr_t)resultsByte,
                               (float *)(uintptr_t)dstShadow, (uint32_t *)(uintptr_t)texUpdatesByte,
                               (float *)(uintptr_t)dstRows, 1, (const uint32_t *)(uintptr_t)gbufByte);
}

/* E-191: a keyed caster row (KEYED_CASTER_FLOATS) for each queue row listed at indices: its x and y, its key as a float
   and a zero (the slot pair the shadow program reads the row's statics by, from the keyed frames' statics texture), and
   its shadow terms (shadowH, offX, offY). 0xffffffff, and the rows not to be trusted, when a listed row has no key below
   keyBase: its statics are not in the texture. */
#define KEYED_CASTER_FLOATS 7

__attribute__((export_name("pack_casters_keyed")))
uint32_t pack_casters_keyed(uint32_t table, uint32_t keyByte, uint32_t indices, uint32_t count, uint32_t cap, uint32_t dst,
                            uint32_t keyBase) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const uint32_t *key = (const uint32_t *)(uintptr_t)keyByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const float *X = F32(t, COL_X), *Y = F32(t, COL_Y);
  const float *SH = F32(t, COL_SHADOW_H), *SOX = F32(t, COL_SHADOW_OFF_X), *SOY = F32(t, COL_SHADOW_OFF_Y);
  float *d = (float *)(uintptr_t)dst;
  const uint32_t n = count < cap ? count : cap;
  for (uint32_t k = 0; k < n; k++) {
    const uint32_t i = idx[k];
    const uint32_t s = key[i] & ~KEY_FLAGS;
    if (s >= keyBase) return 0xffffffffu;
    float *r = d + k * KEYED_CASTER_FLOATS;
    r[0] = X[i];
    r[1] = Y[i];
    r[2] = (float)s;
    r[3] = 0.0f;
    r[4] = SH[i];
    r[5] = SOX[i];
    r[6] = SOY[i];
  }
  return n;
}

/* E-372: with the sun frames' region (sunByte, gpuPackClient.js keyedSunViews), the scan writes each keyed row's sun
   frame in its fourth float as pre-render's sunFrameFor (preRenderWorker.js) works it out for a DirectionalSprite: the
   frame the sun sees, ±(textureId + 1), negative mirrored; 0 for the sprite's own. The region starts with the block,
   KS_WORDS u32: the collector's row types (u8) and entities (i32) by queue row, the entity count (DirectionalSprite's
   active's length), DirectionalSprite's active, mode, directionIndex and animation, ShadowCaster's active, orient and
   sunKind (0: none), SpriteRenderer's spritesheetId (u8 each), the entities' frames of the cycle (u16, 0: none), the sheet
   table (SF_WORDS u32 a sheet id: flags, the direction count, groups, the frames axis, a fixed card's direction, the
   bytes of a uniform table's frames for the sun's turn (frameOf) and of the frames by absolute direction (frameAt), each
   (direction, group, frame) as sunFrameFor indexes them), the list of the rows left to the JS (keyed row, entity) and its
   capacity in pairs, then the rows the scan listed, which it writes. A caster the descriptors do not decide (a table that
   is not uniform, or that the region does not hold; a direction past the table's: none drawn yet) keeps 0 and is listed;
   past the capacity it is only counted, and the JS writes every row's frame. */
enum {
  KS_TYPES, KS_ENTITIES, KS_ENTITY_COUNT, KS_ACTIVE, KS_MODE, KS_DIRECTION, KS_ANIMATION, KS_CASTS, KS_ORIENT, KS_KIND,
  KS_SHEET, KS_FRAME, KS_SHEETS, KS_LIST, KS_LIST_CAP, KS_LISTED, KS_WORDS
};
enum { SF_FLAGS, SF_COUNT, SF_GROUPS, SF_MAX_FRAMES, SF_FRONT, SF_FRAME_OF, SF_FRAME_AT, SF_WORDS = 8 };
#define SF_TABLE 1u
#define SF_UNIFORM 2u
#define SF_SOLID 4u
#define SF_DEFER 8u
/* ShadowCaster's kind for a light that casts its card (shadowCaster.js CAST_KIND.SPRITE). */
#define CAST_CARD 1u
/* keyed_sun_frame's answer for a caster it leaves to the JS: no frame is this value (a texture id is a u16). */
#define SUN_FRAME_JS ((int32_t)0x80000000)

/* sunFrameFor for entity e, its tests in its order: an active DirectionalSprite playing a group, casting (ShadowCaster's
   active), whose sheet has a table and whose kind for the sun is a card; then a fixed card's frame at the table's front
   in frameAt (what sunFrameFor's slot path gives there), or a uniform table's at the direction drawn in frameOf, the
   frame of the cycle 0 past the frames axis. */
INLINE int32_t keyed_sun_frame(uint32_t e, uint32_t entities, const uint8_t *active, const uint8_t *mode,
                               const uint8_t *casts, const uint8_t *sheet, const uint32_t *sheets, const uint8_t *kind,
                               const uint8_t *orient, const uint8_t *direction, const uint8_t *animation,
                               const uint16_t *frame) {
  if (e >= entities || active[e] != 1 || mode[e] != 1) return 0;
  if (casts && casts[e] != 1) return 0;
  const uint32_t *t = sheets + (uint32_t)sheet[e] * SF_WORDS;
  const uint32_t flags = t[SF_FLAGS];
  if (!(flags & SF_TABLE)) return 0;
  const uint32_t k = kind ? kind[e] : 0;
  if (k != CAST_CARD && (k != 0 || (flags & SF_SOLID))) return 0;
  if (flags & SF_DEFER) return SUN_FRAME_JS;
  uint32_t d;
  uint32_t at;
  if (orient && orient[e] == 1) {
    d = t[SF_FRONT];
    at = t[SF_FRAME_AT];
  } else {
    d = direction[e];
    if (!(flags & SF_UNIFORM) || d >= t[SF_COUNT]) return SUN_FRAME_JS;
    at = t[SF_FRAME_OF];
  }
  const uint32_t groups = t[SF_GROUPS];
  const uint32_t most = t[SF_MAX_FRAMES];
  const uint32_t g = animation[e];
  uint32_t f = frame ? frame[e] : 0;
  if (f >= most) f = 0;
  return ((const int32_t *)(uintptr_t)at)[(d * groups + (g < groups ? g : 0)) * most + f];
}

/* E-192: pack_casters_keyed over the casters it finds itself: the queue rows whose shadowH is above 0 and whose type is
   not a glow's (compactShadowCasterIndices' test), in the queue's order, until cap rows; the same rows the compaction
   and pack_casters_keyed write. 0xffffffff at a caster with no key below keyBase. typeByte 0: no type column. E-372:
   framed (a constant, so each form is a copy) writes each row's sun frame from the block at S. xy (E-331, a constant
   too): also each row's x and y into xs and ys, and at bounds the six doubles the shadow stamp's grid build would work
   out of the rows (wasm/shadowStamp.c, grid_from_xy): minX, minY, maxX, maxY over the x and y as doubles (its
   comparisons, in its order: a NaN takes no part), 1 when an x or y is NaN (else 0), and the row count. Written only
   when the scan returns its rows. */
INLINE uint32_t casters_keyed_scan(const uint32_t *t, const uint32_t *key, const uint8_t *type, uint32_t count,
                                   uint32_t cap, float *d, uint32_t keyBase, uint32_t *S, const int framed, float *xs,
                                   float *ys, double *bounds, const int xy) {
  const float *X = F32(t, COL_X), *Y = F32(t, COL_Y);
  const float *SH = F32(t, COL_SHADOW_H), *SOX = F32(t, COL_SHADOW_OFF_X), *SOY = F32(t, COL_SHADOW_OFF_Y);
  const uint8_t *rowType = framed ? (const uint8_t *)(uintptr_t)S[KS_TYPES] : 0;
  const int32_t *rowEntity = framed ? (const int32_t *)(uintptr_t)S[KS_ENTITIES] : 0;
  const uint32_t entities = framed ? S[KS_ENTITY_COUNT] : 0;
  const uint8_t *active = framed ? (const uint8_t *)(uintptr_t)S[KS_ACTIVE] : 0;
  const uint8_t *mode = framed ? (const uint8_t *)(uintptr_t)S[KS_MODE] : 0;
  const uint8_t *direction = framed ? (const uint8_t *)(uintptr_t)S[KS_DIRECTION] : 0;
  const uint8_t *animation = framed ? (const uint8_t *)(uintptr_t)S[KS_ANIMATION] : 0;
  const uint8_t *casts = framed ? (const uint8_t *)(uintptr_t)S[KS_CASTS] : 0;
  const uint8_t *orient = framed ? (const uint8_t *)(uintptr_t)S[KS_ORIENT] : 0;
  const uint8_t *kind = framed ? (const uint8_t *)(uintptr_t)S[KS_KIND] : 0;
  const uint8_t *sheet = framed ? (const uint8_t *)(uintptr_t)S[KS_SHEET] : 0;
  const uint16_t *frame = framed ? (const uint16_t *)(uintptr_t)S[KS_FRAME] : 0;
  const uint32_t *sheets = framed ? (const uint32_t *)(uintptr_t)S[KS_SHEETS] : 0;
  uint32_t *list = framed ? (uint32_t *)(uintptr_t)S[KS_LIST] : 0;
  const uint32_t listCap = framed ? S[KS_LIST_CAP] : 0;
  uint32_t listed = 0;
  double minX = __builtin_inf();
  double minY = __builtin_inf();
  double maxX = -__builtin_inf();
  double maxY = -__builtin_inf();
  int32_t nan = 0;
  uint32_t n = 0;
  for (uint32_t i = 0; i < count && n < cap; i++) {
    if (type && type[i] == 3) continue;
    const float sh = SH[i];
    if (!(sh > 0.0f)) continue;
    const uint32_t s = key[i] & ~KEY_FLAGS;
    if (s >= keyBase) {
      if (framed) S[KS_LISTED] = listed;
      return 0xffffffffu;
    }
    float *r = d + n * KEYED_CASTER_FLOATS;
    const float fx = X[i];
    const float fy = Y[i];
    r[0] = fx;
    r[1] = fy;
    r[2] = (float)s;
    int32_t v = 0;
    if (framed && rowType[i] == 0) {
      const uint32_t e = (uint32_t)rowEntity[i];
      v = keyed_sun_frame(e, entities, active, mode, casts, sheet, sheets, kind, orient, direction, animation, frame);
      if (v == SUN_FRAME_JS) {
        if (listed < listCap) {
          list[2 * listed] = n;
          list[2 * listed + 1] = e;
        }
        listed++;
        v = 0;
      }
    }
    r[3] = (float)v;
    r[4] = sh;
    r[5] = SOX[i];
    r[6] = SOY[i];
    if (xy) {
      xs[n] = fx;
      ys[n] = fy;
      const double x = fx;
      const double y = fy;
      nan |= (x != x) | (y != y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    n++;
  }
  if (framed) S[KS_LISTED] = listed;
  if (xy) {
    bounds[0] = minX;
    bounds[1] = minY;
    bounds[2] = maxX;
    bounds[3] = maxY;
    bounds[4] = nan ? 1.0 : 0.0;
    bounds[5] = (double)n;
  }
  return n;
}

/* E-372: sunByte, the sun frames' region (0: no frames, the fourth float 0 as before). */
__attribute__((export_name("pack_casters_keyed_scan")))
uint32_t pack_casters_keyed_scan(uint32_t table, uint32_t keyByte, uint32_t typeByte, uint32_t count, uint32_t cap,
                                 uint32_t dst, uint32_t keyBase, uint32_t sunByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const uint32_t *key = (const uint32_t *)(uintptr_t)keyByte;
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  float *d = (float *)(uintptr_t)dst;
  if (sunByte) {
    return casters_keyed_scan(t, key, type, count, cap, d, keyBase, (uint32_t *)(uintptr_t)sunByte, 1, 0, 0, 0, 0);
  }
  return casters_keyed_scan(t, key, type, count, cap, d, keyBase, 0, 0, 0, 0, 0, 0);
}

/* E-331: pack_casters_keyed_scan that also hands the shadow stamp its casters' x, y and bounds (casters_keyed_scan's
   xy) at xByte, yByte and boundsByte. */
__attribute__((export_name("pack_casters_keyed_scan_xy")))
uint32_t pack_casters_keyed_scan_xy(uint32_t table, uint32_t keyByte, uint32_t typeByte, uint32_t count, uint32_t cap,
                                    uint32_t dst, uint32_t keyBase, uint32_t sunByte, uint32_t xByte, uint32_t yByte,
                                    uint32_t boundsByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  const uint32_t *key = (const uint32_t *)(uintptr_t)keyByte;
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  float *d = (float *)(uintptr_t)dst;
  float *xs = (float *)(uintptr_t)xByte;
  float *ys = (float *)(uintptr_t)yByte;
  double *bounds = (double *)(uintptr_t)boundsByte;
  if (sunByte) {
    return casters_keyed_scan(t, key, type, count, cap, d, keyBase, (uint32_t *)(uintptr_t)sunByte, 1, xs, ys, bounds, 1);
  }
  return casters_keyed_scan(t, key, type, count, cap, d, keyBase, 0, 0, xs, ys, bounds, 1);
}

/* E-394: the full caster rows' sun frames in the pack (pack and pack_scatter framed), from the block at S (KS_*, as the
   keyed scan reads it): each row's entity in its tint float as pre-render's applySunFramesFor writes it (-1 for a row
   that is not an entity's sprite) and, for a DirectionalSprite, the frame the sun sees (keyed_sun_frame): its texture
   (|frame| - 1) and its scale's sign flipped when the frame is mirrored the other way. A row the descriptors do not decide
   (keyed_sun_frame's SUN_FRAME_JS), or whose mirrored frame would flip a NaN scale, keeps the pack's texture and scale and
   is listed (output row, entity); past the list's capacity it is only counted, and the JS writes every row's frame. */
INLINE void sun_cols(const uint32_t *S, SunCols *c) {
  c->rowType = (const uint8_t *)(uintptr_t)S[KS_TYPES];
  c->rowEntity = (const int32_t *)(uintptr_t)S[KS_ENTITIES];
  c->entities = S[KS_ENTITY_COUNT];
  c->active = (const uint8_t *)(uintptr_t)S[KS_ACTIVE];
  c->mode = (const uint8_t *)(uintptr_t)S[KS_MODE];
  c->direction = (const uint8_t *)(uintptr_t)S[KS_DIRECTION];
  c->animation = (const uint8_t *)(uintptr_t)S[KS_ANIMATION];
  c->casts = (const uint8_t *)(uintptr_t)S[KS_CASTS];
  c->orient = (const uint8_t *)(uintptr_t)S[KS_ORIENT];
  c->kind = (const uint8_t *)(uintptr_t)S[KS_KIND];
  c->sheet = (const uint8_t *)(uintptr_t)S[KS_SHEET];
  c->frame = (const uint16_t *)(uintptr_t)S[KS_FRAME];
  c->sheets = (const uint32_t *)(uintptr_t)S[KS_SHEETS];
  c->list = (uint32_t *)(uintptr_t)S[KS_LIST];
  c->listCap = S[KS_LIST_CAP];
}

INLINE void sun_cols_listed(uint32_t *S, uint32_t listed) { S[KS_LISTED] = listed; }

/* Output row k (d), queue row i. */
INLINE void full_row_sun_frame(float *d, uint32_t i, uint32_t k, const SunCols *c, uint32_t *listed) {
  if (c->rowType[i] != 0) {
    d[9] = -1.0f;
    return;
  }
  const int32_t e = c->rowEntity[i];
  d[9] = (float)e;
  const int32_t v = keyed_sun_frame((uint32_t)e, c->entities, c->active, c->mode, c->casts, c->sheet, c->sheets, c->kind,
                                    c->orient, c->direction, c->animation, c->frame);
  if (v == 0) return;
  if (v != SUN_FRAME_JS) {
    const float sx = d[2];
    if (!(v < 0 && sx != sx)) {
      d[10] = (float)((v < 0 ? -v : v) - 1);
      if ((v < 0) != (sx < 0.0f)) d[2] = -sx;
      return;
    }
  }
  const uint32_t m = *listed;
  if (m < c->listCap) {
    c->list[2 * m] = k;
    c->list[2 * m + 1] = (uint32_t)e;
  }
  *listed = m + 1;
}

/* E-394: pack_casters with the rows' sun frames and entities from the sun frames' region at sunByte. */
__attribute__((export_name("pack_casters_framed")))
uint32_t pack_casters_framed(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                             uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t sunByte) {
  return pack((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom, (float *)(uintptr_t)dst, typeByte,
              (uint32_t *)(uintptr_t)particlesOut, 1, (uint32_t *)(uintptr_t)sunByte, 1);
}

/* E-394: pack_casters_scatter with the rows' sun frames and entities from the sun frames' region at sunByte. */
__attribute__((export_name("pack_casters_scatter_framed")))
uint32_t pack_casters_scatter_framed(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                                     uint32_t dst, uint32_t typeByte, uint32_t particlesOut, uint32_t invByte,
                                     uint32_t rowCount, uint32_t sunByte) {
  return pack_scatter((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom, (float *)(uintptr_t)dst,
                      typeByte, (uint32_t *)(uintptr_t)particlesOut, invByte, rowCount, 1, (uint32_t *)(uintptr_t)sunByte,
                      1);
}

/* E-393: the lamps' frames of directional casters in the stamp rows, as pre-render's applyKeyedLampFramesInto (keyed rows)
   and applyLampFramesInto (full rows) write them (preRenderWorker.js), from the sun frames' region: E-372's sheet table,
   whose descriptors also say whether a sheet stands on a contact (SF_CONTACT) and, for a uniform table whose borders the
   lamps' turn reads without an arctangent (lampTurnGeometry), SF_LAMP_GEO and the byte of that geometry (SF_GEO: the cos
   and sin of half a step, then each border's in the first quarter), and the lamp block at B, LF_WORDS u32: DirectionalSprite's
   active, mode, directionIndex and animation, ShadowCaster's orient and lampKind (0: none), SpriteRenderer's spritesheetId
   (u8 each), the entities' frames of the cycle (u16, 0: none), the entity count (DirectionalSprite's active's length), the
   sheet table, the light table (LAMP_LIGHT_DOUBLES a stamp light index: x, y, the light's entity, 1 for a light and 0 for
   none), the list of the rows left to the JS (a u32 each: the stamp row) and its capacity; then the rows listed and the rows
   gone through, which it writes; and the quarter turns' table (8 f64: preRenderWorker.js QUARTER_C then QUARTER_S), read
   by index as the JS reads it: a select between those constants was a branch on the ray's quarter in TurboFan's code, a
   mispredicted one on every other row. Each row in the JS's order: a row of its lamp's own entity drops its shadow (its shadow
   height 0); an active DirectionalSprite playing a group whose sheet has a table takes, when its kind for the lamps is a
   card, the frame its lamp sees: a fixed card its table's front, any other the direction drawn turned by the ray from the
   lamp, told from the quarter and the borders it has passed as the JS tells it (the same doubles, the same operations); a
   full row whose kind is no card the camera's direction, a keyed one frame 0. A row the kernel does not decide goes in
   the list untouched but for its drop: a light index past the table, an entity float that is not an int32, a sheet whose
   frames the region does not hold, a table without the geometry, no direction drawn, a ray within the margin of a
   border (lampFrameFor's arctangent), a full row whose mirrored frame flips a NaN scale. A row that finds the list full
   ends the call: it and the rows after it stay as they were, for the JS. */
enum {
  LF_ACTIVE, LF_MODE, LF_DIRECTION, LF_ANIMATION, LF_ORIENT, LF_KIND, LF_SHEET, LF_FRAME, LF_ENTITY_COUNT, LF_SHEETS,
  LF_LIGHTS, LF_LIST, LF_LIST_CAP, LF_LISTED, LF_DONE, LF_QUARTER, LF_WORDS
};
#define SF_CONTACT 16u
#define SF_LAMP_GEO 32u
/* A sheet descriptor's word for its lamp geometry's byte (E-372 left it free). */
#define SF_GEO 7
#define LAMP_LIGHT_DOUBLES 4
/* The stamp rows: keyed (KEYED_CASTER_FLOATS and the light) and full (gpuQueueLayout.js GPU_CASTER_FLOATS). */
#define KEYED_STAMP_FLOATS (KEYED_CASTER_FLOATS + 4)
#define FULL_STAMP_FLOATS 22
/* preRenderWorker.js LAMP_TURN_MARGIN and LAMP_TURN_MIN. */
#define LAMP_TURN_MARGIN 1e-4
#define LAMP_TURN_MIN 1e-200

typedef struct {
  const uint8_t *active, *mode, *direction, *animation, *orient, *kind, *sheet;
  const uint16_t *frame;
  uint32_t entities;
  const uint32_t *sheets;
  const double *quarter;
} LampCols;

/* One stamp row (r) for its light (present: a light; its entity lid at lx, ly): 1 when it is left to the JS. */
INLINE int lamp_frame_row(float *r, const LampCols *c, int present, double lid, double lx, double ly, double invG,
                          const int keyed) {
  const float ef = r[keyed ? 2 : 9];
  /* The JS reads the entity with `| 0`: past the int32 range (NaN too) it is its own. */
  if (!(ef >= -2147483648.0f && ef < 2147483648.0f)) return 1;
  const int32_t e = (int32_t)ef;
  if (present && (double)e == lid) r[keyed ? 4 : 15] = 0.0f;
  if (e < 0 || (uint32_t)e >= c->entities || c->active[e] != 1 || c->mode[e] != 1) return 0;
  const uint32_t *t = c->sheets + (uint32_t)c->sheet[e] * SF_WORDS;
  const uint32_t flags = t[SF_FLAGS];
  if (!(flags & SF_TABLE)) return 0;
  const uint32_t k = c->kind ? c->kind[e] : 0;
  const int card = k == CAST_CARD || (k == 0 && !(flags & SF_CONTACT));
  if (keyed && !card) {
    if (!(r[3] == 0.0f)) r[3] = 0.0f;
    return 0;
  }
  const int fixed = c->orient && c->orient[e] == 1;
  const uint32_t count = t[SF_COUNT];
  uint32_t d;
  if (card && !fixed) {
    if (!present) return 0;
    if ((flags & (SF_DEFER | SF_LAMP_GEO)) != SF_LAMP_GEO) return 1;
    const uint32_t cur = c->direction[e];
    if (cur >= count) return 1;
    /* applyLampFramesInto's turn: (-dy, -dx) turned on by half a step, its quarter from the signs, its sector from the
       borders it has passed, kept when both of the sector's borders are farther than the margin. */
    const double *geo = (const double *)(uintptr_t)t[SF_GEO];
    const double dx = (double)r[0] - lx;
    const double dy = ((double)r[1] - ly) * invG;
    const double gc = geo[0];
    const double gs = geo[1];
    const double X = dx * gs - dy * gc;
    const double Y = -(dx * gc + dy * gs);
    const uint32_t below = Y < 0.0;
    const uint32_t quad = (below << 1) | ((uint32_t)(X < 0.0) ^ below);
    /* QUARTER_C and QUARTER_S: cos and sin of -quad quarter turns, exact, from the table (no branch on the quarter). */
    const double qc = c->quarter[quad];
    const double qs = c->quarter[4 + quad];
    const double u = qc * X + qs * Y;
    const double w = qc * Y - qs * X;
    const double len = __builtin_fabs(u) + __builtin_fabs(w);
    const uint32_t quarter = count >> 2;
    uint32_t j = 0;
    for (uint32_t b = 4; b <= 2 * quarter; b += 2) j += geo[b] * w - geo[b + 1] * u >= 0.0;
    const uint32_t lo = 2 + 2 * j;
    const double margin = LAMP_TURN_MARGIN * len;
    if (!(len > LAMP_TURN_MIN && geo[lo] * w - geo[lo + 1] * u > margin && geo[lo + 3] * u - geo[lo + 2] * w > margin)) {
      return 1;
    }
    d = cur + quad * quarter + j;
    if (d >= count) d -= count;
  } else {
    if (flags & SF_DEFER) return 1;
    /* frameFacing: a fixed card's front, the camera's direction for columns; none past the table's directions. */
    d = card ? t[SF_FRONT] : c->direction[e];
    if (d >= count) return 0;
  }
  const uint32_t groups = t[SF_GROUPS];
  const uint32_t most = t[SF_MAX_FRAMES];
  const uint32_t g = c->animation[e];
  uint32_t f = c->frame ? c->frame[e] : 0;
  if (f >= most) f = 0;
  const int32_t v = ((const int32_t *)(uintptr_t)t[SF_FRAME_AT])[(d * groups + (g < groups ? g : 0)) * most + f];
  if (keyed) {
    if (v != 0) r[3] = (float)v;
    return 0;
  }
  if (v == 0) return 0;
  const float sx = r[2];
  if (v < 0 && sx != sx) return 1;
  r[10] = (float)((v < 0 ? -v : v) - 1);
  if ((v < 0) != (sx < 0.0f)) r[2] = -sx;
  return 0;
}

/* E-393: stampN rows (keyed, a constant, so each form is a copy) whose light is lightIdx[k] (u16): the lamp block at B,
   the light table's first lightCount lights. The light is read once a run of its rows (the stamp lists come by light).
   Returns the rows gone through (B[LF_DONE] too). */
INLINE uint32_t lamp_frame_rows(float *rows, uint32_t stampN, const uint16_t *lightIdx, uint32_t lightCount, double invG,
                                uint32_t *B, const int keyed) {
  LampCols c;
  c.active = (const uint8_t *)(uintptr_t)B[LF_ACTIVE];
  c.mode = (const uint8_t *)(uintptr_t)B[LF_MODE];
  c.direction = (const uint8_t *)(uintptr_t)B[LF_DIRECTION];
  c.animation = (const uint8_t *)(uintptr_t)B[LF_ANIMATION];
  c.orient = (const uint8_t *)(uintptr_t)B[LF_ORIENT];
  c.kind = (const uint8_t *)(uintptr_t)B[LF_KIND];
  c.sheet = (const uint8_t *)(uintptr_t)B[LF_SHEET];
  c.frame = (const uint16_t *)(uintptr_t)B[LF_FRAME];
  c.entities = B[LF_ENTITY_COUNT];
  c.sheets = (const uint32_t *)(uintptr_t)B[LF_SHEETS];
  c.quarter = (const double *)(uintptr_t)B[LF_QUARTER];
  const double *lights = (const double *)(uintptr_t)B[LF_LIGHTS];
  uint32_t *list = (uint32_t *)(uintptr_t)B[LF_LIST];
  const uint32_t listCap = B[LF_LIST_CAP];
  const uint32_t stride = keyed ? KEYED_STAMP_FLOATS : FULL_STAMP_FLOATS;
  uint32_t listed = 0;
  uint32_t li = 0xffffffffu;
  int known = 0;
  int present = 0;
  double lid = 0.0, lx = 0.0, ly = 0.0;
  uint32_t k = 0;
  for (; k < stampN; k++) {
    const uint32_t i = lightIdx[k];
    if (i != li) {
      li = i;
      known = i < lightCount;
      if (known) {
        const double *L = lights + i * LAMP_LIGHT_DOUBLES;
        lx = L[0];
        ly = L[1];
        lid = L[2];
        present = L[3] != 0.0;
      }
    }
    if (known && !lamp_frame_row(rows + k * stride, &c, present, lid, lx, ly, invG, keyed)) continue;
    if (listed == listCap) break;
    list[listed++] = k;
  }
  B[LF_LISTED] = listed;
  B[LF_DONE] = k;
  return k;
}

__attribute__((export_name("lamp_frames")))
uint32_t lamp_frames(uint32_t rowsByte, uint32_t stampN, uint32_t lightIdxByte, uint32_t lightCount, double invG,
                     uint32_t blockByte, uint32_t keyed) {
  float *rows = (float *)(uintptr_t)rowsByte;
  const uint16_t *lightIdx = (const uint16_t *)(uintptr_t)lightIdxByte;
  uint32_t *B = (uint32_t *)(uintptr_t)blockByte;
  if (keyed) return lamp_frame_rows(rows, stampN, lightIdx, lightCount, invG, B, 1);
  return lamp_frame_rows(rows, stampN, lightIdx, lightCount, invG, B, 0);
}

/* packInstancedRows' slow path, its parameters as doubles at `params` (gpuPackClient.js GENERAL_PARAMS): flags
   (screen 1, a turned camera 2, pixel snap 4, a type filter 8, an include type 16), the camera's x and y, the screen
   scale, the turn's cos and sin, its focus x and y, half the canvas in pixels, the snap camera's x and y and zoom,
   and the include and two exclude types (-1 for none). A filtered row does not take a slot; the depth and the
   particle count follow the rows written. Arithmetic as the JS: float32 columns widened, every operation in
   double, Math.round as V8 rounds, each value stored as a Float32Array stores it. */
#define G_SCREEN 1u
#define G_TURNED 2u
#define G_SNAP 4u
#define G_FILTER 8u
#define G_INCLUDE 16u

INLINE double js_round(double x) {
  double r = __builtin_ceil(x);
  if (r - 0.5 > x) r -= 1.0;
  return r;
}

INLINE double snap_world(double v, double cam, double zoom) {
  if (!(zoom > 0)) return v;
  return js_round((v - cam) * zoom) / zoom + cam;
}

INLINE uint32_t pack_general(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                             float *dst, uint32_t typeByte, uint32_t *particles, const double *P, int caster) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t stride = caster ? 22 : 15;
  const uint32_t flags = (uint32_t)P[0];
  const int screen = (flags & G_SCREEN) != 0;
  const int turned = (flags & G_TURNED) != 0;
  const int snap = (flags & G_SNAP) != 0;
  const int filter = (flags & G_FILTER) != 0 && type;
  const int hasInclude = (flags & G_INCLUDE) != 0;
  const double camX = P[1], camY = P[2], scale = P[3], camC = P[4], camS = P[5];
  const double focusX = P[6], focusY = P[7], halfW = P[8], halfH = P[9];
  const double snapX = P[10], snapY = P[11], snapZoom = P[12];
  const int32_t include = (int32_t)P[13], exclude0 = (int32_t)P[14], exclude1 = (int32_t)P[15];
  const float *X = F32(t, COL_X), *Y = F32(t, COL_Y), *SX = F32(t, COL_SCALE_X), *SY = F32(t, COL_SCALE_Y);
  const float *RC = F32(t, COL_ROT_C), *RS = F32(t, COL_ROT_S);
  uint32_t out = 0;
  uint32_t p = 0;
  for (uint32_t k = 0; k < count; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (filter) {
      const int32_t ty = type[i];
      if (hasInclude && ty != include) continue;
      if ((exclude0 >= 0 && ty == exclude0) || (exclude1 >= 0 && ty == exclude1)) continue;
    }
    if (out >= cap) break;
    if (type) p += type[i] == 1;
    double x = X[i];
    double y = Y[i];
    double sx = SX[i];
    double sy = SY[i];
    double rc = RC[i];
    double rs = RS[i];
    if (screen) {
      if (turned) {
        const double dx = x - focusX;
        const double dy = y - focusY;
        x = halfW + (dx * camC - dy * camS) * scale;
        y = halfH + (dx * camS + dy * camC) * scale;
        const double nrc = rc * camC - rs * camS;
        rs = rs * camC + rc * camS;
        rc = nrc;
      } else {
        x = (x - camX) * scale;
        y = (y - camY) * scale;
      }
      sx *= scale;
      sy *= scale;
    }
    if (snap) {
      if (screen) {
        x = js_round(x);
        y = js_round(y);
      } else {
        x = snap_world(x, snapX, snapZoom);
        y = snap_world(y, snapY, snapZoom);
      }
    }
    float *d = dst + out * stride;
    sprite_row(t, i, d, 1.0 - (double)(out + 1) * invDepthDenom);
    d[0] = (float)x;
    d[1] = (float)y;
    d[2] = (float)sx;
    d[3] = (float)sy;
    d[6] = (float)rc;
    d[7] = (float)rs;
    if (caster) {
      d[15] = F32(t, COL_SHADOW_H)[i];
      d[16] = F32(t, COL_SHADOW_OFF_X)[i];
      d[17] = F32(t, COL_SHADOW_OFF_Y)[i];
      d[18] = 0;
      d[19] = 0;
      d[20] = 0;
      d[21] = 0;
    }
    out++;
  }
  *particles = p;
  return out;
}

__attribute__((export_name("pack_sprites_general")))
uint32_t pack_sprites_general(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dstByte, uint32_t typeByte, uint32_t particlesByte, uint32_t paramsByte) {
  return pack_general((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dstByte, typeByte, (uint32_t *)(uintptr_t)particlesByte,
                      (const double *)(uintptr_t)paramsByte, 0);
}

__attribute__((export_name("pack_casters_general")))
uint32_t pack_casters_general(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double invDepthDenom,
                              uint32_t dstByte, uint32_t typeByte, uint32_t particlesByte, uint32_t paramsByte) {
  return pack_general((const uint32_t *)(uintptr_t)table, indices, count, cap, invDepthDenom,
                      (float *)(uintptr_t)dstByte, typeByte, (uint32_t *)(uintptr_t)particlesByte,
                      (const double *)(uintptr_t)paramsByte, 1);
}

/* W9e. A pose batch's streams (renderer.interpolation: instancedSpriteBatch.js _packPoseOnly and
   _packPoseAndStatics). Per row the pose x, y, rotC, rotS and the previous x, y (POSE_DYN_FLOATS, 6), and, unless
   stat is 0, the statics in E-82's order (sprite_static's, the scale in screen units). The previous pose is read
   from prevX and prevY (0: the current one, as the JS does without them or with the pose snap), and it goes through
   the same screen transform and pixel snap. Parameters as pack_general's, at `params`; the depth is the JS's
   1 - (out + 1) / depthDenom. A filtered row does not take a slot. */
#define POSE_DYN_FLOATS 6

INLINE uint32_t pack_pose_rows(const uint32_t *t, uint32_t indices, uint32_t count, uint32_t cap, double depthDenom,
                               float *pose, float *stat, uint32_t typeByte, const float *prevX, const float *prevY,
                               const double *P, int statics) {
  const uint8_t *type = (const uint8_t *)(uintptr_t)typeByte;
  const uint32_t *idx = (const uint32_t *)(uintptr_t)indices;
  const uint32_t flags = (uint32_t)P[0];
  const int screen = (flags & G_SCREEN) != 0;
  const int turned = (flags & G_TURNED) != 0;
  const int snap = (flags & G_SNAP) != 0;
  const int filter = (flags & G_FILTER) != 0 && type;
  const int hasInclude = (flags & G_INCLUDE) != 0;
  const double camX = P[1], camY = P[2], scale = P[3], camC = P[4], camS = P[5];
  const double focusX = P[6], focusY = P[7], halfW = P[8], halfH = P[9];
  const double snapX = P[10], snapY = P[11], snapZoom = P[12];
  const int32_t include = (int32_t)P[13], exclude0 = (int32_t)P[14], exclude1 = (int32_t)P[15];
  const float *X = F32(t, COL_X), *Y = F32(t, COL_Y), *SX = F32(t, COL_SCALE_X), *SY = F32(t, COL_SCALE_Y);
  const float *RC = F32(t, COL_ROT_C), *RS = F32(t, COL_ROT_S);
  uint32_t out = 0;
  for (uint32_t k = 0; k < count; k++) {
    const uint32_t i = indices ? idx[k] : k;
    if (filter) {
      const int32_t ty = type[i];
      if (hasInclude && ty != include) continue;
      if ((exclude0 >= 0 && ty == exclude0) || (exclude1 >= 0 && ty == exclude1)) continue;
    }
    if (out >= cap) break;
    double x = X[i];
    double y = Y[i];
    double px = prevX ? (double)prevX[i] : x;
    double py = prevY ? (double)prevY[i] : y;
    double sx = 0, sy = 0;
    if (statics) {
      sx = SX[i];
      sy = SY[i];
    }
    if (screen) {
      if (turned) {
        const double dx = x - focusX;
        const double dy = y - focusY;
        x = halfW + (dx * camC - dy * camS) * scale;
        y = halfH + (dx * camS + dy * camC) * scale;
        const double pdx = px - focusX;
        const double pdy = py - focusY;
        px = halfW + (pdx * camC - pdy * camS) * scale;
        py = halfH + (pdx * camS + pdy * camC) * scale;
      } else {
        x = (x - camX) * scale;
        y = (y - camY) * scale;
        px = (px - camX) * scale;
        py = (py - camY) * scale;
      }
      if (statics) {
        sx *= scale;
        sy *= scale;
      }
    }
    if (snap) {
      if (screen) {
        x = js_round(x);
        y = js_round(y);
        px = js_round(px);
        py = js_round(py);
      } else {
        x = snap_world(x, snapX, snapZoom);
        y = snap_world(y, snapY, snapZoom);
        px = snap_world(px, snapX, snapZoom);
        py = snap_world(py, snapY, snapZoom);
      }
    }
    double rc = RC[i];
    double rs = RS[i];
    if (screen && turned) {
      const double nrc = rc * camC - rs * camS;
      rs = rs * camC + rc * camS;
      rc = nrc;
    }
    float *d = pose + out * POSE_DYN_FLOATS;
    d[0] = (float)x;
    d[1] = (float)y;
    d[2] = (float)rc;
    d[3] = (float)rs;
    d[4] = (float)px;
    d[5] = (float)py;
    if (statics) {
      float *s = stat + out * STATIC_FLOATS;
      sprite_static(t, i, s, 1.0 - (double)(out + 1) / depthDenom);
      s[0] = (float)sx;
      s[1] = (float)sy;
    }
    out++;
  }
  return out;
}

/* W9e: the pose stream at dstPose, and the statics at dstStatic unless it is 0. */
__attribute__((export_name("pack_pose")))
uint32_t pack_pose(uint32_t table, uint32_t indices, uint32_t count, uint32_t cap, double depthDenom, uint32_t dstPose,
                   uint32_t dstStatic, uint32_t typeByte, uint32_t prevXByte, uint32_t prevYByte, uint32_t paramsByte) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  float *pose = (float *)(uintptr_t)dstPose;
  float *stat = (float *)(uintptr_t)dstStatic;
  const float *prevX = (const float *)(uintptr_t)prevXByte;
  const float *prevY = (const float *)(uintptr_t)prevYByte;
  const double *P = (const double *)(uintptr_t)paramsByte;
  if (dstStatic) return pack_pose_rows(t, indices, count, cap, depthDenom, pose, stat, typeByte, prevX, prevY, P, 1);
  return pack_pose_rows(t, indices, count, cap, depthDenom, pose, stat, typeByte, prevX, prevY, P, 0);
}
