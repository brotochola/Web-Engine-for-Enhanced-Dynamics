// E-76 W26: the decal stamp kernel (wasm/test/decalStamp.c, a test module) against the JS stamp the engine shipped
// (tests/reference/decalStamp.mjs), bit for bit. Random batches built to reach every branch: stamps clipped at tile
// and world edges, on tile and pixel boundaries, outside the world, NaN and infinite positions; stamps a
// whole number of pixels wide that start an ulp before a pixel edge, the only ones whose last column and
// row sample past the texture (the JS skips those); scales of 0, negative, NaN and infinite, under a pixel,
// and over many tiles; alpha 1 and float32 values in (0, 1) (the vector loop), float32 values too small to
// draw, just under and just over 256/255, doubles that are not float32, past 256/255 (the stores clamp), 0,
// negative, huge (ToInt32 wraps), NaN and infinite (the scalar loop); tints past 2^31, negative and
// fractional; both blend modes and one that is neither; blood.png, dense, sparse, opaque, 1 × 1 and
// odd-sized textures; tiles of random bytes; a column map narrower than some clips. Each batch: the same
// tiles and dirty flags as the JS, the tile count the JS loop reaches, and no byte written outside the
// kernel's tiles, flags and column map. stampToTileBuffers has no rotation, so no stamp here rotates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stampToTileBuffers } from '../reference/decalStamp.mjs';
import { calculateDecalTileBounds, calculateTileClipRegion } from '../../src/util/utils.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { bloodTexture, columnBytes, DECAL_SLOTS, F_SCALAR, KERNEL_URL, STAMP_BYTES } from '../bench/decalStampWasmMicrobench.mjs';

const BATCH = 96;
const BATCHES = 50;

// Tile layouts: 32 px tiles; 37 px tiles (a world-to-pixel ratio that is not a power of two); the scene's
// 128 px tiles with a column map 9 wide, so wider clips take the scalar loop; 48 px tiles at resolution 1.
const CONFIGS = [
  { tileSize: 64, resolution: 0.5, tilesX: 5, tilesY: 4 },
  { tileSize: 100, resolution: 0.37, tilesX: 4, tilesY: 3 },
  { tileSize: 256, resolution: 0.5, tilesX: 3, tilesY: 2, columnsCap: 9 },
  { tileSize: 48, resolution: 1, tilesX: 3, tilesY: 3 },
];

const EDGE_ALPHAS = [
  0, -0, 1, 0.7, 0.123456789, 1e-3, Math.fround(0.0045), Math.fround(0.01), Math.fround(1e-30), 2 ** -130,
  Math.fround(1.0039215), Math.fround(1.0039216), 1.5, 3, 300, 2.5e9, 1e12, -0.5, -2.5e9, -1e12, NaN, Infinity,
  -Infinity,
];
const EDGE_TINTS = [0, 0xffffff, 0xffffffff, 0x80000000, -1, 1234.5, NaN];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function textures(r) {
  const make = (width, height, alphaAt) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = (r() * 256) | 0;
      rgba[i * 4 + 1] = (r() * 256) | 0;
      rgba[i * 4 + 2] = (r() * 256) | 0;
      rgba[i * 4 + 3] = alphaAt(i % width, (i / width) | 0);
    }
    return { width, height, rgba };
  };
  return [
    bloodTexture(),
    make(24, 24, () => {
      const u = r();
      return u < 0.15 ? 0 : u < 0.25 ? 1 : u < 0.35 ? 255 : (r() * 256) | 0;
    }),
    make(16, 16, (x, y) => (((x >> 2) + (y >> 2)) & 1 ? 200 : 0)),
    make(8, 8, () => 255),
    make(1, 1, () => 255),
    make(7, 3, () => (r() * 256) | 0),
    make(33, 17, () => (r() < 0.5 ? 0 : 128 + ((r() * 128) | 0))),
  ];
}

/** The kernel's vector loop takes a float32 alpha in (0, 256/255) (decalStamp.c). */
const vectorAlpha = (a) => a > 0 && a * 255 < 256 && Math.fround(a) === a;

function position(r, extent, tileSize, pixel) {
  const u = r();
  if (u < 0.02) return [NaN, Infinity, -Infinity, 1e12, -1e12][(r() * 5) | 0];
  let v = -tileSize * 0.5 + r() * (extent + tileSize);
  if (u < 0.12) v = Math.round(v / tileSize) * tileSize;
  else if (u < 0.2) v = Math.round(v / pixel) * pixel;
  return r() < 0.3 ? Math.fround(v) : v;
}

function scale(r) {
  const u = r();
  if (u < 0.02) return 0;
  if (u < 0.04) return -1 - r();
  if (u < 0.06) return 1e-4 * r();
  if (u < 0.07) return NaN;
  if (u < 0.08) return Infinity;
  if (u < 0.13) return 6 + r() * 10;
  return Math.fround(0.05 + r() * 3);
}

const nudgeF64 = new Float64Array(1);
const nudgeI64 = new BigInt64Array(nudgeF64.buffer);
/** `v` moved by `k` ulps. */
function nudge(v, k) {
  nudgeF64[0] = v;
  nudgeI64[0] += BigInt(k);
  return nudgeF64[0];
}

/**
 * A stamp n tile pixels wide on each axis whose left and top edges sit up to two ulps before tile pixel p:
 * its last column and row can sample one texel past the texture.
 */
function edgeStamp(r, cfg, tex) {
  const tilePixels = Math.floor(cfg.tileSize * cfg.resolution);
  const toPixel = tilePixels / cfg.tileSize;
  const n = 1 + ((r() * 12) | 0);
  const scaleX = n / (tex.width * toPixel);
  const scaleY = n / (tex.height * toPixel);
  const at = (tiles, scaleV, size) => {
    const p = 1 + ((r() * Math.max(1, tilePixels - n - 1)) | 0);
    const tile = (r() * tiles) | 0;
    return nudge(tile * cfg.tileSize + p / toPixel + (size * scaleV) / 2, -((r() * 3) | 0));
  };
  return { worldX: at(cfg.tilesX, scaleX, tex.width), worldY: at(cfg.tilesY, scaleY, tex.height), scaleX, scaleY };
}

function randomStamp(r, cfg, texList) {
  const tilePixels = Math.floor(cfg.tileSize * cfg.resolution);
  const pixel = cfg.tileSize / tilePixels;
  const texture = (r() * texList.length) | 0;
  let place;
  if (r() < 0.1) place = edgeStamp(r, cfg, texList[texture]);
  else {
    const scaleX = scale(r);
    place = {
      worldX: position(r, cfg.tilesX * cfg.tileSize, cfg.tileSize, pixel),
      worldY: position(r, cfg.tilesY * cfg.tileSize, cfg.tileSize, pixel),
      scaleX,
      scaleY: r() < 0.7 ? scaleX : scale(r),
    };
  }
  const u = r();
  return {
    ...place,
    alpha: u < 0.3 ? EDGE_ALPHAS[(r() * EDGE_ALPHAS.length) | 0] : Math.fround(0.02 + r() * 0.98),
    tint: r() < 0.1 ? EDGE_TINTS[(r() * EDGE_TINTS.length) | 0] : (r() * 2 ** 32) >>> 0,
    blendMode: r() < 0.45 ? 1 : r() < 0.1 ? 2 : 0,
    texture,
  };
}

/**
 * What stampToTileBuffers's loop reaches for one stamp, through the same helpers: the tiles it flags, and
 * whether a column or a row samples outside the texture (the JS `continue`s on srcX and srcY).
 */
function walk(s, tex, cfg, tilePixels) {
  const out = { tiles: 0, pastColumn: false, pastRow: false };
  const halfW = (tex.width * s.scaleX) / 2;
  const halfH = (tex.height * s.scaleY) / 2;
  const sw = (tex.width * s.scaleX * cfg.resolution + 0.999) | 0;
  const sh = (tex.height * s.scaleY * cfg.resolution + 0.999) | 0;
  const bounds = calculateDecalTileBounds(s.worldX, s.worldY, halfW, halfH, cfg.tileSize, cfg.tilesX, cfg.tilesY, {});
  if (!bounds.valid) return out;
  for (let ty = bounds.minTileY; ty <= bounds.maxTileY; ty++) {
    for (let tx = bounds.minTileX; tx <= bounds.maxTileX; tx++) {
      const c = calculateTileClipRegion(s.worldX, s.worldY, halfW, halfH, tx, ty, cfg.tileSize, tilePixels, tex.width, tex.height, sw, sh, {});
      if (!c.valid) continue;
      out.tiles++;
      const stepX = c.uvScaleX * (tex.width / sw);
      const stepY = c.uvScaleY * (tex.height / sh);
      let acc = c.srcOffsetX * (tex.width / sw);
      for (let x = c.dstStartX; x < c.dstEndX; x++, acc += stepX) if ((acc | 0) < 0 || (acc | 0) >= tex.width) out.pastColumn = true;
      acc = c.srcOffsetY * (tex.height / sh);
      for (let y = c.dstStartY; y < c.dstEndY; y++, acc += stepY) if ((acc | 0) < 0 || (acc | 0) >= tex.height) out.pastRow = true;
    }
  }
  return out;
}

async function setup(cfg, texList, flags) {
  const tilePixels = Math.floor(cfg.tileSize * cfg.resolution);
  const totalTiles = cfg.tilesX * cfg.tilesY;
  const tileBytes = totalTiles * tilePixels * tilePixels * 4;
  const cap = cfg.columnsCap ?? tilePixels;
  const list = [
    { name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES },
    { name: 'tilesJs', owner: 'test', bytes: tileBytes },
    { name: 'dirtyJs', owner: 'test', bytes: totalTiles },
    { name: 'tiles', owner: 'kernel', bytes: tileBytes },
    { name: 'dirty', owner: 'kernel', bytes: totalTiles },
    ...texList.map((t, k) => ({ name: `tex${k}`, owner: 'read only', bytes: t.rgba.length })),
    { name: 'stamps', owner: 'test', bytes: BATCH * STAMP_BYTES },
    { name: 'columns', owner: 'kernel', bytes: columnBytes(cap) },
    { name: 'table', owner: 'test', bytes: DECAL_SLOTS.length * 4 },
  ];
  const layout = layoutRegions(list);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  const u8 = new Uint8Array(buffer);
  // Canaries everywhere the kernel must not write.
  for (let i = 0; i < u8.length; i++) u8[i] = (i * 7 + 3) & 0xff;
  const tex = texList.map((t, k) => {
    const view = new Uint8ClampedArray(buffer, R[`tex${k}`].byte, t.rgba.length);
    view.set(t.rgba);
    return { width: t.width, height: t.height, rgba: view };
  });
  const t = new Uint32Array(buffer, R.table.byte, DECAL_SLOTS.length);
  const put = (slot, v) => { t[DECAL_SLOTS.indexOf(slot)] = v; };
  put('tiles', R.tiles.byte);
  put('dirty', R.dirty.byte);
  put('tilesX', cfg.tilesX);
  put('tilesY', cfg.tilesY);
  put('tilePixels', tilePixels);
  put('stamps', R.stamps.byte);
  put('columns', R.columns.byte);
  put('columnsCap', cap);
  put('flags', flags);
  const { stamp_tiles: stampTiles } = await loadWasmKernel('decalStamp', KERNEL_URL, memory, ['stamp_tiles']);
  return {
    R, u8, tex, tilePixels, stampTiles,
    tilesJs: new Uint8ClampedArray(buffer, R.tilesJs.byte, tileBytes),
    dirtyJs: new Uint8Array(buffer, R.dirtyJs.byte, totalTiles),
    tiles: new Uint8ClampedArray(buffer, R.tiles.byte, tileBytes),
    dirty: new Uint8Array(buffer, R.dirty.byte, totalTiles),
    recF64: new Float64Array(buffer, R.stamps.byte, BATCH * (STAMP_BYTES / 8)),
    recU32: new Uint32Array(buffer, R.stamps.byte, BATCH * (STAMP_BYTES / 4)),
  };
}

/** Bytes of `now` outside the regions named in `writable` that differ from `before`: [first, count]. */
function outsideWrites(before, now, R, writable) {
  const ranges = writable.map((n) => [R[n].byte, R[n].byte + R[n].bytes]).sort((a, b) => a[0] - b[0]);
  let at = 0;
  let first = -1;
  let count = 0;
  for (const [lo, hi] of [...ranges, [now.length, now.length]]) {
    for (let i = at; i < lo; i++) {
      if (before[i] !== now[i]) {
        if (first < 0) first = i;
        count++;
      }
    }
    at = hi;
  }
  return [first, count];
}

async function runConfigs(seed, flags) {
  const r = rng(seed);
  const texList = textures(r);
  const seen = {
    vectorNormal: 0, vectorMultiply: 0, scalar: 0, outside: 0, multiTile: 0, pastColumn: 0, pastRow: 0, scalarPastColumn: 0,
    changed: 0, tiles: 0,
  };
  for (const cfg of CONFIGS) {
    const k = await setup(cfg, texList, flags);
    for (let i = 0; i < k.tilesJs.length; i++) k.tilesJs[i] = (r() * 256) | 0;
    k.tiles.set(k.tilesJs);
    k.dirtyJs.fill(0);
    k.dirty.fill(0);
    for (let b = 0; b < BATCHES; b++) {
      if (r() < 0.5) {
        // Pixi claims the flags between frames.
        k.dirtyJs.fill(0);
        k.dirty.fill(0);
      }
      const n = 1 + ((r() * BATCH) | 0);
      const before = k.tilesJs.slice();
      let expected = 0;
      for (let s = 0; s < n; s++) {
        const st = randomStamp(r, cfg, texList);
        const tex = k.tex[st.texture];
        stampToTileBuffers({
          worldX: st.worldX,
          worldY: st.worldY,
          tint: st.tint,
          scaleX: st.scaleX,
          scaleY: st.scaleY,
          alpha: st.alpha,
          blendMode: st.blendMode,
          textureRgba: tex.rgba,
          texWidth: tex.width,
          texHeight: tex.height,
          decalsTiles: k.tilesJs,
          decalsTilesDirty: k.dirtyJs,
          decalsTileSize: cfg.tileSize,
          decalsTilePixelSize: k.tilePixels,
          decalsTilesX: cfg.tilesX,
          decalsTilesY: cfg.tilesY,
          decalsResolution: cfg.resolution,
        });
        const f = s * 8;
        const u = s * 16;
        k.recF64[f] = st.worldX;
        k.recF64[f + 1] = st.worldY;
        k.recF64[f + 2] = st.scaleX;
        k.recF64[f + 3] = st.scaleY;
        k.recF64[f + 4] = st.alpha;
        k.recU32[u + 10] = st.tint;
        k.recU32[u + 11] = st.blendMode === 1 ? 1 : 0;
        k.recU32[u + 12] = tex.rgba.byteOffset;
        k.recU32[u + 13] = tex.width;
        k.recU32[u + 14] = tex.height;
        const reached = walk(st, tex, cfg, k.tilePixels);
        expected += reached.tiles;
        if (reached.tiles === 0) seen.outside++;
        if (reached.tiles > 1) seen.multiTile++;
        if (!(flags & F_SCALAR) && vectorAlpha(st.alpha)) {
          if (st.blendMode === 1) seen.vectorMultiply++;
          else seen.vectorNormal++;
          // The vector loop's masked columns and skipped rows.
          if (reached.pastColumn) seen.pastColumn++;
          if (reached.pastRow) seen.pastRow++;
        } else {
          seen.scalar++;
          if (reached.pastColumn) seen.scalarPastColumn++;
        }
      }
      for (let i = 0; i < before.length; i++) if (before[i] !== k.tilesJs[i]) seen.changed++;
      const snapshot = k.u8.slice();
      const stamped = k.stampTiles(k.R.table.byte, n, cfg.tileSize, cfg.resolution);
      const where = `tiles of ${k.tilePixels} px, batch ${b}`;
      assert.equal(stamped, expected, `${where}: tiles stamped`);
      seen.tiles += stamped;
      const at = k.tiles.findIndex((x, i) => x !== k.tilesJs[i]);
      assert.equal(at, -1, `${where}: tiles differ at byte ${at} (pixel ${at >> 2}: kernel ${k.tiles[at]}, JS ${k.tilesJs[at]})`);
      assert.deepEqual(k.dirty, k.dirtyJs, `${where}: dirty flags`);
      const [first, count] = outsideWrites(snapshot, k.u8, k.R, ['tiles', 'dirty', 'columns']);
      assert.equal(count, 0, `${where}: ${count} bytes written outside the kernel's regions, first at ${first}`);
    }
  }
  return seen;
}

test('the kernel stamps what stampToTileBuffers stamps, bit for bit', async (t) => {
  const seen = await runConfigs(0xdeca1, 0);
  for (const [key, n] of Object.entries(seen)) assert.ok(n > 0, `the batches reach ${key}`);
  assert.ok(seen.vectorNormal > 1000 && seen.vectorMultiply > 1000, 'most stamps take the vector loop');
  t.diagnostic(JSON.stringify(seen));
});

test('its scalar loop alone stamps what stampToTileBuffers stamps', async (t) => {
  const seen = await runConfigs(0x5ca1a, F_SCALAR);
  assert.equal(seen.vectorNormal + seen.vectorMultiply, 0);
  assert.ok(seen.changed > 0 && seen.tiles > 0 && seen.scalarPastColumn > 0);
  t.diagnostic(JSON.stringify(seen));
});

test('on the scene fixture the kernel writes the particle worker\'s tiles', async () => {
  const { setupDecalKernel } = await import('../bench/decalStampWasmMicrobench.mjs');
  const k = await setupDecalKernel();
  const js = k.checksumFrames(k.stampFrameJs);
  const wasm = k.checksumFrames(k.stampFrameWasm);
  assert.equal(wasm.checksum, js.checksum, 'tiles and dirty flags after the fixture frames');
  assert.ok(wasm.stamped > 6000, `the frames reach tiles (${wasm.stamped})`);
  assert.equal(k.vectorStamps, k.fx.alpha.length, 'every scene stamp takes the vector loop');
});
