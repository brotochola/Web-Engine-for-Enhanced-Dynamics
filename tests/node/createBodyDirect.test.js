/**
 * E-91. createBodyForEntity calls the wasm body creators with the numbers directly, instead of
 * building an options object that PhysicsWorld.create / createCircle / createBox spread over their
 * defaults. Both paths are run here against a Module whose exports record their arguments: for
 * random bodies of every kind the direct call must pass exactly what the options API passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShapeType, Box2dBodyType } from '../../src/box2d/box2dConstants.js';

const BOX2D_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/box2d');
const post = fs.readFileSync(path.join(BOX2D_DIR, 'weedjsPost.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(BOX2D_DIR, 'physicsApi.js'), 'utf8');

function recordingApi() {
  const calls = [];
  const Module = {
    cwrap: (name) => (...args) => {
      calls.push([name, ...args]);
      return 7;
    },
  };
  const api = new Function('Module', `${apiSource}\nreturn createPhysicsApi(Module);`)(Module);
  calls.length = 0; // world creation and friends
  return { api, calls };
}

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
  const views = {
    rbActive: new Uint8Array(N).map(() => (rng() < 0.8 ? 1 : 0)),
    colActive: new Uint8Array(N).map(() => (rng() < 0.85 ? 1 : 0)),
    shapeType: new Uint8Array(N).map(() => (rng() < 0.5 ? ShapeType.Circle : ShapeType.Box)),
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
    radius: new Float32Array(N).map(() => 1 + rng() * 30),
    width: new Float32Array(N).map(() => 1 + rng() * 60),
    height: new Float32Array(N).map(() => 1 + rng() * 60),
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
});

/** The options createBodyForEntity built before E-91, passed to the options API. */
function referenceCalls(views, i) {
  const { api, calls } = recordingApi();
  const world = new api.PhysicsWorld(0, 0);
  calls.length = 0;
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
  if (rb && !col) world.create(opts);
  else if (!col) return calls;
  else if (shape === ShapeType.Circle) world.createCircle({ ...opts, radius: views.radius[i] });
  else world.createBox({ ...opts, hx: views.width[i] * 0.5, hy: views.height[i] * 0.5 });
  return calls;
}

function directCalls(views, i) {
  const { api, calls } = recordingApi();
  const world = new api.PhysicsWorld(0, 0);
  calls.length = 0;
  const start = post.indexOf('  function createBodyForEntity(i) {');
  const end = post.indexOf('  // sync-body-geometry-start');
  assert.ok(start >= 0 && end > start, 'createBodyForEntity block missing in weedjsPost.js');
  const h = helpers(views);
  const make = new Function(
    'views', 'ShapeType', 'Box2dBodyType', 'isFixedRotation', 'world', 'bodyCreators', 'multiShape',
    'addAllFixtures', 'syncChain', 'densityForEntity', 'categoryBitsFor', 'MAX_POLY_VERTS', 'polygonSkin',
    `${post.slice(start, end)}\nreturn createBodyForEntity;`,
  );
  const createBodyForEntity = make(
    views, ShapeType, Box2dBodyType, h.isFixedRotation, world, api.bodyCreators, new Uint8Array(N),
    () => true, () => true, h.densityForEntity, h.categoryBitsFor, 8, () => 0,
  );
  createBodyForEntity(i);
  return calls;
}

test('createBodyForEntity passes the wasm creators what the options API passed', () => {
  let kinds = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const views = randomViews(seed);
    for (let i = 0; i < N; i++) {
      const want = referenceCalls(views, i);
      const got = directCalls(views, i);
      assert.deepEqual(got, want, `seed ${seed} entity ${i}`);
      if (want[0]) kinds.add(want[0][0]);
    }
  }
  assert.deepEqual([...kinds].sort(), ['create_body', 'create_body_box', 'create_body_circle']);
});
