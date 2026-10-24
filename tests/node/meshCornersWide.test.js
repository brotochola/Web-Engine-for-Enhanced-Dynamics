// E-130: the corner kernel on a 32-bit arena. With renderer.maxMeshVerts past 65535 MeshGeometry's vertex counts
// and triangle indices are Uint32, and meshCornersClient binds wasm/meshCorners.c's rewrite_corners_u32 for them
// (a 16-bit arena keeps rewrite_corners). The kernel against rewriteExplicitMeshCorners on meshCornersWasm.test.js's
// random frames over 32-bit columns: a small arena bound at 32 bits (every case of the 16-bit frames, plus corner
// indices of 2^16 and up past the mesh, 2^31 and up among them, and vertex counts of 2^31 and up, which the JS
// reads as negative), and an arena of 70 000 vertices with meshes past 65 535 vertices whose indices name the
// vertices past 65 535. Each frame: the same return code and every word of the row region, bit for bit. Then
// Pixi's real MESH layer path on a scene of maxMeshVerts 70 000 with a 66 306-vertex plane, as meshCornersWired
// runs it: the switch off, the mesh memory in JS, and the kernel draw the same rows frame after frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MESH_UV_FILL_FLOATS, COLLIDER_FILL_FLOATS, rewriteExplicitMeshCorners } from '../../src/render/colliderFillBatch.js';
import { bindMeshCorners, rewriteCornersWasm } from '../../src/render/meshCornersClient.js';
import { E, frameCall, rng, setup } from '../helpers/meshCornerFrames.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { createWeedPosePayload, initWeedPoseDefaults } from '../../src/box2d/box2dHotFields.js';

test('a 16-bit arena binds rewrite_corners, a 32-bit one rewrite_corners_u32, and mixed widths are refused', async () => {
  const narrow = await setup();
  assert.equal(narrow.wide, false);
  assert.equal(narrow.b.indexWidth, 16);
  assert.ok(narrow.geom.indices instanceof Uint16Array);
  const forced = await setup({ width: 32 });
  assert.equal(forced.wide, true);
  assert.equal(forced.b.indexWidth, 32);
  const large = await setup({ V: 70000, I: 4096 });
  assert.equal(large.wide, true, 'past 65 535 vertices without asking');
  assert.equal(large.b.indexWidth, 32);
  assert.ok(large.geom.vertCount instanceof Uint32Array && large.geom.indices instanceof Uint32Array);
  // The 16-bit counts with the 32-bit indices: no export reads that.
  const mixed = { ...forced.geom, vertCount: new Uint16Array(forced.buffer, 0, E) };
  await assert.rejects(bindMeshCorners(forced.memory, 64, mixed), /vertCount is not a Uint32Array/);
});

/**
 * What the JS should do with this frame, run by run (meshCornersWasm.test.js's mirror, over the arena's own
 * capacities and with the counts and indices read as the JS reads them, `| 0`), and the branches it takes.
 */
function expected(s, views, n, step, gen, last, uvGen, lastUv, tally) {
  const g = s.geom;
  const ent = s.entity;
  const uvOn = step >= MESH_UV_FILL_FLOATS && !!views.meshUvU && !!views.meshUvV;
  const uvG = uvOn && lastUv ? uvGen : null;
  let k = 0;
  while (k < n) {
    const id = ent[k];
    const i = id | 0;
    let end = k + 1;
    while (end < n && ent[end] === id) end++;
    const run = end - k;
    if (i < 0) tally.negative++;
    const vertDirty = i >= 0 && i < gen.length && gen[i] !== (i < last.length ? last[i] : 0);
    const uvDirty = uvG !== null && i >= 0 && i < uvG.length && uvG[i] !== (i < lastUv.length ? lastUv[i] : 0);
    k = end;
    if (!vertDirty && !uvDirty) continue;
    if (i >= E) {
      tally.pastGeometry++;
      return -1;
    }
    const vOff = g.vertOffset[i];
    if (vOff < 0) continue;
    const vN = g.vertCount[i] | 0;
    const iAt = g.indexOffset[i];
    const want = iAt >= 0 ? Math.floor(g.indexCount[i] / 3) : vN >= 3 ? vN - 2 : 0;
    if (want !== run) {
      if (vN < 0) tally.hugeCount++;
      tally.need++;
      return -1;
    }
    if (vN < 3) {
      if (vN < 0) tally.hugeCount++;
      tally.underThree++;
      return -1;
    }
    const uvRun = uvOn && (uvG === null || uvDirty);
    const pastVerts = vOff + vN > s.V;
    if (iAt >= 0) {
      let high = false;
      for (let q = 0; q < 3 * run; q++) {
        const o = iAt + q;
        const ix = o < s.I ? g.indices[o] | 0 : 0;
        if (ix < 0 || ix >= vN) {
          if (ix < 0 || ix > 65535) tally.wideBadIndex++;
          tally.badIndex++;
          return -1;
        }
        if (ix > 65535) high = true;
      }
      tally[uvRun ? 'indexedUv' : 'indexed']++;
      if (iAt + 3 * run > s.I) tally.pastIndices++;
      if (high) tally.highIndex++;
    } else {
      tally[uvRun ? 'fanUv' : 'fan']++;
    }
    if (vN > 65535) tally.bigMesh++;
    if (pastVerts) tally.pastVerts++;
  }
  return n > 0 ? 1 : 0;
}

/** `frames` random frames on the arena `opts`: the JS, the mirror and the kernel, word for word. */
async function compareFrames(opts, frames, seed, mustReach) {
  const s = await setup(opts);
  assert.equal(s.wide, true);
  const r = rng(seed);
  const tally = {
    negative: 0, pastGeometry: 0, need: 0, underThree: 0, badIndex: 0, wideBadIndex: 0, hugeCount: 0,
    fan: 0, fanUv: 0, indexed: 0, indexedUv: 0, pastVerts: 0, pastIndices: 0, highIndex: 0, bigMesh: 0,
  };
  const codes = { 0: 0, 1: 0, '-1': 0 };
  const pattern = new Uint32Array(s.outWords.length);
  for (let k = 0; k < frames; k++) {
    const { mode, n, views, stride, last, genNow, lastUvGen, uvGenNow, step, gen, uvSource } = frameCall(r, s, k, pattern);
    s.outWords.set(pattern);
    const jsCode = rewriteExplicitMeshCorners(s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
    const jsWords = s.outWords.slice();
    assert.equal(expected(s, views, n, step, gen, last, uvSource, lastUvGen, tally), jsCode, `frame ${k} (mode ${mode}): the test's mirror of the JS`);
    s.outWords.set(pattern);
    const declined = s.b.declined;
    const code = rewriteCornersWasm(s.b, s.out, n, s.entity, views, stride, last, genNow, lastUvGen, uvGenNow);
    assert.equal(s.b.declined, declined, `frame ${k}: the kernel took the call`);
    assert.equal(code, jsCode, `frame ${k} (mode ${mode}, ${n} instances, stride ${stride}): return code`);
    const at = s.outWords.findIndex((w, q) => w !== jsWords[q]);
    assert.equal(at, -1, `frame ${k} (mode ${mode}, stride ${stride}): word ${at}: kernel 0x${(s.outWords[at] >>> 0).toString(16)}, JS 0x${(jsWords[at] >>> 0).toString(16)}`);
    codes[jsCode]++;
  }
  for (const branch of mustReach) assert.ok(tally[branch] > 0, `no frame reached ${branch}`);
  for (const [code, hits] of Object.entries(codes)) assert.ok(hits > 0, `no frame returned ${code}`);
  return { tally, codes };
}

test('rewrite_corners_u32 writes what rewriteExplicitMeshCorners writes on a 32-bit arena, frame after frame', async (t) => {
  const small = await compareFrames({ width: 32 }, 800, 0xe130, [
    'negative', 'pastGeometry', 'need', 'underThree', 'badIndex', 'wideBadIndex', 'hugeCount',
    'fan', 'fanUv', 'indexed', 'indexedUv', 'pastVerts', 'pastIndices',
  ]);
  t.diagnostic(`1024 vertices, 800 frames: codes ${JSON.stringify(small.codes)}; ${JSON.stringify(small.tally)}`);
  const large = await compareFrames({ V: 70000, I: 3072 }, 120, 0x1e130, ['indexed', 'indexedUv', 'highIndex', 'bigMesh', 'fan']);
  t.diagnostic(`70 000 vertices, 120 frames: codes ${JSON.stringify(large.codes)}; ${JSON.stringify(large.tally)}`);
});

// Pixi's real MESH layer path, as meshCornersWired.test.js runs it, on a 32-bit arena.

const N = 24;
const MAX_VERTS = 70000;
const MAX_INDICES = 420000;
const FRAMES = 40;
const BIG_SEGS = [257, 256];

const SHADERS = {
  colliderFill: fs.readFileSync(new URL('../../src/shaders/colliderFill.wgsl', import.meta.url), 'utf8'),
  meshUvFill: fs.readFileSync(new URL('../../src/shaders/meshUvFill.wgsl', import.meta.url), 'utf8'),
};

class WideMeshThing extends GameObject {}
WideMeshThing.components = [RigidBody, Collider, MeshRenderer];

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.warn = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

function buildScene(meshCorners) {
  Query.reset();
  const scene = {
    totalEntityCount: N,
    nextComponentId: 4,
    registeredClasses: [{ class: WideMeshThing, count: N, startIndex: 0, entityType: 0, components: WideMeshThing.components }],
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
  createSceneSharedBuffers(scene);
  scene.weedPose = createWeedPosePayload(N);
  initWeedPoseDefaults(scene.weedPose);
  return scene;
}

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

function grid(r, sx, sy, jitter) {
  const xy = new Float32Array((sx + 1) * (sy + 1) * 2);
  let p = 0;
  for (let j = 0; j <= sy; j++) {
    for (let i = 0; i <= sx; i++) {
      xy[p++] = -20 + (40 * i) / sx + (r() - 0.5) * jitter;
      xy[p++] = -15 + (30 * j) / sy + (r() - 0.5) * jitter;
    }
  }
  return xy;
}

function fan(r, n) {
  const xy = [];
  const rad = 10 + r() * 10;
  for (let i = 0; i < n; i++) xy.push(Math.cos((i / n) * Math.PI * 2) * rad, Math.sin((i / n) * Math.PI * 2) * rad);
  return xy;
}

function ropePoints(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push((i - (n - 1) * 0.5) * 9, (r() - 0.5) * 14);
  return pts;
}

/** Entity 0: the 66 306-vertex plane; the rest small grids, ropes and fans. */
function makeMesh(r, mr, i, fresh) {
  if (i === 0) {
    mr.setPlane(40 + (fresh ? 0 : r() * 4), 30, BIG_SEGS[0], BIG_SEGS[1]);
    return;
  }
  const kind = i % 3;
  if (kind === 0) mr.setPlane(40, 30, 3 + (fresh ? 0 : Math.floor(r() * 2)), 2);
  else if (kind === 1) mr.setRope(ropePoints(r, 5 + (fresh ? 1 : Math.floor(r() * 3))), 5);
  else mr.setMesh(fan(r, 5 + (fresh ? 1 : Math.floor(r() * 3))));
}

function gameFrame(r, api) {
  const changed = r() < 0.15 ? 1 + Math.floor(r() * (N - 1)) : -1;
  if (changed >= 0) {
    if (r() < 0.25) api[changed].clearMesh();
    else makeMesh(r, api[changed], changed, false);
  }
  for (let i = 0; i < N; i++) {
    if (i === changed || r() < 0.3) continue;
    const mr = api[i];
    if (MeshGeometry.vertOffset[i] < 0) {
      if (r() < 0.3) makeMesh(r, mr, i, true);
      continue;
    }
    const vN = MeshGeometry.vertCount[i];
    if (i === 0) {
      // Positions only, or the same plane again (its UVs in place).
      if (r() < 0.8) mr.setVertices(grid(r, BIG_SEGS[0], BIG_SEGS[1], 0.1));
      else makeMesh(r, mr, 0, false);
    } else if (i % 3 === 1) {
      mr.setRope(ropePoints(r, vN / 2), 5);
    } else {
      mr.setVertices(Float32Array.from({ length: vN * 2 }, () => (r() - 0.5) * 40));
    }
  }
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let q = 0; q < n; q++) if (a[q] !== b[q]) return q;
  return -1;
}

async function run(px, meshCorners, kernel) {
  const scene = await quietly(() => buildScene(meshCorners));
  await quietly(() => initPixi(px, scene));
  if (!kernel) px._meshCornersWasm = null;
  assert.equal(MeshGeometry.indexWidth, 32, 'the scene bound a 32-bit arena');
  // Each rewrite's return code: a rewrite that answers -1 sends Pixi to a full pack, whose rows match anyway.
  const codes = [];
  const rewrite = Object.getPrototypeOf(px)._rewriteMeshCorners;
  px._rewriteMeshCorners = function (...args) {
    const code = rewrite.apply(this, args);
    codes.push(code);
    return code;
  };
  const layerId = Layer.get('mesh').id;
  const cl = px._customLayers[layerId];
  assert.ok(cl?.fillBatch, 'the MESH layer has its fill batch');
  const r = rng(0xb16);
  const api = [];
  for (let i = 0; i < N; i++) {
    const mr = new MeshRenderer(i);
    api.push(mr);
    MeshRenderer.active[i] = 1;
    MeshRenderer.layerMask[i] = 1 << layerId;
    Transform.x[i] = 100 + (i % 6) * 80;
    Transform.y[i] = 100 + ((i / 6) | 0) * 80;
    Transform.rotC[i] = Math.cos(i * 0.3);
    Transform.rotS[i] = Math.sin(i * 0.3);
    makeMesh(r, mr, i, true);
  }
  assert.equal(MeshGeometry.vertCount[0], (BIG_SEGS[0] + 1) * (BIG_SEGS[1] + 1), 'the plane past 65 535 vertices');
  const frames = [];
  await quietly(() => {
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) gameFrame(r, api);
      px.updateCustomLayers();
      const fillN = cl.prevCount | 0;
      const uvN = cl.uvPrevCount | 0;
      const fill = cl.fillBatch.dataU32.slice(0, fillN * COLLIDER_FILL_FLOATS);
      const uv = cl.uvFillBatch ? cl.uvFillBatch.dataU32.slice(0, uvN * MESH_UV_FILL_FLOATS) : new Uint32Array(0);
      frames.push({ fillN, uvN, fill, uv });
    }
  });
  delete px._rewriteMeshCorners;
  return { scene, cl, frames, codes, kernel: px._meshCornersWasm };
}

test('Pixi draws the same rows of a 32-bit arena with the switch off, on the mesh memory in JS, and through the kernel', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const off = await run(px, false, false);
  assert.equal(off.scene.meshMemory, null);
  const js = await run(px, true, false);
  assert.ok(js.scene.meshMemory, 'the mesh memory');
  assert.ok(js.cl.meshRegion, 'the layer has its regions');
  const wasm = await run(px, true, true);
  assert.ok(wasm.kernel, 'the kernel bound');
  assert.equal(wasm.kernel.indexWidth, 32, 'rewrite_corners_u32');
  assert.equal(wasm.kernel.declined, 0, 'the kernel took every call');
  assert.ok(wasm.kernel.calls > FRAMES / 2, `the kernel ran (${wasm.kernel.calls} calls)`);
  // The kernel rewrote what the JS rewrote: the same codes, call for call, most of them done.
  assert.deepEqual(wasm.codes, js.codes, 'the kernel answers each rewrite as the JS does');
  assert.deepEqual(off.codes, js.codes);
  const done = js.codes.filter((c) => c === 1).length;
  assert.ok(done > FRAMES, `${done} of ${js.codes.length} rewrites done`);
  let uvRows = 0;
  for (let f = 0; f < FRAMES; f++) {
    const a = off.frames[f];
    for (const [name, other] of [['mesh memory, JS', js.frames[f]], ['kernel', wasm.frames[f]]]) {
      assert.equal(other.fillN, a.fillN, `frame ${f}, ${name}: fill rows`);
      assert.equal(other.uvN, a.uvN, `frame ${f}, ${name}: UV rows`);
      const atFill = firstDiff(other.fill, a.fill);
      assert.equal(atFill, -1, `frame ${f}, ${name}: fill row ${Math.floor(atFill / COLLIDER_FILL_FLOATS)}`);
      const atUv = firstDiff(other.uv, a.uv);
      assert.equal(atUv, -1, `frame ${f}, ${name}: UV row ${Math.floor(atUv / MESH_UV_FILL_FLOATS)}`);
    }
    uvRows += a.uvN;
  }
  assert.ok(uvRows > FRAMES * BIG_SEGS[0] * BIG_SEGS[1] * 2, `${uvRows} UV rows compared`);
});
