/**
 * E-91. createBodyForEntity calls the wasm body creators with the numbers directly, instead of
 * building an options object that PhysicsWorld.create / createCircle / createBox / createPolygon
 * spread over their defaults. That option API left physicsApi.js (N-303 CR-2); its merging stays
 * here as the reference: for random bodies of every kind, the direct call must pass exactly what
 * the options API passed (a polygon's vertices compared by value: the API malloc'd a copy, the
 * direct call writes them to the fixtures' heap scratch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShapeType, Box2dBodyType, DEFAULT_FILTER_MASK } from '../../src/box2d/box2dConstants.js';

const BOX2D_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/box2d');
const post = fs.readFileSync(path.join(BOX2D_DIR, 'weedjsPost.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(BOX2D_DIR, 'physicsApi.js'), 'utf8');

const WORLD_ID = 7; // what the recording exports return, create_world's too
const MAX_POLY_VERTS = 8;

function recordingApi() {
  const calls = [];
  const Module = {
    cwrap: (name) => (...args) => {
      calls.push([name, ...args]);
      return WORLD_ID;
    },
  };
  const api = new Function('Module', `${apiSource}\nreturn createPhysicsApi(Module);`)(Module);
  calls.length = 0; // world creation and friends
  return { api, calls };
}

// The option API as physicsApi.js had it (its DEFAULT_MATERIAL and the four creators), recording
// the export each one called with its arguments. A polygon's vertex pointer is the vertex list.
const DEFAULT_MATERIAL = Object.freeze({
  density: 1.0,
  friction: 0.3,
  restitution: 0.0,
  linearDamping: 0.0,
  angularDamping: 0.0,
  gravityScale: 1.0,
  vx: 0.0,
  vy: 0.0,
  angularVelocity: 0.0,
  isSensor: false,
  enableHitEvents: false,
  categoryBits: 1,
  maskBits: DEFAULT_FILTER_MASK,
});

/** The material and filter arguments every shaped creator took after its shape's own. */
function shapedTail(o) {
  return [
    o.density, o.friction, o.restitution, o.linearDamping, o.angularDamping, o.gravityScale,
    o.vx, o.vy, o.angularVelocity, o.isSensor ? 1 : 0, o.enableHitEvents ? 1 : 0,
    o.categoryBits, o.maskBits, o.groupIndex ?? 0, o.fixedRotation ? 1 : 0, o.entity ?? o.entityIndex ?? -1,
  ];
}

const optionApi = {
  create(options) {
    const o = { ...DEFAULT_MATERIAL, ...options };
    return ['create_body', WORLD_ID, o.type ?? Box2dBodyType.DYNAMIC, o.x ?? 0, o.y ?? 0, o.angle ?? 0,
      o.linearDamping, o.angularDamping, o.gravityScale, o.vx, o.vy, o.angularVelocity,
      o.fixedRotation ? 1 : 0, o.entity ?? o.entityIndex ?? -1];
  },
  createBox(options) {
    const o = { ...DEFAULT_MATERIAL, ...options };
    return ['create_body_box', WORLD_ID, o.type ?? Box2dBodyType.DYNAMIC, o.x ?? 0, o.y ?? 0, o.angle ?? 0,
      o.hx ?? 0.5, o.hy ?? 0.5, o.offsetX ?? 0, o.offsetY ?? 0, ...shapedTail(o)];
  },
  createCircle(options) {
    const o = { ...DEFAULT_MATERIAL, ...options };
    return ['create_body_circle', WORLD_ID, o.type ?? Box2dBodyType.DYNAMIC, o.x ?? 0, o.y ?? 0, o.angle ?? 0,
      o.radius ?? 0.5, o.offsetX ?? 0, o.offsetY ?? 0, ...shapedTail(o)];
  },
  createPolygon(options) {
    const o = { ...DEFAULT_MATERIAL, ...options };
    const verts = o.verts ?? o.vertices;
    // The API copied the vertices into Box2D's heap as float32.
    const heapCopy = Array.from(Float32Array.from(verts));
    return ['create_body_polygon', WORLD_ID, o.type ?? Box2dBodyType.DYNAMIC, o.x ?? 0, o.y ?? 0, o.angle ?? 0,
      heapCopy, verts.length / 2, o.offsetX ?? 0, o.offsetY ?? 0, ...shapedTail(o), o.radius > 0 ? o.radius : 0];
  },
};

const N = 64;
function randomViews(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const f32 = () => new Float32Array(N).map(() => (rng() - 0.5) * 400);
  const shapes = [ShapeType.Circle, ShapeType.Box, ShapeType.Polygon];
  const views = {
    rbActive: new Uint8Array(N).map(() => (rng() < 0.8 ? 1 : 0)),
    colActive: new Uint8Array(N).map(() => (rng() < 0.85 ? 1 : 0)),
    shapeType: new Uint8Array(N).map(() => shapes[(rng() * 3) | 0]),
    rbStatic: new Uint8Array(N).map(() => (rng() < 0.3 ? 1 : 0)),
    friction: new Float32Array(N).map(() => (rng() < 0.2 ? -1 : rng())),
    restitution: new Float32Array(N).map(() => rng()),
    enableHitEvents: new Uint8Array(N).map(() => (rng() < 0.5 ? 1 : 0)),
    linearDamping: new Float32Array(N).map(() => rng()),
    angularDamping: new Float32Array(N).map(() => rng()),
    rotation: f32(),
    x: f32(),
    y: f32(),
    offsetX: f32(),
    offsetY: f32(),
    vx: f32(),
    vy: f32(),
    angularVelocity: f32(),
    isTrigger: new Uint8Array(N).map(() => (rng() < 0.2 ? 1 : 0)),
    collisionMask: new Uint32Array(N).map(() => (rng() * 0xffffffff) >>> 0),
    collisionGroupIndex: new Int16Array(N).map(() => ((rng() - 0.5) * 20) | 0),
    // A circle's radius, a polygon's skin (0 for some).
    radius: new Float32Array(N).map(() => (rng() < 0.3 ? 0 : 1 + rng() * 30)),
    width: new Float32Array(N).map(() => 1 + rng() * 60),
    height: new Float32Array(N).map(() => 1 + rng() * 60),
    polyCount: new Uint8Array(N).map(() => (rng() * (MAX_POLY_VERTS + 1)) | 0),
    polyVertexX: new Float32Array(N * MAX_POLY_VERTS).map(() => (rng() - 0.5) * 80),
    polyVertexY: new Float32Array(N * MAX_POLY_VERTS).map(() => (rng() - 0.5) * 80),
    fixedRotation: new Uint8Array(N).map(() => (rng() < 0.3 ? 1 : 0)),
    density: new Float32Array(N).map(() => rng() * 3),
    category: new Uint32Array(N).map(() => 1 << ((rng() * 31) | 0)),
  };
  return views;
}

// The engine helpers the function calls, the same for both paths.
const helpers = (views) => ({
  isFixedRotation: (i) => views.fixedRotation[i] !== 0,
  densityForEntity: (i) => views.density[i],
  categoryBitsFor: (i) => views.category[i],
  polygonSkin: (i) => (views.radius[i] > 0 ? views.radius[i] : 0),
});

/** The options createBodyForEntity built before E-91, passed to the options API. */
function referenceCalls(views, i) {
  const h = helpers(views);
  const rb = views.rbActive[i] !== 0;
  const col = views.colActive[i] !== 0;
  const shape = views.shapeType[i] | 0;
  const isStatic = !rb || views.rbStatic[i] !== 0 || shape === ShapeType.Chain;
  const rawFriction = views.friction[i];
  const opts = {
    type: isStatic ? Box2dBodyType.STATIC : Box2dBodyType.DYNAMIC,
    x: views.x[i],
    y: views.y[i],
    angle: h.isFixedRotation(i) ? 0 : views.rotation[i],
    offsetX: views.offsetX[i],
    offsetY: views.offsetY[i],
    density: h.densityForEntity(i, shape),
    friction: rawFriction >= 0 ? rawFriction : 0,
    restitution: views.restitution[i] || 0,
    linearDamping: views.linearDamping[i] || 0,
    angularDamping: views.angularDamping[i] || 0,
    gravityScale: 1,
    vx: views.vx[i],
    vy: views.vy[i],
    angularVelocity: views.angularVelocity[i],
    isSensor: views.isTrigger[i] !== 0,
    enableHitEvents: views.enableHitEvents[i] !== 0,
    categoryBits: h.categoryBitsFor(i),
    maskBits: views.collisionMask[i] >>> 0,
    groupIndex: views.collisionGroupIndex[i] | 0,
    fixedRotation: h.isFixedRotation(i),
    entityIndex: i,
  };
  if (rb && !col) return [optionApi.create(opts)];
  if (!col) return [];
  // A circle without a radius makes no body (radius doubles as a polygon's skin, 0 for some here).
  if (shape === ShapeType.Circle) return views.radius[i] > 0 ? [optionApi.createCircle({ ...opts, radius: views.radius[i] })] : [];
  if (shape === ShapeType.Box) return [optionApi.createBox({ ...opts, hx: views.width[i] * 0.5, hy: views.height[i] * 0.5 })];
  const count = views.polyCount[i] | 0;
  if (count < 3) return [];
  const verts = [];
  for (let v = 0; v < count; v++) verts.push(views.polyVertexX[i * MAX_POLY_VERTS + v], views.polyVertexY[i * MAX_POLY_VERTS + v]);
  return [optionApi.createPolygon({ ...opts, verts, radius: h.polygonSkin(i) })];
}

function directCalls(views, i) {
  const { api, calls } = recordingApi();
  const world = new api.PhysicsWorld(0, 0);
  calls.length = 0;
  const start = post.indexOf('  function createBodyForEntity(i) {');
  const end = post.indexOf('  // sync-body-geometry-start');
  assert.ok(start >= 0 && end > start, 'createBodyForEntity block missing in weedjsPost.js');
  const h = helpers(views);
  // The heap scratch: a pointer token, and the vertices it holds (float32, interleaved).
  const SCRATCH = 4096;
  let scratch = [];
  const writePolygonToHeapScratch = (srcX, srcY, base, count) => {
    scratch = [];
    for (let v = 0; v < count; v++) scratch.push(srcX[base + v], srcY[base + v]);
    scratch = Array.from(Float32Array.from(scratch));
    return SCRATCH;
  };
  const make = new Function(
    'views', 'ShapeType', 'Box2dBodyType', 'isFixedRotation', 'world', 'bodyCreators', 'multiShape',
    'addAllFixtures', 'syncChain', 'densityForEntity', 'categoryBitsFor', 'MAX_POLY_VERTS', 'polygonSkin',
    'writePolygonToHeapScratch',
    `${post.slice(start, end)}\nreturn createBodyForEntity;`,
  );
  const createBodyForEntity = make(
    views, ShapeType, Box2dBodyType, h.isFixedRotation, world, api.bodyCreators, new Uint8Array(N),
    () => true, () => true, h.densityForEntity, h.categoryBitsFor, MAX_POLY_VERTS, h.polygonSkin,
    writePolygonToHeapScratch,
  );
  createBodyForEntity(i);
  return calls.map((call) => {
    if (call[0] !== 'create_body_polygon') return call;
    assert.equal(call[6], SCRATCH, 'the polygon reads the heap scratch');
    const out = call.slice();
    out[6] = scratch;
    return out;
  });
}

test('createBodyForEntity passes the wasm creators what the options API passed', () => {
  const kinds = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const views = randomViews(seed);
    for (let i = 0; i < N; i++) {
      const want = referenceCalls(views, i);
      const got = directCalls(views, i);
      assert.deepEqual(got, want, `seed ${seed} entity ${i}`);
      if (want[0]) kinds.add(want[0][0]);
    }
  }
  assert.deepEqual([...kinds].sort(), ['create_body', 'create_body_box', 'create_body_circle', 'create_body_polygon']);
});
