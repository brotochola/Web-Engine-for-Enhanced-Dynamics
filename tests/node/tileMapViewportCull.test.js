import test from 'node:test';
import assert from 'node:assert/strict';
import { TileMap } from '../../src/core/tileMap.js';
import {
  deriveViewportChunkSize,
  normalizeChunkGrid,
  computeChunkTileRect,
  listVisibleChunks,
  listEvictChunkKeys,
  chunkKey,
  chunkRing,
} from '../../src/render/tilemapCull.js';

function makeMap(w, h) {
  const map = new TileMap(0, 'test', w, h, 16, 16, [{ firstgid: 1, columns: 8 }]);
  const data = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[y * w + x] = 1; // every cell filled
    }
  }
  map._layers.push({
    name: 'ground',
    data,
    mapWidth: w,
    mapHeight: h,
    tileWidth: 16,
    tileHeight: 16,
    visible: true,
    opacity: 1,
  });
  return map;
}

test('buildCompositeTilemap without tileRect emits full map', () => {
  const map = makeMap(10, 8);
  const tiles = [];
  map.buildCompositeTilemap(
    { tile(_tex, x, y) { tiles.push([x / 16, y / 16]); } },
    {}
  );
  assert.equal(tiles.length, 80);
});

test('buildCompositeTilemap tileRect only emits that range (max exclusive)', () => {
  const map = makeMap(20, 15);
  const tiles = [];
  map.buildCompositeTilemap(
    { tile(_tex, x, y) { tiles.push([x / 16, y / 16]); } },
    { tileRect: { minX: 3, minY: 2, maxX: 7, maxY: 5 } }
  );
  assert.equal(tiles.length, 4 * 3);
  for (const [tx, ty] of tiles) {
    assert.ok(tx >= 3 && tx < 7);
    assert.ok(ty >= 2 && ty < 5);
  }
});

test('buildCompositeTilemap clamps tileRect to map bounds', () => {
  const map = makeMap(5, 5);
  const tiles = [];
  map.buildCompositeTilemap(
    { tile(_tex, x, y) { tiles.push([x / 16, y / 16]); } },
    { tileRect: { minX: -10, minY: -10, maxX: 100, maxY: 100 } }
  );
  assert.equal(tiles.length, 25);
});

test('deriveViewportChunkSize uses ceil of view tiles', () => {
  assert.deepEqual(deriveViewportChunkSize(10.2, 7.1), { chunkW: 11, chunkH: 8 });
});

test('deriveViewportChunkSize fixed chunkTiles overrides view', () => {
  assert.deepEqual(deriveViewportChunkSize(40, 30, 16), { chunkW: 16, chunkH: 16 });
});

test('normalizeChunkGrid forces odd positive', () => {
  assert.equal(normalizeChunkGrid(3), 3);
  assert.equal(normalizeChunkGrid(4), 5);
  assert.equal(normalizeChunkGrid(0), 1);
});

test('same chunk after small camera move (caller would skip rebuild)', () => {
  const a = computeChunkTileRect({
    cameraTileX: 25.1,
    cameraTileY: 40.2,
    chunkW: 20,
    chunkH: 15,
    chunkGrid: 3,
    margin: 2,
    mapW: 200,
    mapH: 200,
  });
  const b = computeChunkTileRect({
    cameraTileX: 25.9,
    cameraTileY: 40.8,
    chunkW: 20,
    chunkH: 15,
    chunkGrid: 3,
    margin: 2,
    mapW: 200,
    mapH: 200,
  });
  assert.equal(a.chunkX, b.chunkX);
  assert.equal(a.chunkY, b.chunkY);
  assert.deepEqual(a.tileRect, b.tileRect);
});

test('crossing chunk boundary changes chunk and 3x3 union', () => {
  const inside = computeChunkTileRect({
    cameraTileX: 59.5,
    cameraTileY: 50,
    chunkW: 20,
    chunkH: 20,
    chunkGrid: 3,
    margin: 0,
    mapW: 200,
    mapH: 200,
  });
  const crossed = computeChunkTileRect({
    cameraTileX: 60.5,
    cameraTileY: 50,
    chunkW: 20,
    chunkH: 20,
    chunkGrid: 3,
    margin: 0,
    mapW: 200,
    mapH: 200,
  });
  assert.equal(inside.chunkX, 2);
  assert.equal(crossed.chunkX, 3);
  // 3x3 of 20-tile chunks: width 60 (away from map edge)
  assert.equal(inside.tileRect.maxX - inside.tileRect.minX, 60);
  assert.equal(crossed.tileRect.maxX - crossed.tileRect.minX, 60);
  // New union still covers previous view center tile
  assert.ok(crossed.tileRect.minX <= 59.5);
  assert.ok(crossed.tileRect.maxX > 59.5);
});

test('chunkGrid 3 union spans 3x chunk size (clamped at map edge)', () => {
  const mid = computeChunkTileRect({
    cameraTileX: 50,
    cameraTileY: 50,
    chunkW: 10,
    chunkH: 10,
    chunkGrid: 3,
    margin: 0,
    mapW: 100,
    mapH: 100,
  });
  assert.equal(mid.tileRect.maxX - mid.tileRect.minX, 30);
  assert.equal(mid.tileRect.maxY - mid.tileRect.minY, 30);

  const corner = computeChunkTileRect({
    cameraTileX: 2,
    cameraTileY: 2,
    chunkW: 10,
    chunkH: 10,
    chunkGrid: 3,
    margin: 0,
    mapW: 100,
    mapH: 100,
  });
  assert.equal(corner.chunkX, 0);
  assert.equal(corner.tileRect.minX, 0);
  assert.equal(corner.tileRect.minY, 0);
});

function keysOf(chunks) {
  return chunks.map((c) => c.key).sort();
}

test('small camera move inside a chunk keeps the same visible keys', () => {
  const a = listVisibleChunks({
    viewMinX: 25, viewMinY: 40, viewMaxX: 45, viewMaxY: 55,
    chunkW: 20, chunkH: 15, ring: 1, mapW: 200, mapH: 200,
  });
  const b = listVisibleChunks({
    viewMinX: 26, viewMinY: 41, viewMaxX: 46, viewMaxY: 56,
    chunkW: 20, chunkH: 15, ring: 1, mapW: 200, mapH: 200,
  });
  assert.deepEqual(keysOf(a), keysOf(b));
});

test('crossing a chunk adds new keys; ring keeps the old ones', () => {
  const inside = listVisibleChunks({
    viewMinX: 21, viewMinY: 40, viewMaxX: 39, viewMaxY: 55,
    chunkW: 20, chunkH: 20, ring: 1, mapW: 200, mapH: 200,
  });
  const crossed = listVisibleChunks({
    viewMinX: 41, viewMinY: 40, viewMaxX: 59, viewMaxY: 55,
    chunkW: 20, chunkH: 20, ring: 1, mapW: 200, mapH: 200,
  });
  const insideKeys = new Set(keysOf(inside));
  const crossedKeys = new Set(keysOf(crossed));
  assert.ok(insideKeys.has(chunkKey(1, 2)));
  assert.ok(crossedKeys.has(chunkKey(2, 2)));
  assert.ok(crossedKeys.has(chunkKey(3, 2))); // new after crossing
  assert.ok(crossedKeys.has(chunkKey(1, 2))); // still in ring
  assert.ok(!crossedKeys.has(chunkKey(0, 2))); // left the ring
});

test('zoom-out view lists more keys; tileRect for a chunk stays fixed', () => {
  const zoomedIn = listVisibleChunks({
    viewMinX: 50, viewMinY: 50, viewMaxX: 70, viewMaxY: 70,
    chunkW: 20, chunkH: 20, ring: 1, mapW: 200, mapH: 200,
  });
  const zoomedOut = listVisibleChunks({
    viewMinX: 20, viewMinY: 20, viewMaxX: 100, viewMaxY: 100,
    chunkW: 20, chunkH: 20, ring: 1, mapW: 200, mapH: 200,
  });
  assert.ok(zoomedOut.length > zoomedIn.length);
  const a = zoomedIn.find((c) => c.key === chunkKey(2, 2));
  const b = zoomedOut.find((c) => c.key === chunkKey(2, 2));
  assert.ok(a && b);
  assert.deepEqual(a.tileRect, b.tileRect);
  assert.deepEqual(a.tileRect, { minX: 40, minY: 40, maxX: 60, maxY: 60 });
});

test('listEvictChunkKeys drops keys outside the cache keep set', () => {
  const view = {
    viewMinX: 40, viewMinY: 40, viewMaxX: 60, viewMaxY: 60,
    chunkW: 20, chunkH: 20, mapW: 200, mapH: 200,
  };
  const visible = listVisibleChunks({ ...view, ring: chunkRing(3) });
  const keep = listVisibleChunks({ ...view, ring: chunkRing(5) });
  const keepKeys = keep.map((c) => c.key);
  const cached = [...keepKeys, chunkKey(8, 8), chunkKey(9, 9)];
  const evict = listEvictChunkKeys(cached, keepKeys);
  assert.deepEqual(evict.sort(), [chunkKey(8, 8), chunkKey(9, 9)].sort());
  for (const c of visible) {
    assert.ok(keepKeys.includes(c.key));
  }
});

test('cache ring keep set is a superset of visible keys', () => {
  const view = {
    viewMinX: 30, viewMinY: 30, viewMaxX: 90, viewMaxY: 90,
    chunkW: 20, chunkH: 20, mapW: 200, mapH: 200,
  };
  const visible = listVisibleChunks({ ...view, ring: chunkRing(3) });
  const keep = listVisibleChunks({ ...view, ring: chunkRing(5) });
  const keepKeys = new Set(keysOf(keep));
  assert.ok(keep.length >= visible.length);
  for (const c of visible) {
    assert.ok(keepKeys.has(c.key), `keep missing visible ${c.key}`);
  }
});
