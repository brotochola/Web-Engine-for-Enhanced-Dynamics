// The lamps' map's atlas is made again at once when this frame's lamps are more tiles than it was made for, and otherwise
// only once another layout has been asked for LAMP_MAP_SETTLE_FRAMES frames in a row: a light that lives a few frames (a
// muzzle flash with a wide reach) moved the auto tile's count and size, and Predator by night made a 4096 px atlas again
// every few frames (N-416). E-551: each tile has its own lamp's side, shelf-packed; a wider lamp for a few frames shrinks
// the tiles into the map instead, and a map is made smaller only past twice the texels the tiles take. The real Pixi
// worker's lampMap, its target creation counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, cloneWorker } from '../bench/workerHarness.mjs';
import { LAMP_MAP_SETTLE_FRAMES } from '../../src/render/pixi/lampMap.js';
import { LAMP_TILE_ROWS } from '../../src/render/lampVolumeCache.js';

async function lampMap() {
  const px = cloneWorker(await loadWorker('pixiWorker.js', 'pixiRenderer'));
  px._lampTileAuto = true;
  px._lampTileSize = 256;
  px.shadowResolution = 0.5;
  px._pixelArtLight = false;
  px._ensureTargetDepth = () => {};
  px.lighting.lightingShader = null;
  px.lighting.lampMapRT = null;
  const made = [];
  const map = px.lampMap;
  const gpu = { caps: { maxStampLights: 64 } };
  map.tileData = new Float32Array(64 * 4 * LAMP_TILE_ROWS);
  map.tileRects = new Float32Array(64 * 3);
  map.packOrder = new Int32Array(64);
  // `tiles` lamps 50 px up, each reaching `reach` (the tiles' texture's row 0), then the frame's plan and map.
  const frame = (tiles, reach) => {
    map.tileData.fill(0, 0, 64 * 4);
    for (let t = 0; t < tiles; t++) map.tileData.set([0, 0, 50, reach], t * 4);
    map.tileCount = tiles;
    const before = px.lighting.lampMapRT;
    map._planLayout(gpu, tiles);
    assert.equal(map._ensureMap(gpu), true);
    if (px.lighting.lampMapRT !== before) made.push(`${map.mapWidth}x${map.mapHeight}`);
    // Every tile inside the map.
    for (let t = 0; t < tiles; t++) {
      const [x0, y0, side] = map.tileRects.subarray(t * 3, t * 3 + 3);
      assert.ok(x0 + 2 * side <= map.mapWidth && y0 + side <= map.mapHeight, `tile ${t} in the map`);
    }
  };
  return { map, made, frame };
}

test('a map with room is kept; one too small is made again at once; a much too large one only after LAMP_MAP_SETTLE_FRAMES', async () => {
  const { map, made, frame } = await lampMap();
  // 4 lamps reaching 400 at shadowResolution 0.5: halves of 256, four a 2048 row.
  frame(4, 400);
  assert.deepEqual(made, ['2048x256'], 'the first map');
  // A flash reaching 800 (halves of 512): the map grows at once, and once, as the flash comes and goes.
  frame(4, 800);
  assert.deepEqual(made, ['2048x256', '4096x512']);
  for (let f = 0; f < 10; f++) { frame(4, 400); frame(4, 800); }
  assert.equal(made.length, 2, 'not made again for the same flash');
  // Back to the first lamps for good: the bigger map stays until it has been over twice what they take for a while.
  for (let f = 0; f < LAMP_MAP_SETTLE_FRAMES - 1; f++) frame(4, 400);
  assert.equal(made.length, 2, 'not yet');
  frame(4, 400);
  assert.equal(made[2], '2048x256', 'made again once it settled');
  // More lamps than fit: made at once (64 halves of 256 take 8 rows of 8).
  frame(64, 400);
  assert.deepEqual(made.slice(3), ['4096x2048']);
  assert.equal(map.lights, 64);
});

test('E-551: lamps of different reaches take tiles of their own sides', async () => {
  const { map } = await lampMap();
  // A street lamp's reach and a fire's, before any map is made (a map already made would take the wider one in for a while).
  map.tileData.set([0, 0, 50, 400, 0, 0, 50, 1000], 0);
  map._planLayout({ caps: { maxStampLights: 64 } }, 2);
  // At shadowResolution 0.5: 400 px want 250 texels (256), 1000 want 625 (640).
  assert.deepEqual([map.tileRects[2], map.tileRects[5]], [256, 640]);
});
