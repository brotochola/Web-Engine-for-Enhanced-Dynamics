import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('destructibleTerrainScene declares LAYER_KIND.MESH', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scene = fs.readFileSync(
    path.join(here, '../../demos/destructibleTerrainScene/destructibleTerrainScene.js'),
    'utf8'
  );
  const island = fs.readFileSync(
    path.join(here, '../../demos/destructibleTerrainScene/gameObjects/terrainIsland.js'),
    'utf8'
  );
  assert.match(scene, /kind:\s*LAYER_KIND\.MESH/);
  assert.match(scene, /fragment:\s*'rockContour'/);
  assert.match(scene, /webgl:\s*'\/demos\/shaders\/rockContour\.frag'/);
  assert.match(scene, /webgpu:\s*'\/demos\/shaders\/rockContour\.wgsl'/);
  assert.match(scene, /terrainRendererBackend/);
  assert.match(scene, /benchRemesh/);
  assert.equal(scene.includes('fillSpace'), false);
  assert.match(scene, /rocky:\s*'\/demos\/img\/rocky\.jpg'/);
  assert.match(island, /MeshRenderer/);
  assert.match(island, /setTexture\('rocky'\)/);
  assert.match(island, /setTileWorld\(128\)/);
  assert.match(island, /visualOutset\s*=\s*2/);
  assert.equal(island.includes('SpriteRenderer'), false);
  assert.equal(island.includes('fillTint'), false);
});
