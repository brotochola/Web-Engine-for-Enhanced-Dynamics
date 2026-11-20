import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform, LINK_COUNT } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { noteEntityType } from '../../src/core/entityTypes.js';
import { bindStaticSceneryGen, bindStaticTypes, staticSceneryGen } from '../../src/core/staticScenery.js';
import { enterSpawnHere, leaveSpawnHere } from '../../src/core/spawningHere.js';
import { bindCommandRing, createCommandRingSab, drainCommandRing } from '../../src/box2d/box2dCommandRing.js';
import { BODY_DIRTY, bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { entity } from '../helpers/setterWorld.mjs';

// E-533: Transform's and RigidBody's statics by entity index (Transform.setX(i, x), RigidBody.addVelocity(i, dvx, dvy),
// ...) do what the entity's methods do. Each case runs an entity's method on one entity and the static on a twin with
// the same components and the same columns, and compares what they wrote: every column, the commands Box2D was sent,
// the body's dirty marks, the static scenery counter and the warnings. (GameObject's methods are the reference until
// they call the same work; then this keeps the two forms together.)

const f = Math.fround;
const N = 12;
/** The twins: the entity's method writes A, the static writes B. */
const A = 1;
const B = 2;
/** A parent for the child cases. */
const PARENT = 7;

class Crate {
  static components = [RigidBody, Collider];
}
class Floater {
  static components = [RigidBody];
}
class Wall {
  static components = [Collider];
}
class Walker {
  static components = [SpriteRenderer];
}
class Prop {
  static components = [SpriteRenderer];
  static isStatic = true;
}

/** Entity types (not 0 or 1, which other tests bind as static scenery or not), each with its _hasComponents. */
const KINDS = {
  crate: { type: 2, flags: { RigidBody: true, Collider: true }, C: Crate },
  floater: { type: 3, flags: { RigidBody: true }, C: Floater },
  wall: { type: 4, flags: { Collider: true }, C: Wall },
  walker: { type: 5, flags: { SpriteRenderer: true }, C: Walker },
  prop: { type: 6, flags: { SpriteRenderer: true }, C: Prop },
};
for (const k of Object.values(KINDS)) noteEntityType(k.type, k.C);

let ring = null;
let dirtyFlags = null;
let dirtySabs = null;

function bindWorld() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotation = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  RigidBody.sleeping = new Uint8Array(N);
  ring = createCommandRingSab(256);
  bindCommandRing(ring);
  bindStaticSceneryGen(new SharedArrayBuffer(4));
  bindStaticTypes(Object.values(KINDS).map((k) => ({ entityType: k.type, isStatic: k.C.isStatic === true })));
  dirtySabs = {
    bodyDirtyFlags: new SharedArrayBuffer(N * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(N / 32) * 4),
    bodyGeneration: new SharedArrayBuffer(N * 4),
  };
  bindBodySyncBuffers(dirtySabs);
  dirtyFlags = new Int32Array(dirtySabs.bodyDirtyFlags);
}

/** Every command in the ring, drained, entity `i` written as 'E'. */
function drain(i) {
  const out = [];
  const rec = (name) => (e, ...args) => out.push([name, e === i ? 'E' : e, ...args]);
  drainCommandRing(new Int32Array(ring), new Float32Array(ring), {
    setTransform: (e, x, y, c, s) => out.push(['setTransform', e === i ? 'E' : e, x, y, c, s]),
    setVelocity: rec('setVelocity'),
    setRotCS: rec('setRotCS'),
    setAngularVelocity: rec('setAngularVelocity'),
    setFixedRotation: rec('setFixedRotation'),
    setSleepThreshold: rec('setSleepThreshold'),
    setAwake: rec('setAwake'),
    applyImpulse: rec('applyImpulse'),
    applyAngularImpulse: rec('applyAngularImpulse'),
  });
  return out;
}

const TRANSFORM_COLUMNS = ['x', 'y', 'rotation', 'rotC', 'rotS', 'parent', 'localX', 'localY', 'localRotation'];
const BODY_COLUMNS = [...Object.keys(RigidBody.ARRAY_SCHEMA), 'vx', 'vy', 'angularVelocity', 'sleeping'];

/** Entity i's columns (a column unbound reads null) and dirty marks. */
function snapshot(i) {
  const out = {};
  for (const k of TRANSFORM_COLUMNS) out[`Transform.${k}`] = Transform[k] ? Transform[k][i] : null;
  for (const k of BODY_COLUMNS) out[`RigidBody.${k}`] = RigidBody[k] ? RigidBody[k][i] : null;
  out.dirty = dirtyFlags[i];
  return out;
}

/** The same starting state on entity i: the kind's type, a pose, a velocity, a circle collider. */
function place(i, kind) {
  Transform.entityType[i] = kind.type;
  Transform.active[i] = 1;
  Transform.x[i] = 4;
  Transform.y[i] = -2;
  if (Transform.rotation) Transform.rotation[i] = f(0.25);
  if (Transform.rotC) Transform.rotC[i] = f(Math.cos(0.25));
  if (Transform.rotS) Transform.rotS[i] = f(Math.sin(0.25));
  RigidBody.vx[i] = f(0.1);
  RigidBody.vy[i] = -3;
  RigidBody.angularVelocity[i] = 0.5;
  if (RigidBody.sleeping) RigidBody.sleeping[i] = 1;
  if (kind.flags.RigidBody) {
    RigidBody.active[i] = 1;
    RigidBody.mass[i] = 2;
    RigidBody.invMass[i] = 0.5;
  }
  if (kind.flags.Collider) {
    Collider.active[i] = 1;
    Collider.shapeType[i] = ShapeType.Circle;
    Collider.radius[i] = 3;
  }
}

/** Makes entity i a child of PARENT (transform.parent), as a link does, its parent elsewhere. */
function linkChild(i) {
  Transform.parent[i] = PARENT;
  Transform.localX[i] = 5;
  Transform.localY[i] = 1;
  Transform.localRotation[i] = 0.5;
  Transform.links[LINK_COUNT] = 1;
}

/** console.warn's lines while fn runs. */
function warningsOf(fn) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return said;
}

/**
 * One case: `prepare(i)` after place() on both twins; `old(entity)` on A through the entity's method, `now(index)` on B
 * through the static. `options.ring` false runs both with no ring bound; `options.columns` unbinds columns for both.
 */
function twin(name, kindName, prepare, old, now, options = {}) {
  bindWorld();
  const kind = KINDS[kindName];
  if (options.columns) for (const [cls, key] of options.columns) cls[key] = null;
  place(A, kind);
  place(B, kind);
  Transform.x[PARENT] = 100;
  Transform.y[PARENT] = 50;
  if (prepare) {
    prepare(A);
    prepare(B);
  }
  if (options.ring === false) bindCommandRing(null);

  const run = (fn, i) => {
    resetWarnOnce();
    const g0 = staticSceneryGen();
    const warned = warningsOf(fn);
    return { columns: snapshot(i), sent: ring && options.ring !== false ? drain(i) : [], scenery: staticSceneryGen() - g0, warned };
  };
  const e = entity(A, kind.flags);
  Object.defineProperty(e, 'rigidBody', { value: new RigidBody(A) });
  const before = run(() => old(e), A);
  const after = run(() => now(B), B);
  assert.deepEqual(after, before, `${name} (${kindName}): the static and the entity's method differ`);
  return before;
}

const ALL = Object.keys(KINDS);

test('Transform.setX and setY: what set x and set y write, send and count, every kind, child or not, ring or not', () => {
  for (const kind of ALL) {
    for (const v of [10.1, 4, f(0.3), 0.3]) {
      const sent = twin(`x = ${v}`, kind, null, (e) => (e.x = v), (i) => Transform.setX(i, v)).sent;
      if (v === 4) assert.equal(sent.length, 0, 'the same value: nothing');
      twin(`y = ${v}`, kind, null, (e) => (e.y = v), (i) => Transform.setY(i, v));
    }
    twin('x, child', kind, linkChild, (e) => (e.x = 9), (i) => Transform.setX(i, 9));
    twin('y, child', kind, linkChild, (e) => (e.y = 9), (i) => Transform.setY(i, 9));
    twin('x, no ring', kind, null, (e) => (e.x = 9), (i) => Transform.setX(i, 9), { ring: false });
    twin('x, no rotation columns', kind, null, (e) => (e.x = 9), (i) => Transform.setX(i, 9), {
      columns: [[Transform, 'rotC'], [Transform, 'rotS']],
    });
  }
  const crate = twin('x', 'crate', null, (e) => (e.x = 10.1), (i) => Transform.setX(i, 10.1));
  assert.deepEqual(crate.sent, [['setTransform', 'E', f(10.1), -2, f(f(Math.cos(0.25))), f(f(Math.sin(0.25)))]]);
  assert.equal(twin('x', 'prop', null, (e) => (e.x = 10.1), (i) => Transform.setX(i, 10.1)).scenery, 1);
  assert.equal(twin('x, child', 'walker', linkChild, (e) => (e.x = 9), (i) => Transform.setX(i, 9)).warned.length, 1);
});

test('Transform.setPosition: what setPosition writes and sends, every kind, child or not', () => {
  for (const kind of ALL) {
    for (const [x, y] of [[5.5, 6.6], [4, -2], [4, 0.3], [f(0.1), f(0.2)]]) {
      twin(`setPosition(${x}, ${y})`, kind, null, (e) => e.setPosition(x, y), (i) => Transform.setPosition(i, x, y));
    }
    twin('setPosition, child', kind, linkChild, (e) => e.setPosition(1, 2), (i) => Transform.setPosition(i, 1, 2));
    twin('setPosition, no ring', kind, null, (e) => e.setPosition(1, 2), (i) => Transform.setPosition(i, 1, 2), {
      ring: false,
    });
  }
  assert.equal(twin('setPosition', 'prop', null, (e) => e.setPosition(1, 2), (i) => Transform.setPosition(i, 1, 2)).scenery, 0);
});

test('Transform.setRotation: what set rotation writes and sends (cos and sin of the double given), every kind', () => {
  // 0.00137: its sin, as float32, differs from that of its float32.
  assert.notEqual(f(Math.sin(0.00137)), f(Math.sin(f(0.00137))));
  for (const kind of ALL) {
    for (const r of [1.25, 0.25, f(0.25), 0.00137, -3]) {
      twin(`rotation = ${r}`, kind, null, (e) => (e.rotation = r), (i) => Transform.setRotation(i, r));
    }
    twin('rotation, child', kind, linkChild, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1));
    twin('rotation, no ring', kind, null, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1), { ring: false });
    twin('rotation, no cos/sin columns', kind, null, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1), {
      columns: [[Transform, 'rotC'], [Transform, 'rotS']],
    });
    twin('rotation, no sin column', kind, null, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1), {
      columns: [[Transform, 'rotS']],
    });
    twin('rotation, no angle column', kind, null, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1), {
      columns: [[Transform, 'rotation']],
    });
  }
  assert.equal(twin('rotation', 'wall', null, (e) => (e.rotation = 1), (i) => Transform.setRotation(i, 1)).sent.length, 1);
});

test('Transform.setRotationCS: what setRotationCS writes and sends, RigidBody, Collider alone or neither', () => {
  const a = 2 * 0.0137;
  // Its atan2 from float32 cos and sin differs from the one from the doubles.
  assert.notEqual(f(Math.atan2(Math.sin(a), Math.cos(a))), f(Math.atan2(f(Math.sin(a)), f(Math.cos(a)))));
  for (const kind of ALL) {
    for (const [c, s] of [[0.6, 0.8], [Math.cos(a), Math.sin(a)], [1, 0]]) {
      twin(`setRotationCS(${c}, ${s})`, kind, null, (e) => e.setRotationCS(c, s), (i) => Transform.setRotationCS(i, c, s));
    }
    twin('setRotationCS, child', kind, linkChild, (e) => e.setRotationCS(0, 1), (i) => Transform.setRotationCS(i, 0, 1));
    twin('setRotationCS, no ring', kind, null, (e) => e.setRotationCS(0, 1), (i) => Transform.setRotationCS(i, 0, 1), {
      ring: false,
    });
    twin('setRotationCS, no columns', kind, null, (e) => e.setRotationCS(0, 1), (i) => Transform.setRotationCS(i, 0, 1), {
      columns: [[Transform, 'rotC'], [Transform, 'rotS'], [Transform, 'rotation']],
    });
  }
});

test('a pose written in the entity\'s own spawn on this worker sends its body nothing (SST-20), outside it a SET_TRANSFORM', () => {
  bindWorld();
  place(B, KINDS.crate);
  assert.equal(enterSpawnHere(B), true);
  try {
    Transform.setX(B, 8);
    Transform.setY(B, 9);
  } finally {
    leaveSpawnHere();
  }
  assert.deepEqual(drain(B), []);
  assert.equal(Transform.x[B], 8);
  Transform.setX(B, 10);
  assert.deepEqual(drain(B), [['setTransform', 'E', 10, 9, f(Math.cos(0.25)), f(Math.sin(0.25))]]);
});

test('Transform.setParent and transform.parent = v run the same link policy', () => {
  bindWorld();
  const calls = [];
  const policy = Transform._linkPolicy;
  Transform._linkPolicy = (i, v) => calls.push([i, v]);
  try {
    new Transform(A).parent = PARENT;
    Transform.setParent(B, PARENT);
    new Transform(A).parent = null;
    Transform.setParent(B, null);
  } finally {
    Transform._linkPolicy = policy;
  }
  assert.deepEqual(calls, [[A, PARENT], [B, PARENT], [A, null], [B, null]]);
});

test('RigidBody.setVx, setVy, setAngularVelocity and setVelocity: what the entity\'s setters write and send', () => {
  for (const kind of ALL) {
    for (const v of [3.3, f(0.1), 0.1, -3, 0.5]) {
      twin(`vx = ${v}`, kind, null, (e) => (e.vx = v), (i) => RigidBody.setVx(i, v));
      twin(`vy = ${v}`, kind, null, (e) => (e.vy = v), (i) => RigidBody.setVy(i, v));
      twin(`angularVelocity = ${v}`, kind, null, (e) => (e.angularVelocity = v), (i) => RigidBody.setAngularVelocity(i, v));
      twin(`setVelocity(${v}, 2)`, kind, null, (e) => e.setVelocity(v, 2), (i) => RigidBody.setVelocity(i, v, 2));
    }
    twin('setVelocity, the same', kind, null, (e) => e.setVelocity(0.1, -3), (i) => RigidBody.setVelocity(i, 0.1, -3));
    twin('vx, no ring', kind, null, (e) => (e.vx = 7), (i) => RigidBody.setVx(i, 7), { ring: false });
    twin('setVelocity, no ring', kind, null, (e) => e.setVelocity(7, 8), (i) => RigidBody.setVelocity(i, 7, 8), {
      ring: false,
    });
  }
  assert.equal(twin('vx', 'walker', null, (e) => (e.vx = 7), (i) => RigidBody.setVx(i, 7)).columns['RigidBody.vx'], f(0.1));
});

test('RigidBody.addVelocity and scaleVelocity: the sum and the product of the double given, as the entity\'s', () => {
  // Values whose float32 would round the result differently.
  const dv = 7 * 0.0137;
  const k = 0.9 + 4 * 0.00137;
  assert.notEqual(f(f(0.1) + dv), f(f(0.1) + f(dv)));
  assert.notEqual(f(3 * k), f(3 * f(k)));
  for (const kind of ALL) {
    twin('addVelocity', kind, null, (e) => e.addVelocity(dv, 1.5), (i) => RigidBody.addVelocity(i, dv, 1.5));
    twin('addVelocity 0', kind, null, (e) => e.addVelocity(0, 0), (i) => RigidBody.addVelocity(i, 0, 0));
    twin('addVelocity, no ring', kind, null, (e) => e.addVelocity(1, 1), (i) => RigidBody.addVelocity(i, 1, 1), {
      ring: false,
    });
    const set3 = (i) => (RigidBody.vx[i] = 3);
    twin('scaleVelocity', kind, set3, (e) => e.scaleVelocity(k), (i) => RigidBody.scaleVelocity(i, k));
    twin('scaleVelocity 1', kind, set3, (e) => e.scaleVelocity(1), (i) => RigidBody.scaleVelocity(i, 1));
  }
  const r = twin('addVelocity', 'crate', null, (e) => e.addVelocity(dv, 1.5), (i) => RigidBody.addVelocity(i, dv, 1.5));
  assert.equal(r.columns['RigidBody.vx'], f(f(0.1) + dv));
});

test('RigidBody.addAcceleration and accelerateTowards: what the entity\'s add, nothing within 1 px', () => {
  const ax = 7 * 0.0137;
  for (const kind of ALL) {
    const seed = (i) => (RigidBody.ax[i] = f(0.1));
    twin('addAcceleration', kind, seed, (e) => e.addAcceleration(ax, -2.5), (i) => RigidBody.addAcceleration(i, ax, -2.5));
    for (const [x, y, acc] of [[34, 38, 5], [4.5, -2.5, 5], [100.1, -7.3, 0.37], [4, -2, 9]]) {
      twin(`accelerateTowards(${x}, ${y}, ${acc})`, kind, seed, (e) => e.accelerateTowards(x, y, acc), (i) =>
        RigidBody.accelerateTowards(i, x, y, acc),
      );
    }
  }
  const r = twin('accelerateTowards', 'crate', null, (e) => e.accelerateTowards(34, 38, 5), (i) =>
    RigidBody.accelerateTowards(i, 34, 38, 5),
  );
  assert.deepEqual([r.columns['RigidBody.ax'], r.columns['RigidBody.ay']], [3, 4]);
});

test('RigidBody.setFixedRotation, setStatic and setAwake: what the entity\'s methods write, mark and send', () => {
  for (const kind of ALL) {
    for (const on of [true, false, 1, 0, 'yes']) {
      twin(`setFixedRotation(${on})`, kind, null, (e) => e.setFixedRotation(on), (i) => RigidBody.setFixedRotation(i, on));
      twin(`fixedRotation = ${on}`, kind, null, (e) => (e.fixedRotation = on), (i) => RigidBody.setFixedRotation(i, on));
      twin(`isStatic = ${on}`, kind, null, (e) => (e.isStatic = on), (i) => RigidBody.setStatic(i, on));
      twin(`setAwake(${on})`, kind, null, (e) => e.setAwake(on), (i) => RigidBody.setAwake(i, on));
    }
    twin('setAwake()', kind, null, (e) => e.setAwake(), (i) => RigidBody.setAwake(i));
    twin('setAwake, no sleeping column', kind, null, (e) => e.setAwake(false), (i) => RigidBody.setAwake(i, false), {
      columns: [[RigidBody, 'sleeping']],
    });
    twin('setFixedRotation, no ring', kind, null, (e) => e.setFixedRotation(1), (i) => RigidBody.setFixedRotation(i, 1), {
      ring: false,
    });
  }
  const r = twin('isStatic', 'crate', null, (e) => (e.isStatic = true), (i) => RigidBody.setStatic(i, true));
  assert.equal(r.columns['RigidBody.static'], 1);
  assert.equal(r.columns['RigidBody.invMass'], 0);
  assert.equal(r.columns.dirty, BODY_DIRTY.BODY_TYPE);
});

test('the RigidBody facade\'s setters run its statics: active, static, damping, sleep threshold, mass', () => {
  bindWorld();
  place(A, KINDS.crate);
  place(B, KINDS.crate);
  const body = new RigidBody(A);
  const clean = () => {
    dirtyFlags.fill(0);
    new Int32Array(dirtySabs.bodyDirtyWords).fill(0);
  };

  body.active = 1;
  assert.equal(dirtyFlags[A], 0, 'already on: nothing');
  body.active = 0;
  RigidBody.setActive(B, false);
  assert.deepEqual([RigidBody.active[A], RigidBody.active[B]], [0, 0]);
  const lifecycle = BODY_DIRTY.LIFECYCLE | BODY_DIRTY.BODY_TYPE | BODY_DIRTY.MASS;
  assert.deepEqual([dirtyFlags[A], dirtyFlags[B]], [lifecycle, lifecycle]);
  body.active = true;
  RigidBody.setActive(B, 1);
  clean();

  body.static = true;
  assert.equal(RigidBody.static[A], 1);
  assert.equal(RigidBody.invMass[A], 0);
  assert.equal(RigidBody.mass[A], f(Math.PI * 9), 'a static circle\'s mass from its area');
  assert.equal(dirtyFlags[A], BODY_DIRTY.BODY_TYPE);
  body.static = 0;
  assert.equal(RigidBody.static[A], 0);
  assert.ok(RigidBody.invMass[A] > 0);
  clean();

  for (const [value, want] of [[-3, 0], ['2', 2], [undefined, 0], [0.3, f(0.3)]]) {
    body.linearDamping = value;
    RigidBody.setAngularDamping(B, value);
    assert.equal(RigidBody.linearDamping[A], want);
    assert.equal(RigidBody.angularDamping[B], want);
    assert.equal(dirtyFlags[A], BODY_DIRTY.DAMPING);
    assert.equal(dirtyFlags[B], BODY_DIRTY.DAMPING);
    body.angularDamping = value;
    assert.equal(RigidBody.angularDamping[A], want);
    clean();
  }

  body.sleepThreshold = 4;
  RigidBody.setSleepThreshold(B, -1);
  assert.equal(RigidBody.sleepThreshold[A], 4);
  assert.equal(RigidBody.sleepThreshold[B], 0);
  assert.deepEqual(drain(A), [['setSleepThreshold', 'E', 4], ['setSleepThreshold', B, 0]]);

  // The inverse of the double given (its float32's differs).
  const m = 1 + 3 * 0.0137;
  assert.notEqual(f(1 / m), f(1 / f(m)));
  body.mass = m;
  RigidBody.setMass(B, m);
  for (const i of [A, B]) {
    assert.equal(RigidBody.mass[i], f(m));
    assert.equal(RigidBody.invMass[i], f(1 / m));
    assert.equal(RigidBody.inertia[i], f(0.5 * f(m) * 3 * 3));
    assert.equal(dirtyFlags[i], BODY_DIRTY.MASS);
  }
  // N-132: the spawn's sync from the collider keeps a mass set by hand.
  RigidBody.syncMassFromCollider(B, true);
  assert.equal(RigidBody.mass[B], f(m));
  RigidBody.setMass(B, -5);
  assert.deepEqual([RigidBody.mass[B], RigidBody.invMass[B]], [0, 0]);
});

test('the facades\' column writes stay column writes: rigidBody.vx and fixedRotation, transform.x and rotation send nothing', () => {
  bindWorld();
  place(A, KINDS.crate);
  const body = new RigidBody(A);
  body.vx = 9;
  body.fixedRotation = 1;
  const pose = new Transform(A);
  const g0 = staticSceneryGen();
  pose.x = 12;
  pose.rotation = 1;
  assert.equal(RigidBody.vx[A], 9);
  assert.equal(RigidBody.fixedRotation[A], 1);
  assert.equal(Transform.x[A], 12);
  assert.equal(Transform.rotC[A], f(Math.cos(1)));
  assert.deepEqual(drain(A), []);
  assert.equal(staticSceneryGen(), g0);
});
