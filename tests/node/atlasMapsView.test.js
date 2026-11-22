// DBG-6: the atlas inspector's maps modes decode the twin page (any of E-497's formats) into each frame's rectangle, and
// the readout names the frame and texel under a point. Hand-made texels: a known height, a known octahedral normal.
import test from 'node:test';
import assert from 'node:assert/strict';

import { atlasMapsAt, atlasMapsImage, frameWindow, twinFullSize } from '../../src/core/atlasMapsView.js';
import { encodeOctahedral, HEIGHT_UNITS } from '../../src/render/spriteMaps.js';

const px = (img, x, y) => Array.from(img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** A format-A page: width x height texels, `cells` [x, y, heightPx, normal] written. */
function pageA(width, height, cells) {
  const texels = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, z, n] of cells) {
    const a = (y * width + x) * 4;
    const code = Math.round(z * HEIGHT_UNITS);
    texels[a] = code >> 8;
    texels[a + 1] = code & 255;
    encodeOctahedral(n[0], n[1], n[2], texels, a + 2);
  }
  return { texels, width, height };
}

// Two frames side by side in a 4 x 1 atlas: f1 has maps (a height map) in the twin's window at (4, 0); f2 is unshaded.
const json = {
  frames: {
    f1: { frame: { x: 0, y: 0, w: 2, h: 1 }, maps: { x: 4, y: 0, heights: true } },
    f2: { frame: { x: 2, y: 0, w: 2, h: 1 }, unshaded: true },
  },
  meta: { size: { w: 4, h: 1 }, maps: true },
};
const page = pageA(6, 1, [[4, 0, 10, [0, 0, 1]], [5, 0, 20, [1, 0, 0]]]);

test('height: a ramp to the page\'s highest point over the frame\'s own rectangle; no map stays clear', () => {
  const img = atlasMapsImage(page, json, 'height');
  assert.equal(img.maxZ, 20);
  assert.equal(img.frames, 2);
  assert.deepEqual(px(img, 0, 0), [255, 115, 13, 255], 'half the highest: the ramp\'s middle');
  assert.deepEqual(px(img, 1, 0), [255, 255, 255, 255], 'the highest: white');
  assert.deepEqual(px(img, 2, 0), [0, 0, 0, 0], 'the unshaded frame has no map');
});

test('normals: 0.5 + 0.5 n of the stored normal', () => {
  const img = atlasMapsImage(page, json, 'normals');
  const [r, g, b] = px(img, 0, 0);
  assert.ok(Math.abs(r - 128) <= 2 && Math.abs(g - 128) <= 2 && b >= 253, `straight up: ${r}, ${g}, ${b}`);
  const [r2, , b2] = px(img, 1, 0);
  assert.ok(r2 >= 253 && Math.abs(b2 - 128) <= 2, `along x: ${r2}, ${b2}`);
});

test('marks: blue a height map, magenta an unshaded frame; relief greys a frame of no relief sheet', () => {
  const marks = atlasMapsImage(page, json, 'marks');
  assert.deepEqual(px(marks, 0, 0), [40, 110, 255, 255]);
  assert.deepEqual(px(marks, 3, 0), [230, 40, 230, 255]);
  const relief = atlasMapsImage(page, json, 'relief');
  assert.deepEqual(px(relief, 0, 0), [70, 70, 70, 255]);
});

test('format B: heights two to a texel (code + 1), no normals (grey)', () => {
  const texels = new Uint8ClampedArray(4);
  const c0 = Math.round(5 * HEIGHT_UNITS) + 1;
  const c1 = Math.round(7 * HEIGHT_UNITS) + 1;
  texels[0] = c0 >> 8;
  texels[1] = c0 & 255;
  texels[2] = c1 >> 8;
  texels[3] = c1 & 255;
  const pageB = { texels, width: 1, height: 1 };
  const jsonB = { frames: { f: { frame: { x: 0, y: 0, w: 2, h: 1 }, maps: { x: 0, y: 0 } } }, meta: { size: { w: 2, h: 1 }, maps: true, mapsFormat: 'B' } };
  assert.deepEqual(twinFullSize(pageB, 'B'), { w: 2, h: 1 });
  const img = atlasMapsImage(pageB, jsonB, 'height');
  assert.equal(img.maxZ, 7);
  assert.deepEqual(px(img, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(atlasMapsImage(pageB, jsonB, 'normals'), 0, 0), [128, 128, 128, 255]);
});

test('a bake from before E-496: no frame names a window, the page has the atlas\'s size, frames read their own texels', () => {
  const old = { frames: { f: { frame: { x: 1, y: 0, w: 1, h: 1 } } }, meta: { size: { w: 2, h: 1 }, maps: true } };
  const p = pageA(2, 1, [[1, 0, 3, [0, 0, 1]]]);
  assert.equal(frameWindow(old.frames.f, false), null);
  const img = atlasMapsImage(p, old, 'height');
  assert.deepEqual(px(img, 1, 0), [255, 255, 255, 255]);
});

test('the readout: the frame under a point, its marks, and the texel there', () => {
  const at = atlasMapsAt(page, json, 1, 0);
  assert.equal(at.name, 'f1');
  assert.equal(at.marks.heights, true);
  assert.equal(at.texel.z, 20);
  const unshaded = atlasMapsAt(page, json, 3, 0);
  assert.equal(unshaded.name, 'f2');
  assert.equal(unshaded.marks.unshaded, true);
  assert.equal(unshaded.texel, null);
  assert.equal(atlasMapsAt(page, json, 9, 9), null);
  assert.equal(atlasMapsAt(null, json, 0, 0).texel, null, 'before the page is read: the frame alone');
});
