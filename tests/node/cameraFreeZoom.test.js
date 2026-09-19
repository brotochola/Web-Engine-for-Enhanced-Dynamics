import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';
import { RigidBody } from '../../src/components/rigidBody.js';

function setupCamera({ zoom = 1, cx = 400, cy = 300, canvasW = 800, canvasH = 600 } = {}) {
  const data = new Float32Array(Camera.FLOAT_COUNT);
  data[0] = zoom;
  data[1] = cx - canvasW / (2 * zoom);
  data[2] = cy - canvasH / (2 * zoom);
  data[3] = cx;
  data[4] = cy;
  data[5] = zoom;
  Camera.initialize(data, canvasW, canvasH);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  return data;
}

test('follow lerps zoom toward targetZoom (does not snap)', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300 });
  Camera.targetZoom = 2;

  Camera.follow(400, 300, 0.15, 1);

  assert.notEqual(Camera.zoom, 1);
  assert.notEqual(Camera.zoom, Camera.targetZoom);
  assert.ok(Camera.zoom > 1 && Camera.zoom < 2);
});

test('follow keeps screen-center world point stable across a zoom lerp step', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300 });
  const beforeX = Camera.centerX;
  const beforeY = Camera.centerY;

  Camera.targetZoom = 2;
  Camera.follow(400, 300, 0.15, 1);

  assert.ok(Math.abs(Camera.centerX - beforeX) < 1e-4);
  assert.ok(Math.abs(Camera.centerY - beforeY) < 1e-4);
});

test('updateFree wheel writes targetZoom and lets follow lerp (no setZoom snap)', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300 });
  Mouse.initialize(new Float32Array(13));
  Mouse.wheel = 100; // one typical notch worth of deltaY

  Camera.setFree(true, { zoomSensitivity: 0.001, smoothing: 0.15 });
  Camera.setFreeTarget(400, 300);

  const zoomBefore = Camera.zoom;
  Camera.updateFree(1);

  assert.notEqual(Camera.targetZoom, zoomBefore);
  assert.notEqual(Camera.zoom, Camera.targetZoom);
  assert.ok(Math.abs(Camera.zoom - zoomBefore) > 1e-6);
  assert.ok(Math.abs(Camera.zoom - Camera.targetZoom) > 1e-6);

  Camera.setFree(false);
  Mouse.wheel = 0;
});

test('updateFree one notch zoom-in stays ~1.1x (not near maxZoom)', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300 });
  Mouse.initialize(new Float32Array(13));
  Mouse.wheel = -100;

  Camera.setFree(true, { zoomSensitivity: 0.001, smoothing: 0.15 });
  Camera.setFreeTarget(400, 300);
  Camera.updateFree(1);

  // exp(0.1) ≈ 1.105; must not race toward maxZoom (50)
  assert.ok(Camera.targetZoom > 1.05 && Camera.targetZoom < 1.2);
  assert.ok(Camera.targetZoom < Camera.maxZoom * 0.5);

  Camera.setFree(false);
  Mouse.wheel = 0;
});

test('updateFree equal in then out restores targetZoom (log-symmetric)', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300 });
  Mouse.initialize(new Float32Array(13));

  Camera.setFree(true, { zoomSensitivity: 0.001, smoothing: 0.15 });
  Camera.setFreeTarget(400, 300);
  const start = Camera.targetZoom;

  Mouse.wheel = -100;
  Camera.updateFree(1);
  Mouse.wheel = 100;
  Camera.updateFree(1);

  assert.ok(Math.abs(Camera.targetZoom - start) < 1e-5);

  Camera.setFree(false);
  Mouse.wheel = 0;
});

function stubPoseBody({ x = 10, y = 20, vx = 100, vy = 0 } = {}) {
  const prevActive = RigidBody.active;
  const prevVx = RigidBody.vx;
  const prevVy = RigidBody.vy;
  RigidBody.active = new Uint8Array([1]);
  RigidBody.vx = new Float32Array([vx]);
  RigidBody.vy = new Float32Array([vy]);
  const poseX = new Float32Array([x]);
  const poseY = new Float32Array([y]);
  Camera.bindDisplayPose(poseX, poseY, new Float32Array([1]), new Float32Array([0]));
  return {
    poseX,
    poseY,
    restore() {
      Camera.bindDisplayPose(null, null, null, null);
      RigidBody.active = prevActive;
      RigidBody.vx = prevVx;
      RigidBody.vy = prevVy;
    },
  };
}

test('followEntity look-ahead ignores live vx until pose xy publishes', () => {
  setupCamera({ zoom: 1, cx: 10, cy: 20 });
  const stub = stubPoseBody({ x: 10, y: 20, vx: 100, vy: 0 });
  const look = 0.33;

  Camera.followEntity(0, look, 1, 1);
  const first = Camera.getFollowTarget();
  assert.ok(first);
  assert.equal(first.x, 10 + 100 * look);
  assert.equal(first.y, 20);

  RigidBody.vx[0] = 999;
  Camera.followEntity(0, look, 1, 1);
  const frozen = Camera.getFollowTarget();
  assert.equal(frozen.x, first.x);
  assert.equal(frozen.y, first.y);

  stub.poseX[0] = 12;
  RigidBody.vx[0] = 200;
  Camera.followEntity(0, look, 1, 1);
  const emaVx = 100 + (200 - 100) * Camera._LOOK_HOLD_EMA;
  const moved = Camera.getFollowTarget();
  assert.ok(Math.abs(moved.x - (12 + emaVx * look)) < 1e-6);
  assert.equal(moved.y, 20);

  stub.restore();
});

test('alignFollowCameraToLatchedPose snaps queue cam to packed pose, not eased SAB + delta', () => {
  const data = setupCamera({ zoom: 1, cx: 10, cy: 20, canvasW: 800, canvasH: 600 });
  const stub = stubPoseBody({ x: 10, y: 20, vx: 0, vy: 0 });
  const halfW = 400;
  const halfH = 300;

  Camera.followEntity(0, 0, 1, 1);
  const camX = Camera.x;
  const camY = Camera.y;
  assert.equal(data[Camera.IDX_FOLLOW_ENTITY], 1);
  assert.equal(data[Camera.IDX_FOLLOW_USED_X], 10);
  assert.equal(data[Camera.IDX_FOLLOW_USED_Y], 20);

  stub.poseX[0] = 40;
  stub.poseY[0] = 25;
  const aligned = Camera.alignFollowCameraToLatchedPose(camX, camY, stub.poseX, stub.poseY);
  assert.equal(aligned.x, 40 - halfW);
  assert.equal(aligned.y, 25 - halfH);

  const same = Camera.alignFollowCameraToLatchedPose(camX, camY, new Float32Array([10]), new Float32Array([20]));
  assert.equal(same.x, 10 - halfW);
  assert.equal(same.y, 20 - halfH);

  Camera.follow(10, 20, 1, 1);
  assert.equal(data[Camera.IDX_FOLLOW_ENTITY], 0);
  const raw = Camera.alignFollowCameraToLatchedPose(camX, camY, stub.poseX, stub.poseY);
  assert.equal(raw.x, camX);
  assert.equal(raw.y, camY);

  stub.restore();
});

test('alignFollowCameraToLatchedPose ignores ease lag on SAB cam', () => {
  setupCamera({ zoom: 1, cx: 400, cy: 300, canvasW: 800, canvasH: 600 });
  const stub = stubPoseBody({ x: 800, y: 300, vx: 0, vy: 0 });
  Camera.bindDisplayPose(stub.poseX, stub.poseY, new Float32Array([1]), new Float32Array([0]), 1);

  Camera.followEntity(0, 0, 0.1, 1);
  const easedX = Camera.x;
  const easedY = Camera.y;
  const targetCamX = 800 - 400;
  assert.ok(Math.abs(easedX - targetCamX) > 1e-3, 'SAB still easing');

  stub.poseX[0] = 830;
  stub.poseY[0] = 310;
  const aligned = Camera.alignFollowCameraToLatchedPose(easedX, easedY, stub.poseX, stub.poseY);
  assert.ok(Math.abs(aligned.x - (830 - 400)) < 1e-6);
  assert.ok(Math.abs(aligned.y - (310 - 300)) < 1e-6);
  assert.ok(Math.abs(aligned.x - (easedX + 30)) > 1e-3, 'must not be eased + pose delta');

  stub.restore();
});

test('alignFollowCameraToLatchedPose keeps look-ahead lead on packed pose', () => {
  setupCamera({ zoom: 1, cx: 10, cy: 20, canvasW: 800, canvasH: 600 });
  const stub = stubPoseBody({ x: 10, y: 20, vx: 100, vy: 50 });
  const look = 0.33;
  Camera.followEntity(0, look, 1, 1);
  stub.poseX[0] = 40;
  stub.poseY[0] = 25;
  const aligned = Camera.alignFollowCameraToLatchedPose(Camera.x, Camera.y, stub.poseX, stub.poseY);
  assert.ok(Math.abs(aligned.x - (40 + 100 * look - 400)) < 1e-6);
  assert.ok(Math.abs(aligned.y - (25 + 50 * look - 300)) < 1e-6);
  stub.restore();
});

test('followEntity holds pan when pose generation is unchanged', () => {
  const data = setupCamera({ zoom: 1, cx: 400, cy: 300, canvasW: 800, canvasH: 600 });
  const stub = stubPoseBody({ x: 800, y: 300, vx: 0, vy: 0 });
  Camera.bindDisplayPose(stub.poseX, stub.poseY, new Float32Array([1]), new Float32Array([0]), 1);

  Camera.followEntity(0, 0, 0.1, 1);
  const xAfterFirst = data[1];
  const yAfterFirst = data[2];
  const targetCamX = 800 - 400;
  assert.ok(Math.abs(xAfterFirst - targetCamX) > 1e-3, 'first follow only eases part way');

  Camera.followEntity(0, 0, 0.1, 1);
  assert.equal(data[1], xAfterFirst);
  assert.equal(data[2], yAfterFirst);

  Camera.bindDisplayPose(stub.poseX, stub.poseY, new Float32Array([1]), new Float32Array([0]), 2);
  Camera.followEntity(0, 0, 0.1, 1);
  assert.notEqual(data[1], xAfterFirst);

  stub.restore();
});
