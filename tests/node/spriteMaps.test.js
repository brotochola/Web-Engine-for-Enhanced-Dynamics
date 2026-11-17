// DX-MAPS on real code: the octahedral bytes the shaders decode, a heightMap's two encodings, the outline fix the light
// bench found, normals from heights, and the twin page (E-496): each frame's maps in a window of its own, shared by
// sheets with the same map files, and the maps table that says where.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEIGHT_UNITS, decodeOctahedral, encodeOctahedral, fixOutline, frameTwinTexels, normalsFromHeight, readHeights,
} from '../../src/render/spriteMaps.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { MAPS_HEIGHTS, MAPS_TWIN, TWIN_PAD, mapsTableLayout, packMapsTable } from '../../src/render/mapsTable.js';
import { twinPresent } from '../../src/render/twinTexel.js';

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

/** Runs fn with the in-memory canvas standing in for OffscreenCanvas and ImageData. */
function withMemCanvas(fn) {
  const savedOC = globalThis.OffscreenCanvas;
  const savedID = globalThis.ImageData;
  globalThis.OffscreenCanvas = MemCanvas;
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  try {
    return fn();
  } finally {
    globalThis.OffscreenCanvas = savedOC;
    globalThis.ImageData = savedID;
  }
}

// E-496: the twin page holds the frames with maps alone, each in a window of its own, TWIN_PAD texels from every other
// rectangle and from the page's edges, at even texels; the texels in a window are what the frame's own rectangle of the
// atlas-sized page held.
test('the twin page holds each frame\'s maps in a window of its own, padded and even, not at its atlas rectangle', () => {
  withMemCanvas(() => {
    // A sheet of two 4 × 2 frames side by side; frame b is trimmed to its right half. Heights: frame a 2 px, frame b 5 px.
    const sheet = image(8, 2, (x) => [255, 255, 255, x < 4 || x >= 6 ? 255 : 0]);
    const heights = image(8, 2, (x) => {
      const z = (x < 4 ? 2 : 5) * HEIGHT_UNITS;
      return [z >> 8, z & 255, 0, 255];
    });
    const maps = { heightImg: heights, normalImg: null, gray: 0 };
    const frames = [
      { sourceImg: sheet, sourceRect: { x: 0, y: 0, w: 4, h: 2 }, frameRect: { x: 0, y: 0, w: 4, h: 2 }, rect: { x: 10, y: 3, width: 4, height: 2 }, maps },
      { sourceImg: sheet, sourceRect: { x: 6, y: 0, w: 2, h: 2 }, frameRect: { x: 4, y: 0, w: 4, h: 2 }, sourceX: 2, rect: { x: 1, y: 8, width: 2, height: 2 }, maps },
      { sourceImg: sheet, sourceRect: null, rect: { x: 0, y: 0, width: 1, height: 1 }, maps: null },
    ];
    const twin = SpriteSheetRegistry._paintMapsPage(frames, 64, 64, true);
    const { width, texels } = twin;
    assert.equal(twin.canvas.width, width);
    assert.equal(width % 2, 0, 'an even width');
    assert.equal(twin.height % 2, 0, 'an even height');
    assert.ok(width * twin.height < 16 * 12, 'smaller than the atlas: only the frames with maps');
    const at = (x, y) => Array.from(texels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    const heightAt = (x, y) => ((at(x, y)[0] << 8) | at(x, y)[1]) / HEIGHT_UNITS;
    const [a, b, none] = frames;
    assert.equal(none.mapsAt, undefined, 'a texture without maps has no window');
    for (const [d, z, w, h] of [[a, 2, 4, 2], [b, 5, 2, 2]]) {
      assert.ok(d.mapsAt.x >= TWIN_PAD && d.mapsAt.y >= TWIN_PAD, 'padded from the page\'s edges');
      assert.equal(d.mapsAt.x % 2, 0, 'at an even texel');
      assert.equal(d.mapsAt.y % 2, 0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal(heightAt(d.mapsAt.x + x, d.mapsAt.y + y), z);
      // TWIN_PAD texels of nothing all round it.
      for (let k = 1; k <= TWIN_PAD; k++) {
        assert.deepEqual(at(d.mapsAt.x - k, d.mapsAt.y), [0, 0, 0, 0]);
        assert.deepEqual(at(d.mapsAt.x, d.mapsAt.y - k), [0, 0, 0, 0]);
      }
    }
    assert.deepEqual(at(a.mapsAt.x, a.mapsAt.y).slice(2), [127, 127], 'flat heights: the normal faces the camera');
    assert.equal(SpriteSheetRegistry._paintMapsPage([{ sourceImg: sheet, sourceRect: { x: 0, y: 0, w: 4, h: 2 }, rect: { x: 0, y: 0, width: 4, height: 2 } }], 8, 8), null);
  });
});

// E-496: sheets naming the same map files share one rectangle a frame (the union of their trims), each frame's window its
// own trim in it; the opaque pixels it holds maps for are every sharing frame's.
test('sheets with the same map files share one rectangle of the twin page, each frame at its own trim', () => {
  withMemCanvas(() => {
    // Two 6 × 2 sheets over one height map (3 px everywhere): sheet p is opaque in columns 0-3, sheet q in 2-5.
    const heights = image(6, 2, () => [0, 3 * HEIGHT_UNITS, 0, 255]);
    const p = image(6, 2, (x) => [255, 0, 0, x <= 3 ? 255 : 0]);
    const q = image(6, 2, (x) => [0, 0, 255, x >= 2 ? 255 : 0]);
    const shared = (key) => ({ heightImg: heights, normalImg: null, gray: 0, key });
    const fr = { x: 0, y: 0, w: 6, h: 2 };
    const fp = { sourceImg: p, sourceRect: { x: 0, y: 0, w: 4, h: 2 }, frameRect: fr, sourceX: 0, rect: { x: 0, y: 0, width: 4, height: 2 }, maps: shared('body') };
    const fq = { sourceImg: q, sourceRect: { x: 2, y: 0, w: 4, h: 2 }, frameRect: fr, sourceX: 2, rect: { x: 8, y: 0, width: 4, height: 2 }, maps: shared('body') };
    const twin = SpriteSheetRegistry._paintMapsPage([fp, fq], 64, 64, true);
    assert.equal(fq.mapsAt.x - fp.mapsAt.x, 2, 'q\'s window is its trim\'s offset into the shared rectangle');
    assert.equal(fq.mapsAt.y, fp.mapsAt.y);
    const present = (x, y) => twinPresent(twin.texels, (y * twin.width + x) * 4);
    for (let x = 0; x < 6; x++) assert.equal(present(fp.mapsAt.x + x, fp.mapsAt.y), true, `the union of their opaque pixels, column ${x}`);
    // Other files: rectangles of their own.
    const fp2 = { ...fp, mapsAt: undefined };
    const fq2 = { ...fq, maps: shared('other'), mapsAt: undefined };
    const apart = SpriteSheetRegistry._paintMapsPage([fp2, fq2], 64, 64, true);
    assert.ok(apart.width * apart.height > twin.width * twin.height, 'two rectangles take more room than one');
    const sameRect = fq2.mapsAt.x - fp2.mapsAt.x === 2 && fq2.mapsAt.y === fp2.mapsAt.y;
    assert.equal(sameRect, false, 'q is not in p\'s rectangle');
    // Its own rectangle holds q's opaque pixels alone: p's columns 0-1 are not in it.
    const at = (x, y) => (y * apart.width + x) * 4;
    assert.equal(twinPresent(apart.texels, at(fq2.mapsAt.x, fq2.mapsAt.y)), true);
    assert.equal(twinPresent(apart.texels, at(fq2.mapsAt.x - 1, fq2.mapsAt.y)), false, 'padding before it');
  });
});

// E-496: the maps table, a texel a textureId: the window's offset from the frame's atlas rectangle, and its marks.
test('the maps table gives each frame its window\'s offset and marks, nothing to a frame without maps', () => {
  const textures = [
    { frame: { x: 10, y: 3 }, weedMaps: { x: 4, y: 2, heights: true } },
    { frame: { x: 1, y: 8 }, weedMaps: { x: 2, y: 6 } },
    { frame: { x: 0, y: 0 } },
    null,
  ];
  const t = packMapsTable(textures);
  assert.deepEqual([t.width, t.height], [1, 4]);
  assert.equal(t.mapped, 2);
  assert.deepEqual(Array.from(t.data.subarray(0, 4)), [-6, -1, MAPS_TWIN | MAPS_HEIGHTS, 0]);
  assert.deepEqual(Array.from(t.data.subarray(4, 8)), [1, -2, MAPS_TWIN, 0]);
  assert.deepEqual(Array.from(t.data.subarray(8, 16)), [0, 0, 0, 0, 0, 0, 0, 0]);
  // A bake from before E-496: its twin page is the atlas's layout, every frame read at offset 0.
  const old = packMapsTable([{ frame: { x: 5, y: 5 } }], true);
  assert.deepEqual(Array.from(old.data), [0, 0, MAPS_TWIN | MAPS_HEIGHTS, 0]);
  // N-111's fold: past the most rows, each row holds several.
  assert.deepEqual(mapsTableLayout(5000, 2048), { width: 3, height: 1667 });
  assert.deepEqual(mapsTableLayout(0), { width: 1, height: 1 });
});
