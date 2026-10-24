/* Float32 variants of the mesh corner rewrite (wasm/meshCorners.c, E-76 W11, E-121), a test module for the
   float32 pass (WASM_HYPOTHESES "Open decisions" 5). The rewrite computes nothing: every corner is a 32-bit
   copy, so there is no double arithmetic for float32 to replace. What a float32 form can change is how the
   corners move:
     rewrite_corners_f32    one float load and one float store per coordinate, in the JS order (six stores a
                            fill row, twelve a UV row), where the shipped kernel joins x and y into one 64-bit
                            store
     rewrite_corners_f32x4  corners a and b of a triangle as one f32x4 store, assembled from four 32-bit lane
                            loads (no integer shifts or ors), corner c as one 64-bit lane store; the UV corners
                            the same. A fan keeps vertex 0 in the low half of a vector and moves the shared edge
                            in from the previous triangle with one shuffle
   Same table and memory contract as rewrite_corners, which this module also exports (the shipped body,
   included). The run walk, the generation tests, the topology checks and the checked copy for a torn mesh are
   the shipped ones. Bit-identical to rewrite_corners (tests/node/meshCornersF32.test.js). */
#include "../meshCorners.c"

/* Rows through these, as the shipped kernel's words: either store may alias the other (an odd or small
   stride), and the JS order must hold. */
typedef float __attribute__((may_alias)) fword;

/* f32: an indexed run, word by word. x, y, u, v start at the run's vertex offset. */
INLINE int32_t indexed_run_f32(fword *out, uint32_t base, uint32_t step, int uvOn, const uint16_t *ix, uint32_t run,
                               uint32_t vN, const float *x, const float *y, const float *u, const float *v) {
  for (uint32_t t = 0; t < run; t++, ix += 3, base += step) {
    const uint32_t a = ix[0];
    const uint32_t b = ix[1];
    const uint32_t c = ix[2];
    if (a >= vN || b >= vN || c >= vN) return -1;
    fword *row = out + base;
    row[0] = x[a];
    row[1] = y[a];
    row[2] = x[b];
    row[3] = y[b];
    row[4] = x[c];
    row[5] = y[c];
    if (uvOn) {
      fword *uv = row + R_UV0;
      uv[0] = u[a];
      uv[1] = v[a];
      uv[2] = u[b];
      uv[3] = v[b];
      uv[4] = u[c];
      uv[5] = v[c];
    }
  }
  return 1;
}

/* f32: a fan run (vertex 0, t + 1, t + 2), word by word. */
INLINE void fan_run_f32(fword *out, uint32_t base, uint32_t step, int uvOn, uint32_t run, const float *x,
                        const float *y, const float *u, const float *v) {
  for (uint32_t t = 0; t < run; t++, base += step) {
    fword *row = out + base;
    row[0] = x[0];
    row[1] = y[0];
    row[2] = x[t + 1];
    row[3] = y[t + 1];
    row[4] = x[t + 2];
    row[5] = y[t + 2];
    if (uvOn) {
      fword *uv = row + R_UV0;
      uv[0] = u[0];
      uv[1] = v[0];
      uv[2] = u[t + 1];
      uv[3] = v[t + 1];
      uv[4] = u[t + 2];
      uv[5] = v[t + 2];
    }
  }
}

/* (x[a], y[a], x[b], y[b]): four lane loads, the bits as they are. */
INLINE v128_t two_corners(const float *x, const float *y, uint32_t a, uint32_t b) {
  v128_t r = wasm_v128_load32_zero(x + a);
  r = wasm_v128_load32_lane(y + a, r, 1);
  r = wasm_v128_load32_lane(x + b, r, 2);
  return wasm_v128_load32_lane(y + b, r, 3);
}

/* (x[c], y[c], 0, 0). */
INLINE v128_t one_corner(const float *x, const float *y, uint32_t c) {
  const v128_t r = wasm_v128_load32_zero(x + c);
  return wasm_v128_load32_lane(y + c, r, 1);
}

/* A row's three corners: words 0..3 in one store, 4..5 in another, in that order. */
INLINE void store_row(fword *row, v128_t ab, v128_t c) {
  wasm_v128_store(row, ab);
  wasm_v128_store64_lane(row + 4, c, 0);
}

/* f32x4: an indexed run. */
INLINE int32_t indexed_run_f32x4(fword *out, uint32_t base, uint32_t step, int uvOn, const uint16_t *ix, uint32_t run,
                                 uint32_t vN, const float *x, const float *y, const float *u, const float *v) {
  for (uint32_t t = 0; t < run; t++, ix += 3, base += step) {
    const uint32_t a = ix[0];
    const uint32_t b = ix[1];
    const uint32_t c = ix[2];
    if (a >= vN || b >= vN || c >= vN) return -1;
    fword *row = out + base;
    store_row(row, two_corners(x, y, a, b), one_corner(x, y, c));
    if (uvOn) store_row(row + R_UV0, two_corners(u, v, a, b), one_corner(u, v, c));
  }
  return 1;
}

/* f32x4: a fan run. p0 holds vertex 0 in lanes 0..1; the last corner of a triangle is the middle one of the
   next. */
INLINE void fan_run_f32x4(fword *out, uint32_t base, uint32_t step, int uvOn, uint32_t run, const float *x,
                          const float *y, const float *u, const float *v) {
  const v128_t p0 = one_corner(x, y, 0);
  v128_t p1 = one_corner(x, y, 1);
  v128_t q0 = wasm_i32x4_splat(0);
  v128_t q1 = q0;
  if (uvOn) {
    q0 = one_corner(u, v, 0);
    q1 = one_corner(u, v, 1);
  }
  for (uint32_t t = 0; t < run; t++, base += step) {
    const v128_t p2 = one_corner(x, y, t + 2);
    fword *row = out + base;
    store_row(row, wasm_i32x4_shuffle(p0, p1, 0, 1, 4, 5), p2);
    p1 = p2;
    if (uvOn) {
      const v128_t q2 = one_corner(u, v, t + 2);
      store_row(row + R_UV0, wasm_i32x4_shuffle(q0, q1, 0, 1, 4, 5), q2);
      q1 = q2;
    }
  }
}

/* rewrite_corners with the copies above (simd: 0 for f32, 1 for f32x4; a constant once inlined). */
INLINE int32_t rewrite_corners_with(uint32_t table, const int simd) {
  const uint32_t *t = (const uint32_t *)(uintptr_t)table;
  fword *out = PTR(fword, T_OUT);
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
  const float *vx = PTR(const float, T_VX);
  const float *vy = PTR(const float, T_VY);
  const float *u = PTR(const float, T_U);
  const float *v = PTR(const float, T_V);
  const uint32_t vertCap = t[T_VERT_CAP];
  const uint16_t *indices = PTR(const uint16_t, T_INDICES);
  const uint32_t indexCap = t[T_INDEX_CAP];
  const int uvGenOn = uvOn && t[T_UV_GEN] != 0;
  const uint32_t *uvGen = PTR(const uint32_t, T_UV_GEN);
  const uint32_t uvGenLen = t[T_UV_GEN_LEN];
  const uint32_t *lastUv = PTR(const uint32_t, T_LAST_UV);
  const uint32_t lastUvLen = t[T_LAST_UV_LEN];

  if (n == 0) return 0;
  uint32_t k = 0;
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
        const uint32_t vN = vertCount[id];
        const int32_t iAt = indexOffset[id];
        const uint32_t need = iAt >= 0 ? indexCount[id] / 3u : (vN >= 3 ? vN - 2 : 0u);
        if (need != run || vN < 3) return -1;
        const int uvRun = uvOn && (!uvGenOn || uvDirty);
        const uint32_t base = k * step;
        const int fits = (uint64_t)(uint32_t)vOff + vN <= vertCap &&
                         (iAt < 0 || (uint64_t)(uint32_t)iAt + 3ull * run <= indexCap);
        if (!fits) {
          /* The shipped checked copy (word by word), for a mesh torn by a replace between the reads. */
          if (checked_run((word *)out, base, step, uvRun, run, vN, iAt, (uint32_t)vOff, indices, indexCap,
                          (const uint32_t *)vx, (const uint32_t *)vy, (const uint32_t *)u, (const uint32_t *)v,
                          vertCap) < 0) {
            return -1;
          }
        } else {
          const uint32_t o = (uint32_t)vOff;
          if (iAt >= 0) {
            const uint16_t *ix = indices + (uint32_t)iAt;
            int32_t r;
            if (simd) {
              r = uvRun ? indexed_run_f32x4(out, base, step, 1, ix, run, vN, vx + o, vy + o, u + o, v + o)
                        : indexed_run_f32x4(out, base, step, 0, ix, run, vN, vx + o, vy + o, u, v);
            } else {
              r = uvRun ? indexed_run_f32(out, base, step, 1, ix, run, vN, vx + o, vy + o, u + o, v + o)
                        : indexed_run_f32(out, base, step, 0, ix, run, vN, vx + o, vy + o, u, v);
            }
            if (r < 0) return -1;
          } else if (simd) {
            if (uvRun) fan_run_f32x4(out, base, step, 1, run, vx + o, vy + o, u + o, v + o);
            else fan_run_f32x4(out, base, step, 0, run, vx + o, vy + o, u, v);
          } else {
            if (uvRun) fan_run_f32(out, base, step, 1, run, vx + o, vy + o, u + o, v + o);
            else fan_run_f32(out, base, step, 0, run, vx + o, vy + o, u, v);
          }
        }
      }
    }
    k = end;
  }
  return 1;
}

__attribute__((export_name("rewrite_corners_f32")))
int32_t rewrite_corners_f32(uint32_t table) {
  return rewrite_corners_with(table, 0);
}

__attribute__((export_name("rewrite_corners_f32x4")))
int32_t rewrite_corners_f32x4(uint32_t table) {
  return rewrite_corners_with(table, 1);
}
