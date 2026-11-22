/**
 * DX-SCORELOAD: the scoreboard's loads per machine (tests/bench/scoreboardLoads.mjs). A row's scene at a calibrated
 * value of its load knob, the linear step toward the target, the primary the floor judges, the loads file, and the
 * catalog's knobs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENGINE_FEATURES } from '../bench/engineFeatureCatalog.mjs';
import { usesStressStepFloor } from '../bench/measureLib.mjs';
import { nextLoad, primaryMs, readScoreboardLoads, sceneAtLoad } from '../bench/scoreboardLoads.mjs';

const RAY = { id: 'ray', primary: ['logic0_STEP_MS'], scene: { key: 'rayStress', loadKnob: { key: 'casts', base: 3072, max: 49152 } } };

test('a row runs at its calibrated load, its scene\'s own query kept; without a value, the catalog\'s scene', () => {
  assert.equal(sceneAtLoad(RAY, null), RAY.scene);
  assert.equal(sceneAtLoad(RAY, { spatial: { entities: 12000 } }), RAY.scene);
  assert.equal(sceneAtLoad(RAY, { ray: { casts: 6144 } }).query, 'casts=6144');
  const withQuery = { ...RAY, scene: { ...RAY.scene, query: '?backend=webgpu&casts=1' } };
  assert.equal(sceneAtLoad(withQuery, { ray: { casts: 6144 } }).query, 'backend=webgpu&casts=6144');
  const noKnob = { id: 'box2d', scene: { key: 'box2d' } };
  assert.equal(sceneAtLoad(noKnob, { box2d: { bodies: 5 } }), noKnob.scene);
});

test('the next load scales in a straight line to the target, at least one step up, never past the cap', () => {
  const knob = RAY.scene.loadKnob;
  assert.equal(nextLoad(knob, 3072, 4.5, 9), 6144);
  assert.equal(nextLoad(knob, 1, 8.9, 9), 2, 'one step at least');
  assert.equal(nextLoad(knob, 40000, 1, 9), 49152, 'capped');
  assert.equal(nextLoad({ key: 'queries', base: 1 }, 1, 0, 9), 90, 'a primary of 0 reads as 0.1 ms');
});

test('the primary the floor judges is the largest median of the row\'s ms primaries', () => {
  const two = { primary: ['logic0_STEP_MS', 'physics_STEP_MS', 'BODY_COUNT'] };
  assert.equal(primaryMs(two, { logic0_STEP_MS: { median: 4 }, physics_STEP_MS: { median: 7 }, BODY_COUNT: { median: 900 } }), 7);
  assert.ok(Number.isNaN(primaryMs(two, {})));
});

test('a loads file must hold its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoreload-'));
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({ vs: 'v0.14.0', rows: { ray: { casts: 6144 } } }));
  fs.writeFileSync(bad, JSON.stringify({ ray: { casts: 6144 } }));
  try {
    assert.deepEqual(readScoreboardLoads(good), { ray: { casts: 6144 } });
    assert.throws(() => readScoreboardLoads(bad), /has no "rows" object/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the catalog\'s load knobs: on stress rows only, a key, a default under its cap', () => {
  const knobbed = ENGINE_FEATURES.filter((f) => f.scene?.loadKnob);
  assert.ok(knobbed.length >= 6, 'the rows that read FAIL under the floor on the ASUS have knobs');
  for (const f of knobbed) {
    const k = f.scene.loadKnob;
    assert.ok(usesStressStepFloor(f.scene), `${f.id} is a stress row`);
    assert.match(k.key, /^[a-zA-Z]+$/, `${f.id} key`);
    assert.ok(Number.isInteger(k.base) && k.base > 0, `${f.id} base`);
    assert.ok(Number.isInteger(k.max) && k.max >= k.base, `${f.id} max`);
  }
  for (const id of ['ray', 'rayVsBox2d', 'spatial', 'queryAabb', 'spawn', 'bullets']) {
    assert.ok(knobbed.some((f) => f.id === id), `${id} has a knob`);
  }
});
