import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';

// followEntity holds the camera while the physics publish frame is unchanged, so
// a body's camera does not ease ahead of its sprite. An entity without a body is
// moved by logic through Transform every tick: holding it on the publish frame
// froze the camera for good in a world where nothing awake ever publishes (a
// networked client whose cars are bodiless puppets, a scene of sleeping bodies).

const W = 1280;
const H = 720;
const N = 4;
const BODY = 0;
const BODYLESS = 1;

function boot() {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = 1;
  data[5] = 1;
  RigidBody.active = new Uint8Array(N);
  RigidBody.active[BODY] = 1;
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  // One publish, never repeated: the world went quiet.
  const poseX = new Float32Array(N);
  const poseY = new Float32Array(N);
  Camera.bindDisplayPose(poseX, poseY, null, null, 7);
  return { poseX, poseY };
}

function centerX() {
  return Camera.x + W / (2 * (Camera.zoom || 1));
}

test('a bodiless entity is followed while the physics publish frame stays the same', () => {
  boot();
  Camera.centerOn(0, 0);
  const start = centerX();
  for (let k = 1; k <= 40; k++) {
    Transform.x[BODYLESS] = 2000 + k * 10;
    Transform.y[BODYLESS] = 300;
    Camera.followEntity(BODYLESS, 0, 0.5, 1);
  }
  const end = centerX();
  assert.ok(end - start > 1500, `camera moved toward the entity: ${start} → ${end}`);
});

test('the drawn camera of a followed bodiless entity is the SAB camera, not its empty pose slot', () => {
  const { poseX, poseY } = boot(); // pose slots stay 0: bodies only are published
  Camera.centerOn(0, 0);
  for (let k = 1; k <= 60; k++) {
    Transform.x[BODYLESS] = 5000;
    Transform.y[BODYLESS] = 3000;
    Camera.followEntity(BODYLESS, 0, 0.5, 1);
  }
  const drawn = Camera.resolveDrawnCamera(poseX, poseY, { zoom: 0, x: 0, y: 0, rotation: 0 });
  const cx = drawn.x + W / (2 * drawn.zoom);
  const cy = drawn.y + H / (2 * drawn.zoom);
  assert.ok(Math.abs(cx - 5000) < 5 && Math.abs(cy - 3000) < 5, `drawn centre ${cx}, ${cy}`);
});

test('the drawn camera of a followed body still snaps to its published pose', () => {
  const { poseX, poseY } = boot();
  Camera.centerOn(0, 0);
  poseX[BODY] = 4000;
  poseY[BODY] = 1000;
  Camera.followEntity(BODY, 0, 0.1, 1); // the SAB camera eases a little toward it
  const drawn = Camera.resolveDrawnCamera(poseX, poseY, { zoom: 0, x: 0, y: 0, rotation: 0 });
  const cx = drawn.x + W / (2 * drawn.zoom);
  assert.ok(Math.abs(cx - 4000) < 1, `snapped to the pose, not the eased SAB value: ${cx}`);
});

test('a body still holds on an unchanged publish (its sprite has not moved)', () => {
  const { poseX } = boot();
  Camera.centerOn(0, 0);
  poseX[BODY] = 2000;
  Camera.followEntity(BODY, 0, 0.5, 1); // first call on this publish: eases
  const afterFirst = centerX();
  for (let k = 0; k < 10; k++) Camera.followEntity(BODY, 0, 0.5, 1);
  assert.equal(centerX(), afterFirst, 'same publish frame: no further easing');
});
