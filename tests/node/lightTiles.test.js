// E-205: the light pass's lights by screen tile (src/render/lightTiles.js). The bins must never leave a light out of a
// tile where it adds anything: each test packs lights as pixiWorker does, bins them for a camera, and checks every pixel
// of a small light pass the way lightingBasic does: its floor point (a floor pixel's own, a face pixel's under its
// height), the light's reachWindow there, and the tile the shader looks the point up in.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIGHT_TILE_BORDER,
  LIGHT_TILE_PX,
  LightTiles,
  TILE_CAM_COS,
  TILE_CAM_FULL_H,
  TILE_CAM_FULL_W,
  TILE_CAM_GROUND_INV_Y,
  TILE_CAM_MARGIN,
  TILE_CAM_SIN,
  TILE_CAM_SNAP,
  TILE_CAM_X,
  TILE_CAM_Y,
  TILE_CAM_ZOOM,
  binLightTiles,
  layoutLightTiles,
  writeLightTileUniforms,
} from '../../src/render/lightTiles.js';
import { LIGHT_DATA_TEX_HEIGHT } from '../../src/util/utils.js';

const f32 = Math.fround;

/** A camera as the light pass's uniforms carry it (float32). */
function camera({ x = 0, y = 0, zoom = 1, rot = 0, fullW = 480, fullH = 270, viewW = 240, viewH = 135, groundScaleY = 0.7, heightScaleY = 0.75 } = {}) {
  return {
    x: f32(x), y: f32(y), zoom: f32(zoom), c: f32(Math.cos(rot)), s: f32(Math.sin(rot)),
    fullW, fullH, viewW, viewH, gInv: f32(1 / groundScaleY), hsy: f32(heightScaleY),
  };
}

/** Lights packed as _packLightData packs them: row 0 x, floor y, I' (radius² / 100 + h²); row 1's w the height. */
function pack(lights, maxLights) {
  const data = new Float32Array(maxLights * LIGHT_DATA_TEX_HEIGHT * 4);
  lights.forEach((l, i) => {
    const h = l.h ?? 0;
    const base = (l.r * l.r) / 100;
    data[i * 4] = l.x;
    data[i * 4 + 1] = l.floorY;
    data[i * 4 + 2] = l.intensity ?? (h > 0 ? base + h * h : base);
    data[(maxLights + i) * 4 + 3] = h;
  });
  return data;
}

function binned(cam, lights, { maxLights = 64, count = lights.length, snap = 0, rowAlign = 1, margin = null } = {}) {
  const t = new LightTiles();
  t.cam[TILE_CAM_SNAP] = snap;
  if (margin !== null) t.cam[TILE_CAM_MARGIN] = margin;
  layoutLightTiles(t, cam.viewW, cam.viewH, maxLights, rowAlign);
  const c = t.cam;
  c[TILE_CAM_ZOOM] = cam.zoom;
  c[TILE_CAM_X] = cam.x;
  c[TILE_CAM_Y] = cam.y;
  c[TILE_CAM_COS] = cam.c;
  c[TILE_CAM_SIN] = cam.s;
  c[TILE_CAM_FULL_W] = cam.fullW;
  c[TILE_CAM_FULL_H] = cam.fullH;
  c[TILE_CAM_GROUND_INV_Y] = cam.gInv;
  const data = pack(lights, maxLights);
  const words = binLightTiles(t, data, maxLights, count);
  return { t, data, words, maxLights };
}

/** lightingBasic's weedScreenToWorld for a pixel centre (px, py) of the pass, unflipped. */
function pixelWorld(cam, px, py) {
  const sx = (px / cam.viewW) * cam.fullW - cam.fullW * 0.5;
  const sy = (py / cam.viewH) * cam.fullH - cam.fullH * 0.5;
  const fx = cam.x + cam.fullW / (2 * cam.zoom);
  const fy = cam.y + cam.fullH / (2 * cam.zoom);
  return [fx + (cam.c * sx + cam.s * sy) / cam.zoom, fy + (-cam.s * sx + cam.c * sy) / cam.zoom];
}

/** weedWorldToNorm × uViewport. */
function worldPixel(cam, wx, wy) {
  const fx = cam.x + cam.fullW / (2 * cam.zoom);
  const fy = cam.y + cam.fullH / (2 * cam.zoom);
  const dx = (wx - fx) * cam.zoom;
  const dy = (wy - fy) * cam.zoom;
  return [((cam.c * dx - cam.s * dy + cam.fullW * 0.5) / cam.fullW) * cam.viewW, ((cam.s * dx + cam.c * dy + cam.fullH * 0.5) / cam.fullH) * cam.viewH];
}

/** lightingBasic's reachWindow > 0 at floor point (x, y) for light i, in float32 as the GPU computes it. */
function reaches(data, maxLights, i, x, y) {
  const lx = data[i * 4];
  const ly = data[i * 4 + 1];
  const ip = data[i * 4 + 2];
  const h = data[(maxLights + i) * 4 + 3];
  if (!(ip > 0)) return false;
  const d2 = f32(f32((x - lx) * (x - lx)) + f32((y - ly) * (y - ly)));
  const room = f32(ip - f32(h * h));
  const q = f32(d2 / f32(100 * (room > 1e-6 ? room : 1e-6)));
  return 1 - q * q > 0;
}

/** The shader's lightTile: a tile of the grid, or null for the every-light row. */
function tileOf(t, px, py) {
  const tx = Math.floor(px / t.tilePx) + t.border;
  const ty = Math.floor(py / t.tilePx) + t.border;
  return tx >= 0 && ty >= 0 && tx < t.cols && ty < t.rows ? [tx, ty] : null;
}

function hasBit(t, tile, i) {
  const ty = tile === null ? t.rows : tile[1];
  const tx = tile === null ? 0 : tile[0];
  const word = t.bits[((i >> 5) * t.rowsPerWord + ty) * t.texWidth + tx];
  return ((word >>> (i & 31)) & 1) === 1;
}

/**
 * Every pixel of the pass, as a floor pixel and as face pixels at a few heights: each light that reaches the point has its
 * bit in the point's tile. Returns how many (pixel, light) pairs were lit, so a test can tell it checked something.
 */
function assertConservative(cam, lights, opts = {}) {
  const { t, data, maxLights } = binned(cam, lights, opts);
  const heights = opts.heights ?? [0, 37.5, 160, 900];
  let lit = 0;
  for (let py = 0.5; py < cam.viewH; py += 1) {
    for (let px = 0.5; px < cam.viewW; px += 1) {
      let [wx, wy] = pixelWorld(cam, px, py);
      if (opts.snap) {
        wx = Math.floor(wx) + 0.5;
        wy = Math.floor(wy) + 0.5;
      }
      for (const z of heights) {
        // A face pixel's floor point is under it: z px up rises z · heightScaleY on the screen. Its tile is looked up there
        // (a floor pixel, z 0, at its own place: the pixel's centre, before pixel art's snap).
        const fy = wy + z * cam.hsy;
        const tile = z === 0 ? tileOf(t, px, py) : tileOf(t, ...worldPixel(cam, wx, fy));
        for (let i = 0; i < lights.length; i++) {
          if (!reaches(data, maxLights, i, wx, fy * cam.gInv)) continue;
          lit++;
          if (!hasBit(t, tile, i)) {
            assert.fail(`light ${i} reaches pixel (${px}, ${py}) at height ${z} but is not in its tile ${tile}`);
          }
        }
      }
    }
  }
  return { t, lit };
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(n, cam, seed, { minR = 20, maxR = 160 } = {}) {
  const rng = seeded(seed);
  const spanX = cam.fullW / cam.zoom;
  const spanY = cam.fullH / cam.zoom;
  return Array.from({ length: n }, () => ({
    x: cam.x - 0.3 * spanX + rng() * 1.6 * spanX,
    floorY: (cam.y - 0.3 * spanY + rng() * 1.6 * spanY) * cam.gInv,
    r: minR + rng() * (maxR - minR),
    h: rng() < 0.5 ? 0 : 10 + rng() * 120,
  }));
}

test('a straight camera: every light is in every tile where it reaches a floor or a face pixel', () => {
  const cam = camera({ x: 100, y: -40, zoom: 0.8 });
  const { lit } = assertConservative(cam, scatter(24, cam, 1));
  assert.ok(lit > 10000, `the lights reach pixels (${lit})`);
  // The ellipses alone, without the margin for the GPU's float error, are already conservative.
  assertConservative(cam, scatter(24, cam, 1), { margin: 0 });
});

test('a turned and zoomed camera, and pixel art\'s snap', () => {
  const cam = camera({ x: -300, y: 220, zoom: 1.7, rot: 0.7 });
  assertConservative(cam, scatter(16, cam, 2, { minR: 10, maxR: 90 }));
  assertConservative(cam, scatter(16, cam, 2, { minR: 10, maxR: 90 }), { margin: 0 });
  const art = camera({ x: 13, y: 7, zoom: 3, rot: -2.4, groundScaleY: 0.5 });
  assertConservative(art, scatter(12, art, 3, { minR: 4, maxR: 40 }), { snap: 0.5 });
});

test('lights whose reach ends on a tile edge, centred on a tile corner, and off the screen', () => {
  const cam = camera({ zoom: 1, viewW: 240, viewH: 135, fullW: 240, fullH: 135, groundScaleY: 1 });
  const T = LIGHT_TILE_PX;
  const lights = [
    // Centred on a tile corner.
    { x: 3 * T, floorY: 2 * T, r: 20 },
    // Its reach ends exactly on the edge between two columns, and two rows.
    { x: 5 * T + 8, floorY: 4 * T + 8, r: 24 },
    { x: 10 * T, floorY: 5 * T, r: 2 * T },
    // Past the left edge, reaching in by a few px; and one whose reach stops just short of the screen.
    { x: -30, floorY: 60, r: 34 },
    { x: 300, floorY: 60, r: 59 },
    // Reaches ending a twentieth of a px past the centre of the first pixel of the next column, the next row, and (to
    // the left) of the last pixel of the column before: that tile holds one lit pixel.
    { x: 88, floorY: 40, r: 24.55 },
    { x: 40, floorY: 88, r: 24.55 },
    { x: 136, floorY: 100, r: 24.55 },
  ];
  const { t } = assertConservative(cam, lights, { heights: [0] });
  assertConservative(cam, lights, { heights: [0], margin: 0 });
  // The one past the left edge is in column 0 of the screen (grid column `border`), not past column 1.
  const inCol = (i, col) => Array.from({ length: t.rows }, (_, ty) => hasBit(t, [col, ty], i)).some(Boolean);
  assert.ok(inCol(3, LIGHT_TILE_BORDER), 'the light past the edge reaches the first column');
  assert.ok(!inCol(3, LIGHT_TILE_BORDER + 2), 'and not the third');
});

test('a light covering the whole screen is in every tile; one with no intensity in none but the every-light row', () => {
  const cam = camera({ rot: 0.3 });
  const { t } = binned(cam, [{ x: 240, floorY: 190, r: 5000, h: 30 }, { x: 240, floorY: 190, r: 100, intensity: 0 }]);
  for (let ty = 0; ty < t.rows; ty++) {
    for (let tx = 0; tx < t.cols; tx++) {
      assert.ok(hasBit(t, [tx, ty], 0), `tile ${tx}, ${ty}`);
      assert.ok(!hasBit(t, [tx, ty], 1), `tile ${tx}, ${ty} without the dark light`);
    }
  }
  assert.ok(hasBit(t, null, 0) && hasBit(t, null, 1), 'the every-light row holds both');
});

test('no lights: no words, every bit clear; then fewer lights clear what the last bin wrote', () => {
  const cam = camera();
  const { t, words } = binned(cam, []);
  assert.equal(words, 0);
  assert.equal(t.wordsUsed, 0);
  assert.ok(t.bits.every((w) => w === 0));
  const lights = scatter(40, cam, 4);
  const data = pack(lights, 64);
  assert.equal(binLightTiles(t, data, 64, 40), 2);
  assert.ok(t.bits.some((w) => w !== 0));
  assert.equal(binLightTiles(t, data, 64, 0), 0);
  assert.ok(t.bits.every((w) => w === 0), 'the next frame with no lights leaves nothing behind');
});

test('more lights than a word: each light\'s bit in its own word\'s band, every one conservative', () => {
  const cam = camera({ x: 50, y: 50, zoom: 0.6, rot: 1.1 });
  const lights = scatter(77, cam, 5, { minR: 15, maxR: 70 });
  const { t, lit } = assertConservative(cam, lights, { maxLights: 96, heights: [0, 120] });
  assertConservative(cam, lights, { maxLights: 96, heights: [0, 120], margin: 0 });
  assert.equal(t.words, 3);
  assert.equal(t.wordsUsed, 3);
  assert.ok(lit > 0);
  // Light 70 (word 2, bit 6) shows up only in word 2's band.
  const word2 = t.bits.subarray(2 * t.rowsPerWord * t.texWidth, 3 * t.rowsPerWord * t.texWidth);
  assert.ok(word2.some((w) => ((w >>> 6) & 1) === 1));
  for (let i = 0; i < 77; i++) assert.ok(hasBit(t, null, i), `the every-light row holds light ${i}`);
});

test('the bins are tight: a light is in few tiles past those its reach touches', () => {
  const cam = camera({ zoom: 1, viewW: 480, viewH: 270, fullW: 960, fullH: 540 });
  const lights = scatter(20, cam, 6, { minR: 40, maxR: 200 });
  const { t, data, maxLights } = binned(cam, lights, { margin: 0 });
  let set = 0;
  let touched = 0;
  for (let i = 0; i < lights.length; i++) {
    const hit = new Set();
    for (let py = 0.5; py < cam.viewH; py += 1) {
      for (let px = 0.5; px < cam.viewW; px += 1) {
        const [wx, wy] = pixelWorld(cam, px, py);
        if (reaches(data, maxLights, i, wx, wy * cam.gInv)) hit.add(`${Math.floor(px / t.tilePx)},${Math.floor(py / t.tilePx)}`);
      }
    }
    touched += hit.size;
    for (let ty = t.border; ty < t.rows - t.border; ty++) {
      for (let tx = t.border; tx < t.cols - t.border; tx++) if (hasBit(t, [tx, ty], i)) set++;
    }
  }
  assert.ok(set >= touched, 'conservative');
  assert.ok(set <= touched * 1.15 + 4 * lights.length, `on the screen ${set} tiles set where the lights touch ${touched}`);
});

test('the layout: a word\'s band is the grid and the every-light row; WebGPU rows of 256 bytes; uniforms', () => {
  const t = new LightTiles();
  assert.equal(layoutLightTiles(t, 960, 540, 256, 64), true);
  assert.equal(t.cols, 60 + 2 * LIGHT_TILE_BORDER);
  assert.equal(t.rows, 34 + 2 * LIGHT_TILE_BORDER);
  assert.equal(t.rowsPerWord, t.rows + 1);
  assert.equal(t.words, 8);
  assert.equal(t.texWidth % 64, 0);
  assert.equal(t.texHeight, t.rowsPerWord * 8);
  assert.equal(layoutLightTiles(t, 960, 540, 256, 64), false, 'the same size keeps the texture');
  const grid = new Float32Array(4);
  const words = new Float32Array(4);
  writeLightTileUniforms(t, grid, words);
  assert.deepEqual([...grid], [LIGHT_TILE_PX, LIGHT_TILE_BORDER, t.cols, t.rows]);
  assert.deepEqual([...words.subarray(0, 2)], [0, t.rowsPerWord]);
  // A target so tall that 16 px tiles would not fit a texture's rows takes bigger tiles.
  const tall = new LightTiles();
  layoutLightTiles(tall, 2048, 8192, 1024, 1);
  assert.ok(tall.texHeight <= 4096 && tall.tilePx > LIGHT_TILE_PX);
});
