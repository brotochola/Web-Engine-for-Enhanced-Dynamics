import test from 'node:test';
import assert from 'node:assert/strict';

import { viewScreenToWorld, viewWorldToScreen } from '../../src/util/viewBounds.js';
import { Mouse } from '../../src/core/mouse.js';

// Review R6. Camera.screenToWorld, Camera.worldToScreen and the mouse's world
// position each carried their own copy of the turned-view math; they share
// viewScreenToWorld / viewWorldToScreen now.

const CANVAS = [1920, 1080];

test('screen to world and back is the identity, turned or not', () => {
  const p = { x: 0, y: 0 };
  const q = { x: 0, y: 0 };
  for (const rotation of [0, 0.3, -1.2, Math.PI / 2, Math.PI, 2.9]) {
    for (const zoom of [0.25, 1, 2.5]) {
      for (const [sx, sy] of [[0, 0], [960, 540], [1919, 3], [17, 1001]]) {
        viewScreenToWorld(-300, 125, zoom, rotation, CANVAS[0], CANVAS[1], sx, sy, p);
        viewWorldToScreen(-300, 125, zoom, rotation, CANVAS[0], CANVAS[1], p.x, p.y, q);
        assert.ok(Math.abs(q.x - sx) < 1e-6 && Math.abs(q.y - sy) < 1e-6, `rot ${rotation} zoom ${zoom} at ${sx},${sy}: ${q.x},${q.y}`);
      }
    }
  }
});

test('the canvas center is the view focus at any rotation', () => {
  const p = { x: 0, y: 0 };
  for (const rotation of [0, 0.7, -2.2]) {
    viewScreenToWorld(100, 50, 2, rotation, CANVAS[0], CANVAS[1], CANVAS[0] / 2, CANVAS[1] / 2, p);
    assert.ok(Math.abs(p.x - (100 + CANVAS[0] / 4)) < 1e-9 && Math.abs(p.y - (50 + CANVAS[1] / 4)) < 1e-9);
  }
});

test("the mouse's world position is viewScreenToWorld of its canvas position", () => {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  const camera = { x: -40, y: 300, zoom: 1.5, rotation: 0.9, canvasWidth: CANVAS[0], canvasHeight: CANVAS[1] };
  Mouse._canvasX[0] = 700;
  Mouse._canvasY[0] = 210;
  Mouse._writeWorld(0, camera);
  const want = viewScreenToWorld(-40, 300, 1.5, 0.9, CANVAS[0], CANVAS[1], 700, 210, { x: 0, y: 0 });
  const base = Mouse._slot(0);
  assert.ok(Math.abs(Mouse._data[base + Mouse._SX] - want.x) < 1e-3);
  assert.ok(Math.abs(Mouse._data[base + Mouse._SY] - want.y) < 1e-3);
});
