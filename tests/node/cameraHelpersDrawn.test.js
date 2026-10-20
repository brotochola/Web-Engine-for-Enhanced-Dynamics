import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// N-13. isOnScreen / worldToScreen / screenToWorld / getViewportBounds answer
// "on the screen the player sees". With followEntity that screen is drawn
// with the camera snapped to the pose (resolveDrawnCamera), while the SAB x/y
// eases behind it: 90 world px at 10 px/frame and smoothing 0.1. The helpers
// used the eased x/y, so CameraInOutListener fired late at the leading edge.

const W = 1280;
const H = 720;
const N = 4;

function boot() {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = 1;
  data[5] = 1;
  data[1] = 1000 - W / 2;
  data[2] = 500 - H / 2;
  RigidBody.active = new Uint8Array(N);
  RigidBody.active[0] = 1;
  return data;
}

/** Logic frames: publish pose generation f, then followEntity, moving 10 px/frame. */
function follow(frames) {
  let x = 1000;
  for (let f = 1; f <= frames; f++) {
    x += 10;
    const poseX = new Float32Array(N);
    const poseY = new Float32Array(N);
    poseX[0] = x;
    poseY[0] = 500;
    Camera.bindDisplayPose(poseX, poseY, null, null, f);
    Camera.followEntity(0, 0, 0.1, 1);
  }
  return x;
}

test('the helpers answer for the drawn camera while following an entity', () => {
  const data = boot();
  const x = follow(60);
  const drawnLeft = x - W / 2;
  assert.ok(drawnLeft - data[1] > 80, `the SAB trails by ~90 px (${drawnLeft - data[1]})`);

  assert.equal(Camera.isOnScreen(drawnLeft + W - 20, 500), true, 'leading edge is on screen');
  assert.equal(Camera.isOnScreen(drawnLeft - 20, 500), false, 'trailing edge has left');

  const s = Camera.worldToScreen(x, 500, { x: 0, y: 0 });
  assert.ok(Math.abs(s.x - W / 2) < 1e-3 && Math.abs(s.y - H / 2) < 1e-3, `entity at ${s.x}, ${s.y}`);

  const w = Camera.screenToWorld(W / 2, H / 2, { x: 0, y: 0 });
  assert.ok(Math.abs(w.x - x) < 1e-3 && Math.abs(w.y - 500) < 1e-3, `center at ${w.x}, ${w.y}`);

  const v = Camera.getViewportBounds({});
  assert.ok(Math.abs(v.left - drawnLeft) < 1e-3, `left ${v.left}`);
});

test('a camera write is seen at once, in the same frame', () => {
  boot();
  follow(10);
  Camera.setPosition(5000, 5000); // clears the follow stamp
  assert.equal(Camera.isOnScreen(5000 + 10, 5000 + 10), true);
  assert.equal(Camera.getViewportBounds({}).left, 5000);
  Camera.zoom = 2;
  assert.equal(Camera.getViewportBounds({}).width, W / 2);
  Camera.setAngle(Math.PI / 2);
  assert.ok(Math.abs(Camera.getViewportBounds({}).width - H / 2) < 1e-3, 'the angle is seen too');
});

test('a new pose generation moves the followed view before the next follow call', () => {
  boot();
  const x = follow(20);
  const poseX = new Float32Array(N);
  const poseY = new Float32Array(N);
  poseX[0] = x + 10;
  poseY[0] = 500;
  Camera.bindDisplayPose(poseX, poseY, null, null, 21);
  const s = Camera.worldToScreen(x + 10, 500, { x: 0, y: 0 });
  assert.ok(Math.abs(s.x - W / 2) < 1e-3, `entity drawn at the center (${s.x})`);
});
