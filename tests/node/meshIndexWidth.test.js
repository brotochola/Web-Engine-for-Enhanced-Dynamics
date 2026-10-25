// E-130: the mesh arena's index width. MeshGeometry's vertex counts and triangle indices are Uint16 while
// renderer.maxMeshVerts is at most 65535 and Uint32 past that (up to 2^20 vertices). Up to 65535 the arena binds
// the arrays it bound before E-130: the same classes at the same byte offsets in a block of the same size, from
// the scene's boot path too, and the MeshRenderer calls take and refuse what they did. Past 65535 a mesh may pass
// 65535 vertices and its indices 65535: setMesh, setPlane, setPolygon and setRope store it, a save keeps it, and
// Pixi's packs and corner rewrite write its rows from the vertices its indices name. The packs and the rewrite
// write the same words from a 32-bit arena as from a 16-bit one, frame after frame of MeshRenderer edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MESH_INDICES,
  MAX_MESH_VERTS_U16,
  MAX_MESH_VERTS_U32,
  MeshGeometry,
  meshIndexWidth,
  resetMeshGeometryWarns,
} from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import {
  COLLIDER_FILL_FLOATS,
  MESH_UV_FILL_FLOATS,
  packColliderFill,
  packMeshUvFill,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';
import { rewriteExplicitMeshCorners } from '../reference/meshCorners.mjs';
import { triangulateSimplePolygon } from '../../src/render/meshTriangulate.js';
import { applyMeshes, packMeshes } from '../../src/core/save/worldBufferSave.js';
import { decodeSaveUncompressed, encodeSaveUncompressed } from '../../src/core/save/entitySaveSnapshot.js';
import { LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers, validateSceneSharedBufferConfig } from '../../src/util/sceneSharedBuffers.js';

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
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  const warns = [];
  console.log = console.info = console.debug = () => {};
  console.warn = (msg) => warns.push(String(msg));
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return warns;
}

/** Bind a fresh arena (width omitted: from maxVerts, as a scene binds it). */
function bindArena(V, I, E, width) {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  resetColliderFillMeshLayerWarn();
  MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(V, I, E, width)), V, I, E, width);
}

const COLUMNS = [
  'vertOffset', 'vertCount', 'indexOffset', 'indexCount', 'hasUv', 'vertexX', 'vertexY', 'uvU', 'uvV', 'indices',
  'revision', 'vertEpoch', 'vertGen', 'uvGen', 'lock', 'vertFreeCount', 'indexFreeCount', 'vertFreeOff',
  'vertFreeLen', 'indexFreeOff', 'indexFreeLen',
];

/**
 * The block bindMeshGeom laid out before E-130, column by column (class, byte offset, length), with `Narrow` the
 * class of vertCount and indices: Uint16Array is that layout, Uint32Array the 32-bit one.
 */
function layoutOf(V, I, E, Narrow = Uint16Array) {
  const F = E + 1;
  const nb = Narrow.BYTES_PER_ELEMENT;
  let o = 0;
  const cols = {};
  const col = (name, ctor, count, bytes) => {
    cols[name] = { ctor, byteOffset: o, length: count };
    o += bytes;
  };
  const align = () => {
    o = (o + 3) & ~3;
  };
  col('vertOffset', Int32Array, E, E * 4);
  col('vertCount', Narrow, E, E * nb);
  align();
  col('indexOffset', Int32Array, E, E * 4);
  col('indexCount', Uint32Array, E, E * 4);
  col('hasUv', Uint8Array, E, E);
  align();
  col('vertexX', Float32Array, V, V * 4);
  col('vertexY', Float32Array, V, V * 4);
  col('uvU', Float32Array, V, V * 4);
  col('uvV', Float32Array, V, V * 4);
  col('indices', Narrow, I, I * nb);
  align();
  col('revision', Uint32Array, 1, 4);
  col('vertEpoch', Uint32Array, 1, 4);
  col('vertGen', Uint32Array, E, E * 4);
  col('uvGen', Uint32Array, E, E * 4);
  col('lock', Int32Array, 1, 4);
  col('vertFreeCount', Int32Array, 1, 4);
  col('indexFreeCount', Int32Array, 1, 4);
  col('vertFreeOff', Int32Array, F, F * 4);
  col('vertFreeLen', Int32Array, F, F * 4);
  col('indexFreeOff', Int32Array, F, F * 4);
  col('indexFreeLen', Int32Array, F, F * 4);
  return { byteLength: o, cols };
}

function assertLayout(want, label) {
  for (const name of COLUMNS) {
    const view = MeshGeometry[name];
    const w = want.cols[name];
    assert.equal(view.constructor, w.ctor, `${label}: ${name} class`);
    assert.equal(view.byteOffset, w.byteOffset, `${label}: ${name} byte offset`);
    assert.equal(view.length, w.length, `${label}: ${name} length`);
  }
}

const SIXTEEN = [
  [1, 0, 1],
  [3, 0, 7],
  [64, 96, 8],
  [4096, 12288, 48],
  [8192, 24576, 41],
  [65534, 1, 3],
  [65535, 524288, 2665],
  [65535, 4194304, 65535],
];

test('up to 65 535 vertices the arena binds the 16-bit arrays it bound before', () => {
  for (const [V, I, E] of SIXTEEN) {
    const label = `${V} verts, ${I} indices, ${E} entities`;
    const want = layoutOf(V, I, E);
    assert.equal(meshIndexWidth(V), 16, label);
    assert.equal(MeshGeometry.getBufferSize(V, I, E), want.byteLength, `${label}: block size`);
    bindArena(V, I, E);
    assertLayout(want, label);
    assert.equal(MeshGeometry.indexWidth, 16);
    assert.equal(MeshGeometry.IndexArray, Uint16Array);
    assert.equal(MeshGeometry.vertLimit, 65535);
    assert.equal(MeshGeometry.planeSegments, 254);
  }
  // Before any arena, and after a reset, MeshRenderer sees the 16-bit limits it always saw.
  MeshGeometry.reset();
  assert.equal(MeshGeometry.indexWidth, 16);
  assert.equal(MeshGeometry.IndexArray, Uint16Array);
  assert.equal(MeshGeometry.vertLimit, 65535);
  assert.equal(MeshGeometry.planeSegments, 254);
});

test('past 65 535 vertices the vertex counts and the indices are Uint32', () => {
  assert.equal(MAX_MESH_VERTS_U16, 65535);
  assert.equal(MAX_MESH_VERTS_U32, 1048576);
  assert.equal(MAX_MESH_INDICES, 4194304);
  for (const [V, I, E] of [[65536, 0, 1], [70001, 3001, 13], [262144, 1310720, 2665], [MAX_MESH_VERTS_U32, 3, 5]]) {
    const label = `${V} verts, ${I} indices, ${E} entities`;
    const want = layoutOf(V, I, E, Uint32Array);
    assert.equal(meshIndexWidth(V), 32, label);
    assert.equal(MeshGeometry.getBufferSize(V, I, E), want.byteLength, `${label}: block size`);
    bindArena(V, I, E);
    assertLayout(want, label);
    assert.equal(MeshGeometry.indexWidth, 32);
    assert.equal(MeshGeometry.IndexArray, Uint32Array);
    assert.equal(MeshGeometry.vertLimit, MAX_MESH_VERTS_U32);
    assert.equal(MeshGeometry.planeSegments, 1023);
  }
  // A small arena at 32 bits when asked (the tests' way to run the 32-bit paths cheaply); 16 is never forced
  // past 65535.
  bindArena(4096, 12288, 48, 32);
  assertLayout(layoutOf(4096, 12288, 48, Uint32Array), 'forced 32');
  assert.equal(MeshGeometry.getBufferSize(70000, 9, 3, 16), layoutOf(70000, 9, 3, Uint32Array).byteLength);
  MeshGeometry.reset();
  assert.equal(MeshGeometry.vertLimit, 65535, 'reset is 16-bit again');
});

/** A scene the shared-buffer validation accepts, with these mesh arenas. */
function validationScene(renderer) {
  return {
    totalEntityCount: 10,
    nextComponentId: 3,
    registeredClasses: [{ class: class MeshWidthEntity {}, startIndex: 0, count: 10 }],
    config: {
      worldWidth: 1024,
      worldHeight: 1024,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { maxJoints: 0 },
      spatial: { cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 100, ...renderer },
      layers: {},
    },
  };
}

test('the config takes a vertex arena up to 2^20 and an index arena up to 2^22', () => {
  for (const maxMeshVerts of [0, 65535, 65536, 262144, MAX_MESH_VERTS_U32]) {
    assert.doesNotThrow(() => validateSceneSharedBufferConfig(validationScene({ maxMeshVerts })), `${maxMeshVerts}`);
  }
  assert.throws(
    () => validateSceneSharedBufferConfig(validationScene({ maxMeshVerts: MAX_MESH_VERTS_U32 + 1 })),
    /renderer\.maxMeshVerts must be an integer in \[0, 1048576\]/,
  );
  assert.doesNotThrow(() => validateSceneSharedBufferConfig(validationScene({ maxMeshVerts: 65536, maxMeshIndices: MAX_MESH_INDICES })));
  assert.throws(
    () => validateSceneSharedBufferConfig(validationScene({ maxMeshVerts: 65536, maxMeshIndices: MAX_MESH_INDICES + 1 })),
    /renderer\.maxMeshIndices must be an integer in \[0, 4194304\]/,
  );
});

class WidthThing extends GameObject {}
WidthThing.components = [RigidBody, Collider, MeshRenderer];

/** The main thread's shared buffers for a scene of `n` mesh entities on one MESH layer (meshCornersWired's scene). */
function bootScene(n, maxMeshVerts, maxMeshIndices) {
  Query.reset();
  const scene = {
    totalEntityCount: n,
    nextComponentId: 4,
    registeredClasses: [{ class: WidthThing, count: n, startIndex: 0, entityType: 0, components: WidthThing.components }],
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
      renderer: { maxVisibleRenderables: 100, maxMeshVerts, maxMeshIndices },
      layers: { mesh: { kind: LAYER_KIND.MESH, zIndex: 2 } },
      wasm: { ...WASM_DEFAULTS },
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
  quiet(() => createSceneSharedBuffers(scene));
  return scene;
}

test('the scene boot binds the 16-bit block up to 65 535 vertices and the 32-bit one past it', () => {
  const n = 48;
  for (const [V, I, Narrow] of [[4096, 12288, Uint16Array], [65535, 524288, Uint16Array], [70000, 400000, Uint32Array]]) {
    const scene = bootScene(n, V, I);
    const want = layoutOf(V, I, n, Narrow);
    assert.ok(scene.meshMemory, `${V}: the mesh memory`);
    assert.equal(scene.meshMemory.layout.geometryBytes, want.byteLength, `${V}: the block in the mesh memory`);
    assert.equal(scene.buffers.meshGeomData, scene.meshMemory.buffer);
    assertLayout(want, `${V} verts, booted`);
  }
  MeshGeometry.reset();
});

function fanPositions(n, radius) {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xy[i * 2] = Math.cos(a) * radius;
    xy[i * 2 + 1] = Math.sin(a) * radius;
  }
  return xy;
}

/** A strip of `n` vertices, two rows, and its triangles: indices up to n - 1. */
function strip(n) {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    xy[i * 2] = (i >> 1) * 0.5;
    xy[i * 2 + 1] = (i & 1) * 4;
  }
  const idx = new Uint32Array((n - 2) * 3);
  for (let t = 0; t < n - 2; t++) {
    idx[t * 3] = t;
    idx[t * 3 + 1] = t + 1;
    idx[t * 3 + 2] = t + 2;
  }
  return { xy, idx };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * A strictly convex outline of at least `minCount` corners, every corner an integer below 2^24 (exact in the
 * Float32Array setPolygon copies points into): the primitive vectors up to k in each axis, by angle, summed. A
 * regular polygon of that many corners is not convex in float32 and would take the ear clip, O(n^2).
 */
function latticeOutline(minCount) {
  for (let k = 160; ; k += 4) {
    const vecs = [];
    for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) if ((a || b) && gcd(Math.abs(a), Math.abs(b)) === 1) vecs.push([a, b]);
    if (vecs.length < minCount) continue;
    vecs.sort((p, q) => Math.sign(Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0])));
    const xy = new Float64Array(vecs.length * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < vecs.length; i++) {
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      x += vecs[i][0];
      y += vecs[i][1];
    }
    assert.ok(x === 0 && y === 0, 'the outline closes');
    for (let q = 0; q < xy.length; q++) assert.ok(Math.abs(xy[q]) < 16777216, 'corners exact in float32');
    return { xy, n: vecs.length };
  }
}

function assertSameValues(a, b, label) {
  assert.equal(a.length, b.length, `${label}: length`);
  const at = firstDiff(a, b);
  assert.equal(at, -1, `${label}: value ${at}`);
}

test('MeshRenderer takes a mesh past 65 535 vertices in a 32-bit arena, and refuses it in a 16-bit one as before', () => {
  const big = strip(70000);
  const outline = latticeOutline(66000);
  assert.ok(outline.n > 66000 && outline.n < 80000, `${outline.n} corners`);
  // 16 bits: the calls take and refuse what they did.
  bindArena(MAX_MESH_VERTS_U16, MAX_MESH_INDICES, 6);
  const warns16 = quiet(() => {
    const mr = [0, 1, 2, 3, 4].map((i) => new MeshRenderer(i));
    assert.equal(MeshGeometry.replace(0, big.xy, big.idx, null), false, 'a 70 000-vertex mesh');
    mr[1].setPlane(100, 100, 300, 300);
    assert.equal(MeshGeometry.vertCount[1], 255 * 255, 'setPlane clamps to 254 cells');
    assert.equal(MeshGeometry.indexCount[1], 254 * 254 * 6);
    mr[1].clearMesh();
    mr[2].setPolygon(outline.xy);
    assert.equal(MeshGeometry.vertOffset[2], -1, `a ${outline.n}-corner outline`);
    mr[2].setPolygon(fanPositions(1000, 500));
    assert.equal(MeshGeometry.vertCount[2], 1000, 'a 1000-corner outline');
    mr[3].setRope(fanPositions(40000, 500), 2);
    assert.equal(MeshGeometry.vertOffset[3], -1, 'a rope of 80 000 vertices');
  });
  assert.ok(warns16.some((w) => /simple outline/.test(w)), 'setPolygon warns as before');

  // 32 bits.
  bindArena(MAX_MESH_VERTS_U32, MAX_MESH_INDICES, 6);
  quiet(() => {
    const mr = [0, 1, 2, 3, 4].map((i) => new MeshRenderer(i));
    assert.equal(MeshGeometry.replace(0, big.xy, big.idx, null), true, 'a 70 000-vertex mesh');
    assert.equal(MeshGeometry.vertCount[0], 70000);
    assert.equal(MeshGeometry.indexCount[0], big.idx.length);
    const at = MeshGeometry.indexOffset[0];
    assertSameValues(MeshGeometry.indices.subarray(at, at + big.idx.length), big.idx, 'its indices past 65 535, as given');
    const vAt = MeshGeometry.vertOffset[0];
    assert.equal(MeshGeometry.vertexX[vAt + 69999], big.xy[69999 * 2]);
    mr[1].setPlane(100, 100, 300, 300);
    assert.equal(MeshGeometry.vertCount[1], 301 * 301, 'setPlane takes 300 cells');
    assert.equal(MeshGeometry.indexCount[1], 300 * 300 * 6);
    mr[2].setPolygon(outline.xy);
    assert.equal(MeshGeometry.vertCount[2], outline.n, `a ${outline.n}-corner outline`);
    assert.equal(MeshGeometry.indexCount[2], (outline.n - 2) * 3);
    const pAt = MeshGeometry.indexOffset[2];
    assert.equal(MeshGeometry.indices[pAt + (outline.n - 2) * 3 - 1], outline.n - 1, 'its last fan corner');
    mr[3].setRope(fanPositions(40000, 500), 2);
    assert.equal(MeshGeometry.vertCount[3], 80000, 'a rope of 80 000 vertices');
    assert.equal(MeshGeometry.indices[MeshGeometry.indexOffset[3] + 39999 * 6 - 1], 79999);
    mr[4].setPlane(10, 10, 5000, 2);
    assert.equal(MeshGeometry.vertCount[4], 1024 * 3, 'setPlane clamps to 1023 cells');
    const tiny = fanPositions(8, 1);
    assert.equal(MeshGeometry.replace(5, tiny, null, null, MAX_MESH_VERTS_U32 + 1), false, 'past the 32-bit limit');
  });
  MeshGeometry.reset();
});

function saveRoundTrip(meshes) {
  return decodeSaveUncompressed(encodeSaveUncompressed({
    sceneName: 'T',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
    meshes,
  })).meshes;
}

test('a save keeps a mesh past 65 535 vertices, and a 16-bit arena saves Uint16 indices as before', () => {
  bindArena(4096, 12288, 4);
  MeshGeometry.replace(1, new Float32Array([0, 0, 10, 0, 0, 10]), new Uint16Array([0, 1, 2]), null);
  const small = packMeshes([1]);
  assert.ok(small[0].indices instanceof Uint16Array, 'Uint16 indices from a 16-bit arena');
  assert.ok(saveRoundTrip(small)[0].indices instanceof Uint16Array, 'and from the save');

  const big = strip(66000);
  bindArena(262144, 600000, 4);
  assert.equal(MeshGeometry.replace(1, big.xy, big.idx, null), true);
  const records = packMeshes([1]);
  assert.ok(records[0].indices instanceof Uint32Array, 'Uint32 indices from a 32-bit arena');
  applyMeshes(saveRoundTrip(records), [{ old: 1, neu: 3 }]);
  assert.equal(MeshGeometry.vertCount[3], 66000);
  const at = MeshGeometry.indexOffset[3];
  assertSameValues(MeshGeometry.indices.subarray(at, at + big.idx.length), big.idx, 'restored indices');
  const vAt = MeshGeometry.vertOffset[3];
  assertSameValues(MeshGeometry.vertexY.subarray(vAt, vAt + 66000), big.xy.filter((_, q) => q & 1), 'restored y');
  MeshGeometry.reset();
});

function star(points, outer, inner) {
  const xy = new Float32Array(points * 4);
  let o = 0;
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = (i & 1) === 0 ? outer : inner;
    xy[o++] = Math.cos(a) * r;
    xy[o++] = Math.sin(a) * r;
  }
  return xy;
}

test('triangulation takes an outline past 65 535 vertices when the arena does, and ear-clips as before', () => {
  const { xy, n } = latticeOutline(66000);
  const out = new Uint32Array((n - 2) * 3);
  assert.equal(triangulateSimplePolygon(xy, n, out), -1, '16-bit limit by default');
  assert.equal(triangulateSimplePolygon(xy, n, out, MAX_MESH_VERTS_U32), (n - 2) * 3);
  assert.equal(out[out.length - 1], n - 1, 'a fan to the last vertex');
  assert.equal(triangulateSimplePolygon(xy, 65535, out), (65535 - 2) * 3, 'at the 16-bit limit (its first 65 535 corners)');
  assert.equal(triangulateSimplePolygon(xy, MAX_MESH_VERTS_U32 + 1, out, MAX_MESH_VERTS_U32 * 2), -1, 'never past 2^20');
  // Concave outlines (the ear clip): the same triangles at either limit.
  const shapes = [
    [star(5, 52, 22), 10],
    [new Float32Array([0, -80, 70, -20, 28, -20, 28, 70, -28, 70, -28, -20, -70, -20]), 7],
    [new Float32Array([0, 0, 3, 0, 3, 1, 1, 1, 1, 2, 0, 2]), 6],
    [star(700, 300, 120), 1400],
  ];
  for (const [xy, count] of shapes) {
    const a = new Uint32Array((count - 2) * 3);
    const b = new Uint32Array((count - 2) * 3);
    const na = triangulateSimplePolygon(xy, count, a);
    const nb = triangulateSimplePolygon(xy, count, b, MAX_MESH_VERTS_U32);
    assert.equal(na, (count - 2) * 3, `${count}-vertex outline`);
    assert.equal(nb, na);
    assert.deepEqual(b, a, `${count}-vertex outline: the same triangles`);
  }
});

/** Pixi's collider-fill views (_ensureColliderFillViews) over MeshGeometry, poses and paint fixed. */
function makeViews(n) {
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

/** One MESH layer's batches and generations, as Pixi's skip state holds them. */
function makeSide(e, fillCap, uvCap) {
  return {
    fillCap,
    uvCap,
    fill: new Float32Array(fillCap * COLLIDER_FILL_FLOATS),
    uv: new Float32Array(uvCap * MESH_UV_FILL_FLOATS),
    fillEntity: new Uint32Array(fillCap),
    uvEntity: new Uint32Array(uvCap),
    fillCount: 0,
    uvCount: 0,
    lastRevision: -1,
    lastVertGen: new Uint32Array(e),
    lastUvGen: new Uint32Array(e),
    frameVertGen: new Uint32Array(e),
    frameUvGen: new Uint32Array(e),
    full: 0,
    rewrites: 0,
  };
}

function fullPack(side, views) {
  views.instanceEntity = side.fillEntity;
  views.outU32 = new Uint32Array(side.fill.buffer);
  side.fillCount = packColliderFill(side.fill, side.fillCap, 0, views);
  views.instanceEntity = side.uvEntity;
  views.outU32 = new Uint32Array(side.uv.buffer);
  side.uvCount = packMeshUvFill(side.uv, side.uvCap, 0, views);
}

/** Pixi's MESH frame: the generations captured, the corner rewrite when the topology held, else a full pack. */
function pixiFrame(side, views) {
  const rev = MeshGeometry.revision[0] | 0;
  side.frameVertGen.set(MeshGeometry.vertGen);
  side.frameUvGen.set(MeshGeometry.uvGen);
  let full = rev !== side.lastRevision;
  if (!full) {
    const a = rewriteExplicitMeshCorners(side.fill, side.fillCount, side.fillEntity, views, COLLIDER_FILL_FLOATS, side.lastVertGen, side.frameVertGen);
    const b = side.uvCount > 0
      ? rewriteExplicitMeshCorners(side.uv, side.uvCount, side.uvEntity, views, MESH_UV_FILL_FLOATS, side.lastVertGen, side.frameVertGen, side.lastUvGen, side.frameUvGen)
      : 1;
    if (a < 0 || b < 0) full = true;
    else side.rewrites++;
  }
  if (full) {
    fullPack(side, views);
    side.full++;
    side.lastRevision = rev;
  }
  side.lastVertGen.set(side.frameVertGen);
  side.lastUvGen.set(side.frameUvGen);
}

const words = (f, n) => new Uint32Array(f.buffer, f.byteOffset, n);

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let q = 0; q < n; q++) if (a[q] !== b[q]) return q;
  return -1;
}

const EDIT_E = 40;
const SEGS = [[3, 2], [4, 3]];
const QUAD_XY = [-16, -12, 16, -12, 16, 12, -16, 12];
const QUAD_IDX = [[0, 1, 2, 0, 2, 3], [1, 2, 3, 1, 3, 0]];

function grid(r, sx, sy) {
  const xy = [];
  for (let j = 0; j <= sy; j++) for (let i = 0; i <= sx; i++) xy.push(-20 + (40 * i) / sx + (r() - 0.5) * 3, -15 + (30 * j) / sy + (r() - 0.5) * 3);
  return xy;
}

function ropePoints(r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push((i - (n - 1) * 0.5) * 9, (r() - 0.5) * 14);
  return pts;
}

function fan(r, n) {
  const xy = [];
  const rad = 10 + r() * 10;
  for (let i = 0; i < n; i++) xy.push(Math.cos((i / n) * Math.PI * 2) * rad, Math.sin((i / n) * Math.PI * 2) * rad);
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
    mr.setPolygon(star(5, 18 + r() * 6, 8));
  }
}

/** One logic frame of MeshRenderer edits: in place mostly, now and then a new topology or a clear. */
function logicFrame(r, api, shapes) {
  const p = r();
  const changed = p < 0.12 ? Math.floor(r() * EDIT_E) : -1;
  if (changed >= 0) {
    if (p < 0.03) api[changed].clearMesh();
    else makeMesh(r, api[changed], shapes[changed], false);
  }
  for (let i = 0; i < EDIT_E; i++) {
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
      mr.setVertices(star(5, 18 + r() * 6, 8));
    }
  }
}

const EDIT_FRAMES = 200;
const EDIT_CAP = 4000;

/** EDIT_FRAMES frames of edits and Pixi's sequence on an arena of `width`; both batches' words after each. */
function editRun(width) {
  bindArena(8192, 24576, EDIT_E, width);
  const r = rng(0xe130);
  const api = [];
  const shapes = [];
  const frames = [];
  const side = makeSide(EDIT_E, EDIT_CAP, EDIT_CAP);
  const truth = makeSide(EDIT_E, EDIT_CAP, EDIT_CAP);
  quiet(() => {
    for (let i = 0; i < EDIT_E; i++) {
      api.push(new MeshRenderer(i));
      const p = r();
      const shape = { kind: p < 0.35 ? 'grid' : p < 0.55 ? 'rope' : p < 0.7 ? 'quad' : p < 0.85 ? 'fan' : 'star' };
      shapes.push(shape);
      makeMesh(r, api[i], shape, true);
    }
    const views = makeViews(EDIT_E);
    for (let f = 0; f < EDIT_FRAMES; f++) {
      if (f > 0) logicFrame(r, api, shapes);
      pixiFrame(side, views);
      fullPack(truth, views);
      const fill = words(side.fill, side.fillCount * COLLIDER_FILL_FLOATS).slice();
      const uv = words(side.uv, side.uvCount * MESH_UV_FILL_FLOATS).slice();
      assert.equal(truth.fillCount, side.fillCount, `${width}-bit frame ${f}: fill rows against a full pack`);
      assert.equal(truth.uvCount, side.uvCount, `${width}-bit frame ${f}: UV rows against a full pack`);
      const atFill = firstDiff(fill, words(truth.fill, truth.fillCount * COLLIDER_FILL_FLOATS));
      assert.equal(atFill, -1, `${width}-bit frame ${f}: fill word ${atFill} against a full pack`);
      const atUv = firstDiff(uv, words(truth.uv, truth.uvCount * MESH_UV_FILL_FLOATS));
      assert.equal(atUv, -1, `${width}-bit frame ${f}: UV word ${atUv} against a full pack`);
      frames.push({ fill, uv });
    }
  });
  assert.equal(MeshGeometry.indexWidth, width);
  return { frames, rewrites: side.rewrites, full: side.full };
}

test('the packs and the corner rewrite write the same rows from a 32-bit arena as from a 16-bit one', (t) => {
  const a = editRun(16);
  const b = editRun(32);
  assert.ok(a.rewrites > EDIT_FRAMES / 2 && a.full > 5, `${a.rewrites} frames rewritten, ${a.full} packed`);
  assert.equal(b.rewrites, a.rewrites);
  let rows = 0;
  for (let f = 0; f < EDIT_FRAMES; f++) {
    const atFill = firstDiff(b.frames[f].fill, a.frames[f].fill);
    assert.equal(atFill, -1, `frame ${f}: fill word ${atFill}`);
    const atUv = firstDiff(b.frames[f].uv, a.frames[f].uv);
    assert.equal(atUv, -1, `frame ${f}: UV word ${atUv}`);
    rows += a.frames[f].uv.length / MESH_UV_FILL_FLOATS + a.frames[f].fill.length / COLLIDER_FILL_FLOATS;
  }
  assert.ok(rows > EDIT_FRAMES * 200, `${rows} rows compared`);
  t.diagnostic(`${a.rewrites} rewrites, ${a.full} full packs, ${rows} rows`);
  MeshGeometry.reset();
});

/** Each packed row's corners are the words of the vertices (and UVs) its triangle names. */
function assertCorners(rows, count, step, entity, tri, label) {
  const g = MeshGeometry;
  const vx = new Uint32Array(g.vertexX.buffer, g.vertexX.byteOffset, g.vertexX.length);
  const vy = new Uint32Array(g.vertexY.buffer, g.vertexY.byteOffset, g.vertexY.length);
  const u = new Uint32Array(g.uvU.buffer, g.uvU.byteOffset, g.uvU.length);
  const v = new Uint32Array(g.uvV.buffer, g.uvV.byteOffset, g.uvV.length);
  const w = words(rows, count * step);
  const corner = [0, 0, 0];
  let k = 0;
  for (const e of entity) {
    const vOff = g.vertOffset[e];
    const n = g.indexOffset[e] >= 0 ? g.indexCount[e] / 3 : g.vertCount[e] - 2;
    for (let t = 0; t < n; t++, k++) {
      tri(e, t, corner);
      const base = k * step;
      for (let c = 0; c < 3; c++) {
        const at = vOff + corner[c];
        if (w[base + c * 2] !== vx[at] || w[base + c * 2 + 1] !== vy[at]) assert.fail(`${label}: entity ${e} triangle ${t} corner ${c}`);
        if (step === MESH_UV_FILL_FLOATS && (w[base + 18 + c * 2] !== u[at] || w[base + 19 + c * 2] !== v[at])) {
          assert.fail(`${label}: entity ${e} triangle ${t} UV ${c}`);
        }
      }
    }
  }
  assert.equal(k, count, `${label}: rows`);
}

function triOf(e, t, out) {
  const g = MeshGeometry;
  const iAt = g.indexOffset[e];
  if (iAt >= 0) {
    out[0] = g.indices[iAt + t * 3];
    out[1] = g.indices[iAt + t * 3 + 1];
    out[2] = g.indices[iAt + t * 3 + 2];
  } else {
    out[0] = 0;
    out[1] = t + 1;
    out[2] = t + 2;
  }
}

test('Pixi packs and rewrites the rows of meshes past 65 535 vertices from the vertices their indices name', () => {
  const E = 3;
  bindArena(262144, 800000, E);
  const plane = new MeshRenderer(0);
  const big = strip(66000);
  quiet(() => {
    plane.setPlane(600, 600, 300, 300);
    MeshGeometry.replace(1, fanPositions(70000, 400), null, null);
    MeshGeometry.replace(2, big.xy, big.idx, null);
  });
  assert.equal(MeshGeometry.vertCount[0], 90601);
  assert.equal(MeshGeometry.vertCount[1], 70000);
  assert.equal(MeshGeometry.vertCount[2], 66000);
  let maxIndex = 0;
  for (let q = 0; q < MeshGeometry.indexCount[0]; q++) maxIndex = Math.max(maxIndex, MeshGeometry.indices[MeshGeometry.indexOffset[0] + q]);
  assert.equal(maxIndex, 90600, 'the plane names vertices past 65 535');

  const fillCap = 69998 + 65998;
  const uvCap = 300 * 300 * 2;
  const views = makeViews(E);
  const side = makeSide(E, fillCap, uvCap);
  pixiFrame(side, views);
  assert.equal(side.full, 1);
  assert.equal(side.fillCount, fillCap, 'the fan and the strip');
  assert.equal(side.uvCount, uvCap, 'the plane');
  assertCorners(side.fill, side.fillCount, COLLIDER_FILL_FLOATS, [1, 2], triOf, 'fill pack');
  assertCorners(side.uv, side.uvCount, MESH_UV_FILL_FLOATS, [0], triOf, 'UV pack');

  // Positions only (setVertices) on all three, and the plane again (its UVs in place): the rewrite, then a full
  // pack of the same meshes holds the same words.
  const r = rng(0x5eed);
  const jiggle = (n) => Float32Array.from({ length: n * 2 }, () => (r() - 0.5) * 900);
  plane.setVertices(jiggle(90601));
  MeshGeometry.writeVertices(1, jiggle(70000));
  MeshGeometry.writeVertices(2, jiggle(66000));
  pixiFrame(side, views);
  assert.equal(side.rewrites, 1, 'a rewrite, not a pack');
  assertCorners(side.fill, side.fillCount, COLLIDER_FILL_FLOATS, [1, 2], triOf, 'fill rewrite');
  assertCorners(side.uv, side.uvCount, MESH_UV_FILL_FLOATS, [0], triOf, 'UV rewrite');
  plane.setPlane(500, 600, 300, 300);
  pixiFrame(side, views);
  assert.equal(side.rewrites, 2, 'the same plane again: a rewrite with its UVs');
  const truth = makeSide(E, fillCap, uvCap);
  fullPack(truth, views);
  assert.equal(firstDiff(words(side.fill, fillCap * COLLIDER_FILL_FLOATS), words(truth.fill, fillCap * COLLIDER_FILL_FLOATS)), -1, 'fill rows');
  assert.equal(firstDiff(words(side.uv, uvCap * MESH_UV_FILL_FLOATS), words(truth.uv, uvCap * MESH_UV_FILL_FLOATS)), -1, 'UV rows');
  MeshGeometry.reset();
});
