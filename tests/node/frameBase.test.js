// DX-SHADOW3D: where a frame stands (frameBase.js), measured from pictures drawn here: a person's feet, a tree's trunk
// over its roots, a render's legs; and how the base rides in the texture table's spare floats.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACT_HEIGHT,
  isRenderDirections,
  lutBaseFloats,
  measureLowestContact,
  measureStandingBase,
  sheetCastsSolid,
} from '../../src/render/frameBase.js';
import { buildTextureLut, packTextureLutRgba, TEX_LUT_FLOATS } from '../../src/render/instancedSpriteBatch.js';

/** A w × h picture from rectangles [x0, y0, x1, y1) that are opaque. */
function picture(w, h, rects) {
  const on = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) on[y * w + x] = 1;
  }
  return (i, j) => on[j * w + i] === 1;
}

test('a person: the feet at the lowest rows, an ellipse 0.6 as deep as wide', () => {
  // 64 × 64: a body over two feet (rows 54..59), the lowest opaque row 60, the feet spanning x 24..39.
  const p = picture(64, 64, [[26, 10, 38, 54], [24, 54, 31, 60], [33, 54, 40, 60]]);
  const b = measureStandingBase(p, 64, 64);
  assert.equal(b.bottom, 60);
  assert.equal(b.cx, 32);
  assert.equal(b.rx, 8, 'half the feet\'s span, at most 8');
  assert.ok(Math.abs(b.ry - 4.8) < 1e-9);
});

test('a tree: the trunk above the roots, round', () => {
  // A canopy, a trunk 8 px wide (x 60..67) from row 40 to 180, roots spreading 40 px at the bottom (rows 176..180).
  const p = picture(128, 184, [[20, 0, 108, 40], [60, 40, 68, 180], [44, 176, 84, 180]]);
  const b = measureStandingBase(p, 128, 184);
  assert.equal(b.bottom, 180);
  assert.equal(b.cx, 64);
  assert.equal(b.rx, 4);
  assert.equal(b.ry, 4, 'a trunk is round');
});

test('an empty frame has no base', () => {
  assert.equal(measureStandingBase(() => false, 8, 8), null);
});

test('a render stands on its lowest contact: pixels within 1.5 px of its lowest point', () => {
  // Legs (height 0) at rows 30..39 and 20..29, a body (height 20) above: the lowest contact row is 39.
  const opaque = picture(40, 40, [[5, 20, 8, 30], [30, 30, 33, 40], [5, 5, 35, 20]]);
  const height = (i, j) => (j < 20 ? 20 : 0);
  assert.equal(measureLowestContact(opaque, height, 40, 40), 39.5);
  // Made smaller, a render's lowest visible pixels sit a little up: it still stands on them.
  assert.equal(measureLowestContact(opaque, (i, j) => (j < 20 ? 22.5 : 2.5), 40, 40), 39.5);
  assert.equal(measureLowestContact(opaque, () => CONTACT_HEIGHT + 1, 40, 40), 39.5, 'a frame all at one height: its lowest row');
  assert.equal(measureLowestContact(() => false, () => 0, 8, 8), null, 'an empty frame');
});

test('a render is a sheet drawn from 8 directions or more', () => {
  assert.equal(isRenderDirections(undefined), false);
  assert.equal(isRenderDirections({ walk: { up: 'a', left: 'b', down: 'c', right: 'd' } }), false, 'a person of 4');
  assert.equal(isRenderDirections({ stand: { count: 32, anims: 'x_{i}' } }), true);
  const half = { mirrorX: true };
  for (let k = 0; k < 5; k++) half[String(k * 45 - 90)] = `d${k}`;
  assert.equal(isRenderDirections({ drive: half }), true, 'five drawn and mirrored');
});

test('the base rides in the texture table\'s last two floats', () => {
  const out = new Float32Array(2);
  lutBaseFloats(null, out, 0);
  assert.deepEqual(Array.from(out), [0, 0]);
  lutBaseFloats({ cx: 32, rx: 8, ry: 4.8 }, out, 0);
  assert.deepEqual(Array.from(out), [33, 8], 'feet');
  lutBaseFloats({ cx: 64, rx: 4, ry: 4 }, out, 0);
  assert.deepEqual(Array.from(out), [65, -4], 'a trunk');
  lutBaseFloats({ contact: 39.5 }, out, 0);
  assert.deepEqual(Array.from(out), [-40.5, 0], 'a render');

  // Through the table: a texture carrying a base (the Pixi worker sets weedBase from the atlas's json).
  const tex = { orig: { width: 64, height: 64 }, uvs: { x0: 0, y0: 0, x2: 0.5, y2: 0.5 }, trim: null, width: 64, height: 64 };
  const lut = buildTextureLut([{ ...tex, weedBase: { cx: 32, rx: 8, ry: 4.8 } }, tex]);
  assert.equal(TEX_LUT_FLOATS, 12);
  assert.deepEqual(Array.from(lut.subarray(10, 12)), [33, 8]);
  assert.deepEqual(Array.from(lut.subarray(22, 24)), [0, 0], 'no base: zeros');
  const rgba = packTextureLutRgba(lut, 2);
  assert.deepEqual(Array.from(rgba.subarray(10, 12)), [33, 8], 'the third texel\'s zw');
});

test('a sheet casts its solid when a frame of it stands on a contact (a render with height maps)', () => {
  const json = {
    animations: { barn_stand_0: ['barn/0'], barn_stand_1: ['barn/1'], walker_walk_up: ['walker/0'] },
    frames: { 'barn/0': { base: { contact: 41 } }, 'barn/1': { base: { contact: 40 } }, 'walker/0': { base: { cx: 8, rx: 5, ry: 3 } } },
  };
  const barn = { animations: { stand_0: { prefixedName: 'barn_stand_0' }, stand_1: { prefixedName: 'barn_stand_1' } } };
  const walker = { animations: { walk_up: { prefixedName: 'walker_walk_up' } } };
  assert.equal(sheetCastsSolid(json, barn), true);
  assert.equal(sheetCastsSolid(json, walker), false);
  // A contact at row 0 is one; a sheet the atlas does not know, or no atlas, is not.
  json.frames['walker/0'].base = { contact: 0 };
  assert.equal(sheetCastsSolid(json, walker), true);
  assert.equal(sheetCastsSolid(json, { animations: { x: { prefixedName: 'missing' } } }), false);
  assert.equal(sheetCastsSolid(null, barn), false);
});
