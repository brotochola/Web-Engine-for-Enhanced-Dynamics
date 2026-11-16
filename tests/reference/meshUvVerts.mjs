// E-453: the UV batch's rewrite in JavaScript, as wasm/meshCorners.c rewrite_verts runs it (src/render/meshCornersClient.js
// rewriteVertsWasm calls the kernel; the engine runs no JS form). The parity reference the kernel is tested against,
// and the subject of the rewrite's semantic tests (meshUvVerts.test.js).

import { MESH_UV_VERT_FLOATS } from '../../src/render/colliderFillBatch.js';

/**
 * The UV batch's vertex records [0, count) that packMeshUvVerts wrote into `target` (verts, vertexEntity, indices,
 * indexSpan), rewritten for the entities whose vertex or UV generation moved since the ones drawn: the run of records of
 * such an entity gets, when its mesh still has its vertices, its x, y (and u, v unless the UV generations say they did
 * not move, E-118), its reach in every record (the square root of the largest x * x + y * y, as the pack computes it),
 * and its triangles' indices (MeshGeometry's, or its fan's, plus the run's first record) at its span. -1 when the records
 * or the triangles no longer match the mesh (the checks of rewrite_verts, in its order, all made before a run is
 * written). `lastUvGen` and `uvGenNow` as rewriteExplicitMeshCorners takes them.
 * @returns {{ result: number, firstRow: number, pastRow: number, firstIndex: number, pastIndex: number }} result 1
 *   done, -1 repack, 0 nothing to do; the records and the indices written (first >= past: none; firstIndex starts at
 *   0xffffffff)
 */
export function rewriteMeshUvVerts(target, count, views, lastVertGen, genNow, lastUvGen, uvGenNow) {
  const n = count | 0;
  const gen = genNow || views.meshVertGen;
  const done = { result: 0, firstRow: n, pastRow: 0, firstIndex: 0xffffffff, pastIndex: 0 };
  if (n <= 0 || !gen || !lastVertGen) return done;
  const out = target.verts;
  const ent = target.vertexEntity;
  const draw = target.indices;
  const span = target.indexSpan;
  const spanN = span.length >> 1;
  const vx = views.meshVertexX;
  const vy = views.meshVertexY;
  const u = views.meshUvU;
  const v = views.meshUvV;
  const indices = views.meshIndices;
  const geomN = views.meshVertOffset.length;
  const vertCap = vx.length;
  const indexCap = indices.length;
  const uvGen = lastUvGen ? (uvGenNow || views.meshUvGen || null) : null;
  const F = MESH_UV_VERT_FLOATS;
  let k = 0;
  while (k < n) {
    const id = ent[k] >>> 0;
    let end = k + 1;
    while (end < n && (ent[end] >>> 0) === id) end++;
    const run = end - k;
    const vertDirty = id < gen.length && (gen[id] >>> 0) !== (id < lastVertGen.length ? lastVertGen[id] >>> 0 : 0);
    const uvDirty =
      uvGen !== null && id < uvGen.length && (uvGen[id] >>> 0) !== (id < lastUvGen.length ? lastUvGen[id] >>> 0 : 0);
    if (vertDirty || uvDirty) {
      if (id >= geomN) return { ...done, result: -1 };
      const vOff = views.meshVertOffset[id] | 0;
      if (vOff >= 0) {
        const vN = views.meshVertCount[id] >>> 0;
        if (vN !== run || vN < 3) return { ...done, result: -1 };
        const iAt = views.meshIndexOffset[id] | 0;
        const tris = iAt >= 0 ? Math.floor((views.meshIndexCount[id] >>> 0) / 3) : vN - 2;
        if (id >= spanN) return { ...done, result: -1 };
        const at = span[2 * id] >>> 0;
        const cnt = span[2 * id + 1] >>> 0;
        if (cnt !== tris * 3) return { ...done, result: -1 };
        if (vOff + vN > vertCap) return { ...done, result: -1 };
        if (iAt >= 0) {
          if (iAt + cnt > indexCap) return { ...done, result: -1 };
          for (let j = 0; j < cnt; j++) if ((indices[iAt + j] >>> 0) >= vN) return { ...done, result: -1 };
        }
        if (k < done.firstRow) done.firstRow = k;
        done.pastRow = end;
        const uvRun = uvGen === null || uvDirty;
        let far = 0;
        for (let i = 0; i < vN; i++) {
          const o = (k + i) * F;
          const x = vx[vOff + i];
          const y = vy[vOff + i];
          out[o] = x;
          out[o + 1] = y;
          if (uvRun) {
            out[o + 2] = u[vOff + i];
            out[o + 3] = v[vOff + i];
          }
          const d = x * x + y * y;
          if (d > far) far = d;
        }
        const reach = Math.sqrt(far);
        for (let i = 0; i < vN; i++) out[(k + i) * F + 9] = reach;
        if (cnt > 0) {
          if (at < done.firstIndex) done.firstIndex = at;
          if (at + cnt > done.pastIndex) done.pastIndex = at + cnt;
          if (iAt >= 0) {
            for (let j = 0; j < cnt; j++) draw[at + j] = k + (indices[iAt + j] >>> 0);
          } else {
            for (let t = 0; t < tris; t++) {
              draw[at + t * 3] = k;
              draw[at + t * 3 + 1] = k + t + 1;
              draw[at + t * 3 + 2] = k + t + 2;
            }
          }
        }
      }
    }
    k = end;
  }
  done.result = 1;
  return done;
}

/**
 * The triangles a UV batch draws, as rows: for each 3 indices of `indices` [0, indexCount), its corners' x, y and u, v
 * and the paint and entity of its first corner's record, in the 24-float FILL_ROW order of packMeshUvFill's rows (but
 * the depth, which the records do not carry: 0). E-453's parity: the indexed batch draws what the rows drew.
 * @returns {Float32Array} indexCount / 3 rows of 24 floats
 */
export function expandMeshUvVerts(verts, indices, indexCount) {
  const tris = (indexCount / 3) | 0;
  const rows = new Float32Array(tris * 24);
  const rowsU32 = new Uint32Array(rows.buffer);
  const vertsU32 = new Uint32Array(verts.buffer, verts.byteOffset, verts.length);
  const F = MESH_UV_VERT_FLOATS;
  for (let t = 0; t < tris; t++) {
    const r = t * 24;
    for (let c = 0; c < 3; c++) {
      const o = indices[t * 3 + c] * F;
      rows[r + c * 2] = verts[o];
      rows[r + c * 2 + 1] = verts[o + 1];
      rows[r + 18 + c * 2] = verts[o + 2];
      rows[r + 18 + c * 2 + 1] = verts[o + 3];
    }
    const o = indices[t * 3] * F;
    rows[r + 6] = verts[o + 4];
    rows[r + 7] = verts[o + 5];
    rows[r + 8] = verts[o + 6];
    rows[r + 9] = verts[o + 7];
    rowsU32[r + 10] = vertsU32[o + 8];
    rows[r + 12] = verts[o + 10];
    rows[r + 13] = verts[o + 12];
    rows[r + 14] = verts[o + 13];
    rows[r + 15] = verts[o + 14];
    rows[r + 16] = verts[o + 15];
    rows[r + 17] = verts[o + 11];
  }
  return rows;
}
