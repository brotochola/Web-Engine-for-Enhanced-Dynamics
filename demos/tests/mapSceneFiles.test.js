// VISUAL_EDITOR_PLAN.md ED-5: Predator's rocks, trees and houses (from demos/trees_and_rocks.json) and littleCity's
// houses and trees (from its objects JSON) moved to scene files, which their scenes name as defaultSceneFile. Parity
// with the JSON they came from, read the way the engine reads the file; and every class in the scene's pools.
// In a browser: the same classes at the same pool indices and positions after a load (the ED-5 sitting, R-0650).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../../tests/helpers/registerWebRoot.mjs';

import { parseSceneFile, sceneFileScriptUrl } from '../../src/core/sceneFile.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const placed = (doc, cls) => doc.entities.filter((e) => e.class === cls).map((e) => [e.x, e.y, e.config?.radius ?? null]);

test('Predator: the file places the rocks, the trees and every other house of trees_and_rocks.json', () => {
  const doc = parseSceneFile(read('../predatorScene/levels/map.scene.json'), 'map.scene.json');
  const json = JSON.parse(read('../trees_and_rocks.json'));
  assert.deepEqual(placed(doc, 'Rock'), json.rocks.map((r) => [r.x, r.y, null]));
  assert.deepEqual(placed(doc, 'Tree'), json.trees.map((t) => [t.x, t.y, null]), 'Tree sizes itself: the JSON radius was never read');
  assert.deepEqual(placed(doc, 'House'), json.houses.filter((_, i) => i % 2 === 1).map((h) => [h.x, h.y, null]));
  assert.equal(doc.entities.length, 151 + 1764 + 24);
  const fileUrl = new URL('../predatorScene/levels/map.scene.json', import.meta.url);
  assert.equal(sceneFileScriptUrl(doc, fileUrl.href), new URL('../predatorScene/predatorScene.js', import.meta.url).href);
  assert.equal(doc.export, 'PredatorScene');
});

test('littleCity: the file places the houses, and the trees with their radius', () => {
  const doc = parseSceneFile(read('../littleCity/levels/city.scene.json'), 'city.scene.json');
  const json = JSON.parse(read('../littleCity/objects_208x104_1790114635638.json'));
  assert.deepEqual(placed(doc, 'CityHouse'), json.houses.map((h) => [h.x, h.y, null]));
  assert.deepEqual(
    placed(doc, 'CityTree'),
    json.trees.map((t) => [t.x, t.y, t.radius === 18 ? null : t.radius]),
    'a radius equal to the declared default (18) is left out',
  );
  const fileUrl = new URL('../littleCity/levels/city.scene.json', import.meta.url);
  assert.equal(sceneFileScriptUrl(doc, fileUrl.href), new URL('../littleCity/littleCityScene.js', import.meta.url).href);
  assert.equal(doc.export, 'LittleCityScene');
});

test('each scene names its file, and its pools hold what the file places', async () => {
  for (const [modulePath, exportName, filePath] of [
    ['../predatorScene/predatorScene.js', 'PredatorScene', '../predatorScene/levels/map.scene.json'],
    ['../littleCity/littleCityScene.js', 'LittleCityScene', '../littleCity/levels/city.scene.json'],
  ]) {
    const SceneClass = (await import(modulePath))[exportName];
    const moduleUrl = new URL(modulePath, import.meta.url);
    assert.equal(new URL(SceneClass.defaultSceneFile, moduleUrl).href, new URL(filePath, import.meta.url).href, exportName);
    const pools = new Map(SceneClass.entities.map(([C, n]) => [C.name, n]));
    const doc = parseSceneFile(read(filePath), filePath);
    const counts = new Map();
    for (const e of doc.entities) counts.set(e.class, (counts.get(e.class) || 0) + 1);
    for (const [cls, n] of counts) assert.ok(n <= (pools.get(cls) ?? 0), `${exportName}: ${n} ${cls} in a pool of ${pools.get(cls)}`);
  }
});
