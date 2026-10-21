import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import {
  BOX2D_CMD,
  bindCommandRing,
  createCommandRingSab,
  drainCommandRing,
} from '../../src/box2d/box2dCommandRing.js';
import { bindPoseColumns } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';

// DX 2: applyForce / applyTorque hold until the body's next tick, through the
// ax / ay / angularAccel columns the physics worker already turns into a force
// (× mass) and a torque (× inertia). applyImpulse / applyAngularImpulse are
// commands that run Box2D's own impulse once, so several add up.

const N = 4;
function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  bindPoseColumns(N);
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    RigidBody.active[i] = 1;
    Collider.active[i] = 1;
    Collider.shapeType[i] = ShapeType.Box;
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    RigidBody.mass[i] = 4;
    RigidBody.invMass[i] = 0.25;
    RigidBody.inertia[i] = 10;
    RigidBody.invInertia[i] = 0.1;
  }
}

test('applyForce at the centre adds force / mass to ax, ay', () => {
  setup();
  RigidBody.applyForce(1, 8, -4);
  RigidBody.applyForce(1, 4, 0);
  assert.equal(RigidBody.ax[1], 3);
  assert.equal(RigidBody.ay[1], -1);
  assert.equal(RigidBody.angularAccel[1], 0);
});

test('applyForce at a point also turns the body about its centre of mass', () => {
  setup();
  Transform.x[2] = 100;
  Transform.y[2] = 50;
  // 10 px right of the centre, pushing down (+y): torque = 10 × 6 = 60
  RigidBody.applyForce(2, 0, 6, 110, 50);
  assert.equal(RigidBody.ay[2], 1.5);
  assert.equal(RigidBody.angularAccel[2], 6, 'torque × invInertia');
});

test('a polygon turns about its centroid, rotated with the body', () => {
  setup();
  Collider.shapeType[3] = ShapeType.Polygon;
  Collider.polyCount[3] = 3;
  Collider.polyCentroidX[3] = 4; // local centroid (4, 0)
  Collider.polyCentroidY[3] = 0;
  Transform.x[3] = 0;
  Transform.y[3] = 0;
  Transform.rotC[3] = 0; // turned 90°: the centroid sits at world (0, 4)
  Transform.rotS[3] = 1;
  RigidBody.applyForce(3, 2, 0, 0, 0); // at the body origin, 4 px above the centroid
  // r = (0, 0) - (0, 4) = (0, -4); torque = rx·fy − ry·fx = 0 − (−4)(2) = 8
  assert.ok(Math.abs(RigidBody.angularAccel[3] - 0.8) < 1e-6, `${RigidBody.angularAccel[3]}`);
});

test('an offset collider turns about its shifted centre', () => {
  setup();
  Collider.offsetX[0] = -5; // box shifted 5 px left of the body origin
  Transform.x[0] = 0;
  Transform.y[0] = 0;
  RigidBody.applyForce(0, 0, 2, 0, 0); // at the origin, 5 px right of the box centre
  // r = (0, 0) - (-5, 0) = (5, 0); torque = 5 × 2 = 10
  assert.ok(Math.abs(RigidBody.angularAccel[0] - 1) < 1e-6, `${RigidBody.angularAccel[0]}`);
});

test('applyTorque adds torque × invInertia; static and unpowered bodies stay put', () => {
  setup();
  RigidBody.applyTorque(0, 30);
  assert.equal(RigidBody.angularAccel[0], 3);
  RigidBody.invMass[1] = 0; // static: infinite mass
  RigidBody.invInertia[1] = 0;
  RigidBody.applyForce(1, 100, 100, 50, 50);
  RigidBody.applyTorque(1, 100);
  assert.deepEqual([RigidBody.ax[1], RigidBody.ay[1], RigidBody.angularAccel[1]], [0, 0, 0]);
});

test('the physics force pass turns those columns back into the force and torque asked for', () => {
  setup();
  RigidBody.applyForce(1, 12, -8, 30, 0); // at (30, 0): torque = 30 × -8 = -240
  const weedjsPost = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
  const massStart = weedjsPost.indexOf('// angular-mass-start');
  const massEnd = weedjsPost.indexOf('// angular-mass-end');
  const start = weedjsPost.indexOf('function applyForcesAndTorque()');
  const end = weedjsPost.indexOf('function entityGen(', start);
  const pass = new Function(
    'denseList', 'views', 'bodyApplyForceCenterFn', 'bodyApplyTorqueFn',
    `let denseCount = denseList.length;
    function isFixedRotation() { return false; }
    ${weedjsPost.slice(massStart, massEnd)}
    ${weedjsPost.slice(start, end)}
    return applyForcesAndTorque;`,
  );
  const forces = [];
  const torques = [];
  pass(
    [1],
    {
      rbStatic: new Uint8Array(N),
      mass: RigidBody.mass,
      inertia: RigidBody.inertia,
      ax: RigidBody.ax,
      ay: RigidBody.ay,
      angularAccel: RigidBody.angularAccel,
    },
    (i, fx, fy) => forces.push([i, fx, fy]),
    (i, t) => torques.push([i, t]),
  )();
  assert.deepEqual(forces, [[1, 12, -8]]);
  assert.equal(torques.length, 1);
  assert.ok(Math.abs(torques[0][1] - -240) < 1e-3, `torque ${torques[0][1]}`);
});

test('impulses are commands: point or centre, linear or angular, in order', () => {
  setup();
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  try {
    RigidBody.applyImpulse(2, 5, -6);
    RigidBody.applyImpulse(2, 1, 2, 30, 40);
    RigidBody.applyAngularImpulse(2, 7);
    assert.equal(RigidBody.vx[2], 0, 'no local echo: the step after applies it once');
    const calls = [];
    drainCommandRing(new Int32Array(sab), new Float32Array(sab), {
      applyImpulse: (e, ix, iy, px, py) => calls.push(['impulse', e, ix, iy, px, py]),
      applyAngularImpulse: (e, imp) => calls.push(['angular', e, imp]),
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(0, 4), ['impulse', 2, 5, -6]);
    assert.ok(Number.isNaN(calls[0][4]) && Number.isNaN(calls[0][5]), 'no point: centre');
    assert.deepEqual(calls[1], ['impulse', 2, 1, 2, 30, 40]);
    assert.deepEqual(calls[2], ['angular', 2, 7]);
    assert.ok(BOX2D_CMD.APPLY_IMPULSE > 0 && BOX2D_CMD.APPLY_ANGULAR_IMPULSE > 0);
  } finally {
    bindCommandRing(null);
  }
});

test('the physics host runs Box2D impulses: centre without a point, at the point with one', () => {
  const src = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
  const s = src.indexOf('// body-impulse-start');
  const e = src.indexOf('// body-impulse-end');
  assert.ok(s > 0 && e > s, 'impulse handlers not found in weedjsPost.js');
  const calls = [];
  const make = new Function(
    'hasBody', 'isFixedRotation', 'bodyApplyLinearImpulseFn', 'bodyApplyLinearImpulseCenterFn', 'bodyApplyAngularImpulseFn',
    `${src.slice(s, e)}\nreturn { applyImpulseToBody, applyAngularImpulseToBody };`,
  );
  const h = make(
    Uint8Array.of(0, 1, 1),
    (i) => i === 2,
    (...a) => calls.push(['point', ...a]),
    (...a) => calls.push(['centre', ...a]),
    (...a) => calls.push(['angular', ...a]),
  );
  h.applyImpulseToBody(1, 3, 4, NaN, NaN);
  h.applyImpulseToBody(1, 3, 4, 10, 20);
  h.applyImpulseToBody(0, 9, 9, NaN, NaN); // no body yet: nothing
  h.applyAngularImpulseToBody(1, 5);
  h.applyAngularImpulseToBody(2, 5); // fixed rotation: nothing
  assert.deepEqual(calls, [
    ['centre', 1, 3, 4, 1],
    ['point', 1, 3, 4, 10, 20, 1],
    ['angular', 1, 5, 1],
  ]);
});

test('GameObject forwards the four calls and chains; a body without RigidBody ignores them', () => {
  setup();
  const go = Object.create(GameObject.prototype);
  go.index = 1;
  go._hasComponents = { RigidBody: true };
  assert.equal(go.applyForce(8, 0).applyTorque(10), go);
  assert.equal(RigidBody.ax[1], 2);
  assert.equal(RigidBody.angularAccel[1], 1);
  const ghost = Object.create(GameObject.prototype);
  ghost.index = 2;
  ghost._hasComponents = {};
  ghost.applyForce(8, 0).applyImpulse(1, 1).applyAngularImpulse(1).applyTorque(1);
  assert.equal(RigidBody.ax[2], 0);
  assert.equal(RigidBody.angularAccel[2], 0);
});
