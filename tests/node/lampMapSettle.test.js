// The lamps' map's atlas is made again at once when this frame's lamps need more tiles than it has, and otherwise only
// once another layout has been asked for LAMP_MAP_SETTLE_FRAMES frames in a row: a light that lives a few frames (a muzzle
// flash with a wide reach) moved the auto tile's count and size, and Predator by night made a 4096 px atlas again every
// few frames. The real Pixi worker's lampMap, its target creation counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, cloneWorker } from '../bench/workerHarness.mjs';
import { LAMP_MAP_SETTLE_FRAMES } from '../../src/render/pixi/lampMap.js';

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
  const frame = (tiles, reach) => {
    map.tileCount = tiles;
    map.maxReach = reach;
    const before = px.lighting.lampMapRT;
    // E-551: the layout is planned with the tiles (readTiles), then made.
    map._planLayout(gpu, tiles);
    assert.equal(map._ensureMap(gpu), true);
    if (px.lighting.lampMapRT !== before) made.push(`${map.lights}x${px._lampTileSize}`);
  };
  return { px, map, made, frame };
}

test('a map with room keeps its layout through a short-lived lamp, and takes a new one after LAMP_MAP_SETTLE_FRAMES', async () => {
  const { map, made, frame } = await lampMap();
  frame(20, 400);
  assert.equal(made.length, 1, 'the first map');
  const first = made[0];
  // A flash with a wide reach for a few frames, then gone: the map stays.
  for (let f = 0; f < 3; f++) frame(20, 1500);
  for (let f = 0; f < 10; f++) frame(20, 400);
  assert.deepEqual(made, [first], 'no map made for a flash');
  // More lamps than the map holds: made at once.
  frame(40, 400);
  assert.equal(made.length, 2);
  assert.equal(map.lights, 64);
  // Back to 20 lamps: the bigger map stays until 20 has been asked LAMP_MAP_SETTLE_FRAMES frames in a row.
  for (let f = 0; f < LAMP_MAP_SETTLE_FRAMES - 1; f++) frame(20, 400);
  assert.equal(made.length, 2, 'not yet');
  frame(20, 400);
  assert.equal(made.length, 3, 'made again once it settled');
  assert.equal(made[2], first);
});
