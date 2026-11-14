// DX-MAPS on real code: the octahedral bytes the shaders decode, a heightMap's two encodings, the outline fix the light
// bench found, normals from heights, and the twin page: each frame's maps land at its own rectangle of the atlas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEIGHT_UNITS, decodeOctahedral, encodeOctahedral, fixOutline, frameTwinTexels, normalsFromHeight, readHeights,
} from '../../src/render/spriteMaps.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

const close = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('octahedral bytes: 1..253, 0 never written, and back to the same direction', () => {
  const out = [0, 0];
  for (const n of [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0.6, 0.6, 0.5], [0.3, -0.2, -0.9], [-1, 0, 0]]) {
    encodeOctahedral(n[0], n[1], n[2], out, 0);
    assert.ok(out[0] >= 1 && out[0] <= 253 && out[1] >= 1 && out[1] <= 253, `${out}`);
    const l = Math.hypot(...n);
    const d = decodeOctahedral(out[0], out[1]);
    for (let k = 0; k < 3; k++) close(d[k], n[k] / l, 0.03);
  }
  encodeOctahedral(0, 0, 1, out, 0);
  assert.deepEqual(out, [127, 127], 'facing the camera is the middle');
});

test('a heightMap is R·256 + G in 1/64 px, or a grey picture scaled to its white', () => {
  const rg = new Uint8ClampedArray([1, 0, 0, 255, 0, 64, 0, 255]);
  assert.deepEqual(Array.from(readHeights(rg, 2, 1)), [256 / HEIGHT_UNITS, 1]);
  const grey = new Uint8ClampedArray([255, 255, 255, 255, 51, 51, 51, 255]);
  assert.deepEqual(Array.from(readHeights(grey, 2, 1, 120)), [120, 24]);
});

test('the outline fix raises a pit and a top edge mixed with the background, and nothing else', () => {
  // 3 × 3, all opaque: the middle is 9 px below its neighbours (a table's north outline).
  const h = Float32Array.from([10, 10, 10, 10, 1, 10, 10, 10, 10]);
  const opaque = new Uint8Array(9).fill(1);
  assert.equal(fixOutline(h, opaque, 3, 3), 1);
  assert.equal(h[4], 10);
  // A column: empty above, the pixel below 5 px higher.
  const col = Float32Array.from([0, 2, 7, 7]);
  const colOpaque = Uint8Array.from([0, 1, 1, 1]);
  assert.equal(fixOutline(col, colOpaque, 1, 4), 1);
  assert.equal(col[1], 7);
  // A gentle slope stays as it is.
  const slope = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fixOutline(slope, opaque, 3, 3), 0);
});

test('normals from heights lean away from the climb, in the camera\'s space (y up)', () => {
  const w = 5;
  const opaque = new Uint8Array(25).fill(1);
  const rampX = new Float32Array(25).map((_, p) => p % w);
  const nx = normalsFromHeight(rampX, opaque, w, w);
  const c = 12 * 3;
  assert.ok(nx[c] < -0.5, 'rising to the right: the normal leans left');
  close(nx[c + 1], 0);
  const rampDown = new Float32Array(25).map((_, p) => Math.floor(p / w));
  const ny = normalsFromHeight(rampDown, opaque, w, w);
  assert.ok(ny[c + 1] > 0.5, 'rising down the screen: the normal leans up');
  const flat = normalsFromHeight(new Float32Array(25), opaque, w, w);
  close(flat[c], 0);
  close(flat[c + 1], 0);
  close(flat[c + 2], 1);
});

test('a frame\'s twin texels: height and normal where it is opaque, 0 where it is not', () => {
  const color = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
  const height = new Uint8ClampedArray([0, 128, 0, 255, 0, 128, 0, 255]);
  const t = frameTwinTexels({ color, height, normal: null, w: 2, h: 1 });
  assert.deepEqual(Array.from(t.subarray(0, 4)), [0, 128, 127, 127]);
  assert.deepEqual(Array.from(t.subarray(4, 8)), [0, 0, 0, 0]);
  assert.equal(frameTwinTexels({ color, height: null, normal: null, w: 2, h: 1 }), null);
  const normal = new Uint8ClampedArray([255, 128, 128, 255, 0, 0, 0, 0]);
  const n = frameTwinTexels({ color, height: null, normal, w: 2, h: 1 });
  assert.deepEqual(Array.from(n.subarray(0, 2)), [0, 0], 'no height: on the floor');
  const d = decodeOctahedral(n[2], n[3]);
  assert.ok(d[0] > 0.95, 'the normal map says right');
});

/** A 2D canvas in memory: what createBigAtlas's map page draws and reads. */
class MemCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  getContext() {
    const c = this;
    return {
      drawImage(img, sx, sy, sw, sh, dx, dy) {
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const s = ((sy + y) * img.width + sx + x) * 4;
            const d = ((dy + y) * c.width + dx + x) * 4;
            for (let k = 0; k < 4; k++) c.data[d + k] = img.data[s + k];
          }
        }
      },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let r = 0; r < h; r++) out.set(c.data.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w) * 4), r * w * 4);
        return { data: out, width: w, height: h };
      },
      putImageData(img, dx, dy) {
        for (let r = 0; r < img.height; r++) {
          c.data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((dy + r) * c.width + dx) * 4);
        }
      },
    };
  }
}

/** An image of w × h whose every pixel is fill(x, y). */
function image(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

test('the twin page puts each frame\'s maps at its rectangle of the atlas', () => {
  const savedOC = globalThis.OffscreenCanvas;
  const savedID = globalThis.ImageData;
  globalThis.OffscreenCanvas = MemCanvas;
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  try {
    // A sheet of two 4 × 2 frames side by side; frame b is trimmed to its right half. Heights: frame a 2 px, frame b 5 px.
    const sheet = image(8, 2, (x) => [255, 255, 255, x < 4 || x >= 6 ? 255 : 0]);
    const heights = image(8, 2, (x) => {
      const z = (x < 4 ? 2 : 5) * HEIGHT_UNITS;
      return [z >> 8, z & 255, 0, 255];
    });
    const maps = { heightImg: heights, normalImg: null, gray: 0 };
    const page = SpriteSheetRegistry._paintMapsPage([
      { sourceImg: sheet, sourceRect: { x: 0, y: 0, w: 4, h: 2 }, rect: { x: 10, y: 3, width: 4, height: 2 }, maps },
      { sourceImg: sheet, sourceRect: { x: 6, y: 0, w: 2, h: 2 }, rect: { x: 1, y: 8, width: 2, height: 2 }, maps },
      { sourceImg: sheet, sourceRect: null, rect: { x: 0, y: 0, width: 1, height: 1 }, maps: null },
    ], 16, 12);
    const at = (x, y) => Array.from(page.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    const heightAt = (x, y) => ((at(x, y)[0] << 8) | at(x, y)[1]) / HEIGHT_UNITS;
    for (let y = 3; y < 5; y++) for (let x = 10; x < 14; x++) assert.equal(heightAt(x, y), 2, `frame a at ${x},${y}`);
    for (let y = 8; y < 10; y++) for (let x = 1; x < 3; x++) assert.equal(heightAt(x, y), 5, `frame b at ${x},${y}`);
    assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'a texture without maps leaves its rectangle empty');
    assert.deepEqual(at(9, 3), [0, 0, 0, 0], 'outside every frame');
    assert.deepEqual(at(10, 3).slice(2), [127, 127], 'flat heights: the normal faces the camera');
    assert.equal(SpriteSheetRegistry._paintMapsPage([{ sourceImg: sheet, sourceRect: { x: 0, y: 0, w: 4, h: 2 }, rect: { x: 0, y: 0, width: 4, height: 2 } }], 8, 8), null);
  } finally {
    globalThis.OffscreenCanvas = savedOC;
    globalThis.ImageData = savedID;
  }
});
