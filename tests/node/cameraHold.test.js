// Camera.held (VISUAL_EDITOR_PLAN.md ED-6): while the editor's edit mode holds the view, a game that follows its
// player every frame (Camera.follow in a scene's update, followEntity in a tick on a worker) does not take it back:
// follow, followEntity, centerOn and setPosition return at once, and only the page's free camera moves it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';
import { Transform } from '../../src/components/transform.js';

function setupCamera(floats = Camera.FLOAT_COUNT) {
  const data = new Float32Array(floats);
  data[0] = 1;
  data[1] = 0;
  data[2] = 0;
  data[3] = 400;
  data[4] = 300;
  data[5] = 1;
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  return data;
}

test('held: a game’s follows and moves leave the view where it is', () => {
  setupCamera();
  Camera.held = true;
  assert.equal(Camera.held, true);
  Transform.x = new Float32Array(4);
  Transform.y = new Float32Array(4);
  Transform.x[2] = 3000;
  Transform.y[2] = 2000;
  try {
    Camera.follow(2000, 1500, 1, 1);
    Camera.followEntity(2, 0, 1, 1);
    Camera.centerOn(2000, 1500);
    Camera.setPosition(900, 900);
    assert.deepEqual([Camera.x, Camera.y], [0, 0]);
  } finally {
    Camera.held = false;
  }
  Camera.follow(2000, 1500, 1, 1);
  assert.deepEqual([Camera.x, Camera.y], [1600, 1200], 'released: the next follow moves it again');
});

test('held: the page’s free camera still moves the view', () => {
  setupCamera();
  Mouse.initialize(new Float32Array(Mouse.BUFFER_SIZE / 4));
  Mouse.wheel = 0;
  Camera.held = true;
  try {
    Camera.setFree(true, { smoothing: 1 });
    Camera.setFreeTarget(1000, 700);
    Camera.updateFree(1);
    assert.deepEqual([Camera.centerX, Camera.centerY], [1000, 700]);
  } finally {
    Camera.setFree(false);
    Camera.held = false;
  }
});

test('a camera buffer from before the hold is never held, and holding it writes nothing', () => {
  const data = setupCamera(17);
  Camera.held = true;
  assert.equal(Camera.held, false);
  assert.equal(data.length, 17);
  Camera.follow(2000, 1500, 1, 1);
  assert.deepEqual([Camera.x, Camera.y], [1600, 1200]);
});
