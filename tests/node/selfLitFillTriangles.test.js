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
  LightEmitter.radius = new Float32Array(N);
  LightEmitter.brightness = new Float32Array(N).fill(1);
  LightEmitter.elevation = new Float32Array(N);
  LightEmitter.color = new Uint32Array(N);
  LightEmitter.offsetX = new Float32Array(N);
  LightEmitter.offsetY = new Float32Array(N);
  // DX-SPOT: no cone (coneCos below every cosine).
  LightEmitter.coneCos = new Float32Array(N).fill(-2);
  LightEmitter.coneInvSpan = new Float32Array(N);
  LightEmitter.dirC = new Float32Array(N).fill(1);
  LightEmitter.dirS = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
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
  // A light raised 12 px up the screen is offsetY -12. The radii are whole, so I = (radius / 10)² is exact: the
  // goldens are the old API's with I = 40000 and 24964 and height 12 (checked on 91248f19).
  const light = (e, x, y, radius, color, offsetY) => {
    Transform.active[e] = 1;
    Transform.x[e] = x;
    Transform.y[e] = y;
    LightEmitter.radius[e] = radius;
    LightEmitter.color[e] = color;
    LightEmitter.offsetY[e] = offsetY;
  };
  light(0, 500, 500, 2000, 0xffcc88, 0);
  light(1, 900, 520, 1580, 0x88aaff, -12);
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

/** The batches Pixi grows (the point lights' and DX-SPOT's cone lights'), with plain arrays where the GPU objects were. */
function captureBatches(px) {
  px._ensureSelfLitBatch = function ensure(verts, idx, keepVerts, keepIdx, cone) {
    const key = cone ? '_selfLitConeBatch' : '_selfLitBatch';
    const old = this[key];
    if (old && verts <= old.vertCap && idx <= old.idxCap) return old;
    const vertCap = Math.ceil(Math.max(verts, old ? old.vertCap : 0, 64) * 1.25);
    const idxCap = Math.ceil(Math.max(idx, old ? old.idxCap : 0, 192) * 1.25);
    const data = new Float32Array(vertCap * FLOATS);
    const indices = new Uint32Array(idxCap);
    const coneData = cone ? new Float32Array(vertCap * 4) : null;
    if (old) {
      data.set(old.data.subarray(0, keepVerts * FLOATS));
      indices.set(old.indices.subarray(0, keepIdx));
      if (cone) coneData.set(old.coneData.subarray(0, keepVerts * 4));
    }
    const batch = {
      mesh: { visible: false, parent: null },
      geometry: { indexBuffer: { update() {} } },
      vbuf: { update: (bytes) => { batch.uploadedBytes = bytes; } },
      data,
      cbuf: cone ? { update() {} } : null,
      coneData,
      indices,
      uniforms: { uCanvasSize: new Float32Array(2) },
      vertCap,
      idxCap,
      idxUsed: keepIdx,
      gpuReady: false,
      uploadedBytes: 0,
    };
    this[key] = batch;
    return batch;
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
  assert.deepEqual(first, { triangles: 142, hash: 651987311 }, 'golden, first frame');

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
  assert.deepEqual(second, { triangles: 142, hash: 4154422693 }, 'golden, after the remesh');
  // E-135: each compound's shared vertices once per light (the soup wrote 352: three per fill triangle).
  assert.equal(px._selfLitBatch.uploadedBytes / (FLOATS * 4), 152, 'vertices written');
});

/** FNV over the drawn triangles of one light (its x in the vertex): their vertices' floats, by bits, in order. */
function lightTriangles(batch, lightX) {
  const n = batch.idxUsed;
  const bits = new Uint32Array(batch.data.buffer);
  let h = 2166136261;
  let triangles = 0;
  for (let t = 0; t + 3 <= n; t += 3) {
    if (batch.data[batch.indices[t] * FLOATS + 2] !== lightX) continue;
    triangles++;
    for (let k = 0; k < 3; k++) {
      const v = batch.indices[t + k];
      for (let f = 0; f < FLOATS; f++) h = Math.imul(h ^ bits[v * FLOATS + f], 16777619) >>> 0;
    }
  }
  return { triangles, hash: h >>> 0 };
}

test('DX-SPOT: a cone light\'s fills go to the cone batch with its cone, the same triangles; the point light\'s stay', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  scene();
  px._selfLitBuffers[0] = selfLitQueue();
  px._visPolyRT = {};
  px._selfLitBatchProgramOpts = {};
  px._selfLitMaxFillVerts = 256 * 20;
  px.canvasWidth = 800;
  px.canvasHeight = 600;
  px._groundInvScaleY = 2;
  captureBatches(px);
  px._buildSelfLitBatch(0);
  const allPoint = { a: lightTriangles(px._selfLitBatch, 500), b: lightTriangles(px._selfLitBatch, 900) };
  assert.equal(px._selfLitConeBatch, null, 'no cone light, no cone batch');

  // Light 1 (x 900) becomes a cone pointing along the entity's facing turned by its direction: 30 degrees.
  const dir = Math.PI / 6;
  LightEmitter.coneCos[1] = Math.fround(Math.cos(0.4));
  LightEmitter.coneInvSpan[1] = 5;
  LightEmitter.dirC[1] = Math.cos(dir);
  LightEmitter.dirS[1] = Math.sin(dir);
  px._buildSelfLitBatch(0);
  assert.deepEqual(lightTriangles(px._selfLitBatch, 500), allPoint.a, 'the point light\'s triangles as they were');
  assert.equal(lightTriangles(px._selfLitBatch, 900).triangles, 0, 'no cone light in the point batch');
  const cone = px._selfLitConeBatch;
  assert.deepEqual(lightTriangles(cone, 900), allPoint.b, 'the cone light\'s triangles, the same floats');
  assert.equal(lightTriangles(cone, 500).triangles, 0);
  // Every vertex it drew carries the cone: the direction on the floor (y times 1 / groundScaleY, unit), cos, 1/span.
  const wx = Math.cos(dir);
  const wy = Math.sin(dir) * 2;
  const len = Math.sqrt(wx * wx + wy * wy);
  const want = [wx / len, wy / len, Math.cos(0.4), 5].map(Math.fround);
  for (let k = 0; k < cone.idxUsed; k++) {
    const v = cone.indices[k];
    assert.deepEqual(Array.from(cone.coneData.subarray(v * 4, v * 4 + 4)), want);
  }

  // Back to a point light: the cone batch draws nothing and hides.
  LightEmitter.coneCos[1] = -2;
  px._buildSelfLitBatch(0);
  assert.equal(px._selfLitConeBatch.idxUsed, 0);
  assert.equal(px._selfLitConeBatch.mesh.visible, false);
  assert.deepEqual(lightTriangles(px._selfLitBatch, 900), allPoint.b);
});
