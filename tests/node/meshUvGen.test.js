// E-118. setVertices writes positions only, so Pixi's rewrite stores the UV batch's UV corners only for meshes
// whose UV generation moved (setMesh, setPlane and setRope bump it; setVertices does not). Frame after frame
// of random MeshRenderer calls (setVertices on grids, fans and stars, setRope, setMesh with new UVs or new
// indices, setPlane, new topologies, clearMesh), Pixi's sequence runs twice on the same meshes: without the UV
// generations (every rewritten UV row stores its UVs, as before E-118) and with them. Both batches must hold
// the same words on both sides after every frame, and the words a full repack of that frame writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import {
  COLLIDER_FILL_FLOATS,
  MESH_UV_FILL_FLOATS,
  packColliderFill,
  packMeshUvFill,
  resetColliderFillMeshLayerWarn,
  rewriteExplicitMeshCorners,
} from '../../src/render/colliderFillBatch.js';

const E = 40;
const MAX_VERTS = 8192;
const MAX_INDICES = 24576;
const CAP = 6000;
const FRAMES = 300;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

/** Pixi's collider-fill views (_ensureColliderFillViews) over MeshGeometry, poses and paint fixed. */
function makeViews() {
  const n = E;
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n).fill(1),
    meshVisible: new Uint8Array(n).fill(1),
    meshLayerMask: new Uint16Array(n).fill(1),
    meshTint: new Uint32Array(n).fill(0x80c0e0),
    meshAlpha: new Float32Array(n).fill(1),
    meshVisualOutset: new Float32Array(n),
    meshBits: 1,
    fixtureCount: new Uint16Array(n),
    primaryShapeType: new Uint8Array(n),
    primaryWidth: new Float32Array(n),
    primaryHeight: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
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
    meshGeomRevision: MeshGeometry.revision,
    meshVertGen: MeshGeometry.vertGen,
    meshVertEpoch: MeshGeometry.vertEpoch,
    meshUvGen: MeshGeometry.uvGen,
    instanceEntity: null,
    outU32: null,
    layerHasVertexUv: 0,
  };
  for (let i = 0; i < n; i++) {
    views.x[i] = 100 + (i % 8) * 80;
    views.y[i] = 100 + ((i / 8) | 0) * 80;
    views.rotC[i] = Math.cos(i * 0.4);
    views.rotS[i] = Math.sin(i * 0.4);
  }
  return views;
}

/** One side's batches and generations, as a MESH layer's skip state holds them. */
function makeSide(uvGen) {
  return {
    uvGen,
    fill: new Float32Array(CAP * COLLIDER_FILL_FLOATS),
    uv: new Float32Array(CAP * MESH_UV_FILL_FLOATS),
    fillEntity: new Uint32Array(CAP),
    uvEntity: new Uint32Array(CAP),
    fillCount: 0,
    uvCount: 0,
    lastRevision: -1,
    lastVertGen: new Uint32Array(E),
    lastUvGen: new Uint32Array(E),
    frameVertGen: new Uint32Array(E),
    frameUvGen: new Uint32Array(E),
    full: 0,
    rewrites: 0,
  };
}

function fullPack(side, views) {
  views.instanceEntity = side.fillEntity;
  views.outU32 = new Uint32Array(side.fill.buffer);
  side.fillCount = packColliderFill(side.fill, CAP, 0, views);
  views.instanceEntity = side.uvEntity;
  views.outU32 = new Uint32Array(side.uv.buffer);
  side.uvCount = packMeshUvFill(side.uv, CAP, 0, views);
  side.full++;
}

/**
 * Pixi's MESH layer frame (pixiWorker updateCustomLayers): capture the generations before any read, repack
 * on a topology change or a mismatch, else rewrite both batches, then record the capture as drawn.
 */
function pixiFrame(side, views) {
  side.frameVertGen.set(MeshGeometry.vertGen);
  side.frameUvGen.set(MeshGeometry.uvGen);
  const rev = MeshGeometry.revision[0] | 0;
  let full = rev !== side.lastRevision;
  if (!full) {
    const fill = rewriteExplicitMeshCorners(side.fill, side.fillCount, side.fillEntity, views, COLLIDER_FILL_FLOATS, side.lastVertGen, side.frameVertGen);
    const uv = side.uvCount <= 0
      ? 1
      : side.uvGen
        ? rewriteExplicitMeshCorners(side.uv, side.uvCount, side.uvEntity, views, MESH_UV_FILL_FLOATS, side.lastVertGen, side.frameVertGen, side.lastUvGen, side.frameUvGen)
        : rewriteExplicitMeshCorners(side.uv, side.uvCount, side.uvEntity, views, MESH_UV_FILL_FLOATS, side.lastVertGen, side.frameVertGen);
    if (fill < 0 || uv < 0) full = true;
    else side.rewrites++;
  }
  if (full) fullPack(side, views);
  side.lastVertGen.set(side.frameVertGen);
  side.lastUvGen.set(side.frameUvGen);
  side.lastRevision = rev;
}

function words(a, floats) {
  return new Uint32Array(a.buffer, a.byteOffset, floats);
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let q = 0; q < n; q++) if (a[q] !== b[q]) return q;
  return -1;
}

/** The meshes, by kind (what each entity holds, and how the frames edit it), and their current shapes. */
function spawn(r, api) {
  const shapes = [];
  for (let i = 0; i < E; i++) {
    const p = r();
    const kind = p < 0.3 ? 'grid' : p < 0.5 ? 'rope' : p < 0.65 ? 'uvMesh' : p < 0.8 ? 'fan' : p < 0.9 ? 'star' : 'none';
    const shape = { kind, segs: SEGS[0], points: 6, verts: 6, uv: null };
    shapes.push(shape);
    remesh(r, api[i], shape, true);
  }
  return shapes;
}

const SEGS = [[2, 2], [3, 2], [4, 3]];

function gridPositions(r, sx, sy, out) {
  const vx = sx + 1;
  const vy = sy + 1;
  for (let j = 0; j < vy; j++) {
    for (let i = 0; i < vx; i++) {
      const p = j * vx + i;
      out[p * 2] = -20 + (40 * i) / sx + (r() - 0.5) * 3;
      out[p * 2 + 1] = -15 + (30 * j) / sy + (r() - 0.5) * 3;
    }
  }
  return out;
}

function ropePoints(r, n) {
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pts[i * 2] = (i - (n - 1) * 0.5) * 9;
    pts[i * 2 + 1] = (r() - 0.5) * 14;
  }
  return pts;
}

function uvQuad(r) {
  const xy = new Float32Array([-16, -12, 16, -12, 16, 12, -16, 12]);
  const uv = new Float32Array(8);
  for (let q = 0; q < 8; q++) uv[q] = r();
  return { xy, uv };
}

function fanPositions(r, n) {
  const xy = new Float32Array(n * 2);
  const rad = 10 + r() * 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xy[i * 2] = Math.cos(a) * rad;
    xy[i * 2 + 1] = Math.sin(a) * rad;
  }
  return xy;
}

function starPoints(r) {
  const xy = new Float32Array(20);
  const outer = 18 + r() * 6;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = (i & 1) === 0 ? outer : outer * 0.4;
    xy[i * 2] = Math.cos(a) * rad;
    xy[i * 2 + 1] = Math.sin(a) * rad;
  }
  return xy;
}

const QUAD_IDX = [new Uint16Array([0, 1, 2, 0, 2, 3]), new Uint16Array([1, 2, 3, 1, 3, 0])];

/** A new mesh for `shape` (a new topology unless the counts happen to match the old one). */
function remesh(r, mr, shape, fresh) {
  if (shape.kind === 'grid') {
    shape.segs = SEGS[fresh ? 0 : Math.floor(r() * SEGS.length)];
    mr.setPlane(40, 30, shape.segs[0], shape.segs[1]);
  } else if (shape.kind === 'rope') {
    shape.points = fresh ? 6 : 4 + Math.floor(r() * 4);
    mr.setRope(ropePoints(r, shape.points), 4 + r() * 3);
  } else if (shape.kind === 'uvMesh') {
    const q = uvQuad(r);
    shape.uv = q.uv;
    mr.setMesh(q.xy, QUAD_IDX[0], q.uv);
  } else if (shape.kind === 'fan') {
    shape.verts = fresh ? 6 : 5 + Math.floor(r() * 3);
    mr.setMesh(fanPositions(r, shape.verts));
  } else if (shape.kind === 'star') {
    mr.setPolygon(starPoints(r));
  }
}

/** One logic tick: in-place edits mostly; now and then one mesh gets a new topology or is cleared. */
function logicTick(r, api, shapes, stats) {
  const p = r();
  const changed = p < 0.1 ? Math.floor(r() * E) : -1;
  if (changed >= 0) {
    if (p < 0.03) api[changed].clearMesh();
    else remesh(r, api[changed], shapes[changed], false);
  }
  for (let i = 0; i < E; i++) {
    const mr = api[i];
    const shape = shapes[i];
    const kind = shape.kind;
    if (i === changed || kind === 'none' || r() < 0.3) continue;
    if (MeshGeometry.vertOffset[i] < 0) {
      // Cleared a frame or more ago: back with a new mesh.
      if (r() < 0.3) remesh(r, mr, shape, true);
      continue;
    }
    if (kind === 'grid') {
      const [sx, sy] = shape.segs;
      if (r() < 0.8) {
        mr.setVertices(gridPositions(r, sx, sy, new Float32Array((sx + 1) * (sy + 1) * 2)));
        stats.positionsOnly++;
      } else {
        // The same plane again: an in-place write of its UVs (the same values) and new positions.
        mr.setPlane(40 + r() * 4, 30, sx, sy);
        stats.uvWrites++;
      }
    } else if (kind === 'rope') {
      mr.setRope(ropePoints(r, shape.points), 4 + r() * 3);
      stats.uvWrites++;
    } else if (kind === 'uvMesh') {
      const q = uvQuad(r);
      const which = r();
      if (which < 0.4) {
        mr.setVertices(q.xy.map((v) => v + (r() - 0.5) * 4));
        stats.positionsOnly++;
      } else if (which < 0.75) {
        // New UVs.
        shape.uv = q.uv;
        mr.setMesh(q.xy, QUAD_IDX[0], q.uv);
        stats.uvWrites++;
      } else {
        // The same UVs through other indices: each corner picks another vertex's UV.
        mr.setMesh(q.xy, QUAD_IDX[1], shape.uv);
        stats.uvWrites++;
      }
    } else if (kind === 'fan') {
      mr.setVertices(fanPositions(r, shape.verts));
    } else if (kind === 'star') {
      mr.setVertices(starPoints(r));
    }
  }
}

test('the UV batch holds the same words with and without the UV generations, and what a full repack writes', (t) => {
  const r = rng(0xe118);
  const geomBytes = MeshGeometry.getBufferSize(MAX_VERTS, MAX_INDICES, E);
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  resetColliderFillMeshLayerWarn();
  MeshGeometry.initializeArrays(new SharedArrayBuffer(geomBytes), MAX_VERTS, MAX_INDICES, E);
  const api = [];
  for (let i = 0; i < E; i++) api.push(new MeshRenderer(i));
  const stats = { positionsOnly: 0, uvWrites: 0, skippedRuns: 0, uvRows: 0 };
  quiet(() => {
    const shapes = spawn(r, api);
    const views = makeViews();
    const before = makeSide(false);
    const after = makeSide(true);
    const truth = makeSide(false);
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) logicTick(r, api, shapes, stats);
      // On a frame that rewrites, the UV-batch meshes that moved their positions and not their UVs: the skip's work.
      for (let i = 0; i < E && (MeshGeometry.revision[0] | 0) === after.lastRevision; i++) {
        if (!MeshGeometry.hasUv[i] || MeshGeometry.vertOffset[i] < 0) continue;
        if (MeshGeometry.vertGen[i] !== after.lastVertGen[i] && MeshGeometry.uvGen[i] === after.lastUvGen[i]) stats.skippedRuns++;
      }
      pixiFrame(before, views);
      pixiFrame(after, views);
      fullPack(truth, views);
      assert.equal(after.fillCount, before.fillCount, `frame ${f}: fill rows`);
      assert.equal(after.uvCount, before.uvCount, `frame ${f}: UV rows`);
      assert.equal(truth.uvCount, before.uvCount, `frame ${f}: UV rows against a full repack`);
      stats.uvRows += before.uvCount;
      const fillFloats = before.fillCount * COLLIDER_FILL_FLOATS;
      const uvFloats = before.uvCount * MESH_UV_FILL_FLOATS;
      for (const [name, a, b] of [
        ['fill, with against without', words(after.fill, fillFloats), words(before.fill, fillFloats)],
        ['UV, with against without', words(after.uv, uvFloats), words(before.uv, uvFloats)],
        ['fill, without against a full repack', words(before.fill, fillFloats), words(truth.fill, fillFloats)],
        ['UV, without against a full repack', words(before.uv, uvFloats), words(truth.uv, uvFloats)],
      ]) {
        const at = firstDiff(a, b);
        assert.equal(at, -1, `frame ${f}, ${name}: word ${at} (row ${Math.floor(at / (name.startsWith('fill') ? COLLIDER_FILL_FLOATS : MESH_UV_FILL_FLOATS))})`);
      }
    }
    // The frames reached what the test is about: rewrites (not only repacks), skipped UV corners, UV writes.
    assert.ok(after.rewrites > FRAMES / 2, `${after.rewrites} frames rewritten, ${after.full} repacked`);
    assert.ok(after.full > 5, `${after.full} repacks`);
    t.diagnostic(`${after.rewrites} frames rewritten, ${after.full} repacked; ${JSON.stringify(stats)}`);
  });
  assert.ok(stats.skippedRuns > 200, `${stats.skippedRuns} UV-batch meshes moved only their positions on a rewrite frame`);
  assert.ok(stats.uvWrites > 200, `${stats.uvWrites} in-place UV writes`);
  assert.ok(stats.uvRows > 1000, `${stats.uvRows} UV rows compared`);
});

test('setVertices leaves the UV generation; the in-place UV writes bump it; a new topology does not need to', () => {
  MeshGeometry.reset();
  MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(256, 768, 4)), 256, 768, 4);
  const mr = new MeshRenderer(0);
  const uv0 = MeshGeometry.uvGen[0];
  mr.setPlane(10, 10, 2, 2);
  const afterPlane = MeshGeometry.uvGen[0];
  assert.equal(afterPlane, uv0, 'a new plane is a new topology: the revision tells Pixi');
  const vg = MeshGeometry.vertGen[0];
  mr.setVertices(new Float32Array(18).fill(1));
  assert.equal(MeshGeometry.uvGen[0], afterPlane, 'positions only');
  assert.notEqual(MeshGeometry.vertGen[0], vg);
  mr.setPlane(12, 10, 2, 2);
  assert.notEqual(MeshGeometry.uvGen[0], afterPlane, 'the same plane again writes its UVs in place');
  const ropeAt = MeshGeometry.uvGen[1];
  const rope = new MeshRenderer(1);
  rope.setRope([0, 0, 10, 0, 20, 5], 3);
  rope.setRope([0, 0, 10, 2, 20, 5], 3);
  assert.notEqual(MeshGeometry.uvGen[1], ropeAt, 'setRope in place');
  const fan = new MeshRenderer(2);
  fan.setMesh([0, 0, 10, 0, 10, 10, 0, 10]);
  const fanGen = MeshGeometry.uvGen[2];
  fan.setMesh([0, 0, 11, 0, 10, 10, 0, 10]);
  assert.equal(MeshGeometry.uvGen[2], fanGen, 'a mesh without UVs never bumps it');
});
