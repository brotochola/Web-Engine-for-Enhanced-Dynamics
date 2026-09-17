import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_FEATURES, getFeature, filterFeatures } from '../bench/engineFeatureCatalog.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const REQUIRED = [
  'ray',
  'rayVsBox2d',
  'decals',
  'emit',
  'integrate',
  'spatial',
  'box2d',
  'liquidfun',
  'liquidfunCouple',
  'liquidfunQuery',
  'queryAabb',
  'nav',
  'visPoly',
  'tilemap',
  'tilemapCull',
  'contactDrain',
  'box2dRayJs',
  'queryPublish',
  'preRender',
  'compute',
  'decorations',
  'bullets',
  'spawn',
  'steadyCombat',
];

test('catalog has one unique row per hot engine feature', () => {
  const ids = ENGINE_FEATURES.map((f) => f.id);
  assert.deepEqual([...new Set(ids)].sort(), [...REQUIRED].sort());
  for (const id of REQUIRED) {
    const row = getFeature(id);
    assert.ok(row, `missing ${id}`);
    assert.ok(row.module && row.module.startsWith('src/'), `${id} module`);
    assert.ok(Array.isArray(row.primary), `${id} primary`);
    assert.ok(Array.isArray(row.load), `${id} load`);
    if (row.kernel) {
      assert.ok(fs.existsSync(path.join(root, row.kernel.script)), `${id} kernel ${row.kernel.script}`);
    }
    if (row.scene) {
      assert.ok(row.scene.path && row.scene.exportName, `${id} scene path`);
      assert.ok(fs.existsSync(path.join(root, row.scene.path.replace(/^\//, ''))), `${id} scene file`);
    }
  }
});

test('box2d / balls-equivalent load includes BODY_COUNT', () => {
  const row = getFeature('box2d');
  assert.ok(row.load.includes('BODY_COUNT'));
  assert.equal(row.scene.exportName, 'BallsScene');
});

test('visPoly scene is the raycasted bench, not Predator', () => {
  const row = getFeature('visPoly');
  assert.match(row.scene.path, /visPolyStressScene/);
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/visPolyStressScene.js'), 'utf8');
  assert.match(src, /raycasted:\s*true/);
  assert.match(src, /seed:/);
});

test('steadyCombat is a seeded bench scene, not demos/predator', () => {
  const row = getFeature('steadyCombat');
  assert.match(row.scene.path, /steadyCombatScene/);
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/steadyCombatScene.js'), 'utf8');
  assert.match(src, /seed:/);
  assert.doesNotMatch(src, /predatorScene/);
});

test('bullets row uses BulletStressScene and a kernel, not RayStress', () => {
  const row = getFeature('bullets');
  assert.match(row.scene.path, /bulletStressScene/);
  assert.equal(row.scene.exportName, 'BulletStressScene');
  assert.equal(row.kernel.script, 'tests/bench/bulletTickMicrobench.mjs');
  assert.ok(row.load.includes('ACTIVE_BULLETS'));
  assert.equal(row.load.includes('BODY_COUNT'), false);
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/bulletStressScene.js'), 'utf8');
  assert.match(src, /maxBullets/);
  assert.match(src, /seed:/);
  const driver = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/bullets/bulletStressDriver.js'),
    'utf8'
  );
  assert.match(driver, /BulletPool\.spawn/);
});

test('filterFeatures --only keeps the named subset', () => {
  const rows = filterFeatures(['box2d', 'emit']);
  assert.deepEqual(rows.map((r) => r.id), ['emit', 'box2d']);
});

test('preRender load key is entities processed, not BODY_COUNT', () => {
  const row = getFeature('preRender');
  assert.ok(row.load.includes('ENTITIES_PROCESSED'));
  assert.equal(row.load.includes('BODY_COUNT'), false);
});

test('tilemap has a seeded stress scene with primary and load', () => {
  const row = getFeature('tilemap');
  assert.ok(row.scene, 'tilemap scene');
  assert.match(row.scene.path, /tilemapStressScene/);
  assert.equal(row.scene.exportName, 'TilemapStressScene');
  assert.deepEqual(row.primary, ['logic0_STEP_MS']);
  assert.ok(row.load.includes('ENTITIES_PROCESSED'));
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/tilemapStressScene.js'), 'utf8');
  assert.match(src, /seed:/);
  const querier = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/tilemapStress/tilemapStressQuerier.js'),
    'utf8'
  );
  assert.match(querier, /getTileId/);
});

test('tilemapCull is a distinct scene from getTileId tilemap', () => {
  const row = getFeature('tilemapCull');
  assert.match(row.scene.path, /tilemapCullStressScene/);
  assert.equal(row.scene.exportName, 'TilemapCullStressScene');
  assert.doesNotMatch(row.scene.path, /tilemapStressScene\.js$/);
  assert.deepEqual(row.primary, ['pixi_STEP_MS']);
  assert.ok(row.load.includes('ENTITIES_PROCESSED'));
  assert.equal(row.kernel.script, 'tests/bench/tilemapCullMicrobench.mjs');
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/tilemapCullStressScene.js'), 'utf8');
  assert.match(src, /seed:/);
  assert.match(src, /kind: LAYER_KIND.TILEMAP/);
  assert.match(src, /chunkTiles/);
  const driver = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/tilemapCull/tilemapCullPanDriver.js'),
    'utf8'
  );
  assert.match(driver, /Camera\.centerOn/);
  const cullSrc = fs.readFileSync(path.join(root, 'src/render/tilemapCull.js'), 'utf8');
  assert.match(cullSrc, /<< 16/);
  assert.match(cullSrc, /out\.count/);
  const pixi = fs.readFileSync(path.join(root, 'src/workers/pixiWorker.js'), 'utf8');
  assert.match(pixi, /_createTilemapRuntime/);
  assert.match(pixi, /visArgs/);
  assert.doesNotMatch(pixi, /key "cx,cy"/);
});

test('contactDrain scene uses CollisionListener pile', () => {
  const row = getFeature('contactDrain');
  assert.match(row.scene.path, /contactDrainStressScene/);
  assert.equal(row.scene.exportName, 'ContactDrainStressScene');
  assert.deepEqual(row.primary, ['logic0_STEP_MS']);
  assert.ok(row.load.includes('BODY_COUNT'));
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/contactDrainStressScene.js'), 'utf8');
  assert.match(src, /seed:/);
  const body = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/contactDrain/contactDrainBody.js'),
    'utf8'
  );
  assert.match(body, /CollisionListener/);
});

test('box2dRayJs uses BoxBusy scene and Box2d.castRayClosest', () => {
  const row = getFeature('box2dRayJs');
  assert.equal(row.scene.exportName, 'RayVsBox2dBoxBusyScene');
  assert.match(row.scene.path, /rayVsBox2dStressScene/);
  assert.ok(row.primary.includes('physics_STEP_MS'));
  assert.ok(row.load.includes('BODY_COUNT'));
  const scene = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/rayVsBox2dStressScene.js'), 'utf8');
  assert.match(scene, /RayVsBox2dBoxBusyScene/);
  const driver = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/ray/rayStressDriver.js'),
    'utf8'
  );
  assert.match(driver, /Box2d\.castRayClosest/);
  const post = fs.readFileSync(path.join(root, 'src/box2d/weedjsPost.js'), 'utf8');
  assert.match(post, /function serviceRayCastClosest\(/);
  assert.match(post, /castRayClosestBits/);
});

test('particle tournament aborts unless the snapshot flag is passed', () => {
  const script = path.join(root, 'tests/bench/runParticleHypTournament.mjs');
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(String(r.stderr || r.stdout), /i-know-this-uses-snapshots/);
});
