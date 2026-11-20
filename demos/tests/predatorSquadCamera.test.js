// N-248: with the page's ?zoom= pinned, Predator followed its squad at the squad camera's own fitted zoom and then set
// the pinned zoom, which keeps the view's top-left corner: every frame re-zoomed around the corner. The first frame (a
// dtRatio in the hundreds: the follow at full strength) threw the view thousands of pixels off the squad, and the next
// ones crawled back while the two zooms fought. The squad camera now takes the pinned zoom itself. These run the real
// updateSquadCamera and PredatorScene.update (the demo loads through the web-root hook) on a stand-in squad.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/helpers/registerWebRoot.mjs';

const W = 1280;
const H = 720;
// The squad: three soldiers around (5000, 2500), 1600 x 1600 wide.
const SQUAD = [[4200, 1700], [5800, 3300], [5000, 2500]];

async function setup() {
  const { Camera, Transform } = (await import('../../src/index.js')).default;
  const { MySoldier } = await import('../../demos/predatorScene/gameObjects/mySoldier.js');
  const camera = await import('../../demos/predatorScene/gameObjects/cameraController.js');
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data[0] = 1;
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(10000, 5000);
  Camera.centerOn(1000, 1000); // where create() left the view, far from the squad
  const saved = { x: Transform.x, y: Transform.y };
  Transform.x = new Float32Array(SQUAD.map((p) => p[0]));
  Transform.y = new Float32Array(SQUAD.map((p) => p[1]));
  const own = Object.getOwnPropertyDescriptor(MySoldier, 'getAllActive');
  Object.defineProperty(MySoldier, 'getAllActive', { value: () => [0, 1, 2], configurable: true, writable: true });
  camera.resetSquadCameraHold();
  const restore = () => {
    Transform.x = saved.x;
    Transform.y = saved.y;
    if (own) Object.defineProperty(MySoldier, 'getAllActive', own);
    else delete MySoldier.getAllActive;
  };
  return { Camera, camera, restore };
}

test('a pinned zoom: the first frame is on the squad at that zoom, and it stays there', async () => {
  const { Camera, camera, restore } = await setup();
  try {
    camera.updateSquadCamera(280, 1);
    assert.equal(Camera.zoom, 1);
    assert.ok(Math.abs(Camera.centerX - 5000) < 1 && Math.abs(Camera.centerY - 2500) < 1, `centre ${Camera.centerX},${Camera.centerY}`);
    for (let f = 0; f < 30; f++) camera.updateSquadCamera(1, 1);
    assert.equal(Camera.zoom, 1);
    assert.ok(Math.abs(Camera.centerX - 5000) < 1 && Math.abs(Camera.centerY - 2500) < 1, `centre ${Camera.centerX},${Camera.centerY} after 30 frames`);
  } finally {
    restore();
  }
});

test("PredatorScene.update gives the squad camera the page's pinned zoom; unpinned it fits the squad", async () => {
  const { PredatorScene } = await import('../../demos/predatorScene/predatorScene.js');
  const { Camera, restore } = await setup();
  try {
    PredatorScene.prototype.update.call({ _freeCam: false, _pinZoom: 1 }, 280, 280 * 16.67, 0, 1);
    assert.equal(Camera.zoom, 1);
    assert.ok(Math.abs(Camera.centerX - 5000) < 1 && Math.abs(Camera.centerY - 2500) < 1, `pinned: centre ${Camera.centerX},${Camera.centerY}`);
  } finally {
    restore();
  }
  const again = await setup();
  try {
    PredatorScene.prototype.update.call({ _freeCam: false, _pinZoom: 0 }, 280, 280 * 16.67, 0, 1);
    assert.ok(again.Camera.zoom < 1, `unpinned: the squad's fit, ${again.Camera.zoom}`);
    assert.ok(Math.abs(again.Camera.centerX - 5000) < 1, `unpinned: centre x ${again.Camera.centerX}`);
  } finally {
    again.restore();
  }
});
