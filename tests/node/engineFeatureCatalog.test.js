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

test('filterFeatures --only keeps the named subset', () => {
  const rows = filterFeatures(['box2d', 'emit']);
  assert.deepEqual(rows.map((r) => r.id), ['emit', 'box2d']);
});

test('particle tournament aborts unless the snapshot flag is passed', () => {
  const script = path.join(root, 'tests/bench/runParticleHypTournament.mjs');
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(String(r.stderr || r.stdout), /i-know-this-uses-snapshots/);
});
