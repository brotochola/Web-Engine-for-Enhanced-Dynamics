import test from 'node:test';
import assert from 'node:assert/strict';

import { TileMap } from '../../src/core/tileMap.js';

// TileMap's world queries at the map's edges (N-78): a point outside the map is empty, wherever it is (left of or
// above the map within one tile, NaN, the infinities, past the far side), and worldToTile floors.

function load(tileWidth, tileHeight) {
  const w = 4;
  const h = 3;
  const data = Array.from({ length: w * h }, (_, i) => i + 1); // every tile set: 0 can only mean empty
  TileMap.initializeFromLoaded({
    edges: {
      data: {
        width: w,
        height: h,
        tilewidth: tileWidth,
        tileheight: tileHeight,
        tilesets: [{ firstgid: 1, columns: 4, tilewidth: tileWidth, tileheight: tileHeight }],
        layers: [{ type: 'tilelayer', name: 'ground', data, visible: true, opacity: 1 }],
      },
    },
  });
  return TileMap.get('edges');
}

test('a point outside the map holds no tile, the first tile column and row included', () => {
  const map = load(16, 16);
  const outside = [
    [-0.5, 4], [4, -0.5], [-15.99, -15.99],
    [NaN, 4], [4, NaN], [Infinity, 4], [-Infinity, 4], [4, Infinity],
    [64, 4], [4, 48], [1e12, 4],
  ];
  for (const [x, y] of outside) {
    assert.equal(map.getTileId(x, y, 'ground'), 0, `getTileId(${x}, ${y})`);
    assert.equal(map.getTileId(x, y), 0, `getTileId(${x}, ${y}) over every layer`);
    assert.equal(map.getAllTileIds(x, y).ground, 0, `getAllTileIds(${x}, ${y})`);
  }
  assert.equal(map.getTileId(0, 0, 'ground'), 1);
  assert.equal(map.getTileId(63.99, 47.99, 'ground'), 12, 'the last tile, up to its far edge');
  assert.equal(map.getAllTileIds(17, 16).ground, 6);
});

test('a tile size that is not a power of two still answers the last tile and nothing past it', () => {
  const map = load(49, 49);
  const right = 4 * 49;
  assert.equal(map.getTileId(right - 1e-9, 0, 'ground'), 4);
  assert.equal(map.getTileId(right, 0, 'ground'), 0);
  assert.equal(map.getTileId(49, 49, 'ground'), 6);
});

test('worldToTile floors, so a point left of or above the map gets a negative tile', () => {
  const map = load(16, 16);
  const out = { tileX: 0, tileY: 0 };
  assert.deepEqual(map.worldToTile(-0.5, -16.5, out), { tileX: -1, tileY: -2 });
  assert.deepEqual(map.worldToTile(31.9, 16, out), { tileX: 1, tileY: 1 });
});
