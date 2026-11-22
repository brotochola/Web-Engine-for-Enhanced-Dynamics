// OL-15: the debug overlay's light polygons (visual aids, "lights") are read from the walls' rows, the only thing
// pre-render publishes about what a lamp sees since the old fan pass went. A row holds the lamp's floor point and each
// vertex's offset from it in floor px (lampWallRow.js); the overlay draws world px on the screen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicsDebugRenderer } from '../../src/core/debug/rendering/physicsDebugRenderer.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { WALL_ROW_ARGS, wallRowsLayout, writeWallRow } from '../../src/render/visibility/lampWallRow.js';

/** A canvas context that keeps the points of what is stroked. */
function recordingContext() {
  const paths = [];
  const ellipses = [];
  let path = null;
  return {
    paths,
    ellipses,
    ellipse(x, y, rx, ry) { ellipses.push([x, y, rx, ry]); },
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

/** Two lamps: #0 a point light, #1 a cone of 90° pointing along +x of an entity turned 90° (so down the screen). */
function withLamps(fn) {
  const keys = ['active', 'radius', 'brightness', 'offsetX', 'offsetY', 'coneHalf', 'dirC', 'dirS'];
  const tkeys = ['active', 'x', 'y', 'rotC', 'rotS'];
  const saved = Object.fromEntries(keys.map((k) => [k, LightEmitter[k]]));
  const tsaved = Object.fromEntries(tkeys.map((k) => [k, Transform[k]]));
  try {
    LightEmitter.active = new Uint8Array([1, 1]);
    LightEmitter.radius = new Float32Array([100, 50]);
    LightEmitter.brightness = new Float32Array([1, 1]);
    LightEmitter.offsetX = new Float32Array([10, 0]);
    LightEmitter.offsetY = new Float32Array([0, 0]);
    LightEmitter.coneHalf = new Float32Array([Math.PI, Math.PI / 4]);
    LightEmitter.dirC = new Float32Array([1, 1]);
    LightEmitter.dirS = new Float32Array([0, 0]);
    Transform.active = new Uint8Array([1, 1]);
    Transform.x = new Float32Array([200, 400]);
    Transform.y = new Float32Array([100, 300]);
    Transform.rotC = new Float32Array([1, 0]);
    Transform.rotS = new Float32Array([0, 1]);
    return fn();
  } finally {
    Object.assign(LightEmitter, saved);
    Object.assign(Transform, tsaved);
  }
}

test('a point light is a pool on the floor: an ellipse floorScaleY as tall as wide, at its offset floor point', () => {
  withLamps(() => {
    const ctx = recordingContext();
    new PhysicsDebugRenderer().drawLights(ctx, null, { x: 0, y: 0 }, 2, null, null, { buf: null, lightCount: 0, rowFloats: 0, floorScaleY: 0.5 });
    assert.equal(ctx.ellipses.length, 1, 'only the point light is an ellipse');
    assert.deepEqual(ctx.ellipses[0], [420, 200, 200, 100]);
  });
});

test('a cone light is a wedge on the floor around its axis, the entity\'s turn turning it', () => {
  withLamps(() => {
    const ctx = recordingContext();
    new PhysicsDebugRenderer().drawLights(ctx, null, { x: 0, y: 0 }, 1, null, null, { buf: null, lightCount: 0, rowFloats: 0, floorScaleY: 0.5 });
    assert.equal(ctx.paths.length, 1, 'one wedge');
    const wedge = ctx.paths[0];
    assert.deepEqual(wedge[0], [400, 300], 'from the lamp');
    // Down the screen, 45° each side on the floor: the arc's ends at (400 ± 50·sin45, 300 + 50·cos45·0.5).
    const end = wedge[wedge.length - 1];
    const first = wedge[1];
    const dx = 50 * Math.SQRT1_2;
    const dy = 50 * Math.SQRT1_2 * 0.5;
    for (const [x, y] of [first, end]) {
      assert.ok(Math.abs(Math.abs(x - 400) - dx) < 1e-3 && Math.abs(y - 300 - dy) < 1e-3, `edge (${x}, ${y})`);
    }
    const mid = wedge[1 + (wedge.length - 2) / 2];
    assert.ok(Math.abs(mid[0] - 400) < 1e-3 && Math.abs(mid[1] - 325) < 1e-3, `axis (${mid[0]}, ${mid[1]})`);
  });
});
