import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Camera } from '../../src/core/camera.js';
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { viewWorldBounds } from '../../src/util/viewBounds.js';

// N-12. Pixi turns the world about the canvas center (_placeWorldCamera: pivot at
// the focus, position at the center). Every cull tested the unrotated canvas
// rectangle, so a turned camera culled what it drew: at 90 degrees on 1280x720
// the left and right ~200 px of the screen were empty (headed run, boids).

const W = 1280;
const H = 720;
const ANGLES = [0, 0.3, Math.PI / 4, Math.PI / 2, 2.2, -1.1, Math.PI];
const ZOOMS = [0.5, 1, 2];

function bootCamera(zoom, x, y, rot) {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  data[0] = zoom;
  data[1] = x;
  data[2] = y;
  data[5] = zoom;
  data[9] = rot;
  return data;
}

/** World points under a grid of drawn screen pixels, edges and corners included. */
function drawnWorldPoints() {
  const out = [];
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = Camera.screenToWorld((W * i) / 8, (H * j) / 8, { x: 0, y: 0 });
      out.push([p.x, p.y]);
    }
  }
  return out;
}

function assertCullKeeps(bounds, points, label) {
  for (const [x, y] of points) {
    const sx = x * bounds.zoom - bounds.cameraOffsetX;
    const sy = y * bounds.zoom - bounds.cameraOffsetY;
    assert.ok(
      sx >= bounds.minX - 1e-6 && sx <= bounds.maxX + 1e-6 && sy >= bounds.minY - 1e-6 && sy <= bounds.maxY + 1e-6,
      `${label}: drawn point (${x.toFixed(1)}, ${y.toFixed(1)}) is culled`,
    );
  }
}

test('screen cull bounds keep every drawn pixel at any angle and zoom', () => {
  for (const zoom of ZOOMS) {
    for (const rot of ANGLES) {
      const data = bootCamera(zoom, 300, 200, rot);
      const b = calculateCameraScreenBounds(zoom, data[1], data[2], W, H, 0.1, {}, data[9]);
      assertCullKeeps(b, drawnWorldPoints(), `zoom ${zoom} rot ${rot}`);
    }
  }
});

test('rotation 0 gives the same bounds as before', () => {
  const b = calculateCameraScreenBounds(0.5, 10, 20, W, H, 0.1, {});
  assert.deepEqual(b, { zoom: 0.5, cameraOffsetX: 5, cameraOffsetY: 10, minX: -64, maxX: W + 64, minY: -36, maxY: H + 36 });
  const v = viewWorldBounds(0.5, 10.1, 20.3, W, H, 0, {});
  assert.deepEqual(v, { minX: 10.1, minY: 20.3, maxX: 10.1 + W / 0.5, maxY: 20.3 + H / 0.5 });
});

test('viewWorldBounds contains the drawn view at any angle', () => {
  for (const zoom of ZOOMS) {
    for (const rot of ANGLES) {
      const data = bootCamera(zoom, -50, 75, rot);
      const v = viewWorldBounds(zoom, data[1], data[2], W, H, data[9], {});
      for (const [x, y] of drawnWorldPoints()) {
        assert.ok(x >= v.minX - 1e-6 && x <= v.maxX + 1e-6 && y >= v.minY - 1e-6 && y <= v.maxY + 1e-6,
          `zoom ${zoom} rot ${rot}: (${x}, ${y}) outside`);
      }
    }
  }
});

test('pre-render culls with the frame rotation', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const data = bootCamera(1, 300, 200, Math.PI / 2);
  pre.cameraData = data;
  pre.canvasWidth = W;
  pre.canvasHeight = H;
  pre.cullingRatio = 0.1;
  pre._poseX = null;
  pre._poseY = null;
  pre.renderQueueCamera = null;
  pre.latchCamera(0);
  assertCullKeeps(pre.calculateCameraBounds(), drawnWorldPoints(), 'pre-render 90 degrees');
});

test('the particle worker culls with the camera rotation', async () => {
  const par = await loadWorker('particleWorker.js', 'particleWorker');
  const data = bootCamera(2, 300, 200, -1.1);
  par.cameraData = data;
  par.canvasWidth = W;
  par.canvasHeight = H;
  par.cullingRatio = 0.1;
  par._frameCamValid = false;
  assertCullKeeps(par._frameCameraBounds(), drawnWorldPoints(), 'particle -1.1 rad');
});

test('Camera.isOnScreen agrees with what the turned view draws', () => {
  bootCamera(1, 0, 0, Math.PI / 2);
  // Focus (640, 360). At 90 degrees the screen spans world x 640±360, y 360±640.
  assert.equal(Camera.isOnScreen(640, 360 - 600), true, 'far along the long screen axis');
  assert.equal(Camera.isOnScreen(640 + 600, 360), false, 'inside the unrotated box, off the turned screen');
  for (const [x, y] of drawnWorldPoints()) assert.equal(Camera.isOnScreen(x, y, 1e-3), true);
});

test('Camera.getViewportBounds is the box around the turned view', () => {
  bootCamera(1, 0, 0, Math.PI / 2);
  const v = Camera.getViewportBounds({});
  assert.ok(Math.abs(v.left - (640 - 360)) < 1e-3, `left ${v.left}`);
  assert.ok(Math.abs(v.top - (360 - 640)) < 1e-3, `top ${v.top}`);
  assert.ok(Math.abs(v.width - 720) < 1e-3, `width ${v.width}`);
  assert.ok(Math.abs(v.height - 1280) < 1e-3, `height ${v.height}`);

  bootCamera(2, 5, 6, 0);
  assert.deepEqual(Camera.getViewportBounds({}), { left: 5, top: 6, right: 5 + W / 2, bottom: 6 + H / 2, width: W / 2, height: H / 2 });
});
