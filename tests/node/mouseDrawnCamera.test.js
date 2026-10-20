import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');
const { Mouse } = await import('../../src/core/mouse.js');
const { Camera } = await import('../../src/core/camera.js');
const layout = await import('../../src/render/renderQueueLayout.js');

// B17. The cursor's world point has to come from the camera Pixi draws. With
// followEntity that camera is snapped to the packed pose plus the look-ahead,
// while the Camera SAB x/y eases toward it (MEMORY_STRUCTURE: "SAB x/y may
// ease; drawn follow is renderQueueCamera"). At smoothing 0.1 and 600 px/s the
// eased camera trails by 90 world px, and so did every click.

const W = 800;
const H = 600;

function bootCamera(zoom, x, y) {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  data[0] = zoom;
  data[1] = x;
  data[2] = y;
  data[5] = zoom;
}

function stubScene() {
  const buffers = {
    renderQueueSync: new SharedArrayBuffer(8),
    renderQueueCameraA: new SharedArrayBuffer(layout.RENDER_QUEUE_CAMERA_BYTES),
    renderQueueCameraB: new SharedArrayBuffer(layout.RENDER_QUEUE_CAMERA_BYTES),
  };
  return {
    buffers,
    _drawnCameraViews: Scene.prototype._drawnCameraViews,
    camera: { zoom: 1, x: 0, y: 0, rotation: 0, canvasWidth: 0, canvasHeight: 0 },
    sync: new Int32Array(buffers.renderQueueSync),
    camA: new Float32Array(buffers.renderQueueCameraA, 0, 4),
    camB: new Float32Array(buffers.renderQueueCameraB, 0, 4),
  };
}

/** Pre-render's order: write the queue camera into the unpublished slot, then publish. */
function publish(scene, zoom, x, y, rot = 0) {
  const next = Atomics.load(scene.sync, 0) + 1;
  const cam = ((next - 1) & 1) === 0 ? scene.camA : scene.camB;
  cam[0] = zoom;
  cam[1] = x;
  cam[2] = y;
  cam[3] = rot;
  Atomics.store(scene.sync, 0, next);
}

function bootMouse(canvasX, canvasY) {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  Mouse.reset();
  Mouse._writeCanvas(0, canvasX, canvasY);
}

const updateCameraBuffer = Scene.prototype.updateCameraBuffer;

test('the cursor world point uses the drawn queue camera, not the eased SAB camera', () => {
  bootCamera(1, 100, 50); // eased, trailing
  const scene = stubScene();
  publish(scene, 1, 190, 50); // drawn: snapped to pose + lead
  bootMouse(400, 300);

  updateCameraBuffer.call(scene);

  assert.equal(Mouse.x, 400 + 190);
  assert.equal(Mouse.y, 300 + 50);
  assert.equal(scene.camera.x, 190);
  assert.equal(scene.camera.canvasWidth, W);
});

test('zoom, rotation and slot parity come from the newest published queue', () => {
  bootCamera(1, 0, 0);
  const scene = stubScene();
  publish(scene, 2, 10, 20, 0); // frame 1 -> slot A
  publish(scene, 4, 30, 40, 0.5); // frame 2 -> slot B
  bootMouse(W / 2 + 80, H / 2);

  updateCameraBuffer.call(scene);

  assert.equal(scene.camera.zoom, 4);
  assert.equal(scene.camera.x, 30);
  assert.equal(scene.camera.rotation, 0.5);
  // 80 screen px right of center at zoom 4 = 20 world px along the rotated x axis.
  const focusX = 30 + W / (2 * 4);
  const focusY = 40 + H / (2 * 4);
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  assert.ok(Math.abs(Mouse.x - (focusX + c * 20)) < 1e-3, `x ${Mouse.x}`);
  assert.ok(Math.abs(Mouse.y - (focusY - s * 20)) < 1e-3, `y ${Mouse.y}`);

  publish(scene, 3, 50, 60, 0); // frame 3 -> slot A again
  updateCameraBuffer.call(scene);
  assert.equal(scene.camera.zoom, 3);
  assert.equal(scene.camera.x, 50);
});

test('before the first publish the mirror falls back to the Camera SAB', () => {
  bootCamera(2, 120, 80);
  const scene = stubScene();
  bootMouse(100, 100);

  updateCameraBuffer.call(scene);

  assert.equal(scene.camera.zoom, 2);
  assert.equal(scene.camera.x, 120);
  assert.equal(Mouse.x, 100 / 2 + 120);
});

test('a scene without render-queue buffers keeps the Camera SAB path', () => {
  bootCamera(1, 7, 9);
  const scene = { buffers: {}, _drawnCameraViews: Scene.prototype._drawnCameraViews, camera: { zoom: 1, x: 0, y: 0, rotation: 0, canvasWidth: 0, canvasHeight: 0 } };
  bootMouse(0, 0);

  updateCameraBuffer.call(scene);

  assert.equal(scene.camera.x, 7);
  assert.equal(Mouse.y, 9);
});

test('a new scene buffer set is picked up (restart rebinds the views)', () => {
  bootCamera(1, 0, 0);
  const scene = stubScene();
  publish(scene, 1, 11, 0);
  bootMouse(0, 0);
  updateCameraBuffer.call(scene);
  assert.equal(scene.camera.x, 11);

  const fresh = stubScene();
  scene.buffers = fresh.buffers;
  scene.sync = fresh.sync;
  scene.camA = fresh.camA;
  scene.camB = fresh.camB;
  publish(scene, 1, 22, 0);
  updateCameraBuffer.call(scene);
  assert.equal(scene.camera.x, 22);
});

test('readQueueCamera retries when pre-render publishes during the copy', () => {
  assert.equal(typeof layout.readQueueCamera, 'function');
  const sync = new Int32Array(new SharedArrayBuffer(8));
  const b = layout.createRenderQueueCameraViews(new SharedArrayBuffer(layout.RENDER_QUEUE_CAMERA_BYTES));
  b.camera.set([2, 200, 210, 0]);
  sync[0] = 1;
  // Slot A holds frame 1. Mid-copy, frame 2 (slot B) is published and pre-render
  // starts writing frame 3 into slot A. A copy without a re-check returns a mix.
  let raced = false;
  const camA = [1, 100, 110, 0];
  const a = {
    camera: {
      get 0() { return camA[0]; },
      get 1() {
        if (!raced) {
          raced = true;
          Atomics.store(sync, 0, 2);
          camA[0] = 3; camA[1] = 300; camA[2] = 310;
        }
        return camA[1];
      },
      get 2() { return camA[2]; },
      get 3() { return camA[3]; },
    },
    poseReady: new Int32Array(1),
  };
  const out = { zoom: 0, x: 0, y: 0, rotation: 0 };

  const frame = layout.readQueueCamera(sync, a, b, out);

  assert.equal(frame, 2);
  assert.deepEqual(out, { zoom: 2, x: 200, y: 210, rotation: 0 });
});

test('readQueueCamera returns 0 before anything is published', () => {
  const sync = new Int32Array(new SharedArrayBuffer(8));
  const a = layout.createRenderQueueCameraViews(new SharedArrayBuffer(layout.RENDER_QUEUE_CAMERA_BYTES));
  const b = layout.createRenderQueueCameraViews(new SharedArrayBuffer(layout.RENDER_QUEUE_CAMERA_BYTES));
  const out = { zoom: 5, x: 5, y: 5, rotation: 5 };
  assert.equal(layout.readQueueCamera(sync, a, b, out), 0);
  assert.deepEqual(out, { zoom: 5, x: 5, y: 5, rotation: 5 });
});
