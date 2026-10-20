import test from 'node:test';
import assert from 'node:assert/strict';

import { Mouse } from '../../src/core/mouse.js';

// B16. bible_of_weed_js.md shows `zoom *= Mouse.pinchRatio()`. A ratio taken in world
// coordinates feeds back through that zoom: the next frame re-projects the same fingers
// with the new zoom and reports the inverse, so the zoom flickers. The ratio must be
// measured on the screen.

const camera = { x: 0, y: 0, zoom: 1, rotation: 0, canvasWidth: 800, canvasHeight: 600 };

function boot() {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  Mouse.reset();
  camera.zoom = 1;
  camera.x = 0;
  camera.y = 0;
}

function touch(id, x, y, buttons = 1) {
  return { pointerId: id, pointerType: 'touch', button: 0, buttons, clientX: x, clientY: y, currentTarget: null };
}

// One frame as a worker sees it: edges latched, game code runs, previous positions saved.
function frame(read) {
  Mouse.updateWorldPosition(camera);
  Mouse.updateEdgeFlags();
  const value = read();
  Mouse.snapshotPreviousFrame();
  return value;
}

test('a pinch that spreads once and then holds still zooms once, without flicker', () => {
  boot();
  Mouse.pointerDown(touch(1, 300, 300), camera);
  Mouse.pointerDown(touch(2, 400, 300), camera);
  frame(() => Mouse.pinchRatio());
  frame(() => Mouse.pinchRatio());

  Mouse.pointerMove(touch(2, 410, 300), camera); // 100 px apart -> 110 px
  const ratios = [];
  for (let f = 0; f < 4; f++) {
    ratios.push(frame(() => {
      const r = Mouse.pinchRatio();
      camera.zoom *= r;
      return r;
    }));
  }
  assert.ok(Math.abs(ratios[0] - 1.1) < 1e-6, `spread frame ${ratios[0]}`);
  for (let f = 1; f < ratios.length; f++) {
    assert.ok(Math.abs(ratios[f] - 1) < 1e-6, `still fingers, frame ${f}: ${ratios[f]}`);
  }
  assert.ok(Math.abs(camera.zoom - 1.1) < 1e-6);
});

test('a finger that lands in a reused slot does not produce a jump', () => {
  boot();
  Mouse.pointerDown(touch(1, 300, 300), camera);
  Mouse.pointerDown(touch(2, 310, 300), camera);
  frame(() => Mouse.pinchRatio());
  Mouse.pointerUp(touch(2, 310, 300, 0), camera);
  frame(() => Mouse.pinchRatio());
  // A new finger takes the freed slot far away; the old slot's previous point is stale.
  Mouse.pointerDown(touch(3, 700, 500), camera);
  const r = frame(() => Mouse.pinchRatio());
  assert.equal(r, 1, `pair changed this frame: ${r}`);
});

test('canvas positions are readable from any realm through the shared buffer', () => {
  boot();
  Mouse.pointerDown(touch(1, 120, 80), camera);
  assert.equal(Mouse.canvasXAt(0), 120);
  assert.equal(Mouse.canvasYAt(0), 80);
});
