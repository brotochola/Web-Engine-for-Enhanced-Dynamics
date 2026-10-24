/* The particle worker's flowfield (E-76 W14): ParticleWorker.computeFlowfield
   (src/workers/particleWorker.js) for one target cell, from scratch.reset() to the smoothed vectors. The
   same search: Dijkstra over distance buckets (bucket min(distance, maxDistance), the last one a catch-all
   popped in list order), a cell joining a bucket at its head and leaving it from where it is, the head of
   the lowest bucket popped next, the eight neighbours in NAV_DX/NAV_DY order at cost 10 or 14, a strictly
   shorter distance taking the direction back to the cell; then each wall pointed at its nearest walkable
   neighbour (the first of the eight on a tie); then each direction replaced by the 3 x 3 average,
   Math.round((sum / count) * 127). So it writes the distances, directions and Int8Array vector pairs the
   JS writes. The JS's bookkeeping is folded, not ported: the visit stamp, the walkability test and the grid
   edges are one state byte per cell, written per call; a filed cell's bucket is min(distance, maxDistance),
   so bucketNodeDist is not kept; bucketTail and the identity bucketNodeCell are never read. The smoothing
   adds packed (x + 1, y + 1, 1) per direction across, then down (integer sums, exact in any order), and
   reads the quotient from a table of the 19 x 10 (sum, count) pairs, each computed in double as the JS
   computes it per cell. Every array is a byte offset into the imported shared memory, read from a table of
   u32 offsets (T_*). The slot stays JS (allocateFlowfieldSlot, the copy of T_OUT, READY). Returns the cells
   the search settled; 0, writing nothing, for a target off the grid (the message handler drops those). */
#include <stdint.h>

#define INLINE static inline __attribute__((always_inline))

/* u32 slots of the table (FLOWFIELD_SLOTS in src/workers/navFlowfieldClient.js, in the same order). */
enum {
  T_WALK,     /* u8 per cell: NavGrid's walkability, 0 = blocked */
  T_WIDTH,    /* gridWidth */
  T_HEIGHT,   /* gridHeight */
  T_MAX_DIST, /* scratch.maxDistance: the last bucket */
  T_STATE,    /* u8 per cell: S_* */
  T_DIST,     /* u16 per cell: scratch.distance */
  T_DIR,      /* u8 per cell: scratch.direction (DIRECTION) */
  T_NEXT,     /* i32 per cell: the bucket lists, toward the tail */
  T_PREV,     /* i32 per cell: toward the head */
  T_HEAD,     /* i32 per bucket, maxDistance + 1 */
  T_SUMS,     /* u32 per cell: the smoothing's row sums */
  T_QUOTIENT, /* i8, QUOTIENT_BYTES: the smoothing's rounded quotients */
  T_OUT,      /* i8 pairs per cell: the smoothed vectors (scratch.smoothedVectors) */
  T_SLOTS
};

#define S_WALL 1u    /* walkability 0 */
#define S_SETTLED 2u /* scratch.isVisited */
#define S_TOP 4u     /* row 0: no neighbour above */
#define S_BOTTOM 8u  /* the last row */
#define S_LEFT 16u   /* column 0 */
#define S_RIGHT 32u  /* the last column */

#define UNREACHED 65535u /* scratch.distance.fill(65535) */
#define COST_STRAIGHT 10u
#define COST_DIAGONAL 14u

/* DIRECTION (src/core/navGrid.js) */
#define DIR_NONE 0u
#define DIR_N 1u
#define DIR_NE 2u
#define DIR_E 3u
#define DIR_SE 4u
#define DIR_S 5u
#define DIR_SW 6u
#define DIR_W 7u
#define DIR_NW 8u

/* DIR_TO_VEC as 2-bit fields, direction d at bit 2d: x + 1 in VEC_X1, y + 1 in VEC_Y1; NONE's are 0. */
#define VEC_X1 0x6a4u
#define VEC_Y1 0x6a40u

/* The smoothing's quotients: QUOTIENT_COUNTS counts (0 .. 9) for each sum -9 .. 9. */
#define QUOTIENT_COUNTS 10u
#define QUOTIENT_BYTES (19u * QUOTIENT_COUNTS)

/* Math.round: the nearest integer, a half up (the floor and the difference are exact). */
INLINE double js_round(double v) {
  const double f = __builtin_floor(v);
  return v - f >= 0.5 ? f + 1.0 : f;
}

/* DIR_TO_VEC[d] for a direction 1 .. 8. */
INLINE int32_t vec_x(uint32_t d) { return (int32_t)((VEC_X1 >> (2u * d)) & 3u) - 1; }
INLINE int32_t vec_y(uint32_t d) { return (int32_t)((VEC_Y1 >> (2u * d)) & 3u) - 1; }

/* A direction for the smoothing's sums: x + 1 in bits 0-7, y + 1 in 8-15, 1 in 16-23; NONE adds nothing.
   Nine of them stay under 256 per field. */
INLINE uint32_t packed_vec(uint32_t d) {
  return ((VEC_X1 >> (2u * d)) & 3u) | (((VEC_Y1 >> (2u * d)) & 3u) << 8) | ((uint32_t)(d != DIR_NONE) << 16);
}

/* _bucketInsertCell's link: the cell becomes the head of bucket b. */
INLINE void push_cell(int32_t *next, int32_t *prev, int32_t *head, uint32_t cell, uint32_t b) {
  const int32_t h = head[b];
  prev[cell] = -1;
  next[cell] = h;
  if (h >= 0) prev[h] = (int32_t)cell;
  head[b] = (int32_t)cell;
}

/* _bucketUnlinkCell: the cell leaves bucket b from where it is. */
INLINE void unlink_cell(int32_t *next, int32_t *prev, int32_t *head, uint32_t cell, uint32_t b) {
  const int32_t p = prev[cell];
  const int32_t q = next[cell];
  if (p >= 0) next[p] = q;
  else head[b] = q;
  if (q >= 0) prev[q] = p;
}

/* One neighbour of the settled cell, the body of the JS loop over dir: walls and settled cells are
   skipped; a strictly shorter distance is kept with the direction back, and the cell is filed under its
   bucket, moved if it was filed under another (both clamped to the last bucket, it stays where it is).
   Distances stay under UNREACHED, so UNREACHED means never filed. Returns 1 when the cell joined the
   buckets: bucketCount. */
INLINE uint32_t relax(uint8_t *state, uint16_t *dist, uint8_t *dir, int32_t *next, int32_t *prev, int32_t *head,
                      uint32_t maxD, uint32_t n, uint32_t newDist, uint32_t back) {
  if (state[n] & (S_WALL | S_SETTLED)) return 0;
  const uint32_t old = dist[n];
  if (newDist >= old) return 0;
  dist[n] = (uint16_t)newDist;
  dir[n] = (uint8_t)back;
  const uint32_t b = newDist < maxD ? newDist : maxD;
  if (old == UNREACHED) {
    push_cell(next, prev, head, n, b);
    return 1;
  }
  const uint32_t from = old < maxD ? old : maxD;
  if (from != b) {
    unlink_cell(next, prev, head, n, from);
    push_cell(next, prev, head, n, b);
  }
  return 0;
}

/* The post-pass's look at one neighbour of a wall. best is (distance << 4) | direction; a walkable
   neighbour strictly nearer replaces it, so the first of the eight wins a tie. */
INLINE uint32_t nearer(const uint8_t *state, const uint16_t *dist, uint32_t n, uint32_t toward, uint32_t best) {
  if (state[n] & S_WALL) return best;
  const uint32_t d = dist[n];
  return d < (best >> 4) ? (d << 4) | toward : best;
}

__attribute__((export_name("compute_flowfield")))
uint32_t compute_flowfield(uint32_t table, uint32_t target) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every pointer is read once: the stores below may alias the table as far as the compiler knows. */
  const uint8_t *walk = (const uint8_t *)(uintptr_t)t[T_WALK];
  const uint32_t gw = t[T_WIDTH];
  const uint32_t gh = t[T_HEIGHT];
  const uint32_t maxD = t[T_MAX_DIST];
  uint8_t *state = (uint8_t *)(uintptr_t)t[T_STATE];
  uint16_t *dist = (uint16_t *)(uintptr_t)t[T_DIST];
  uint8_t *dir = (uint8_t *)(uintptr_t)t[T_DIR];
  int32_t *next = (int32_t *)(uintptr_t)t[T_NEXT];
  int32_t *prev = (int32_t *)(uintptr_t)t[T_PREV];
  int32_t *head = (int32_t *)(uintptr_t)t[T_HEAD];
  uint32_t *sums = (uint32_t *)(uintptr_t)t[T_SUMS];
  int8_t *quotient = (int8_t *)(uintptr_t)t[T_QUOTIENT];
  int8_t *out = (int8_t *)(uintptr_t)t[T_OUT];
  const uint32_t cells = gw * gh;
  if (target >= cells) return 0;

  /* scratch.reset() and the fills. The state byte stands for the stamp, the walkability and the edges. */
  for (uint32_t b = 0; b <= maxD; b++) head[b] = -1;
  for (uint32_t c = 0; c < cells; c++) dist[c] = (uint16_t)UNREACHED;
  for (uint32_t c = 0; c < cells; c++) dir[c] = (uint8_t)DIR_NONE;
  for (uint32_t y = 0, c = 0; y < gh; y++) {
    const uint32_t rowEdges = (y == 0 ? S_TOP : 0u) | (y + 1 == gh ? S_BOTTOM : 0u);
    for (uint32_t x = 0; x < gw; x++, c++) {
      const uint32_t edges = rowEdges | (x == 0 ? S_LEFT : 0u) | (x + 1 == gw ? S_RIGHT : 0u);
      state[c] = (uint8_t)(edges | (walk[c] == 0 ? S_WALL : 0u));
    }
  }

  /* The search, from the target (a wall too: it is filed and expanded like any cell). */
  dist[target] = 0;
  push_cell(next, prev, head, target, 0);
  uint32_t filed = 1; /* bucketCount */
  uint32_t at = 0;    /* bucketHeadDistance */
  uint32_t settled = 0;
  while (filed > 0) {
    while (at <= maxD && head[at] < 0) at++;
    if (at > maxD) break;
    /* _bucketPopCell: the head of the lowest bucket */
    const uint32_t cell = (uint32_t)head[at];
    const int32_t after = next[cell];
    head[at] = after;
    if (after >= 0) prev[after] = -1;
    filed--;
    const uint32_t s = state[cell];
    if (s & S_SETTLED) continue;
    state[cell] = (uint8_t)(s | S_SETTLED);
    settled++;
    const uint32_t straight = (uint32_t)dist[cell] + COST_STRAIGHT;
    const uint32_t diagonal = (uint32_t)dist[cell] + COST_DIAGONAL;
    /* NAV_DX/NAV_DY order: N, NE, E, SE, S, SW, W, NW, each filed pointing back (NAV_OPPOSITE_DIR). */
    if (!(s & S_TOP)) filed += relax(state, dist, dir, next, prev, head, maxD, cell - gw, straight, DIR_S);
    if (!(s & (S_TOP | S_RIGHT))) filed += relax(state, dist, dir, next, prev, head, maxD, cell - gw + 1, diagonal, DIR_SW);
    if (!(s & S_RIGHT)) filed += relax(state, dist, dir, next, prev, head, maxD, cell + 1, straight, DIR_W);
    if (!(s & (S_BOTTOM | S_RIGHT))) filed += relax(state, dist, dir, next, prev, head, maxD, cell + gw + 1, diagonal, DIR_NW);
    if (!(s & S_BOTTOM)) filed += relax(state, dist, dir, next, prev, head, maxD, cell + gw, straight, DIR_N);
    if (!(s & (S_BOTTOM | S_LEFT))) filed += relax(state, dist, dir, next, prev, head, maxD, cell + gw - 1, diagonal, DIR_NE);
    if (!(s & S_LEFT)) filed += relax(state, dist, dir, next, prev, head, maxD, cell - 1, straight, DIR_E);
    if (!(s & (S_TOP | S_LEFT))) filed += relax(state, dist, dir, next, prev, head, maxD, cell - gw - 1, diagonal, DIR_SE);
  }

  /* Walls: toward the nearest walkable neighbour (NAV_DIR_MAP), NONE when none was reached. */
  for (uint32_t c = 0; c < cells; c++) {
    const uint32_t s = state[c];
    if (!(s & S_WALL)) continue;
    uint32_t best = (UNREACHED << 4) | DIR_NONE;
    if (!(s & S_TOP)) best = nearer(state, dist, c - gw, DIR_N, best);
    if (!(s & (S_TOP | S_RIGHT))) best = nearer(state, dist, c - gw + 1, DIR_NE, best);
    if (!(s & S_RIGHT)) best = nearer(state, dist, c + 1, DIR_E, best);
    if (!(s & (S_BOTTOM | S_RIGHT))) best = nearer(state, dist, c + gw + 1, DIR_SE, best);
    if (!(s & S_BOTTOM)) best = nearer(state, dist, c + gw, DIR_S, best);
    if (!(s & (S_BOTTOM | S_LEFT))) best = nearer(state, dist, c + gw - 1, DIR_SW, best);
    if (!(s & S_LEFT)) best = nearer(state, dist, c - 1, DIR_W, best);
    if (!(s & (S_TOP | S_LEFT))) best = nearer(state, dist, c - gw - 1, DIR_NW, best);
    dir[c] = (uint8_t)(best & 15u);
  }

  /* The smoothing. Its quotients first: the JS's Math.round(avg * 127) for each (sum, count), count 0
     (nothing around) writing 0 as its else does. */
  for (int32_t sum = -9; sum <= 9; sum++) {
    int8_t *q = quotient + (uint32_t)(sum + 9) * QUOTIENT_COUNTS;
    q[0] = 0;
    for (uint32_t count = 1; count < QUOTIENT_COUNTS; count++) {
      q[count] = (int8_t)(int32_t)js_round(((double)sum / (double)count) * 127.0);
    }
  }
  /* Each cell's packed direction plus its left and right neighbours'. */
  for (uint32_t y = 0; y < gh; y++) {
    const uint32_t row = y * gw;
    uint32_t left = 0;
    uint32_t mid = packed_vec(dir[row]);
    for (uint32_t x = 0; x < gw; x++) {
      const uint32_t right = x + 1 < gw ? packed_vec(dir[row + x + 1]) : 0u;
      sums[row + x] = left + mid + right;
      left = mid;
      mid = right;
    }
  }
  /* Then the rows above and below: the 3 x 3 sums. A cell without a direction writes 0, a wall its own. */
  for (uint32_t y = 0; y < gh; y++) {
    const uint32_t row = y * gw;
    const int up = y > 0;
    const int down = y + 1 < gh;
    for (uint32_t x = 0; x < gw; x++) {
      const uint32_t c = row + x;
      const uint32_t d = dir[c];
      if (d == DIR_NONE) {
        out[2 * c] = 0;
        out[2 * c + 1] = 0;
      } else if (state[c] & S_WALL) {
        out[2 * c] = (int8_t)(vec_x(d) * 127);
        out[2 * c + 1] = (int8_t)(vec_y(d) * 127);
      } else {
        const uint32_t s = sums[c] + (up ? sums[c - gw] : 0u) + (down ? sums[c + gw] : 0u);
        const uint32_t count = s >> 16;
        /* sum + 9 = (x + 1 summed) - count + 9 */
        out[2 * c] = quotient[((s & 0xffu) + 9u - count) * QUOTIENT_COUNTS + count];
        out[2 * c + 1] = quotient[(((s >> 8) & 0xffu) + 9u - count) * QUOTIENT_COUNTS + count];
      }
    }
  }
  return settled;
}
