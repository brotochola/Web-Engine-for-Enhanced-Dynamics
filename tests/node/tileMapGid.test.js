import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILEMAP_GID_PAGE_TILES,
  TILED_FLIP_H,
  TILED_FLIP_V,
  TILED_FLIP_D,
  TILED_GID_MASK,
  listGidPages,
  gidPageSize,
  gidPageByteLength,
  packGidPageRgba8,
  unpackGidRgba8,
  decodeTiledGid,
  applyTiledLocalUv,
  tiledGidAtlasUv,
} from '../../src/render/tilemapGid.js';

test('TILEMAP_GID_PAGE_TILES is WebGL2 minimum max texture size', () => {
  assert.equal(TILEMAP_GID_PAGE_TILES, 2048);
});

test('listGidPages is empty for non-positive sizes', () => {
  assert.deepEqual(listGidPages(0, 10), []);
  assert.deepEqual(listGidPages(10, 0), []);
  assert.deepEqual(listGidPages(10, 10, 0), []);
});

test('listGidPages one page when the map fits', () => {
  const pages = listGidPages(32, 16, 2048);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], { minX: 0, minY: 0, maxX: 32, maxY: 16 });
});

test('listGidPages splits a map that does not divide the page size', () => {
  const pages = listGidPages(2082, 416, 2048);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], { minX: 0, minY: 0, maxX: 2048, maxY: 416 });
  assert.deepEqual(pages[1], { minX: 2048, minY: 0, maxX: 2082, maxY: 416 });
  assert.deepEqual(gidPageSize(pages[1]), { pageW: 34, pageH: 416 });
});

test('listGidPages walks x then y for a 2x2 page grid', () => {
  const pages = listGidPages(3000, 2500, 2048);
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((p) => [p.minX, p.minY, p.maxX, p.maxY]), [
    [0, 0, 2048, 2048],
    [2048, 0, 3000, 2048],
    [0, 2048, 2048, 2500],
    [2048, 2048, 3000, 2500],
  ]);
});

test('packGidPageRgba8 is byte-exact little-endian with the SAB Int32', () => {
  const mapW = 5;
  const mapH = 3;
  const data = new Int32Array(mapW * mapH);
  data[0] = 1;
  data[1] = 42;
  data[7] = (TILED_FLIP_H | 7) >> 0; // signed Int32 store of flip+gid
  data[14] = 0;
  const page = { minX: 1, minY: 1, maxX: 4, maxY: 3 };
  const { pageW, pageH } = gidPageSize(page);
  const out = new Uint8Array(gidPageByteLength(pageW, pageH));
  assert.equal(packGidPageRgba8(data, mapW, page, out), out.length);
  const at = (x, y) => {
    const i = ((y - page.minY) * pageW + (x - page.minX)) * 4;
    return unpackGidRgba8(out[i], out[i + 1], out[i + 2], out[i + 3]);
  };
  assert.equal(at(1, 1), data[1 * mapW + 1] >>> 0);
  assert.equal(at(2, 1), data[1 * mapW + 2] >>> 0);
  assert.equal(at(2, 1), (7 | TILED_FLIP_H) >>> 0);
  assert.equal(at(3, 2), 0);
});

test('packGidPageRgba8 throws if the out buffer is short', () => {
  assert.throws(() => packGidPageRgba8(new Int32Array(4), 2, {
    minX: 0, minY: 0, maxX: 2, maxY: 2,
  }, new Uint8Array(3)));
});

test('decodeTiledGid strips flags and keeps the numeric gid', () => {
  assert.deepEqual(decodeTiledGid(0), { gid: 0, flipH: false, flipV: false, flipD: false });
  assert.deepEqual(decodeTiledGid(12), { gid: 12, flipH: false, flipV: false, flipD: false });
  const raw = (TILED_FLIP_H | TILED_FLIP_V | TILED_FLIP_D | 9) >>> 0;
  assert.deepEqual(decodeTiledGid(raw), { gid: 9, flipH: true, flipV: true, flipD: true });
  assert.equal(raw & TILED_GID_MASK, 9);
});

test('applyTiledLocalUv: H/V/D each combo (diagonal first)', () => {
  const near = (got, u, v) => {
    assert.ok(Math.abs(got.u - u) < 1e-12);
    assert.ok(Math.abs(got.v - v) < 1e-12);
  };
  near(applyTiledLocalUv(0.25, 0.8, false, false, false), 0.25, 0.8);
  near(applyTiledLocalUv(0.25, 0.8, true, false, false), 0.75, 0.8);
  near(applyTiledLocalUv(0.25, 0.8, false, true, false), 0.25, 0.2);
  near(applyTiledLocalUv(0.25, 0.8, true, true, false), 0.75, 0.2);
  near(applyTiledLocalUv(0.25, 0.8, false, false, true), 0.8, 0.25);
  near(applyTiledLocalUv(0.25, 0.8, true, false, true), 0.2, 0.25);
  near(applyTiledLocalUv(0.25, 0.8, false, true, true), 0.8, 0.75);
  near(applyTiledLocalUv(0.25, 0.8, true, true, true), 0.2, 0.75);
});

test('tiledGidAtlasUv empty and below firstgid is null', () => {
  const opts = {
    firstGid: 1, columns: 8, tileWidth: 16, tileHeight: 16, atlasWidth: 128, atlasHeight: 64,
  };
  assert.equal(tiledGidAtlasUv(0, 0.5, 0.5, opts), null);
  assert.equal(tiledGidAtlasUv(3, 0.5, 0.5, { ...opts, firstGid: 5 }), null);
});

test('tiledGidAtlasUv inset 0.5 and flag remaps match the shader contract', () => {
  const opts = {
    firstGid: 1, columns: 8, tileWidth: 16, tileHeight: 16, atlasWidth: 128, atlasHeight: 64,
  };
  // gid 1 → tileId 0 at (0,0). Center of tile after inset: 0.5 + 0.5*15 = 8
  const mid = tiledGidAtlasUv(1, 0.5, 0.5, opts);
  assert.ok(mid);
  assert.equal(mid.u, 8 / 128);
  assert.equal(mid.v, 8 / 64);

  // gid 10 → tileId 9 → col 1 row 1
  const cell = tiledGidAtlasUv(10, 0, 0, opts);
  assert.equal(cell.u, (16 + 0.5) / 128);
  assert.equal(cell.v, (16 + 0.5) / 64);

  const flipped = tiledGidAtlasUv((TILED_FLIP_H | 1) >>> 0, 0, 0, opts);
  // H: local u 0 → 1; px = 0.5 + 1*15 = 15.5
  assert.equal(flipped.u, 15.5 / 128);
  assert.equal(flipped.v, 0.5 / 64);
});
