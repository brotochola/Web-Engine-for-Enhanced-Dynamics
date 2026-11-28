/* Publish filtered neighbors. Same predicate as SpatialWorker._publishFilteredNeighbors, with the
   same arithmetic: the float32 inputs widened to double and every operation in double, so both
   paths publish the same set (E-76 W8a; in float32 they disagreed within ~3e-7 of the range edge).
   Scalar: on Predator's rows the loads dominate and an f32x4 form was no faster.
   Pointers are byte offsets into the imported shared memory. Entity ids are 16-bit, or 32-bit through
   publish_batch_u32 for a scene past 65 535 entities (W8b): the lists, the candidate rows and the neighbor
   rows hold ids of that width.

   E-199: publish_batch_agg (and _u32) publish the same rows and, for the entities of the types that ask
   (a class byte per entity, 0 for none), write what a steering rule would otherwise read neighbour by
   neighbour: the separation (the offsets from the neighbours, each over its d²), the cohesion group's
   centroid and average velocity, and the K nearest of a type. Each aggregate is over the row it publishes,
   with the d² the publish already has. The layout of the table and of a type's config is
   src/util/neighborAggregatesSpec.js's (AGG_*); tests/reference/neighborAggregates.mjs is the same
   arithmetic in JS, and tests/node/neighborAggregatesWasm.test.js holds the two to the bit. The plain
   publish_batch is left as it was: a scene with no aggregates runs it. */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

/* The table's u32 words (aggByte): where each region is, and the nearest columns' slots per entity. */
#define AGG_CLASS 0u
#define AGG_CONFIGS 1u
#define AGG_SEP_X 2u
#define AGG_SEP_Y 3u
#define AGG_SEP_N 4u
#define AGG_COH_X 5u
#define AGG_COH_Y 6u
#define AGG_COH_N 7u
#define AGG_VEL_X 8u
#define AGG_VEL_Y 9u
#define AGG_NEAR_ID 10u
#define AGG_NEAR_D2 11u
#define AGG_NEAR_N 12u
#define AGG_NEAR_SLOTS 13u
/* A type's config: four doubles, then eight u32. */
#define AGG_CONFIG_BYTES 64u
#define AGG_F_SEPARATION 1u
#define AGG_F_COHESION 2u
#define AGG_F_VELOCITY 4u
#define AGG_F_NEAREST 8u
/* A neighbour this close (d² at most 1) has no direction to push from: separation leaves it out. */
#define SEPARATION_MIN_D2 1.0

INLINE void publish_row(uint32_t entityA, uint32_t maxNeighbors, const float *pos, const float *range,
                        const uint16_t *cand16, const uint32_t *cand32, uint16_t *neighbor16, uint32_t *neighbor32,
                        int wide) {
  uint32_t stride = 1u + maxNeighbors;
  double myX = pos[entityA * 4u];
  double myY = pos[entityA * 4u + 1u];
  double myRange = range[entityA];
  uint32_t base = entityA * stride;
  uint32_t candCount = wide ? cand32[base] : cand16[base];
  uint32_t published = 0;
  for (uint32_t i = 0; i < candCount && published < maxNeighbors; i++) {
    uint32_t b = wide ? cand32[base + 1u + i] : cand16[base + 1u + i];
    double dx = (double)pos[b * 4u] - myX;
    double dy = (double)pos[b * 4u + 1u] - myY;
    double er = myRange + (double)pos[b * 4u + 2u];
    if (dx * dx + dy * dy < er * er) {
      if (wide) neighbor32[base + 1u + published] = b;
      else neighbor16[base + 1u + published] = (uint16_t)b;
      published++;
    }
  }
  if (wide) neighbor32[base] = published;
  else neighbor16[base] = (uint16_t)published;
}

INLINE void publish(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                    uint32_t neighborByte, uint32_t listByte, int wide) {
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  const uint16_t *cand16 = (const uint16_t *)(uintptr_t)candByte;
  const uint32_t *cand32 = (const uint32_t *)(uintptr_t)candByte;
  uint16_t *neighbor16 = (uint16_t *)(uintptr_t)neighborByte;
  uint32_t *neighbor32 = (uint32_t *)(uintptr_t)neighborByte;
  const uint16_t *list16 = (const uint16_t *)(uintptr_t)listByte;
  const uint32_t *list32 = (const uint32_t *)(uintptr_t)listByte;

  for (uint32_t n = 0; n < batchCount; n++) {
    uint32_t entityA = wide ? list32[n] : list16[n];
    publish_row(entityA, maxNeighbors, pos, range, cand16, cand32, neighbor16, neighbor32, wide);
  }
}

__attribute__((export_name("publish_batch")))
void publish_batch(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                   uint32_t neighborByte, uint32_t listByte) {
  publish(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, 0);
}

__attribute__((export_name("publish_batch_u32")))
void publish_batch_u32(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte, uint32_t candByte,
                       uint32_t neighborByte, uint32_t listByte) {
  publish(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, 1);
}

/* A type id range test: b in [lo, lo + span). "Any type" is lo 0, span 0xffffffff. */
INLINE int in_range(uint32_t b, uint32_t lo, uint32_t span) { return (b - lo) < span; }

/* One row with its aggregates. sep, coh, vel and near are constants at each call (publish_agg's switch), so each
   mix of aggregates is its own copy of the candidate loop, without a branch on what the type asked for. The output
   columns come from the table (AGG_*), by entity; the nearest ones nearSlots per entity. */
INLINE void publish_row_agg(uint32_t entityA, uint32_t maxNeighbors, const float *pos, const float *range,
                            const uint16_t *cand16, const uint32_t *cand32, uint16_t *neighbor16, uint32_t *neighbor32,
                            const uint8_t *cfg, const uint32_t *table, const float *vx, const float *vy,
                            const int sep, const int coh, const int vel, const int near, const int wide) {
  uint32_t stride = 1u + maxNeighbors;
  double myX = pos[entityA * 4u];
  double myY = pos[entityA * 4u + 1u];
  double myRange = range[entityA];
  uint32_t base = entityA * stride;
  uint32_t candCount = wide ? cand32[base] : cand16[base];
  uint32_t published = 0;

  const double *cfgD = (const double *)cfg;
  const uint32_t *cfgU = (const uint32_t *)(cfg + 32u);
  const double sepR2 = cfgD[0];
  const double sepFloor2 = cfgD[1];
  const double sepFalloff = cfgD[2];
  const double cohMin2 = cfgD[3];
  const uint32_t sepLo = cfgU[1];
  const uint32_t sepSpan = cfgU[2];
  const uint32_t cohLo = cfgU[3];
  const uint32_t cohSpan = cfgU[4];
  const uint32_t nearLo = cfgU[5];
  const uint32_t nearSpan = cfgU[6];
  const uint32_t nearK = cfgU[7];
  const uint32_t nearSlots = table[AGG_NEAR_SLOTS];

  double sx = 0.0;
  double sy = 0.0;
  uint32_t sn = 0;
  double cx = 0.0;
  double cy = 0.0;
  double vxs = 0.0;
  double vys = 0.0;
  uint32_t cn = 0;
  uint32_t nn = 0;
  int32_t *nearId = (int32_t *)(uintptr_t)table[AGG_NEAR_ID] + entityA * nearSlots;
  float *nearD2 = (float *)(uintptr_t)table[AGG_NEAR_D2] + entityA * nearSlots;

  for (uint32_t i = 0; i < candCount && published < maxNeighbors; i++) {
    uint32_t b = wide ? cand32[base + 1u + i] : cand16[base + 1u + i];
    double bx = pos[b * 4u];
    double by = pos[b * 4u + 1u];
    double dx = bx - myX;
    double dy = by - myY;
    double er = myRange + (double)pos[b * 4u + 2u];
    double d2 = dx * dx + dy * dy;
    if (d2 < er * er) {
      if (wide) neighbor32[base + 1u + published] = b;
      else neighbor16[base + 1u + published] = (uint16_t)b;
      published++;
      if (sep && in_range(b, sepLo, sepSpan) && d2 > SEPARATION_MIN_D2 && d2 < sepR2) {
        /* The push away from b: its offset over d² (floored), times the falloff (1 without one). */
        double w = 1.0 - d2 * sepFalloff;
        double dd = d2 < sepFloor2 ? sepFloor2 : d2;
        sx -= (dx * w) / dd;
        sy -= (dy * w) / dd;
        sn++;
      }
      if (coh && in_range(b, cohLo, cohSpan) && d2 >= cohMin2) {
        cx += bx;
        cy += by;
        if (vel) {
          vxs += (double)vx[b];
          vys += (double)vy[b];
        }
        cn++;
      }
      if (near && in_range(b, nearLo, nearSpan)) {
        /* Insertion into the entity's K slots, ascending by d² as stored (float32); a tie keeps the row's order. */
        float d2s = (float)d2;
        uint32_t slot;
        if (nn < nearK) {
          slot = nn++;
        } else if (d2s < nearD2[nearK - 1u]) {
          slot = nearK - 1u;
        } else {
          continue;
        }
        while (slot > 0 && d2s < nearD2[slot - 1u]) {
          nearD2[slot] = nearD2[slot - 1u];
          nearId[slot] = nearId[slot - 1u];
          slot--;
        }
        nearD2[slot] = d2s;
        nearId[slot] = (int32_t)b;
      }
    }
  }
  if (wide) neighbor32[base] = published;
  else neighbor16[base] = (uint16_t)published;

  if (sep) {
    ((float *)(uintptr_t)table[AGG_SEP_X])[entityA] = (float)sx;
    ((float *)(uintptr_t)table[AGG_SEP_Y])[entityA] = (float)sy;
    ((uint16_t *)(uintptr_t)table[AGG_SEP_N])[entityA] = (uint16_t)sn;
  }
  if (coh) {
    ((float *)(uintptr_t)table[AGG_COH_X])[entityA] = cn ? (float)(cx / (double)cn) : 0.0f;
    ((float *)(uintptr_t)table[AGG_COH_Y])[entityA] = cn ? (float)(cy / (double)cn) : 0.0f;
    ((uint16_t *)(uintptr_t)table[AGG_COH_N])[entityA] = (uint16_t)cn;
    if (vel) {
      ((float *)(uintptr_t)table[AGG_VEL_X])[entityA] = cn ? (float)(vxs / (double)cn) : 0.0f;
      ((float *)(uintptr_t)table[AGG_VEL_Y])[entityA] = cn ? (float)(vys / (double)cn) : 0.0f;
    }
  }
  if (near) ((uint16_t *)(uintptr_t)table[AGG_NEAR_N])[entityA] = (uint16_t)nn;
}

#define AGG_ROW(S, C, V, N)                                                                                            \
  publish_row_agg(entityA, maxNeighbors, pos, range, cand16, cand32, neighbor16, neighbor32, cfg, table, vx, vy, S, C, \
                  V, N, wide)

INLINE void publish_agg(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte,
                        uint32_t candByte, uint32_t neighborByte, uint32_t listByte, uint32_t aggByte, uint32_t vxByte,
                        uint32_t vyByte, int wide) {
  const float *pos = (const float *)(uintptr_t)posByte;
  const float *range = (const float *)(uintptr_t)rangeByte;
  const uint16_t *cand16 = (const uint16_t *)(uintptr_t)candByte;
  const uint32_t *cand32 = (const uint32_t *)(uintptr_t)candByte;
  uint16_t *neighbor16 = (uint16_t *)(uintptr_t)neighborByte;
  uint32_t *neighbor32 = (uint32_t *)(uintptr_t)neighborByte;
  const uint16_t *list16 = (const uint16_t *)(uintptr_t)listByte;
  const uint32_t *list32 = (const uint32_t *)(uintptr_t)listByte;
  const uint32_t *table = (const uint32_t *)(uintptr_t)aggByte;
  const uint8_t *classOf = (const uint8_t *)(uintptr_t)table[AGG_CLASS];
  const uint8_t *configs = (const uint8_t *)(uintptr_t)table[AGG_CONFIGS];
  const float *vx = (const float *)(uintptr_t)vxByte;
  const float *vy = (const float *)(uintptr_t)vyByte;
  /* Without the velocity columns in this memory (not bound yet, or not in it) the velocity is not averaged. */
  const uint32_t flagMask = vxByte && vyByte ? 0xffffffffu : ~AGG_F_VELOCITY;

  for (uint32_t n = 0; n < batchCount; n++) {
    uint32_t entityA = wide ? list32[n] : list16[n];
    uint32_t c = classOf[entityA];
    if (c == 0) {
      publish_row(entityA, maxNeighbors, pos, range, cand16, cand32, neighbor16, neighbor32, wide);
      continue;
    }
    const uint8_t *cfg = configs + c * AGG_CONFIG_BYTES;
    uint32_t flags = ((const uint32_t *)(cfg + 32u))[0] & flagMask;
    switch (flags) {
      case AGG_F_SEPARATION: AGG_ROW(1, 0, 0, 0); break;
      case AGG_F_COHESION: AGG_ROW(0, 1, 0, 0); break;
      case AGG_F_COHESION | AGG_F_VELOCITY: AGG_ROW(0, 1, 1, 0); break;
      case AGG_F_NEAREST: AGG_ROW(0, 0, 0, 1); break;
      case AGG_F_SEPARATION | AGG_F_COHESION: AGG_ROW(1, 1, 0, 0); break;
      case AGG_F_SEPARATION | AGG_F_COHESION | AGG_F_VELOCITY: AGG_ROW(1, 1, 1, 0); break;
      case AGG_F_SEPARATION | AGG_F_NEAREST: AGG_ROW(1, 0, 0, 1); break;
      case AGG_F_COHESION | AGG_F_NEAREST: AGG_ROW(0, 1, 0, 1); break;
      case AGG_F_COHESION | AGG_F_VELOCITY | AGG_F_NEAREST: AGG_ROW(0, 1, 1, 1); break;
      case AGG_F_SEPARATION | AGG_F_COHESION | AGG_F_NEAREST: AGG_ROW(1, 1, 0, 1); break;
      case AGG_F_SEPARATION | AGG_F_COHESION | AGG_F_VELOCITY | AGG_F_NEAREST: AGG_ROW(1, 1, 1, 1); break;
      default: publish_row(entityA, maxNeighbors, pos, range, cand16, cand32, neighbor16, neighbor32, wide); break;
    }
  }
}

__attribute__((export_name("publish_batch_agg")))
void publish_batch_agg(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte,
                       uint32_t candByte, uint32_t neighborByte, uint32_t listByte, uint32_t aggByte, uint32_t vxByte,
                       uint32_t vyByte) {
  publish_agg(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, aggByte, vxByte, vyByte, 0);
}

__attribute__((export_name("publish_batch_agg_u32")))
void publish_batch_agg_u32(uint32_t batchCount, uint32_t maxNeighbors, uint32_t posByte, uint32_t rangeByte,
                           uint32_t candByte, uint32_t neighborByte, uint32_t listByte, uint32_t aggByte,
                           uint32_t vxByte, uint32_t vyByte) {
  publish_agg(batchCount, maxNeighbors, posByte, rangeByte, candByte, neighborByte, listByte, aggByte, vxByte, vyByte, 1);
}
