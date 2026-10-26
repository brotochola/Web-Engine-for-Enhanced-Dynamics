// The mesh corner rewrite in JavaScript: rewriteExplicitMeshCorners (src/render/colliderFillBatch.js) as Pixi ran it
// until meshCorners.wasm (E-76 W11) became its only rewrite. Kept as the parity reference the kernel is tested
// against, and the subject of the rewrite's semantic tests (WASM_HYPOTHESES L12); the engine does not use it.

import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';

/**
 * Rewrite aV0..aV2 (and uv0..uv2 when stride is the UV batch) for entities whose
 * vertGen moved. Returns -1 when the packed triangle count no longer matches.
 *
 * E-118: `lastUvGen` holds the UV generations last drawn (MeshGeometry.uvGen, which setMesh, setPlane and
 * setRope bump and setVertices does not) and `uvGenNow` the copy taken with genNow (the live array
 * without it). With them, a run of the UV batch gets its UV corners only when its UV generation moved: a
 * grid that setVertices deforms keeps the UVs it was drawn with, and its rows take half the stores. A run
 * whose UV generation moved is rewritten even when its vertex generation did not, so a capture that
 * caught one of a write's two bumps and not the other draws the write the next frame. The API bumps
 * both in one call, so the runs rewritten are the ones rewritten without them. Without lastUvGen every
 * rewritten run of the UV batch stores its UVs, as before.
 * @returns {number} 1 ok, -1 topology mismatch, 0 nothing to do
 */
export function rewriteExplicitMeshCorners(out, count, entityOfInstance, views, stride, lastVertGen, genNow, lastUvGen, uvGenNow) {
  const n = count | 0;
  // genNow: generations captured before any vertex read (see pixiWorker
  // _captureVertGen). The live array works for a single-threaded caller.
  const gen = genNow || views.meshVertGen;
  if (!out || n <= 0 || !entityOfInstance || !gen || !lastVertGen) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : COLLIDER_FILL_FLOATS;
  const vx = views.meshVertexX;
  const vy = views.meshVertexY;
  const indices = views.meshIndices;
  const u = views.meshUvU;
  const v = views.meshUvV;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!u && !!v;
  // E-118: the UV generations, on the UV batch, when the caller keeps the ones it drew.
  const uvGen = uvOn && lastUvGen ? (uvGenNow || views.meshUvGen || null) : null;
  let k = 0;
  while (k < n) {
    const i = entityOfInstance[k] | 0;
    let end = k + 1;
    while (end < n && (entityOfInstance[end] | 0) === i) end++;
    const run = end - k;
    const vertDirty = i >= 0 && i < gen.length && (gen[i] >>> 0) !== ((lastVertGen[i] >>> 0));
    const uvDirty = uvGen !== null && i >= 0 && i < uvGen.length && (uvGen[i] >>> 0) !== ((lastUvGen[i] >>> 0));
    const vOff = views.meshVertOffset && i >= 0 ? (views.meshVertOffset[i] | 0) : -1;
    if ((vertDirty || uvDirty) && vOff >= 0) {
      const vN = views.meshVertCount ? (views.meshVertCount[i] | 0) : 0;
      const iAt = views.meshIndexOffset ? (views.meshIndexOffset[i] | 0) : -1;
      const need = iAt >= 0
        ? ((views.meshIndexCount[i] >>> 0) / 3) | 0
        : (vN >= 3 ? vN - 2 : 0);
      if (need !== run || vN < 3 || !vx || !vy) return -1;
      // One loop per case, so no row tests whether it stores UVs (review R8).
      const uvRun = uvOn && (uvGen === null || uvDirty);
      if (iAt >= 0) {
        if (!indices) return -1;
        if (uvRun) {
          for (let t = 0; t < run; t++) {
            const o = iAt + t * 3;
            const a = indices[o] | 0;
            const b = indices[o + 1] | 0;
            const c = indices[o + 2] | 0;
            if (a < 0 || b < 0 || c < 0 || a >= vN || b >= vN || c >= vN) return -1;
            const ia = vOff + a;
            const ib = vOff + b;
            const ic = vOff + c;
            const base = (k + t) * step;
            out[base] = vx[ia];
            out[base + 1] = vy[ia];
            out[base + 2] = vx[ib];
            out[base + 3] = vy[ib];
            out[base + 4] = vx[ic];
            out[base + 5] = vy[ic];
            out[base + 18] = u[ia];
            out[base + 19] = v[ia];
            out[base + 20] = u[ib];
            out[base + 21] = v[ib];
            out[base + 22] = u[ic];
            out[base + 23] = v[ic];
          }
        } else {
          for (let t = 0; t < run; t++) {
            const o = iAt + t * 3;
            const a = indices[o] | 0;
            const b = indices[o + 1] | 0;
            const c = indices[o + 2] | 0;
            if (a < 0 || b < 0 || c < 0 || a >= vN || b >= vN || c >= vN) return -1;
            const ia = vOff + a;
            const ib = vOff + b;
            const ic = vOff + c;
            const base = (k + t) * step;
            out[base] = vx[ia];
            out[base + 1] = vy[ia];
            out[base + 2] = vx[ib];
            out[base + 3] = vy[ib];
            out[base + 4] = vx[ic];
            out[base + 5] = vy[ic];
          }
        }
      } else if (uvRun) {
        for (let t = 0; t < run; t++) {
          const ib = vOff + t + 1;
          const ic = vOff + t + 2;
          const base = (k + t) * step;
          out[base] = vx[vOff];
          out[base + 1] = vy[vOff];
          out[base + 2] = vx[ib];
          out[base + 3] = vy[ib];
          out[base + 4] = vx[ic];
          out[base + 5] = vy[ic];
          out[base + 18] = u[vOff];
          out[base + 19] = v[vOff];
          out[base + 20] = u[ib];
          out[base + 21] = v[ib];
          out[base + 22] = u[ic];
          out[base + 23] = v[ic];
        }
      } else {
        for (let t = 0; t < run; t++) {
          const ib = vOff + t + 1;
          const ic = vOff + t + 2;
          const base = (k + t) * step;
          out[base] = vx[vOff];
          out[base + 1] = vy[vOff];
          out[base + 2] = vx[ib];
          out[base + 3] = vy[ib];
          out[base + 4] = vx[ic];
          out[base + 5] = vy[ic];
        }
      }
    }
    k = end;
  }
  return 1;
}
