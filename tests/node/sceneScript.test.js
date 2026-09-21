import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindSceneGraph,
  inferSceneScriptUrl,
  isSceneClass,
  missingWorkerEntityClasses,
  pickSceneClass,
} from '../../src/util/sceneScript.js';

class Scene {}
class GameObject {}
class SharedResource {}

class House extends GameObject {}
class Lootable extends GameObject {}
class Person extends Lootable {}
class MySoldier extends Person {}
class WorldGrid extends SharedResource {}

class PredatorScene extends Scene {
  static entities = [[House, 10], [MySoldier, 5]];
  static sharedResources = [[WorldGrid, { n: Int32Array }]];
}

class TownScene extends Scene {}
class DungeonScene extends Scene {}

test('pickSceneClass: named export', () => {
  const ns = { PredatorScene, extra: 1 };
  assert.equal(pickSceneClass(ns, 'PredatorScene', Scene), PredatorScene);
});

test('pickSceneClass: default Scene', () => {
  const ns = { default: PredatorScene };
  assert.equal(pickSceneClass(ns, undefined, Scene), PredatorScene);
});

test('pickSceneClass: unique Scene export', () => {
  const ns = { PredatorScene, helper: () => {} };
  assert.equal(pickSceneClass(ns, undefined, Scene), PredatorScene);
});

test('pickSceneClass: ambiguous throw', () => {
  assert.throws(
    () => pickSceneClass({ TownScene, DungeonScene }, undefined, Scene),
    /multiple Scene classes/,
  );
});

test('pickSceneClass: missing named export', () => {
  assert.throws(
    () => pickSceneClass({ PredatorScene }, 'Nope', Scene),
    /not found/,
  );
});

test('isSceneClass', () => {
  assert.equal(isSceneClass(PredatorScene, Scene), true);
  assert.equal(isSceneClass(House, Scene), false);
});

test('bindSceneGraph exposes child, parent, SharedResource', () => {
  const globalRef = {};
  bindSceneGraph(PredatorScene, globalRef, GameObject, SharedResource);
  assert.equal(globalRef.House, House);
  assert.equal(globalRef.MySoldier, MySoldier);
  assert.equal(globalRef.Person, Person);
  assert.equal(globalRef.Lootable, Lootable);
  assert.equal(globalRef.WorldGrid, WorldGrid);
  assert.equal(globalRef.GameObject, undefined);
});

test('missingWorkerEntityClasses skips engineProvided', () => {
  const missing = missingWorkerEntityClasses(
    [
      { name: 'House' },
      { name: 'Flash', engineProvided: true },
      { name: 'Ghost' },
    ],
    { House },
  );
  assert.deepEqual(missing, ['Ghost']);
});

test('inferSceneScriptUrl: unique class declaration', async () => {
  const files = {
    'http://127.0.0.1/other.js': 'export class Other {}',
    'http://127.0.0.1/predatorScene.js': 'export class PredatorScene extends Scene {}',
  };
  const url = await inferSceneScriptUrl(PredatorScene, {
    origin: 'http://127.0.0.1',
    getEntries: () => Object.keys(files).map((name) => ({ name })),
    fetch: async (href) => ({
      ok: true,
      text: async () => files[href],
    }),
  });
  assert.equal(url, 'http://127.0.0.1/predatorScene.js');
});
