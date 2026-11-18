// OL-15: the debug overlay's light polygons (visual aids, "lights") are read from the walls' rows, the only thing
// pre-render publishes about what a lamp sees since the old fan pass went. A row holds the lamp's floor point and each
// vertex's offset from it in floor px (lampWallRow.js); the overlay draws world px on the screen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsDebugRenderer } from '../../src/core/debug/rendering/physicsDebugRenderer.js';
import { WALL_ROW_ARGS, wallRowsLayout, writeWallRow } from '../../src/render/visibility/lampWallRow.js';

/** A canvas context that keeps the points of what is stroked. */
function recordingContext() {
  const paths = [];
  let path = null;
  return {
    paths,
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    closePath() {},
    stroke() { if (path && path.length) paths.push(path); path = null; },
    arc() {},
    fill() {},
    set strokeStyle(value) {},
    set fillStyle(value) {},
    set lineWidth(value) {},
  };
}

function drawRows(floorScaleY) {
  const rows = wallRowsLayout(4, 64);
  const f32 = new Float32Array(rows.lights * rows.rowFloats);
  // The second row: a lamp at (200, 140) that sees a box; the first row is empty (a lamp nothing stops has none).
  const xs = new Float32Array([100, 300, 300, 100]);
  const ys = new Float32Array([70, 70, 210, 210]);
  WALL_ROW_ARGS[0] = 200;
  WALL_ROW_ARGS[1] = 140;
  WALL_ROW_ARGS[2] = 1 / floorScaleY;
  writeWallRow(f32, rows.rowFloats, xs, ys, new Float32Array(4), 4);
  const ctx = recordingContext();
  new PhysicsDebugRenderer().drawLights(ctx, null, { x: 10, y: 20 }, 2, null, null, {
    buf: { f32 }, lightCount: 2, rowFloats: rows.rowFloats, floorScaleY,
  });
  return ctx.paths;
}

for (const floorScaleY of [1, 0.7]) {
  test(`the overlay strokes each row's polygon where the world shows it (floorScaleY ${floorScaleY})`, () => {
    const paths = drawRows(floorScaleY);
    assert.equal(paths.length, 1, 'one polygon: the empty row draws nothing');
    const want = [[180, 100], [580, 100], [580, 380], [180, 380]];
    assert.equal(paths[0].length, want.length);
    paths[0].forEach(([x, y], v) => {
      assert.ok(Math.abs(x - want[v][0]) < 1e-3 && Math.abs(y - want[v][1]) < 1e-3, `vertex ${v}: (${x}, ${y})`);
    });
  });
}

test('no rows, or none published yet: only the lights\' own marks are drawn', () => {
  const ctx = recordingContext();
  new PhysicsDebugRenderer().drawLights(ctx, null, { x: 0, y: 0 }, 1, null, null, { buf: null, lightCount: 0, rowFloats: 0, floorScaleY: 1 });
  assert.equal(ctx.paths.length, 0);
});
