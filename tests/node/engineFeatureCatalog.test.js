import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_FEATURES, getFeature, filterFeatures } from '../bench/engineFeatureCatalog.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const REQUIRED = [
  'spotLights',
  'flashlights',
  'ray',
  'rayVsBox2d',
  'decals',
  'emit',
  'integrate',
  'particleLists',
  'particleListsZoomed',
  'spatial',
  'box2d',
  'liquidfun',
  'liquidfunCouple',
  'liquidfunQuery',
  'queryAabb',
  'nav',
  'visPoly',
  'tilemap',
  'tilemapGid',
  'contactDrain',
  'box2dRayJs',
  'queryPublish',
  'preRender',
  'compute',
  'decorations',
  'bullets',
  'spawn',
  'steadyCombat',
  'decalBlit',
  'sceneryCam',
  'meshFillMoving',
  'meshFillPan',
  'meshFillLook',
  'audioStorm',
  'audioSlots',
  'gameObjectAccess',
  'shadowStamp',
  'gpuQueuePack',
  'decalPremultiply',
  'painterRadix',
  'publishPose',
  'preRenderWorker',
  'swayBuckets',
  'decorationCollect',
  'decorationCollectYSort',
  'attachedSway',
  'attachedWalls',
  'attachedScanNone',
  'attachedScanFew',
  'decorationVisibilityGrid',
  'layerFeedParticles',
  'layerFeedBodies',
  'textureUpload',
  // DX-LIGHT3D owner scenes (plan §10).
  'sunShadowMap',
  'selfShadow',
  'depthSort',
  'unshaded',
  'tweenPool',
  'despawnLists',
];

test('catalog has one unique row per hot engine feature', () => {
  const ids = ENGINE_FEATURES.map((f) => f.id);
  assert.deepEqual([...new Set(ids)].sort(), [...REQUIRED].sort());
  for (const id of REQUIRED) {
    const row = getFeature(id);
    assert.ok(row, `missing ${id}`);
    assert.ok(row.module && row.module.startsWith('src/'), `${id} module`);
    // A module that moved (a JS path that left src/ for tests/reference) leaves its row pointing nowhere.
    assert.ok(fs.existsSync(path.join(root, row.module)), `${id}: ${row.module} exists`);
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

test('visPoly scene is the walls bench, not Predator', () => {
  const row = getFeature('visPoly');
  assert.match(row.scene.path, /visPolyStressScene/);
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/visPolyStressScene.js'), 'utf8');
  // The scene asks for walls (lighting.walls) unless a race arm without them is asked for (?arm=maps|plain).
  assert.match(src, /walls:\s*ARM_WALLS/, 'lighting.walls follows the arm');
  assert.match(src, /const ARM_WALLS = ARM === 'walls';/, 'the walls arm');
  assert.match(src, /\? arm : 'walls';/, 'and the default arm is walls');
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

test('tilemapGid is a distinct scene from getTileId tilemap', () => {
  const row = getFeature('tilemapGid');
  assert.match(row.scene.path, /tilemapCullStressScene/);
  assert.equal(row.scene.exportName, 'TilemapCullStressScene');
  assert.doesNotMatch(row.scene.path, /tilemapStressScene\.js$/);
  assert.deepEqual(row.primary, ['pixi_STEP_MS']);
  assert.ok(row.load.includes('ENTITIES_PROCESSED'));
  assert.equal(row.kernel.script, 'tests/bench/tilemapGidMicrobench.mjs');
  const src = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/tilemapCullStressScene.js'), 'utf8');
  assert.match(src, /seed:/);
  assert.match(src, /kind: LAYER_KIND.TILEMAP/);
  const driver = fs.readFileSync(
    path.join(root, 'tests/bench/stressScenes/tilemapCull/tilemapCullPanDriver.js'),
    'utf8'
  );
  assert.match(driver, /Camera\.centerOn/);
  const gidSrc = fs.readFileSync(path.join(root, 'src/render/tilemapGid.js'), 'utf8');
  assert.match(gidSrc, /TILEMAP_GID_PAGE_TILES/);
  assert.match(gidSrc, /packGidPageRgba8/);
  const pixi = fs.readFileSync(path.join(root, 'src/workers/pixiWorker.js'), 'utf8');
  assert.match(pixi, /_fillTilemapPages/);
  assert.match(pixi, /tilemapGid/);
  assert.doesNotMatch(pixi, /CompositeTilemap/);
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
  // The castRayClosest JS service runs on the physics worker (DX-SCORELOAD); ?casts raises its load.
  assert.ok(row.primary.includes('physics_STEP_MS'));
  assert.equal(row.scene.loadKnob?.key, 'casts');
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
// N-161: audioStorm's load key was BODY_COUNT in a scene with no bodies, 0 on both sides, so the row could never
// decide. Every row's load keys must be ones the measurement publishes, and audioStorm's counts its drivers.
test('every load key is one extractMetrics publishes; audioStorm counts its drivers, not bodies', async () => {
  const { extractMetrics } = await import('../bench/measureLib.mjs');
  const published = new Set(Object.keys(extractMetrics({ workers: [] })));
  for (const row of ENGINE_FEATURES) {
    for (const key of row.load) assert.ok(published.has(key), `${row.id}: load key ${key} is not published`);
  }
  const row = getFeature('audioStorm');
  assert.deepEqual(row.load, ['MARK_ACTIVE']);
  const driver = fs.readFileSync(path.join(root, 'tests/bench/stressScenes/audio/audioStormDriver.js'), 'utf8');
  assert.match(driver, /static reportMarkActive = true;/, 'the drivers are what MARK_ACTIVE counts');
});
