/* The mesh corner rewrite (E-76 W11): rewriteExplicitMeshCorners (src/render/colliderFillBatch.js) in C, the
   whole call: the walk over runs of instances that share an entity, the vertex-generation test, the topology
   checks that answer -1, and the corner copy (aV0..aV2, and uv0..uv2 on the UV batch's 24-float rows) through
   the index buffer or as a fan. It runs in Pixi on the mesh memory (src/util/meshMemory.js), through
   src/render/meshCornersClient.js, which writes the table. Every array is a byte offset into that memory:
   the batch rows, the instance-to-entity list, the captured and the drawn generations, and the MeshGeometry
   columns (spans, counts, vertices, UVs, indices). Nothing is computed: each corner is copied as its 32 bits,
   x and y (or u and v) as one 64-bit store. Where the JS reads past a column's end it reads undefined, an
   index of 0 and a corner of NaN; a run whose spans fit its columns takes the loop without those checks, the
   rest a checked copy of it. Returns 1 (done), -1 (the packed triangles no longer match: the caller repacks)
   or 0 (no instances).
   E-118: with the UV generations in the table (captured and drawn; slot T_UV_GEN 0 means none), a run of the
   UV batch is rewritten when its vertex or its UV generation moved, and gets its UV corners only when the UV
   generation moved, as rewriteExplicitMeshCorners does with lastUvGen.
   E-130: MeshGeometry's vertex counts and triangle indices are uint16 while renderer.maxMeshVerts is at most
   65535 and uint32 past that. rewrite_corners reads the 16-bit columns and is the code it was before;
   rewrite_corners_u32 is a copy of it (and of the loops that read indices) over the 32-bit ones. The client
   binds the export of the arena's width.
   E-453: the UV batch draws each mesh's vertices once through an index buffer (colliderFillBatch.js
   packMeshUvVerts), and rewrite_verts (rewrite_verts_u32 on a 32-bit arena) is its rewrite: see there. */
#include <stdint.h>
#include <wasm_simd128.h>

#define INLINE static inline __attribute__((always_inline))
/* undefined stored into a Float32Array. */
#define NAN_BITS 0x7fc00000u
/* MESH_UV_FILL rows: u, v of each corner from float 18. */
#define R_UV0 18u
/* E-453: MESH_UV_VERT records: x, y, u, v from float 0 of 16, the entity's reach at float 9. */
#define V_FLOATS 16u
#define V_REACH 9u

enum {
  T_OUT, T_COUNT, T_STEP, T_UV_ON, T_ENTITY, T_GEN, T_GEN_LEN, T_LAST, T_LAST_LEN,
  T_VERT_OFFSET, T_VERT_COUNT, T_INDEX_OFFSET, T_INDEX_COUNT, T_GEOM_N,
  T_VX, T_VY, T_U, T_V, T_VERT_CAP, T_INDICES, T_INDEX_CAP,
  /* E-118: the UV generations captured this frame and drawn, and their lengths. */
  T_UV_GEN, T_UV_GEN_LEN, T_LAST_UV, T_LAST_UV_LEN,
  /* DX-MESHUPLOAD, written back: the rows this call rewrote, [first, past). first >= past: none. */
  T_FIRST_ROW, T_PAST_ROW,
  /* E-453, rewrite_verts only: the batch's indices, each entity's first index there and their count (2 u32 an
     entity), the entities that table covers, and, written back, the indices the call rewrote, [first, past). */
  T_DRAW_INDICES, T_SPAN, T_SPAN_LEN, T_FIRST_INDEX, T_PAST_INDEX,
  SLOT_COUNT
};

#define PTR(T, c) ((T *)(uintptr_t)t[c])

/* Rows are written through these. Either store may alias the other (rows overlap under a 6-float stride, and
   the JS order must hold), and a pair sits on any 4-byte boundary (an odd stride). */
typedef uint32_t __attribute__((may_alias)) word;
typedef uint64_t __attribute__((may_alias, aligned(4))) pair;

/* One corner, x in the low word (the lower address), y in the high. */
INLINE uint64_t corner(const uint32_t *x, const uint32_t *y, uint32_t at) {
  return (uint64_t)x[at] | ((uint64_t)y[at] << 32);
}

/* The JS `while (end < n && entityOfInstance[end] === i) end++`, four instances a step. */
INLINE uint32_t run_end(const uint32_t *ent, uint32_t k, uint32_t n) {
  const uint32_t id = ent[k];
  const v128_t key = wasm_i32x4_splat((int32_t)id);
  uint32_t end = k + 1;
  while (end + 4 <= n) {
    const uint32_t diff = (uint32_t)wasm_i32x4_bitmask(wasm_i32x4_ne(wasm_v128_load(ent + end), key));
    if (diff) return end + (uint32_t)__builtin_ctz(diff);
    end += 4;
  }
  while (end < n && ent[end] == id) end++;
  return end;
}

/* Indexed run, its index span and vertex span inside their columns. x, y, u, v start at the run's vertex
   offset. A corner index past the mesh stops the call (-1) with the run's earlier triangles written, as in
   the JS. */
INLINE int32_t indexed_run(word *out, uint32_t base, uint32_t step, int uvOn, const uint16_t *ix, uint32_t run,
                           uint32_t vN, const uint32_t *x, const uint32_t *y, const uint32_t *u, const uint32_t *v) {
  for (uint32_t t = 0; t < run; t++, ix += 3, base += step) {
    const uint32_t a = ix[0];
    const uint32_t b = ix[1];
    const uint32_t c = ix[2];
    if (a >= vN || b >= vN || c >= vN) return -1;
    pair *row = (pair *)(out + base);
    row[0] = corner(x, y, a);
    row[1] = corner(x, y, b);
    row[2] = corner(x, y, c);
    if (uvOn) {
      pair *uv = (pair *)(out + base + R_UV0);
      uv[0] = corner(u, v, a);
      uv[1] = corner(u, v, b);
      uv[2] = corner(u, v, c);
    }
  }
  return 1;
}

/* indexed_run over 32-bit indices (E-130). An index of 2^31 or more, negative in the JS's `| 0`, is past any
   mesh (vN < 2^31) and stops the call as the JS does. */
INLINE int32_t indexed_run_u32(word *out, uint32_t base, uint32_t step, int uvOn, const uint32_t *ix, uint32_t run,
                               uint32_t vN, const uint32_t *x, const uint32_t *y, const uint32_t *u,
                               const uint32_t *v) {
  for (uint32_t t = 0; t < run; t++, ix += 3, base += step) {
    const uint32_t a = ix[0];
    const uint32_t b = ix[1];
    const uint32_t c = ix[2];
    if (a >= vN || b >= vN || c >= vN) return -1;
    pair *row = (pair *)(out + base);
    row[0] = corner(x, y, a);
    row[1] = corner(x, y, b);
    row[2] = corner(x, y, c);
    if (uvOn) {
      pair *uv = (pair *)(out + base + R_UV0);
      uv[0] = corner(u, v, a);
      uv[1] = corner(u, v, b);
      uv[2] = corner(u, v, c);
    }
  }
  return 1;
}

/* Fan run (vertex 0, t + 1, t + 2), its vertex span inside the columns. The JS reads vertex 0 and the shared
   edge again for each triangle; the kernel keeps them (it writes only rows, never vertices). */
INLINE void fan_run(word *out, uint32_t base, uint32_t step, int uvOn, uint32_t run, const uint32_t *x,
                    const uint32_t *y, const uint32_t *u, const uint32_t *v) {
  const uint64_t p0 = corner(x, y, 0);
  uint64_t p1 = corner(x, y, 1);
  uint64_t q0 = 0;
  uint64_t q1 = 0;
  if (uvOn) {
    q0 = corner(u, v, 0);
    q1 = corner(u, v, 1);
  }
  for (uint32_t t = 0; t < run; t++, base += step) {
    const uint64_t p2 = corner(x, y, t + 2);
    pair *row = (pair *)(out + base);
    row[0] = p0;
    row[1] = p1;
    row[2] = p2;
    p1 = p2;
    if (uvOn) {
      const uint64_t q2 = corner(u, v, t + 2);
      pair *uv = (pair *)(out + base + R_UV0);
      uv[0] = q0;
      uv[1] = q1;
      uv[2] = q2;
      q1 = q2;
    }
  }
}

/* The checked copy, for a run whose index or vertex span passes its column's end (a mesh torn by a replace
   between the reads): there the JS reads undefined, an index of 0 (undefined | 0) and a corner of NaN.
   Word by word, in the JS order. */
static int32_t checked_run(word *out, uint32_t base, uint32_t step, int uvOn, uint32_t run, uint32_t vN,
                           int32_t iAt, uint32_t vOff, const uint16_t *indices, uint32_t indexCap,
                           const uint32_t *vx, const uint32_t *vy, const uint32_t *u, const uint32_t *v,
                           uint32_t vertCap) {
  for (uint32_t t = 0; t < run; t++, base += step) {
    uint32_t ia;
    uint32_t ib;
    uint32_t ic;
    if (iAt >= 0) {
      const uint64_t o = (uint64_t)(uint32_t)iAt + 3ull * t;
      const uint32_t a = o < indexCap ? indices[o] : 0;
      const uint32_t b = o + 1 < indexCap ? indices[o + 1] : 0;
      const uint32_t c = o + 2 < indexCap ? indices[o + 2] : 0;
      if (a >= vN || b >= vN || c >= vN) return -1;
      ia = vOff + a;
      ib = vOff + b;
      ic = vOff + c;
    } else {
      ia = vOff;
      ib = vOff + t + 1;
      ic = vOff + t + 2;
    }
    /* vOff < 2^31 and an index < 2^16: no sum wraps. */
    word *row = out + base;
    row[0] = ia < vertCap ? vx[ia] : NAN_BITS;
    row[1] = ia < vertCap ? vy[ia] : NAN_BITS;
    row[2] = ib < vertCap ? vx[ib] : NAN_BITS;
    row[3] = ib < vertCap ? vy[ib] : NAN_BITS;
    row[4] = ic < vertCap ? vx[ic] : NAN_BITS;
    row[5] = ic < vertCap ? vy[ic] : NAN_BITS;
    if (uvOn) {
      row[R_UV0] = ia < vertCap ? u[ia] : NAN_BITS;
      row[R_UV0 + 1] = ia < vertCap ? v[ia] : NAN_BITS;
      row[R_UV0 + 2] = ib < vertCap ? u[ib] : NAN_BITS;
      row[R_UV0 + 3] = ib < vertCap ? v[ib] : NAN_BITS;
      row[R_UV0 + 4] = ic < vertCap ? u[ic] : NAN_BITS;
      row[R_UV0 + 5] = ic < vertCap ? v[ic] : NAN_BITS;
    }
  }
  return 1;
}

/* checked_run over 32-bit indices (E-130), word by word in the JS order as there. vOff < 2^31, and an index is
   below vN < 2^31 (the caller turned away a count of 2^31 or more): no sum wraps. */
static int32_t checked_run_u32(word *out, uint32_t base, uint32_t step, int uvOn, uint32_t run, uint32_t vN,
                               int32_t iAt, uint32_t vOff, const uint32_t *indices, uint32_t indexCap,
                               const uint32_t *vx, const uint32_t *vy, const uint32_t *u, const uint32_t *v,
                               uint32_t vertCap) {
  for (uint32_t t = 0; t < run; t++, base += step) {
    uint32_t ia;
    uint32_t ib;
    uint32_t ic;
    if (iAt >= 0) {
      const uint64_t o = (uint64_t)(uint32_t)iAt + 3ull * t;
      const uint32_t a = o < indexCap ? indices[o] : 0;
      const uint32_t b = o + 1 < indexCap ? indices[o + 1] : 0;
      const uint32_t c = o + 2 < indexCap ? indices[o + 2] : 0;
      if (a >= vN || b >= vN || c >= vN) return -1;
      ia = vOff + a;
      ib = vOff + b;
      ic = vOff + c;
    } else {
      ia = vOff;
      ib = vOff + t + 1;
      ic = vOff + t + 2;
    }
    word *row = out + base;
    row[0] = ia < vertCap ? vx[ia] : NAN_BITS;
    row[1] = ia < vertCap ? vy[ia] : NAN_BITS;
    row[2] = ib < vertCap ? vx[ib] : NAN_BITS;
    row[3] = ib < vertCap ? vy[ib] : NAN_BITS;
    row[4] = ic < vertCap ? vx[ic] : NAN_BITS;
    row[5] = ic < vertCap ? vy[ic] : NAN_BITS;
    if (uvOn) {
      row[R_UV0] = ia < vertCap ? u[ia] : NAN_BITS;
      row[R_UV0 + 1] = ia < vertCap ? v[ia] : NAN_BITS;
      row[R_UV0 + 2] = ib < vertCap ? u[ib] : NAN_BITS;
      row[R_UV0 + 3] = ib < vertCap ? v[ib] : NAN_BITS;
      row[R_UV0 + 4] = ic < vertCap ? u[ic] : NAN_BITS;
      row[R_UV0 + 5] = ic < vertCap ? v[ic] : NAN_BITS;
    }
  }
  return 1;
}

__attribute__((export_name("rewrite_corners")))
int32_t rewrite_corners(uint32_t table) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every slot is read once: the row stores below may alias the table as far as the compiler knows. */
  word *out = PTR(word, T_OUT);
  const uint32_t n = t[T_COUNT];
  const uint32_t step = t[T_STEP];
  const int uvOn = t[T_UV_ON] != 0;
  const uint32_t *ent = PTR(const uint32_t, T_ENTITY);
  const uint32_t *gen = PTR(const uint32_t, T_GEN);
  const uint32_t genLen = t[T_GEN_LEN];
  const uint32_t *last = PTR(const uint32_t, T_LAST);
  const uint32_t lastLen = t[T_LAST_LEN];
  const int32_t *vertOffset = PTR(const int32_t, T_VERT_OFFSET);
  const uint16_t *vertCount = PTR(const uint16_t, T_VERT_COUNT);
  const int32_t *indexOffset = PTR(const int32_t, T_INDEX_OFFSET);
  const uint32_t *indexCount = PTR(const uint32_t, T_INDEX_COUNT);
  const uint32_t geomN = t[T_GEOM_N];
  const uint32_t *vx = PTR(const uint32_t, T_VX);
  const uint32_t *vy = PTR(const uint32_t, T_VY);
  const uint32_t *u = PTR(const uint32_t, T_U);
  const uint32_t *v = PTR(const uint32_t, T_V);
  const uint32_t vertCap = t[T_VERT_CAP];
  const uint16_t *indices = PTR(const uint16_t, T_INDICES);
  const uint32_t indexCap = t[T_INDEX_CAP];
  /* E-118: only the UV batch reads the UV generations. */
  const int uvGenOn = uvOn && t[T_UV_GEN] != 0;
  const uint32_t *uvGen = PTR(const uint32_t, T_UV_GEN);
  const uint32_t uvGenLen = t[T_UV_GEN_LEN];
  const uint32_t *lastUv = PTR(const uint32_t, T_LAST_UV);
  const uint32_t lastUvLen = t[T_LAST_UV_LEN];

  if (n == 0) return 0;
  uint32_t k = 0;
  uint32_t firstRow = n;
  uint32_t pastRow = 0;
  while (k < n) {
    const uint32_t id = ent[k];
    const uint32_t end = run_end(ent, k, n);
    const uint32_t run = end - k;
    /* `i >= 0 && i < gen.length` with i = id | 0: an id past 2^31 is negative there, and past any length here.
       The drawn generations read 0 past their end (undefined >>> 0); the UV ones the same. */
    const int vertDirty = id < genLen && gen[id] != (id < lastLen ? last[id] : 0u);
    const int uvDirty = uvGenOn && id < uvGenLen && uvGen[id] != (id < lastUvLen ? lastUv[id] : 0u);
    if (vertDirty || uvDirty) {
      /* Past the MeshGeometry columns the JS reads offset 0, no vertices and no triangles: need 0 !== run. */
      if (id >= geomN) return -1;
      const int32_t vOff = vertOffset[id];
      if (vOff >= 0) {
        if (k < firstRow) firstRow = k;
        pastRow = end;
        const uint32_t vN = vertCount[id];
        const int32_t iAt = indexOffset[id];
        const uint32_t need = iAt >= 0 ? indexCount[id] / 3u : (vN >= 3 ? vN - 2 : 0u);
        if (need != run || vN < 3) return -1;
        /* The UV corners on the UV batch, unless the UV generations say they did not move. */
        const int uvRun = uvOn && (!uvGenOn || uvDirty);
        const uint32_t base = k * step;
        const int fits = (uint64_t)(uint32_t)vOff + vN <= vertCap &&
                         (iAt < 0 || (uint64_t)(uint32_t)iAt + 3ull * run <= indexCap);
        if (!fits) {
          if (checked_run(out, base, step, uvRun, run, vN, iAt, (uint32_t)vOff, indices, indexCap, vx, vy, u, v,
                          vertCap) < 0) {
            return -1;
          }
        } else {
          const uint32_t o = (uint32_t)vOff;
          if (iAt >= 0) {
            const uint16_t *ix = indices + (uint32_t)iAt;
            const int32_t r = uvRun ? indexed_run(out, base, step, 1, ix, run, vN, vx + o, vy + o, u + o, v + o)
                                    : indexed_run(out, base, step, 0, ix, run, vN, vx + o, vy + o, u, v);
            if (r < 0) return -1;
          } else if (uvRun) {
            fan_run(out, base, step, 1, run, vx + o, vy + o, u + o, v + o);
          } else {
            fan_run(out, base, step, 0, run, vx + o, vy + o, u, v);
          }
        }
      }
    }
    k = end;
  }
  ((uint32_t *)(uintptr_t)table)[T_FIRST_ROW] = firstRow;
  ((uint32_t *)(uintptr_t)table)[T_PAST_ROW] = pastRow;
  return 1;
}

/* rewrite_corners on a 32-bit arena (E-130): a copy of the walk, the vertex counts and indices read as uint32
   (indexed_run_u32, checked_run_u32). */
__attribute__((export_name("rewrite_corners_u32")))
int32_t rewrite_corners_u32(uint32_t table) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every slot is read once: the row stores below may alias the table as far as the compiler knows. */
  word *out = PTR(word, T_OUT);
  const uint32_t n = t[T_COUNT];
  const uint32_t step = t[T_STEP];
  const int uvOn = t[T_UV_ON] != 0;
  const uint32_t *ent = PTR(const uint32_t, T_ENTITY);
  const uint32_t *gen = PTR(const uint32_t, T_GEN);
  const uint32_t genLen = t[T_GEN_LEN];
  const uint32_t *last = PTR(const uint32_t, T_LAST);
  const uint32_t lastLen = t[T_LAST_LEN];
  const int32_t *vertOffset = PTR(const int32_t, T_VERT_OFFSET);
  const uint32_t *vertCount = PTR(const uint32_t, T_VERT_COUNT);
  const int32_t *indexOffset = PTR(const int32_t, T_INDEX_OFFSET);
  const uint32_t *indexCount = PTR(const uint32_t, T_INDEX_COUNT);
  const uint32_t geomN = t[T_GEOM_N];
  const uint32_t *vx = PTR(const uint32_t, T_VX);
  const uint32_t *vy = PTR(const uint32_t, T_VY);
  const uint32_t *u = PTR(const uint32_t, T_U);
  const uint32_t *v = PTR(const uint32_t, T_V);
  const uint32_t vertCap = t[T_VERT_CAP];
  const uint32_t *indices = PTR(const uint32_t, T_INDICES);
  const uint32_t indexCap = t[T_INDEX_CAP];
  /* E-118: only the UV batch reads the UV generations. */
  const int uvGenOn = uvOn && t[T_UV_GEN] != 0;
  const uint32_t *uvGen = PTR(const uint32_t, T_UV_GEN);
  const uint32_t uvGenLen = t[T_UV_GEN_LEN];
  const uint32_t *lastUv = PTR(const uint32_t, T_LAST_UV);
  const uint32_t lastUvLen = t[T_LAST_UV_LEN];

  if (n == 0) return 0;
  uint32_t k = 0;
  uint32_t firstRow = n;
  uint32_t pastRow = 0;
  while (k < n) {
    const uint32_t id = ent[k];
    const uint32_t end = run_end(ent, k, n);
    const uint32_t run = end - k;
    /* `i >= 0 && i < gen.length` with i = id | 0: an id past 2^31 is negative there, and past any length here.
       The drawn generations read 0 past their end (undefined >>> 0); the UV ones the same. */
    const int vertDirty = id < genLen && gen[id] != (id < lastLen ? last[id] : 0u);
    const int uvDirty = uvGenOn && id < uvGenLen && uvGen[id] != (id < lastUvLen ? lastUv[id] : 0u);
    if (vertDirty || uvDirty) {
      /* Past the MeshGeometry columns the JS reads offset 0, no vertices and no triangles: need 0 !== run. */
      if (id >= geomN) return -1;
      const int32_t vOff = vertOffset[id];
      if (vOff >= 0) {
        if (k < firstRow) firstRow = k;
        pastRow = end;
        const uint32_t vN = vertCount[id];
        const int32_t iAt = indexOffset[id];
        const uint32_t need = iAt >= 0 ? indexCount[id] / 3u : (vN >= 3 ? vN - 2 : 0u);
        /* The JS reads the count `| 0`: one of 2^31 or more is negative there, under 3. */
        if (need != run || (int32_t)vN < 3) return -1;
        /* The UV corners on the UV batch, unless the UV generations say they did not move. */
        const int uvRun = uvOn && (!uvGenOn || uvDirty);
        const uint32_t base = k * step;
        const int fits = (uint64_t)(uint32_t)vOff + vN <= vertCap &&
                         (iAt < 0 || (uint64_t)(uint32_t)iAt + 3ull * run <= indexCap);
        if (!fits) {
          if (checked_run_u32(out, base, step, uvRun, run, vN, iAt, (uint32_t)vOff, indices, indexCap, vx, vy, u,
                              v, vertCap) < 0) {
            return -1;
          }
        } else {
          const uint32_t o = (uint32_t)vOff;
          if (iAt >= 0) {
            const uint32_t *ix = indices + (uint32_t)iAt;
            const int32_t r = uvRun ? indexed_run_u32(out, base, step, 1, ix, run, vN, vx + o, vy + o, u + o, v + o)
                                    : indexed_run_u32(out, base, step, 0, ix, run, vN, vx + o, vy + o, u, v);
            if (r < 0) return -1;
          } else if (uvRun) {
            fan_run(out, base, step, 1, run, vx + o, vy + o, u + o, v + o);
          } else {
            fan_run(out, base, step, 0, run, vx + o, vy + o, u, v);
          }
        }
      }
    }
    k = end;
  }
  ((uint32_t *)(uintptr_t)table)[T_FIRST_ROW] = firstRow;
  ((uint32_t *)(uintptr_t)table)[T_PAST_ROW] = pastRow;
  return 1;
}

/* E-453: the UV batch's rewrite. Its vertex records (MESH_UV_VERT: V_FLOATS floats a vertex, a mesh's vertices in its
   order) are written by packMeshUvVerts with the indices of its triangles, and where each entity's indices start and how
   many there are (the span table, 2 u32 an entity). A run of records of one entity whose vertex or UV generation moved
   (the same tests as rewrite_corners) gets, when its mesh still has its vertices (offset 0 or more):
   - its vertices again: x and y, and u and v unless the UV generations say they did not move (E-118);
   - its entity's reach again, in every record: the longest vertex, the square root of the largest x * x + y * y in
     doubles, rounded once to float, as packMeshUvVerts computes it;
   - its triangles' indices again (MeshGeometry's, or its fan's), each the run's first record plus the mesh's index,
     at the entity's span.
   Returns -1, the caller repacking, when the records or the triangles no longer match the mesh: an entity past the
   MeshGeometry columns or the span table, a vertex count other than the run's (or under 3), a triangle count other
   than the span's (a mesh the pack left a triangle of out included), a span past its column (a mesh torn by a replace
   between the reads), or an index past the mesh, found before the run is written. Else 1 (0: no records), with the
   records and the indices it wrote, [T_FIRST_ROW, T_PAST_ROW) and [T_FIRST_INDEX, T_PAST_INDEX) (first >= past: none;
   T_FIRST_INDEX starts at 0xffffffff). wide (E-130): the vertex counts and indices are uint32, else uint16. */
typedef float __attribute__((may_alias)) mfloat;

/* A vertex count or an index: uint32 where wide, uint16 else. */
INLINE uint32_t narrow_or_wide(const void *column, uint32_t at, int wide) {
  return wide ? ((const uint32_t *)column)[at] : ((const uint16_t *)column)[at];
}

/* The vertices of a run (x, y; u, v too where uv), and the reach, into the records from `rec`. */
INLINE void verts_run(word *rec, uint32_t vN, int uv, const uint32_t *x, const uint32_t *y, const uint32_t *u,
                      const uint32_t *v) {
  const mfloat *fx = (const mfloat *)x;
  const mfloat *fy = (const mfloat *)y;
  double farthest = 0.0;
  for (uint32_t i = 0; i < vN; i++, rec += V_FLOATS) {
    *(pair *)rec = corner(x, y, i);
    if (uv) *(pair *)(rec + 2) = corner(u, v, i);
    const double dx = fx[i];
    const double dy = fy[i];
    const double d = dx * dx + dy * dy;
    if (d > farthest) farthest = d;
  }
  const float reach = (float)__builtin_sqrt(farthest);
  rec -= vN * V_FLOATS;
  for (uint32_t i = 0; i < vN; i++, rec += V_FLOATS) *(mfloat *)(rec + V_REACH) = reach;
}

INLINE int32_t verts_walk(uint32_t table, int wide) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  /* Every slot is read once: the stores below may alias the table as far as the compiler knows. */
  word *out = PTR(word, T_OUT);
  const uint32_t n = t[T_COUNT];
  const uint32_t *ent = PTR(const uint32_t, T_ENTITY);
  const uint32_t *gen = PTR(const uint32_t, T_GEN);
  const uint32_t genLen = t[T_GEN_LEN];
  const uint32_t *last = PTR(const uint32_t, T_LAST);
  const uint32_t lastLen = t[T_LAST_LEN];
  const int32_t *vertOffset = PTR(const int32_t, T_VERT_OFFSET);
  const void *vertCount = PTR(const void, T_VERT_COUNT);
  const int32_t *indexOffset = PTR(const int32_t, T_INDEX_OFFSET);
  const uint32_t *indexCount = PTR(const uint32_t, T_INDEX_COUNT);
  const uint32_t geomN = t[T_GEOM_N];
  const uint32_t *vx = PTR(const uint32_t, T_VX);
  const uint32_t *vy = PTR(const uint32_t, T_VY);
  const uint32_t *u = PTR(const uint32_t, T_U);
  const uint32_t *v = PTR(const uint32_t, T_V);
  const uint32_t vertCap = t[T_VERT_CAP];
  const void *indices = PTR(const void, T_INDICES);
  const uint32_t indexCap = t[T_INDEX_CAP];
  const int uvGenOn = t[T_UV_GEN] != 0;
  const uint32_t *uvGen = PTR(const uint32_t, T_UV_GEN);
  const uint32_t uvGenLen = t[T_UV_GEN_LEN];
  const uint32_t *lastUv = PTR(const uint32_t, T_LAST_UV);
  const uint32_t lastUvLen = t[T_LAST_UV_LEN];
  word *draw = PTR(word, T_DRAW_INDICES);
  const uint32_t *span = PTR(const uint32_t, T_SPAN);
  const uint32_t spanN = t[T_SPAN_LEN];

  if (n == 0) return 0;
  uint32_t k = 0;
  uint32_t firstRow = n;
  uint32_t pastRow = 0;
  uint32_t firstIndex = 0xffffffffu;
  uint32_t pastIndex = 0;
  while (k < n) {
    const uint32_t id = ent[k];
    const uint32_t end = run_end(ent, k, n);
    const uint32_t run = end - k;
    const int vertDirty = id < genLen && gen[id] != (id < lastLen ? last[id] : 0u);
    const int uvDirty = uvGenOn && id < uvGenLen && uvGen[id] != (id < lastUvLen ? lastUv[id] : 0u);
    if (vertDirty || uvDirty) {
      if (id >= geomN) return -1;
      const int32_t vOff = vertOffset[id];
      if (vOff >= 0) {
        const uint32_t vN = narrow_or_wide(vertCount, id, wide);
        if (vN != run || vN < 3) return -1;
        const int32_t iAt = indexOffset[id];
        const uint32_t tris = iAt >= 0 ? indexCount[id] / 3u : vN - 2;
        if (id >= spanN) return -1;
        const uint32_t at = span[2 * id];
        const uint32_t count = span[2 * id + 1];
        if (count != tris * 3u) return -1;
        if ((uint64_t)(uint32_t)vOff + vN > vertCap) return -1;
        if (iAt >= 0) {
          if ((uint64_t)(uint32_t)iAt + count > indexCap) return -1;
          for (uint32_t j = 0; j < count; j++) {
            if (narrow_or_wide(indices, (uint32_t)iAt + j, wide) >= vN) return -1;
          }
        }
        if (k < firstRow) firstRow = k;
        pastRow = end;
        const uint32_t o = (uint32_t)vOff;
        word *rec = out + k * V_FLOATS;
        if (!uvGenOn || uvDirty) {
          verts_run(rec, vN, 1, vx + o, vy + o, u + o, v + o);
        } else {
          verts_run(rec, vN, 0, vx + o, vy + o, u, v);
        }
        if (count > 0) {
          if (at < firstIndex) firstIndex = at;
          if (at + count > pastIndex) pastIndex = at + count;
          word *d = draw + at;
          if (iAt >= 0) {
            for (uint32_t j = 0; j < count; j++) d[j] = k + narrow_or_wide(indices, (uint32_t)iAt + j, wide);
          } else {
            for (uint32_t tri = 0; tri < tris; tri++, d += 3) {
              d[0] = k;
              d[1] = k + tri + 1;
              d[2] = k + tri + 2;
            }
          }
        }
      }
    }
    k = end;
  }
  uint32_t *back = (uint32_t *)(uintptr_t)table;
  back[T_FIRST_ROW] = firstRow;
  back[T_PAST_ROW] = pastRow;
  back[T_FIRST_INDEX] = firstIndex;
  back[T_PAST_INDEX] = pastIndex;
  return 1;
}

__attribute__((export_name("rewrite_verts")))
int32_t rewrite_verts(uint32_t table) {
  return verts_walk(table, 0);
}

/* rewrite_verts on a 32-bit arena (E-130): the vertex counts and indices read as uint32. */
__attribute__((export_name("rewrite_verts_u32")))
int32_t rewrite_verts_u32(uint32_t table) {
  return verts_walk(table, 1);
}
