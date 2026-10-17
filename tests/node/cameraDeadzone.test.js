import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera, deadzoneCenter } from '../../src/core/camera.js';

function setupCamera({ zoom = 1, cx = 400, cy = 300, canvasW = 800, canvasH = 600 } = {}) {
  const data = new Float32Array(Camera.FLOAT_COUNT);
  data[0] = zoom;
  data[1] = cx - canvasW / (2 * zoom);
  data[2] = cy - canvasH / (2 * zoom);
  data[5] = zoom;
  Camera.initialize(data, canvasW, canvasH);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Camera.setDeadzone(0, 0);
  return data;
}

test('rotation, setRotation, and setAngle write the same radians', () => {
  const data = setupCamera();
  Camera.rotation = 0.5;
  assert.equal(data[Camera.IDX_ROTATION], 0.5);
  assert.equal(Camera.rotation, 0.5);
  Camera.setRotation(-1);
  assert.equal(Camera.rotation, -1);
  Camera.setAngle(0.25);
  assert.equal(Camera.rotation, 0.25);
});

test('deadzone holds a point inside the box and pins an outside point to the edge', () => {
  const inside = deadzoneCenter(410, 290, 400, 300, 80, 60);
  assert.equal(inside.x, 400);
  assert.equal(inside.y, 300);

  const right = deadzoneCenter(500, 300, 400, 300, 80, 60);
  assert.equal(right.x, 420);
  assert.equal(right.y, 300);

  const above = deadzoneCenter(400, 200, 400, 300, 80, 60);
  assert.equal(above.x, 400);
  assert.equal(above.y, 260);

  const track = deadzoneCenter(500, 200, 400, 300, 0, 0);
  assert.equal(track.x, 500);
  assert.equal(track.y, 200);
});

test('followEntity deadzone does not ease the camera for a step inside the box', () => {
  setupCamera();
  Camera.setDeadzone(80, 60);
  const beforeX = Camera.x;
  const beforeY = Camera.y;
  const aim = Camera._deadzoneAim(410, 296);
  Camera.follow(aim.x, aim.y, 1, 1);
  assert.equal(aim.x, 400);
  assert.equal(aim.y, 300);
  assert.ok(Math.abs(Camera.x - beforeX) < 1e-4);
  assert.ok(Math.abs(Camera.y - beforeY) < 1e-4);
});

test('shake decays on sim time and holds during a hitstop step', () => {
  setupCamera();
  Camera.shake(10, 100);

  const full = Camera.advanceShake(0);
  assert.equal(full.x, 10);
  assert.equal(full.y, -5);

  const held = Camera.advanceShake(0);
  assert.equal(held.x, 10);
  assert.equal(held.y, -5);

  const mid = Camera.advanceShake(50);
  assert.equal(mid.x, -5);
  assert.equal(mid.y, 2.5);

  const done = Camera.advanceShake(50);
  assert.equal(done.x, 0);
  assert.equal(done.y, 0);
  assert.equal(Camera.advanceShake(16).x, 0);
});

test('deadzone rotates with Camera.rotation into screen space', () => {
  setupCamera();
  Camera.setDeadzone(80, 60);
  Camera.rotation = Math.PI / 2; // 90 deg: screen X is world -Y, screen Y is world +X

  // Delta dx = 0, dy = -70: in screen space viewDx = 70, viewDy = 0.
  // 70 <= halfW (80) and 0 <= halfH (60), so entity is inside view-space deadzone.
  const inside = Camera._deadzoneAim(400, 230);
  assert.equal(Math.round(inside.x), 400);
  assert.equal(Math.round(inside.y), 300);

  // Delta dx = 0, dy = -100: viewDx = 100 (> halfW 80).
  // targetViewDx = 20. Back in world space: cx = 400, cy = 300 - 20 = 280.
  const outside = Camera._deadzoneAim(400, 200);
  assert.equal(Math.round(outside.x), 400);
  assert.equal(Math.round(outside.y), 280);
});
