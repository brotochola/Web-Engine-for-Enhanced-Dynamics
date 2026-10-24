// E-76 W11, wired: the Pixi worker's real MESH layer path (initializeCustomLayers once, then updateCustomLayers
// every frame) on scenes that createSceneSharedBuffers builds, three ways: the switch off (MeshGeometry in a
// SharedArrayBuffer of its own, Pixi's batches in arrays of their own, the JS rewrite), the mesh memory with
// the JS rewrite, and the mesh memory with the corner kernel. Every frame the game side edits meshes through
// the MeshRenderer API (setVertices on grids, fans and stars; setRope; setMesh with new UVs or new indices; the
// same setPlane again; now and then a new topology or a clearMesh) and repaints one, and all three runs must
// hold the same rows in both batches, word for word. On the mesh memory the batches write their rows there and
// upload arrays of their own (E-123), so each frame also checks that the rows the upload sent are the rows the
// memory holds. Pixi runs on the WebGPU program path, which builds in Node; with no renderer, its uploads stop
// before the GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';
import { LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { createWeedPosePayload, initWeedPoseDefaults } from '../../src/box2d/box2dHotFields.js';

const N = 48;
const MAX_VERTS = 4096;
const MAX_INDICES = 12288;
const FRAMES = 120;

const SHADERS = {
  colliderFill: fs.readFileSync(new URL('../../src/shaders/colliderFill.wgsl', import.meta.url), 'utf8'),
  meshUvFill: fs.readFileSync(new URL('../../src/shaders/meshUvFill.wgsl', import.meta.url), 'utf8'),
};

class MeshThing extends GameObject {}
MeshThing.components = [RigidBody, Collider, MeshRenderer];

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

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.warn = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** The main thread's shared buffers for a scene of N mesh entities on one MESH layer. */
function buildScene(meshCorners) {
  Query.reset();
  const scene = {
    totalEntityCount: N,
    nextComponentId: 4,
    registeredClasses: [{ class: MeshThing, count: N, startIndex: 0, entityType: 0, components: MeshThing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      MeshRenderer: { ComponentClass: MeshRenderer },
    },
    config: {
      worldWidth: 2000,
      worldHeight: 1000,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { enabled: false, maxJoints: 0 },
      spatial: { cellSize: 100, maxNeighbors: 8, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 100, maxMeshVerts: MAX_VERTS, maxMeshIndices: MAX_INDICES },
      layers: { mesh: { kind: LAYER_KIND.MESH, zIndex: 2 } },
      wasm: { ...WASM_DEFAULTS, meshCorners },
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
  // As Scene.createSharedBuffers does with physics off: Transform's pose views on a Weed pose SAB.
  createSceneSharedBuffers(scene);
  scene.weedPose = createWeedPosePayload(N);
  initWeedPoseDefaults(scene.weedPose);
  return scene;
}

/** The Pixi worker, its per-scene state cleared, bound to `scene` through its real init of custom layers. */
async function initPixi(px, scene) {
  px._colliderFillSkip = [];
  px._colliderFillViews = null;
  px._colliderFillLayerCount = -1;
  px._customLayerList = [];
  px.globalEntityCount = scene.totalEntityCount;
  px.config = scene.config;
  px._useWebGpu = true;
  px._engineShaders = SHADERS;
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: null };
  await px.initializeCustomLayers({
    config: scene.config,
    layerData: Layer.getSerializableData(),
    customLayerRenderQueues: scene.customLayerRenderQueues,
    // As sceneWorkerBootstrap posts it.
    meshGeom: {
      enabled: true,
      maxMeshVerts: MAX_VERTS,
      maxMeshIndices: MAX_INDICES,
      entityCount: scene.totalEntityCount,
      data: scene.buffers.meshGeomData,
      memory: scene.meshMemory?.memory || null,
      layout: scene.meshMemory?.layout || null,
    },
  });
}

const SEGS = [[3, 2], [4, 3]];
const QUAD_XY = [-16, -12, 16, -12, 16, 12, -16, 12];
const QUAD_IDX = [[0, 1, 2, 0, 2, 3], [1, 2, 3, 1, 3, 0]];

function ropePoints(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push((i - (n - 1) * 0.5) * 9, (r() - 0.5) * 14);
  return pts;
}

function star(r) {
  const xy = [];
  const outer = 18 + r() * 6;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = (i & 1) === 0 ? outer : outer * 0.4;
    xy.push(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  return xy;
}

function fan(r, n) {
  const xy = [];
  const rad = 10 + r() * 10;
  for (let i = 0; i < n; i++) xy.push(Math.cos((i / n) * Math.PI * 2) * rad, Math.sin((i / n) * Math.PI * 2) * rad);
  return xy;
}

function grid(r, sx, sy) {
  const xy = [];
  for (let j = 0; j <= sy; j++) for (let i = 0; i <= sx; i++) xy.push(-20 + (40 * i) / sx + (r() - 0.5) * 3, -15 + (30 * j) / sy + (r() - 0.5) * 3);
  return xy;
}

function makeMesh(r, mr, shape, fresh) {
  if (shape.kind === 'grid') {
    shape.segs = SEGS[fresh ? 0 : Math.floor(r() * SEGS.length)];
    mr.setPlane(40, 30, shape.segs[0], shape.segs[1]);
  } else if (shape.kind === 'rope') {
    shape.points = fresh ? 6 : 5 + Math.floor(r() * 3);
    mr.setRope(ropePoints(r, shape.points), 5);
  } else if (shape.kind === 'quad') {
    shape.uv = Array.from({ length: 8 }, () => r());
    mr.setMesh(QUAD_XY, QUAD_IDX[0], shape.uv);
  } else if (shape.kind === 'fan') {
    shape.verts = fresh ? 6 : 5 + Math.floor(r() * 3);
    mr.setMesh(fan(r, shape.verts));
  } else {
    mr.setPolygon(star(r));
  }
}

/** One game frame: in-place edits, a repaint, and now and then a new topology or a clear. */
function gameFrame(r, api, shapes) {
  const p = r();
  const changed = p < 0.12 ? Math.floor(r() * N) : -1;
  if (changed >= 0) {
    if (p < 0.03) api[changed].clearMesh();
    else makeMesh(r, api[changed], shapes[changed], false);
  }
  if (r() < 0.2) api[Math.floor(r() * N)].tint = Math.floor(r() * 0xffffff);
  for (let i = 0; i < N; i++) {
    if (i === changed || r() < 0.3) continue;
    const mr = api[i];
    const shape = shapes[i];
    if (MeshGeometry.vertOffset[i] < 0) {
      if (r() < 0.3) makeMesh(r, mr, shape, true);
      continue;
    }
    if (shape.kind === 'grid') {
      if (r() < 0.85) mr.setVertices(grid(r, shape.segs[0], shape.segs[1]));
      else mr.setPlane(40 + r() * 4, 30, shape.segs[0], shape.segs[1]);
    } else if (shape.kind === 'rope') {
      mr.setRope(ropePoints(r, shape.points), 5);
    } else if (shape.kind === 'quad') {
      const w = r();
      if (w < 0.5) mr.setVertices(QUAD_XY.map((v) => v + (r() - 0.5) * 4));
      else if (w < 0.8) mr.setMesh(QUAD_XY, QUAD_IDX[0], (shape.uv = Array.from({ length: 8 }, () => r())));
      else mr.setMesh(QUAD_XY, QUAD_IDX[1], shape.uv);
    } else if (shape.kind === 'fan') {
      mr.setVertices(fan(r, shape.verts));
    } else {
      mr.setVertices(star(r));
    }
  }
}

/**
 * One run: the scene, Pixi bound to it, FRAMES frames of game edits then Pixi's frame, the rows of both batches
 * after each. `kernel` false unbinds the kernel after the init (the JS rewrite on the memory's arrays).
 */
async function run(px, meshCorners, kernel) {
  const scene = await quietly(() => buildScene(meshCorners));
  await quietly(() => initPixi(px, scene));
  if (!kernel) px._meshCornersWasm = null;
  const layerId = Layer.get('mesh').id;
  const cl = px._customLayers[layerId];
  assert.ok(cl?.fillBatch, 'the MESH layer has its fill batch');
  const r = rng(0x11ed);
  const api = [];
  const shapes = [];
  for (let i = 0; i < N; i++) {
    const mr = new MeshRenderer(i);
    api.push(mr);
    MeshRenderer.active[i] = 1;
    MeshRenderer.layerMask[i] = 1 << layerId;
    Transform.x[i] = 100 + (i % 8) * 80;
    Transform.y[i] = 100 + ((i / 8) | 0) * 80;
    Transform.rotC[i] = Math.cos(i * 0.3);
    Transform.rotS[i] = Math.sin(i * 0.3);
    const p = r();
    const shape = { kind: p < 0.35 ? 'grid' : p < 0.55 ? 'rope' : p < 0.7 ? 'quad' : p < 0.85 ? 'fan' : 'star' };
    shapes.push(shape);
    makeMesh(r, mr, shape, true);
  }
  const frames = [];
  await quietly(() => {
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) gameFrame(r, api, shapes);
      px.updateCustomLayers();
      const fillN = cl.prevCount | 0;
      const uvN = cl.uvPrevCount | 0;
      // What the uploads sent: each Buffer's own array.
      const fill = cl.fillBatch.dataU32.slice(0, fillN * COLLIDER_FILL_FLOATS);
      const uv = cl.uvFillBatch ? cl.uvFillBatch.dataU32.slice(0, uvN * MESH_UV_FILL_FLOATS) : new Uint32Array(0);
      // E-123: on the mesh memory, the rows the writers left there, every one of them copied before the upload.
      const fillAt = firstDiff(cl.fillBatch.rowsU32.subarray(0, fill.length), fill);
      assert.equal(fillAt, -1, `frame ${f}: fill float ${fillAt} is not what the upload sent`);
      if (cl.uvFillBatch) {
        const uvAt = firstDiff(cl.uvFillBatch.rowsU32.subarray(0, uv.length), uv);
        assert.equal(uvAt, -1, `frame ${f}: UV float ${uvAt} is not what the upload sent`);
      }
      frames.push({ fillN, uvN, fill, uv });
    }
  });
  return { scene, cl, frames, kernel: px._meshCornersWasm, skip: px._colliderFillSkip[layerId] };
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let q = 0; q < n; q++) if (a[q] !== b[q]) return q;
  return -1;
}

test('Pixi draws the same mesh rows with the switch off, on the mesh memory in JS, and through the kernel', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');

  const off = await run(px, false, false);
  assert.equal(off.scene.meshMemory, null, 'switched off: no mesh memory');
  assert.ok(off.scene.buffers.meshGeomData instanceof SharedArrayBuffer);
  assert.equal(off.cl.meshRegion, null, 'the batches keep arrays of their own');
  assert.ok(!(off.cl.fillBatch.data.buffer instanceof SharedArrayBuffer));
  assert.equal(off.cl.fillBatch.rows, off.cl.fillBatch.data, 'written where they are uploaded from');
  assert.equal(off.cl.uvFillBatch.rows, off.cl.uvFillBatch.data);

  const js = await run(px, true, false);
  const mem = js.scene.meshMemory;
  assert.ok(mem, 'the mesh memory');
  assert.equal(js.scene.buffers.meshGeomData, mem.buffer, 'MeshGeometry lives in it');
  assert.equal(MeshGeometry.vertOffset.buffer, mem.buffer);
  assert.equal(MeshGeometry.vertOffset.byteOffset, 0, 'from byte 0');
  assert.ok(js.cl.meshRegion, 'the layer has its regions');
  assert.equal(js.cl.fillBatch.rows.buffer, mem.buffer, 'fill rows in the memory');
  assert.equal(js.cl.fillBatch.rows.byteOffset, js.cl.meshRegion.fillRowsByte);
  assert.equal(js.cl.uvFillBatch.rows.buffer, mem.buffer, 'UV rows in the memory');
  assert.equal(js.cl.uvFillBatch.rows.byteOffset, js.cl.meshRegion.uvRowsByte);
  // E-123: each Pixi Buffer uploads an array of its own, not a view on the memory.
  for (const batch of [js.cl.fillBatch, js.cl.uvFillBatch]) {
    assert.equal(batch.buffer.data, batch.data);
    assert.ok(!(batch.data.buffer instanceof SharedArrayBuffer), 'the upload array is not shared');
    assert.equal(batch.dataU32.buffer, batch.data.buffer);
    assert.equal(batch.rowsU32.buffer, mem.buffer);
    assert.equal(batch.rowsU32.byteOffset, batch.rows.byteOffset);
  }
  for (const name of ['instanceEntity', 'uvInstanceEntity', 'lastVertGen', 'frameVertGen', 'lastUvGen', 'frameUvGen']) {
    assert.equal(js.skip[name].buffer, mem.buffer, `${name} in the memory`);
  }
  assert.equal(js.kernel, null, 'the JS run has no kernel');

  const wasm = await run(px, true, true);
  assert.ok(wasm.kernel, 'the kernel bound');
  assert.equal(wasm.kernel.declined, 0, 'the kernel took every call');
  assert.ok(wasm.kernel.calls > FRAMES / 2, `the kernel ran (${wasm.kernel.calls} calls)`);

  let rewrites = 0;
  let uvRows = 0;
  for (let f = 0; f < FRAMES; f++) {
    const a = off.frames[f];
    for (const [name, other] of [['mesh memory, JS', js.frames[f]], ['kernel', wasm.frames[f]]]) {
      assert.equal(other.fillN, a.fillN, `frame ${f}, ${name}: fill rows`);
      assert.equal(other.uvN, a.uvN, `frame ${f}, ${name}: UV rows`);
      const atFill = firstDiff(other.fill, a.fill);
      assert.equal(atFill, -1, `frame ${f}, ${name}: fill row ${Math.floor(atFill / COLLIDER_FILL_FLOATS)}, float ${atFill % COLLIDER_FILL_FLOATS}`);
      const atUv = firstDiff(other.uv, a.uv);
      assert.equal(atUv, -1, `frame ${f}, ${name}: UV row ${Math.floor(atUv / MESH_UV_FILL_FLOATS)}, float ${atUv % MESH_UV_FILL_FLOATS}`);
    }
    if (f > 0 && a.uvN === off.frames[f - 1].uvN) rewrites++;
    uvRows += a.uvN;
  }
  assert.ok(rewrites > FRAMES / 2, `${rewrites} frames kept their topology`);
  assert.ok(uvRows > FRAMES * 100, `${uvRows} UV rows compared`);
});
