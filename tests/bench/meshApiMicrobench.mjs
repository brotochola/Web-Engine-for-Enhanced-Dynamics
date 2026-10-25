/**
 * Kernel baselines for the free-mesh API. Each case calls the shipped function.
 * Checksums run before timeIt. A sample under 3 ms grows the iteration count.
 *
 * These numbers are a baseline, not a keep.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { triangulateSimplePolygon } from '../../src/render/meshTriangulate.js';
import {
  packColliderFill,
  packColliderFillPoseOnly,
  packMeshUvFill,
  COLLIDER_FILL_FLOATS,
  MESH_UV_FILL_FLOATS,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';
import { rewriteExplicitMeshCorners } from '../reference/meshCorners.mjs';
import { checksumFloats, isCli, timeIt, writeReport } from './microbenchHelpers.mjs';

const SEED_XY = 0x41e5;

function boot(verts, indices, entities) {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  resetColliderFillMeshLayerWarn();
  const bytes = MeshGeometry.getBufferSize(verts, indices, entities);
  const buf = new SharedArrayBuffer(bytes);
  MeshGeometry.initializeArrays(buf, verts, indices, entities);
}

function fan(n, radius) {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xy[i * 2] = Math.cos(a) * radius;
    xy[i * 2 + 1] = Math.sin(a) * radius;
  }
  return xy;
}

function star() {
  const xy = new Float32Array(20);
  let o = 0;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = (i & 1) === 0 ? 52 : 22;
    xy[o++] = Math.cos(a) * r;
    xy[o++] = Math.sin(a) * r;
  }
  return xy;
}

function convex(n, radius) {
  return fan(n, radius);
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: checksum ${actual} !== ${expected}`);
  }
}

function packViews(n) {
  return {
    entityCount: n,
    meshActive: new Uint8Array(n).fill(1),
    meshVisible: new Uint8Array(n).fill(1),
    meshLayerMask: new Uint16Array(n).fill(1),
    meshTint: new Uint32Array(n).fill(0xffffff),
    meshAlpha: new Float32Array(n).fill(1),
    meshBits: 1,
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n).fill(1),
    rotS: new Float32Array(n),
    meshVertOffset: MeshGeometry.vertOffset,
    meshVertCount: MeshGeometry.vertCount,
    meshIndexOffset: MeshGeometry.indexOffset,
    meshIndexCount: MeshGeometry.indexCount,
    meshHasUv: MeshGeometry.hasUv,
    meshVertexX: MeshGeometry.vertexX,
    meshVertexY: MeshGeometry.vertexY,
    meshUvU: MeshGeometry.uvU,
    meshUvV: MeshGeometry.uvV,
    meshIndices: MeshGeometry.indices,
    meshVertGen: MeshGeometry.vertGen,
  };
}

function row(label, timed, checksum, extra = {}) {
  return {
    label,
    checksum,
    ms: timed.ms,
    iterations: timed.iterations,
    opsPerSec: timed.opsPerSec,
    ...extra,
  };
}

function sameSizeReplace() {
  const n = 64;
  const verts = 16;
  boot(n * verts, 8, n);
  const xy = fan(verts, 20);
  const api = [];
  for (let i = 0; i < n; i++) {
    const mr = new MeshRenderer(i);
    api.push(mr);
    mr.setMesh(xy);
    if ((MeshGeometry.vertOffset[i] | 0) < 0) throw new Error('same-size setup replace failed');
  }
  const rev = MeshGeometry.revision[0] >>> 0;
  xy[0] = 3;
  api[0].setMesh(xy);
  assertEq('same-size revision', MeshGeometry.revision[0] >>> 0, rev);
  assertEq('same-size x0', MeshGeometry.vertexX[MeshGeometry.vertOffset[0]] === 3 ? 1 : 0, 1);
  const sum = checksumFloats(MeshGeometry.vertexX, n * verts);
  const timed = timeIt('replace same-size', (iters) => {
    for (let k = 0; k < iters; k++) {
      xy[0] = k & 1;
      api[k % n].setMesh(xy);
    }
  }, { iterations: 400 });
  MeshGeometry.reset();
  return row('replace same-size', timed, sum, { entities: n, verts });
}

function allocChurn() {
  boot(64, 8, 1);
  const xy = fan(8, 12);
  const mr = new MeshRenderer(0);
  mr.setMesh(xy);
  if ((MeshGeometry.vertCount[0] | 0) !== 8) throw new Error('alloc setup failed');
  mr.clearMesh();
  mr.setMesh(xy);
  assertEq('alloc vertCount', MeshGeometry.vertCount[0] | 0, 8);
  const sum = checksumFloats(MeshGeometry.vertexX, 8);
  const timed = timeIt('clearMesh + setMesh', (iters) => {
    for (let k = 0; k < iters; k++) {
      mr.clearMesh();
      mr.setMesh(xy);
    }
  }, { iterations: 200 });
  MeshGeometry.reset();
  return row('clearMesh + setMesh', timed, sum, { verts: 8 });
}

function writeVerts() {
  const n = 128;
  const verts = 16;
  boot(n * verts, 8, n);
  const buffers = [];
  for (let i = 0; i < n; i++) {
    const xy = fan(verts, 10 + (i % 5));
    buffers.push(xy);
    if (!MeshGeometry.replace(i, xy, null, null)) throw new Error('writeVertices setup failed');
  }
  buffers[0][0] = 7;
  if (!MeshGeometry.writeVertices(0, buffers[0])) throw new Error('writeVertices checksum failed');
  const rev = MeshGeometry.revision[0] >>> 0;
  MeshGeometry.writeVertices(1, buffers[1]);
  assertEq('writeVertices revision', MeshGeometry.revision[0] >>> 0, rev);
  const sum = checksumFloats(MeshGeometry.vertexX, n * verts);
  const timed = timeIt('writeVertices', (iters) => {
    for (let k = 0; k < iters; k++) {
      const i = k % n;
      buffers[i][1] = k & 3;
      MeshGeometry.writeVertices(i, buffers[i]);
    }
  }, { iterations: 400 });
  MeshGeometry.reset();
  return row('writeVertices', timed, sum, { entities: n, verts });
}

function plane() {
  boot(512, 4096, 1);
  const mr = new MeshRenderer(0);
  mr.setPlane(200, 80, 20, 10);
  assertEq('plane verts', MeshGeometry.vertCount[0] | 0, 21 * 11);
  assertEq('plane indices', MeshGeometry.indexCount[0] >>> 0, 20 * 10 * 6);
  const sum = checksumFloats(MeshGeometry.vertexX, 21 * 11);
  const timed = timeIt('setPlane 20x10', (iters) => {
    for (let k = 0; k < iters; k++) mr.setPlane(200, 80, 20, 10);
  }, { iterations: 40 });
  MeshGeometry.reset();
  return row('setPlane 20x10', timed, sum, { verts: 231 });
}

function rope() {
  boot(256, 1024, 1);
  const n = 32;
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pts[i * 2] = i * 4;
    pts[i * 2 + 1] = Math.sin(i) * 6;
  }
  const mr = new MeshRenderer(0);
  mr.setRope(pts, 5);
  assertEq('rope verts', MeshGeometry.vertCount[0] | 0, n * 2);
  const sum = checksumFloats(MeshGeometry.vertexX, n * 2);
  const timed = timeIt('setRope 32', (iters) => {
    for (let k = 0; k < iters; k++) {
      pts[1] = (k & 3) * 0.25;
      mr.setRope(pts, 5);
    }
  }, { iterations: 80 });
  MeshGeometry.reset();
  return row('setRope 32', timed, sum, { points: n });
}

function triangulateCase(label, xy, count, expectIndices) {
  const out = new Uint32Array((count - 2) * 3);
  const got = triangulateSimplePolygon(xy, count, out);
  assertEq(label, got, expectIndices);
  const timed = timeIt(label, (iters) => {
    for (let k = 0; k < iters; k++) triangulateSimplePolygon(xy, count, out);
  }, { iterations: 200 });
  return row(label, timed, got, { verts: count, indices: got });
}

function explicitPack() {
  const fans = 256;
  const uvs = 128;
  const n = fans + uvs;
  const fanVerts = 8;
  boot(fans * fanVerts + uvs * 4, uvs * 6 + 16, n);
  const xy = fan(fanVerts, 16);
  for (let i = 0; i < fans; i++) {
    if (!MeshGeometry.replace(i, xy, null, null)) throw new Error('fan pack setup failed');
  }
  const qxy = new Float32Array([-8, -6, 8, -6, 8, 6, -8, 6]);
  const qidx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const quv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  for (let i = 0; i < uvs; i++) {
    if (!MeshGeometry.replace(fans + i, qxy, qidx, quv)) throw new Error('uv pack setup failed');
  }
  const views = packViews(n);
  for (let i = 0; i < n; i++) {
    views.x[i] = (i % 32) * 20;
    views.y[i] = ((i / 32) | 0) * 20;
  }
  const fanTris = fans * (fanVerts - 2);
  const uvTris = uvs * 2;
  const fillOut = new Float32Array((fanTris + 8) * COLLIDER_FILL_FLOATS);
  const uvOut = new Float32Array((uvTris + 8) * MESH_UV_FILL_FLOATS);
  views.instanceEntity = new Uint32Array(fanTris + 8);
  const packed = packColliderFill(fillOut, fanTris + 8, 0, views);
  assertEq('explicit pack count', packed, fanTris);
  const uvPacked = packMeshUvFill(uvOut, uvTris + 8, 0, views);
  assertEq('uv pack count', uvPacked, uvTris);
  const uvEntity = views.instanceEntity;
  views.instanceEntity = new Uint32Array(fanTris + 8);
  const packedAgain = packColliderFill(fillOut, fanTris + 8, 0, views);
  assertEq('explicit pack recount', packedAgain, fanTris);
  const fillEntity = views.instanceEntity;

  const moved = fan(fanVerts, 16);
  moved[0] = 42;
  if (!MeshGeometry.writeVertices(0, moved)) throw new Error('writeVertices before rewrite failed');
  const last = new Uint32Array(n);
  const code = rewriteExplicitMeshCorners(
    fillOut, packed, fillEntity, views, COLLIDER_FILL_FLOATS, last,
  );
  assertEq('rewrite code', code, 1);
  assertEq('rewrite corner', fillOut[0] === 42 ? 1 : 0, 1);
  const cornerSum = checksumFloats(fillOut, packed * COLLIDER_FILL_FLOATS);

  const fillTimed = timeIt('packColliderFill explicit', (iters) => {
    for (let k = 0; k < iters; k++) packColliderFill(fillOut, fanTris + 8, 0, views);
  }, { iterations: 20 });

  const gen = MeshGeometry.vertGen;
  for (let i = 0; i < fans; i++) Atomics.store(gen, i, 1);
  last.fill(0);
  const rewriteTimed = timeIt('rewriteExplicitMeshCorners', (iters) => {
    for (let k = 0; k < iters; k++) {
      rewriteExplicitMeshCorners(fillOut, packed, fillEntity, views, COLLIDER_FILL_FLOATS, last);
    }
  }, { iterations: 20 });

  views.instanceEntity = uvEntity;
  const uvSum = checksumFloats(uvOut, uvPacked * MESH_UV_FILL_FLOATS);
  const uvTimed = timeIt('packMeshUvFill', (iters) => {
    for (let k = 0; k < iters; k++) packMeshUvFill(uvOut, uvTris + 8, 0, views);
  }, { iterations: 20 });

  views.x[0] = 100;
  views.instanceEntity = fillEntity;
  packColliderFillPoseOnly(fillOut, fanTris + 8, packed, fillEntity, views, COLLIDER_FILL_FLOATS);
  assertEq('pose-only x', fillOut[6] === 100 ? 1 : 0, 1);
  const poseTimed = timeIt('packColliderFillPoseOnly', (iters) => {
    for (let k = 0; k < iters; k++) {
      views.x[0] = k & 255;
      packColliderFillPoseOnly(fillOut, fanTris + 8, packed, fillEntity, views, COLLIDER_FILL_FLOATS);
    }
  }, { iterations: 40 });

  MeshGeometry.reset();
  return [
    row('packColliderFill explicit', fillTimed, cornerSum, { triangles: fanTris }),
    row('rewriteExplicitMeshCorners', rewriteTimed, cornerSum, { triangles: fanTris }),
    row('packMeshUvFill', uvTimed, uvSum, { triangles: uvTris }),
    row('packColliderFillPoseOnly', poseTimed, 100, { triangles: fanTris }),
  ];
}

function main() {
  const cases = [];
  cases.push(sameSizeReplace());
  cases.push(allocChurn());
  cases.push(writeVerts());
  cases.push(plane());
  cases.push(rope());
  cases.push(triangulateCase('triangulate star', star(), 10, 24));
  cases.push(triangulateCase(
    'triangulate arrow',
    new Float32Array([0, -80, 70, -20, 28, -20, 28, 70, -28, 70, -28, -20, -70, -20]),
    7,
    15,
  ));
  cases.push(triangulateCase(
    'triangulate L',
    new Float32Array([0, 0, 3, 0, 3, 1, 1, 1, 1, 2, 0, 2]),
    6,
    12,
  ));
  cases.push(triangulateCase('triangulate convex 128', convex(128, 40), 128, (128 - 2) * 3));
  cases.push(...explicitPack());

  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../results/mesh-api-trace/kernel.json');
  writeReport(out, {
    seed: SEED_XY,
    cases,
  });
}

if (isCli(import.meta.url)) main();
