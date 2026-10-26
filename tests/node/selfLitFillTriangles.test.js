// The triangles Pixi's self-lit batch draws (_buildSelfLitBatch on a real Pixi worker), as a golden: two lights over
// compound occluders (a ring and a jittered grid of triangles, whose fixtures share vertices; a pair that shares
// none), a circle, a box and a polygon, then a remesh. The hash covers every triangle in draw order, each of its
// three vertices' 13 floats, so a change in how the vertices are laid out (E-135: shared vertices instead of a
// triangle soup) must draw the same triangles with the same attributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../../src/util/configDefaults.js';
import { gridCompound } from '../bench/compoundSolidMicrobench.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 16;
const V = MAX_POLYGON_VERTICES;
const FIXTURES = 512;
const NONE = 0xffff;
const FLOATS = 13;
const LIGHTS = [0, 1];
const OCCLUDERS = [2, 3, 4, 5, 6, 7];

function bindComponents() {
  Transform.active = new Uint8Array(N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  for (const [k, T] of Object.entries({
    active: Uint8Array, shapeType: Uint8Array, offsetX: Float32Array, offsetY: Float32Array, fixtureCount: Uint16Array,
    polyCentroidX: Float32Array, polyCentroidY: Float32Array, radius: Float32Array, width: Float32Array,
    height: Float32Array, polyCount: Uint8Array,
  })) Collider[k] = new T(N);
  Collider.polyVertexX = new Float32Array(N * V);
  Collider.polyVertexY = new Float32Array(N * V);
  LightOccluder.active = new Uint8Array(N).fill(1);
  LightOccluder.block = new Float32Array(N).fill(1);
  LightEmitter.lightIntensity = new Float32Array(N);
  LightEmitter.sqrtLightIntensity = new Float32Array(N);
  LightEmitter.lightColor = new Uint32Array(N);
  LightEmitter.height = new Float32Array(N);
  ColliderFixture.head = new Uint16Array(N).fill(NONE);
  ColliderFixture.next = new Uint16Array(FIXTURES).fill(NONE);
  ColliderFixture.active = new Uint8Array(FIXTURES);
  ColliderFixture.vertCount = new Uint8Array(FIXTURES);
  ColliderFixture.vertexX = new Float32Array(FIXTURES * V);
  ColliderFixture.vertexY = new Float32Array(FIXTURES * V);
  ColliderFixture.revision = new Uint32Array(1);
  ColliderFixture.maxCount = FIXTURES;
}

let nextFixture = 0;
/** One compound entity from polygons in local coordinates (arrays of [x, y]). */
function compound(e, x, y, polys) {
  Transform.active[e] = 1;
  Transform.x[e] = x;
  Transform.y[e] = y;
  Collider.active[e] = 1;
  Collider.shapeType[e] = ShapeType.Polygon;
  Collider.fixtureCount[e] = polys.length;
  Collider.polyCentroidX[e] = 3;
  Collider.polyCentroidY[e] = -2;
  let prev = NONE;
  for (const poly of polys) {
    const f = nextFixture++;
    ColliderFixture.active[f] = 1;
    ColliderFixture.vertCount[f] = poly.length;
    poly.forEach(([px, py], k) => {
      ColliderFixture.vertexX[f * V + k] = px;
      ColliderFixture.vertexY[f * V + k] = py;
    });
    if (prev === NONE) ColliderFixture.head[e] = f;
    else ColliderFixture.next[prev] = f;
    prev = f;
  }
}

/** A ring of n segments between radii r0 and r1, two triangles a segment (its fixtures share vertices). */
function ring(n, r0, r1) {
  const pt = (k, r) => {
    const a = ((k % n) / n) * Math.PI * 2;
    return [Math.fround(Math.cos(a) * r), Math.fround(Math.sin(a) * r)];
  };
  const polys = [];
  for (let k = 0; k < n; k++) {
    polys.push([pt(k, r0), pt(k, r1), pt(k + 1, r1)]);
    polys.push([pt(k, r0), pt(k + 1, r1), pt(k + 1, r0)]);
  }
  return polys;
}

function gridPolys(cols, rows, cell, seed) {
  const g = gridCompound(cols, rows, cell, seed);
  const polys = [];
  for (let t = 0; t < g.fixtures; t++) {
    const poly = [];
    for (let k = 0; k < g.vertCount[t]; k++) poly.push([g.vx[t * V + k] - 100, g.vy[t * V + k] - 200]);
    polys.push(poly);
  }
  return polys;
}

function scene() {
  bindComponents();
  nextFixture = 0;
  const light = (e, x, y, intensity, color, height) => {
    Transform.active[e] = 1;
    Transform.x[e] = x;
    Transform.y[e] = y;
    LightEmitter.lightIntensity[e] = intensity;
    LightEmitter.sqrtLightIntensity[e] = Math.sqrt(intensity);
    LightEmitter.lightColor[e] = color;
    LightEmitter.height[e] = height;
  };
  light(0, 500, 500, 40000, 0xffcc88, 0);
  light(1, 900, 520, 25000, 0x88aaff, 12);
  compound(2, 700, 500, ring(12, 30, 55));
  compound(3, 650, 700, gridPolys(4, 3, 20, 7));
  compound(7, 820, 420, [[[0, 0], [30, 0], [15, 25]], [[40, 5], [70, 5], [55, 30]]]);
  const plain = (e, x, y, shape) => {
    Transform.active[e] = 1;
    Transform.x[e] = x;
    Transform.y[e] = y;
    Collider.active[e] = 1;
    Collider.shapeType[e] = shape;
    Collider.offsetX[e] = 2;
    Collider.offsetY[e] = -1;
  };
  plain(4, 600, 420, ShapeType.Circle);
  Collider.radius[4] = 20;
  plain(5, 820, 600, ShapeType.Box);
  Collider.width[5] = 40;
  Collider.height[5] = 20;
  plain(6, 760, 380, ShapeType.Polygon);
  [[0, -20], [18, -6], [11, 16], [-11, 16], [-18, -6]].forEach(([px, py], k) => {
    Collider.polyVertexX[6 * V + k] = px;
    Collider.polyVertexY[6 * V + k] = py;
  });
  Collider.polyCount[6] = 5;
}

/** The self-lit queue pre-render writes: per light, one item per occluder with its display pose. */
function selfLitQueue() {
  const items = [];
  for (const l of LIGHTS) for (const e of OCCLUDERS) items.push([e, l, 0.3 + e * 0.17]);
  const sab = new ArrayBuffer(4 + items.length * 28);
  const buf = { header: new Int32Array(sab, 0, 1), i32: new Int32Array(sab), f32: new Float32Array(sab), u16: new Uint16Array(sab), u8: new Uint8Array(sab) };
  items.forEach(([e, l, rot], n) => {
    const b = 4 + n * 28;
    buf.i32[b >> 2] = e;
    buf.i32[(b >> 2) + 1] = l;
    buf.f32[(b >> 2) + 2] = Transform.x[e];
    buf.f32[(b >> 2) + 3] = Transform.y[e];
    buf.f32[(b >> 2) + 4] = Math.cos(rot);
    buf.f32[(b >> 2) + 5] = Math.sin(rot);
    buf.u8[b + 26] = 0;
  });
  buf.header[0] = items.length;
  return buf;
}

/** The batch Pixi grows, with plain arrays where the GPU objects were. */
function captureBatches(px) {
  px._ensureSelfLitBatch = function ensure(verts, idx, keepVerts, keepIdx) {
    const old = this._selfLitBatch;
    if (old && verts <= old.vertCap && idx <= old.idxCap) return old;
    const vertCap = Math.ceil(Math.max(verts, old ? old.vertCap : 0, 64) * 1.25);
    const idxCap = Math.ceil(Math.max(idx, old ? old.idxCap : 0, 192) * 1.25);
    const data = new Float32Array(vertCap * FLOATS);
    const indices = new Uint32Array(idxCap);
    if (old) {
      data.set(old.data.subarray(0, keepVerts * FLOATS));
      indices.set(old.indices.subarray(0, keepIdx));
    }
    this._selfLitBatch = {
      mesh: { visible: false, parent: null },
      geometry: { indexBuffer: { update() {} } },
      vbuf: { update: (bytes) => { this._selfLitBatch.uploadedBytes = bytes; } },
      data,
      indices,
      uniforms: { uCanvasSize: new Float32Array(2) },
      vertCap,
      idxCap,
      idxUsed: keepIdx,
      gpuReady: false,
      uploadedBytes: 0,
    };
    return this._selfLitBatch;
  };
  px._stampLightCamera = () => {};
  px._visPolyContainer = { addChild(m) { m.parent = this; } };
}

/** FNV over every drawn triangle in order: its three vertices' floats, by bits. */
function drawnTriangles(batch) {
  const n = batch.idxUsed;
  const bits = new Uint32Array(batch.data.buffer);
  let h = 2166136261;
  for (let t = 0; t + 3 <= n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = batch.indices[t + k];
      for (let f = 0; f < FLOATS; f++) h = Math.imul(h ^ bits[v * FLOATS + f], 16777619) >>> 0;
    }
  }
  return { triangles: n / 3, hash: h >>> 0 };
}

test('the self-lit batch draws the same triangles with the same attributes (golden)', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  scene();
  px._selfLitBuffers[0] = selfLitQueue();
  px._visPolyRT = {};
  px._selfLitBatchProgramOpts = {};
  px._selfLitMaxFillVerts = 256 * 20;
  px.canvasWidth = 800;
  px.canvasHeight = 600;
  captureBatches(px);

  assert.equal(px._buildSelfLitBatch(0), false, 'no sprite masks');
  const first = drawnTriangles(px._selfLitBatch);
  assert.deepEqual(first, { triangles: 142, hash: 1696863362 }, 'golden, first frame');

  // A remesh: the fixture revision moves and the ring's outer radius changes.
  let f = ColliderFixture.head[2];
  while (f !== NONE) {
    for (let k = 0; k < ColliderFixture.vertCount[f]; k++) {
      ColliderFixture.vertexX[f * V + k] *= 1.25;
      ColliderFixture.vertexY[f * V + k] *= 1.25;
    }
    f = ColliderFixture.next[f];
  }
  ColliderFixture.revision[0]++;
  px._buildSelfLitBatch(0);
  const second = drawnTriangles(px._selfLitBatch);
  assert.deepEqual(second, { triangles: 142, hash: 1672745060 }, 'golden, after the remesh');
  // E-135: each compound's shared vertices once per light (the soup wrote 352: three per fill triangle).
  assert.equal(px._selfLitBatch.uploadedBytes / (FLOATS * 4), 152, 'vertices written');
});
