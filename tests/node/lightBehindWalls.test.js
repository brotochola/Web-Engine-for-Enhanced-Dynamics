// OL-4: lighting.lightBehindWalls, the share of a lamp's light that still reaches the floor behind a wall (0.33 by
// default, the old pass's look; it was the shaders' own constant). What a scene may write and what it reads as, and
// the light pass's formula in its JS copy (wallRowLight): behind a wall a pixel keeps that share, plus what a wall
// that is not opaque lets through of the rest.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WALL_ROW_ARGS, WALL_UMBRA, wallEdgeCode, wallRowLight, wallRowTexels, writeWallRow,
} from '../../src/render/visibility/lampWallRow.js';
import { LIGHTING_DEFAULTS, lightBehindWallsOf } from '../../src/util/configDefaults.js';
import { unknownConfigKeys } from '../../src/util/configKeys.js';

test('the default is a third, and a scene\'s number is cut to 0..1', () => {
  assert.equal(LIGHTING_DEFAULTS.lightBehindWalls, WALL_UMBRA);
  assert.equal(lightBehindWallsOf(undefined), 0.33);
  assert.equal(lightBehindWallsOf({}), 0.33);
  assert.equal(lightBehindWallsOf({ lightBehindWalls: 0 }), 0, '0 is a value: a shadow that keeps nothing of the lamp');
  assert.equal(lightBehindWallsOf({ lightBehindWalls: 0.5 }), 0.5);
  assert.equal(lightBehindWallsOf({ lightBehindWalls: 7 }), 1);
  assert.equal(lightBehindWallsOf({ lightBehindWalls: -1 }), 0);
  assert.equal(lightBehindWallsOf({ lightBehindWalls: 'dark' }), 0.33);
  assert.equal(lightBehindWallsOf({ lightBehindWalls: NaN }), 0.33);
  assert.deepEqual(unknownConfigKeys({ lighting: { lightBehindWalls: 0 } }), []);
});

/** A lamp at the origin with a wall straight across, 100 px away, of the given opacity; the light at (x, 0). */
function behindWall(opacity, behind) {
  const far = 300 * Math.SQRT2;
  const pts = [[-Math.PI, far, 0], [-Math.PI / 2, far, 0], [-Math.PI / 4, far, 0], [-Math.PI / 4, 100 * Math.SQRT2, 1],
    [Math.PI / 4, 100 * Math.SQRT2, 1], [Math.PI / 4, far, 0], [Math.PI / 2, far, 0], [Math.PI - 1e-5, far, 0]];
  const code = wallEdgeCode(9, opacity);
  const xs = Float32Array.from(pts, ([a, d]) => Math.cos(a) * d);
  const ys = Float32Array.from(pts, ([a, d]) => Math.sin(a) * d);
  const codes = Float32Array.from(pts, ([, , wall]) => (wall ? code : 0));
  const rows = new Float32Array(4 * wallRowTexels(16));
  WALL_ROW_ARGS[0] = 0;
  WALL_ROW_ARGS[1] = 0;
  WALL_ROW_ARGS[2] = 1;
  writeWallRow(rows, 0, xs, ys, codes, pts.length);
  const at = (x) => (behind === undefined ? wallRowLight(rows, 0, x, 0, 0, 0) : wallRowLight(rows, 0, x, 0, 0, 0, behind));
  return { front: at(90), back: at(160) };
}

test('behind an opaque wall a pixel keeps lighting.lightBehindWalls of the lamp', () => {
  assert.equal(behindWall(1).front, 1, 'in front of the wall: the whole lamp');
  assert.ok(Math.abs(behindWall(1).back - 0.33) < 1e-6, 'the default');
  assert.equal(behindWall(1, 0).front, 1);
  assert.equal(behindWall(1, 0).back, 0, '0: the shadow keeps nothing of the lamp');
  assert.ok(Math.abs(behindWall(1, 0.6).back - 0.6) < 1e-6);
  assert.equal(behindWall(1, 1).back, 1, '1: walls stop nothing');
});

test('a wall that is not opaque lets its share of the rest through, whatever the shadow keeps', () => {
  // Opacity 0.5 is stored as 128 of 255.
  const through = 1 - 128 / 255;
  assert.ok(Math.abs(behindWall(0.5, 0).back - through) < 1e-6, 'a shadow of nothing: only what the wall lets through');
  assert.ok(Math.abs(behindWall(0.5).back - (0.33 + 0.67 * through)) < 1e-6, 'the default: a third, and its share of the rest');
});
