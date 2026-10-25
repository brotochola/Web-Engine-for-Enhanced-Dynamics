/**
 * One-sitting probe from the mesh API trace campaign.
 * The pose walk and the hoisted rewrite are in src/. The copy variant lost and is not.
 */
import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';
import {
  sampleMeshFillPose,
  MESH_UV_FILL_FLOATS,
} from '../../src/render/colliderFillBatch.js';
import { rewriteExplicitMeshCorners } from '../reference/meshCorners.mjs';
import { checksumFloats, timeIt } from './microbenchHelpers.mjs';

function poseCtx() {
  return {
    poseTable: null,
    _poseGen: null,
    _poseStamp: 0,
    _poseWidth: 0,
    _poseHeight: 0,
    _poseDirty: false,
    mesh: { visible: false },
  };
}

function fillRuns(instanceEntity, trisPer, entities) {
  let k = 0;
  for (let i = 0; i < entities; i++) {
    for (let t = 0; t < trisPer; t++) instanceEntity[k++] = i;
  }
  return k;
}

function poseViews(entities) {
  const views = {
    entityCount: entities,
    x: new Float32Array(entities),
    y: new Float32Array(entities),
    rotC: new Float32Array(entities),
    rotS: new Float32Array(entities),
  };
  for (let i = 0; i < entities; i++) {
    views.x[i] = i * 3;
    views.y[i] = i * 5;
    views.rotC[i] = 1;
    views.rotS[i] = i * 0.001;
  }
  return views;
}

function poseRunWalk(ctx, instanceEntity, count, views) {
  const n = count | 0;
  if (n <= 0 || !instanceEntity) return 0;
  const entityCount = views.entityCount | 0;
  const width = 256;
  const height = Math.max(1, ((entityCount + width - 1) / width) | 0);
  const need = width * height * 4;
  if (!ctx.poseTable || ctx.poseTable.length < need) ctx.poseTable = new Float32Array(need);
  if (!ctx._poseGen || ctx._poseGen.length < entityCount) ctx._poseGen = new Int32Array(entityCount);
  const table = ctx.poseTable;
  const gen = ctx._poseGen;
  const stamp = (ctx._poseStamp + 1) | 0 || 1;
  ctx._poseStamp = stamp;
  let k = 0;
  while (k < n) {
    const i = instanceEntity[k] | 0;
    let end = k + 1;
    while (end < n && (instanceEntity[end] | 0) === i) end++;
    k = end;
    if (i < 0 || i >= entityCount || gen[i] === stamp) continue;
    gen[i] = stamp;
    const pose = sampleMeshFillPose(i, views);
    const o = i * 4;
    table[o] = pose.x;
    table[o + 1] = pose.y;
    table[o + 2] = pose.c;
    table[o + 3] = pose.s;
  }
  ctx.mesh.visible = true;
  return n;
}

function probePose() {
  const entities = 160;
  const tris = 768;
  const n = entities * tris;
  const ids = new Uint32Array(n);
  fillRuns(ids, tris, entities);
  const views = poseViews(entities);
  const shipped = poseCtx();
  const variant = poseCtx();
  MeshUvFillBatch.prototype.uploadPoseTable.call(shipped, ids, n, views);
  poseRunWalk(variant, ids, n, views);
  const sumS = checksumFloats(shipped.poseTable, entities * 4);
  const sumV = checksumFloats(variant.poseTable, entities * 4);
  if (sumS !== sumV) throw new Error(`pose checksum ${sumS} !== ${sumV}`);
  const a = timeIt('pose shipped', (iters) => {
    for (let i = 0; i < iters; i++) {
      MeshUvFillBatch.prototype.uploadPoseTable.call(shipped, ids, n, views);
    }
  }, { iterations: 4 });
  const b = timeIt('pose run-walk', (iters) => {
    for (let i = 0; i < iters; i++) poseRunWalk(variant, ids, n, views);
  }, { iterations: 4 });
  return { sumS, a, b, instances: n };
}

function bootGrid(entities, sx, sy) {
  const vx = sx + 1;
  const vy = sy + 1;
  const vertN = vx * vy;
  const indexN = sx * sy * 6;
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(entities * vertN, entities * indexN, entities);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), entities * vertN, entities * indexN, entities);
  const pos = new Float32Array(vertN * 2);
  const uv = new Float32Array(vertN * 2);
  const idx = new Uint16Array(indexN);
  for (let j = 0; j < vy; j++) {
    for (let i = 0; i < vx; i++) {
      const p = j * vx + i;
      pos[p * 2] = i;
      pos[p * 2 + 1] = j;
      uv[p * 2] = i / sx;
      uv[p * 2 + 1] = j / sy;
    }
  }
  let w = 0;
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * vx + i;
      idx[w++] = a;
      idx[w++] = a + 1;
      idx[w++] = a + vx + 1;
      idx[w++] = a;
      idx[w++] = a + vx + 1;
      idx[w++] = a + vx;
    }
  }
  for (let e = 0; e < entities; e++) {
    pos[0] = e;
    if (!MeshGeometry.replace(e, pos, idx, uv)) throw new Error('grid replace failed');
    MeshGeometry.writeVertices(e, pos);
  }
  return { vertN, indexN, tris: (indexN / 3) | 0 };
}

function rewriteHoisted(out, count, entityOfInstance, views, stride, lastVertGen) {
  const n = count | 0;
  if (!out || n <= 0 || !entityOfInstance || !views.meshVertGen || !lastVertGen) return 0;
  const step = (stride | 0) > 0 ? (stride | 0) : 18;
  const gen = views.meshVertGen;
  const vx = views.meshVertexX;
  const vy = views.meshVertexY;
  const u = views.meshUvU;
  const v = views.meshUvV;
  const indices = views.meshIndices;
  const uvOn = step >= 24 && u && v;
  let k = 0;
  while (k < n) {
    const i = entityOfInstance[k] | 0;
    let end = k + 1;
    while (end < n && (entityOfInstance[end] | 0) === i) end++;
    const run = end - k;
    const dirty = i >= 0 && i < gen.length && (gen[i] >>> 0) !== (lastVertGen[i] >>> 0);
    const vOff = views.meshVertOffset ? (views.meshVertOffset[i] | 0) : -1;
    if (dirty && vOff >= 0) {
      const vN = views.meshVertCount[i] | 0;
      const iAt = views.meshIndexOffset ? (views.meshIndexOffset[i] | 0) : -1;
      const need = iAt >= 0 ? ((views.meshIndexCount[i] >>> 0) / 3) | 0 : (vN >= 3 ? vN - 2 : 0);
      if (need !== run) return -1;
      if (iAt >= 0) {
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
          if (uvOn) {
            out[base + 18] = u[ia];
            out[base + 19] = v[ia];
            out[base + 20] = u[ib];
            out[base + 21] = v[ib];
            out[base + 22] = u[ic];
            out[base + 23] = v[ic];
          }
        }
      } else {
        for (let t = 0; t < run; t++) {
          const ia = vOff;
          const ib = vOff + t + 1;
          const ic = vOff + t + 2;
          const base = (k + t) * step;
          out[base] = vx[ia];
          out[base + 1] = vy[ia];
          out[base + 2] = vx[ib];
          out[base + 3] = vy[ib];
          out[base + 4] = vx[ic];
          out[base + 5] = vy[ic];
          if (uvOn) {
            out[base + 18] = u[ia];
            out[base + 19] = v[ia];
            out[base + 20] = u[ib];
            out[base + 21] = v[ib];
            out[base + 22] = u[ic];
            out[base + 23] = v[ic];
          }
        }
      }
    }
    k = end;
  }
  return 1;
}

function probeRewrite() {
  const entities = 40;
  const sx = 24;
  const sy = 16;
  const built = bootGrid(entities, sx, sy);
  const tris = built.tris * entities;
  const views = {
    entityCount: entities,
    meshVertOffset: MeshGeometry.vertOffset,
    meshVertCount: MeshGeometry.vertCount,
    meshIndexOffset: MeshGeometry.indexOffset,
    meshIndexCount: MeshGeometry.indexCount,
    meshVertexX: MeshGeometry.vertexX,
    meshVertexY: MeshGeometry.vertexY,
    meshUvU: MeshGeometry.uvU,
    meshUvV: MeshGeometry.uvV,
    meshIndices: MeshGeometry.indices,
    meshVertGen: MeshGeometry.vertGen,
  };
  const ids = new Uint32Array(tris);
  fillRuns(ids, built.tris, entities);
  const outA = new Float32Array(tris * MESH_UV_FILL_FLOATS);
  const outB = new Float32Array(tris * MESH_UV_FILL_FLOATS);
  const last = new Uint32Array(entities);
  for (let i = 0; i < entities; i++) Atomics.store(MeshGeometry.vertGen, i, 1);
  const codeA = rewriteExplicitMeshCorners(outA, tris, ids, views, MESH_UV_FILL_FLOATS, last);
  last.fill(0);
  const codeB = rewriteHoisted(outB, tris, ids, views, MESH_UV_FILL_FLOATS, last);
  if (codeA !== 1 || codeB !== 1) throw new Error(`rewrite codes ${codeA} ${codeB}`);
  const sumA = checksumFloats(outA, tris * 6);
  const sumB = checksumFloats(outB, tris * 6);
  const sumUvA = checksumFloats(outA.subarray(18), 6);
  if (sumA !== sumB) throw new Error(`rewrite checksum ${sumA} !== ${sumB}`);
  for (let i = 0; i < outA.length; i++) {
    if (outA[i] !== outB[i]) throw new Error(`rewrite mismatch at ${i}`);
  }
  last.fill(0);
  const a = timeIt('rewrite shipped', (iters) => {
    for (let i = 0; i < iters; i++) {
      rewriteExplicitMeshCorners(outA, tris, ids, views, MESH_UV_FILL_FLOATS, last);
    }
  }, { iterations: 2 });
  const b = timeIt('rewrite hoisted', (iters) => {
    for (let i = 0; i < iters; i++) {
      rewriteHoisted(outB, tris, ids, views, MESH_UV_FILL_FLOATS, last);
    }
  }, { iterations: 2 });
  MeshGeometry.reset();
  return { sumA, sumUvA, a, b, tris };
}

function writeVerticesFast(entity, positions) {
  const i = entity | 0;
  const n = MeshGeometry.vertCount[i] | 0;
  const floats = n * 2;
  if ((positions.length | 0) !== floats) return false;
  for (let f = 0; f < floats; f++) {
    if (!Number.isFinite(positions[f])) return false;
  }
  const x = MeshGeometry.vertexX;
  const y = MeshGeometry.vertexY;
  const at = MeshGeometry.vertOffset[i] | 0;
  for (let v = 0; v < n; v++) {
    const p = v << 1;
    x[at + v] = positions[p];
    y[at + v] = positions[p + 1];
  }
  const g = MeshGeometry.vertGen;
  const ep = MeshGeometry.vertEpoch;
  const cur = Atomics.load(g, i);
  const next = (cur + 1) >>> 0;
  Atomics.store(g, i, next === 0 ? 1 : next);
  Atomics.add(ep, 0, 1);
  return true;
}

function probeCopy() {
  const entities = 80;
  const verts = 425;
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(entities * verts, 8, entities);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), entities * verts, 8, entities);
  const xy = new Float32Array(verts * 2);
  for (let i = 0; i < xy.length; i++) xy[i] = i * 0.01;
  for (let e = 0; e < entities; e++) {
    const fan = new Float32Array(verts * 2);
    fan.set(xy);
    fan[0] = e;
    if (!MeshGeometry.replace(e, fan, null, null)) throw new Error('copy setup failed');
  }
  const src = new Float32Array(xy);
  src[0] = 4;
  MeshGeometry.writeVertices(0, src);
  const at = MeshGeometry.vertOffset[0] | 0;
  if (MeshGeometry.vertexX[at] !== 4) throw new Error('shipped copy missed');
  writeVerticesFast(0, src);
  if (MeshGeometry.vertexX[at] !== 4) throw new Error('fast copy missed');
  const a = timeIt('writeVertices shipped', (iters) => {
    for (let i = 0; i < iters; i++) {
      src[1] = i & 7;
      MeshGeometry.writeVertices(i % entities, src);
    }
  }, { iterations: 40 });
  const b = timeIt('writeVertices no coerce', (iters) => {
    for (let i = 0; i < iters; i++) {
      src[1] = i & 7;
      writeVerticesFast(i % entities, src);
    }
  }, { iterations: 40 });
  MeshGeometry.reset();
  return { a, b, verts };
}

const pose = probePose();
const rewrite = probeRewrite();
const copy = probeCopy();
const pct = (variant, base) => ((variant.opsPerSec / base.opsPerSec - 1) * 100).toFixed(1);
console.log(JSON.stringify({
  pose: {
    instances: pose.instances,
    checksum: pose.sumS,
    shipped: pose.a.opsPerSec,
    variant: pose.b.opsPerSec,
    pct: pct(pose.b, pose.a),
  },
  rewrite: {
    tris: rewrite.tris,
    checksum: rewrite.sumA,
    shipped: rewrite.a.opsPerSec,
    variant: rewrite.b.opsPerSec,
    pct: pct(rewrite.b, rewrite.a),
  },
  copy: {
    verts: copy.verts,
    shipped: copy.a.opsPerSec,
    variant: copy.b.opsPerSec,
    pct: pct(copy.b, copy.a),
  },
}, null, 2));
