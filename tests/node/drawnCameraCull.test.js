import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Camera } from '../../src/core/camera.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// N-11. Pre-render draws the followEntity camera snapped to the latched pose
// (alignFollowCameraToLatchedPose). The Camera SAB x/y eases toward it and
// trails by v(1-s)/s, 90 world px at 10 px/frame and smoothing 0.1. The
// particle worker culled particles, decorations and bullets against the eased
// x/y, so a fast follow culled the leading edge while it was on screen.

const W = 1920;
const H = 1080;
const N = 4;

function setupCamera() {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = 1;
  data[5] = 1;
  return data;
}

function makePose() {
  const bytes = N * 16;
  return { sync: new SharedArrayBuffer(8), dataA: new SharedArrayBuffer(bytes), dataB: new SharedArrayBuffer(bytes), capacity: N };
}

function poseViews(pose, ready) {
  const sab = ((ready - 1) & 1) === 0 ? pose.dataA : pose.dataB;
  return { x: new Float32Array(sab, 0, N), y: new Float32Array(sab, N * 4, N) };
}

/** Logic side: publish a pose generation, then followEntity on it, like a frame. */
function followFrames(pose, frames, startX, stepX, y) {
  const sync = new Int32Array(pose.sync);
  RigidBody.active = new Uint8Array(N);
  RigidBody.active[0] = 1;
  let x = startX;
  for (let f = 1; f <= frames; f++) {
    x += stepX;
    const v = poseViews(pose, f);
    v.x[0] = x;
    v.y[0] = y;
    Atomics.store(sync, 0, f);
    Camera.bindDisplayPose(v.x, v.y, null, null, f);
    Camera.followEntity(0, 0, 0.1, 1);
  }
  return { x, ready: frames, views: poseViews(pose, frames) };
}

test('the particle worker culls against the camera pre-render draws, not the eased SAB', async () => {
  const data = setupCamera();
  data[1] = 1000 - W / 2;
  data[2] = 500 - H / 2;
  const pose = makePose();
  const last = followFrames(pose, 60, 1000, 10, 500);

  const drawnX = last.x - W / 2;
  const easedX = data[1];
  assert.ok(drawnX - easedX > 80, `the ease trails by ~90 px (${drawnX - easedX})`);

  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.cameraData = data;
  pre._poseX = last.views.x;
  pre._poseY = last.views.y;
  pre.renderQueueCamera = new Float32Array(4);
  pre.latchCamera(0);
  assert.equal(pre._frameCameraX, drawnX, 'pre-render draws the snapped camera');
  assert.equal(pre.renderQueueCamera[1], drawnX);

  const par = await loadWorker('particleWorker.js', 'particleWorker');
  par.cameraData = data;
  par.canvasWidth = W;
  par.canvasHeight = H;
  par.cullingRatio = 0.1;
  par._bindPosePublish(pose);
  par._frameCamValid = false;
  const bounds = par._frameCameraBounds();
  assert.equal(bounds.cameraOffsetX, drawnX, 'particle cull uses the drawn camera');
  assert.equal(bounds.cameraOffsetY, 500 - H / 2);

  // A bullet 50 px inside the drawn right edge must be on screen.
  const bulletX = drawnX + W - 50;
  const sx = bulletX * bounds.zoom - bounds.cameraOffsetX;
  assert.ok(sx < bounds.maxX, `bullet at screen x ${sx} is culled`);
});

test('the cull camera is computed once per frame', async () => {
  const data = setupCamera();
  const pose = makePose();
  const par = await loadWorker('particleWorker.js', 'particleWorker');
  par.cameraData = data;
  par.canvasWidth = W;
  par.canvasHeight = H;
  par.cullingRatio = 0.1;
  par._bindPosePublish(pose);
  data[1] = 100;
  par._frameCamValid = false;
  const a = par._frameCameraBounds().cameraOffsetX;
  data[1] = 200; // a logic write mid-frame does not split particles from bullets
  assert.equal(par._frameCameraBounds().cameraOffsetX, a);
  par._frameCamValid = false; // next update()
  assert.equal(par._frameCameraBounds().cameraOffsetX, 200);
});

test('resolveDrawnCamera clamps an unrotated view to the world and leaves a rotated one', () => {
  const data = setupCamera();
  Camera.setWorldBounds(4000, 3000);
  data[0] = 2;
  data[1] = 3500; // past maxX = 4000 - 1920 / 2
  data[2] = -40;
  data[9] = 0;
  const out = { zoom: 0, x: 0, y: 0, rotation: 0 };
  Camera.resolveDrawnCamera(null, null, out);
  assert.deepEqual(out, { zoom: 2, x: 4000 - W / 2, y: 0, rotation: 0 });

  data[1] = 3500;
  data[2] = -40;
  data[9] = 0.25;
  Camera.resolveDrawnCamera(null, null, out);
  assert.equal(out.x, 3500);
  assert.equal(out.y, -40);
  assert.ok(Math.abs(out.rotation - 0.25) < 1e-7);
});

test('with Camera.follow (no entity stamp) the drawn camera is the SAB camera', () => {
  const data = setupCamera();
  data[1] = 10;
  data[2] = 20;
  Camera.follow(5000, 5000, 0.1, 1);
  const out = { zoom: 0, x: 0, y: 0, rotation: 0 };
  Camera.resolveDrawnCamera(new Float32Array(N), new Float32Array(N), out);
  assert.equal(out.x, data[1]);
  assert.equal(out.y, data[2]);
});
