import test from 'node:test';
import assert from 'node:assert/strict';

import { registerOnLogicWorker, warnings } from '../helpers/logicWorkerEntities.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import {
  checkSceneFile,
  inlineJson,
  isSceneFileUrl,
  parseSceneFile,
  sceneFileScriptUrl,
  sceneFileSpawnOrder,
  serializeSceneFile,
} from '../../src/core/sceneFile.js';

// VISUAL_EDITOR_PLAN.md ED-2 and ED-34: scene files (format 1) and Scene.getByName.

const FIXTURE = `{
  "format": 1,
  "script": "../platformerGameScene.js",
  "export": "PlatformerScene",
  "entities": [
    { "name": "Platform1", "class": "Platform", "x": 600, "y": 2050, "config": { "width": 1200, "tint": 5927055 } },
    { "name": "Player", "class": "BluePlatformerPlayer", "x": 300, "y": 1800, "flag": true },
    { "name": "Path", "class": "Mover", "x": 0.5, "y": -10, "config": { "path": [0, 0, 100, 50] } }
  ],
  "camera": {
    "x": 10,
    "y": 20
  }
}
`;

test('a scene file reads and writes back byte for byte, keys this format does not know included', () => {
  const doc = parseSceneFile(FIXTURE, 'fixture.scene.json');
  assert.equal(doc.entities[1].flag, true);
  assert.deepEqual(doc.camera, { x: 10, y: 20 });
  assert.equal(serializeSceneFile(doc), FIXTURE);
});

test('serializeSceneFile writes keys in the file order, one entity per line, no empty config', () => {
  const text = serializeSceneFile({
    entities: [{ config: {}, y: 2, x: 1, class: 'Rock', name: 'Rock1' }],
    export: 'S',
    script: 's.js',
    format: 1,
  });
  assert.equal(
    text,
    '{\n  "format": 1,\n  "script": "s.js",\n  "export": "S",\n  "entities": [\n    { "name": "Rock1", "class": "Rock", "x": 1, "y": 2 }\n  ]\n}\n',
  );
  assert.equal(serializeSceneFile({ format: 1, script: 's.js', entities: [] }), '{\n  "format": 1,\n  "script": "s.js",\n  "entities": []\n}\n');
  assert.equal(inlineJson({ a: new Float64Array([1, 2.5]), b: {} }), '{ "a": [1, 2.5], "b": {} }');
});

test('a file that is not format 1 is an error naming the file and the entity', () => {
  const at = 'levels/1-1.scene.json';
  assert.throws(() => parseSceneFile('{ nope', at), /levels\/1-1\.scene\.json is not JSON/);
  assert.throws(() => checkSceneFile({ format: 2, script: 's.js' }, at), /format 2 is not supported \(this engine reads format 1\)/);
  assert.throws(() => checkSceneFile({ format: 1 }, at), /"script" must name the scene's module/);
  const base = { format: 1, script: 's.js' };
  assert.throws(
    () => checkSceneFile({ ...base, entities: [{ name: 'A', class: 'Rock', x: 0, y: 0 }, { name: 'A', class: 'Rock', x: 1, y: 1 }] }, at),
    /entities\[1\]: the name "A" is used twice/,
  );
  assert.throws(() => checkSceneFile({ ...base, entities: [{ name: 'A', x: 0, y: 0 }] }, at), /\(A\) needs a "class"/);
  assert.throws(() => checkSceneFile({ ...base, entities: [{ name: 'A', class: 'Rock', x: '0', y: 0 }] }, at), /"x" and "y" must be numbers/);
  assert.deepEqual(checkSceneFile({ ...base }, at).entities, [], 'entities may be left out');
});

test('a scene file names its module relative to itself', () => {
  const doc = { format: 1, script: '../platformerGameScene.js' };
  assert.equal(
    sceneFileScriptUrl(doc, 'http://host/demos/platformerGameScene/levels/1-1.scene.json'),
    'http://host/demos/platformerGameScene/platformerGameScene.js',
  );
  assert.equal(
    sceneFileScriptUrl(doc, '/demos/platformerGameScene/levels/1-1.scene.json', 'http://host'),
    'http://host/demos/platformerGameScene/platformerGameScene.js',
  );
  assert.equal(isSceneFileUrl('/levels/1-1.scene.json'), true);
  assert.equal(isSceneFileUrl('/levels/1-1.scene.json?v=2'), true);
  assert.equal(isSceneFileUrl('/demos/scene.js'), false);
  assert.equal(isSceneFileUrl(Scene), false);
});

class Door extends GameObject {
  static spawnParams = { open: { value: false } };
}
class Lever extends GameObject {
  static spawnParams = {
    door: { value: null, type: 'entity', class: 'Door' },
    path: { value: null, type: 'points' },
  };

  onSpawned(params) {
    Lever.got.push({ door: params.door, path: params.path });
  }
}
Lever.got = [];
class Link extends GameObject {
  static spawnParams = { next: { value: null, type: 'entity' } };

  onSpawned(params) {
    Link.got.push({ index: this.index, next: params.next });
  }
}
Link.got = [];
class Rock extends GameObject {
  speed = 0;
}
class Hero extends GameObject {
  static serializable = true;
}

/** A Scene with only what _spawnSceneFileEntities and getByName use. */
function sceneWith(entities, classes, extra = {}) {
  const scene = Object.create(Scene.prototype);
  Object.assign(scene, {
    sceneFile: checkSceneFile({ format: 1, script: 's.js', entities }, 'test.scene.json'),
    sceneFileUrl: '/levels/test.scene.json',
    registeredClasses: classes.map((C) => ({ class: C })),
    _namedEntities: new Map(),
    _restorePayload: null,
    _restoreAllTypes: false,
    ...extra,
  });
  return scene;
}

const classes = [Door, Lever, Link, Rock, Hero];
const pools = () => registerOnLogicWorker([[Door, 4], [Lever, 4], [Link, 4], [Rock, 2], [Hero, 2]]);

test('a referenced entity spawns first; the reference arrives as the instance, points as a Float64Array', async () => {
  await pools();
  Lever.got.length = 0;
  const scene = sceneWith(
    [
      { name: 'Lever1', class: 'Lever', x: 1, y: 2, config: { door: 'Door1', path: [0, 0, 5, 5] } },
      { name: 'Door1', class: 'Door', x: 10, y: 20 },
      { name: 'Rock1', class: 'Rock', x: 3, y: 4, config: { speed: 7 } },
    ],
    classes,
  );
  const warned = warnings(() => scene._spawnSceneFileEntities());
  assert.deepEqual(warned, []);
  const door = scene.getByName('Door1');
  assert.ok(door instanceof Door);
  assert.equal(Lever.got[0].door, door);
  assert.ok(Lever.got[0].path instanceof Float64Array, 'the loader made the Float64Array, so no copy per spawn');
  assert.deepEqual([...Lever.got[0].path], [0, 0, 5, 5]);
  assert.ok(scene.getByName('Lever1') instanceof Lever);
  assert.equal(scene.getByName('Rock1').speed, 7, 'a class without spawnParams gets its config keys as before');
  assert.equal(scene.getByName('Nobody'), null);
});

test('getByName returns null once the entity despawns, even when its slot is reused', async () => {
  await pools();
  const scene = sceneWith([{ name: 'Door1', class: 'Door', x: 0, y: 0 }], classes);
  scene._spawnSceneFileEntities();
  const door = scene.getByName('Door1');
  const index = door.index;
  door.despawn();
  assert.equal(scene.getByName('Door1'), null);
  const next = Door.spawn({ x: 0, y: 0 });
  assert.equal(next.index, index, 'the pool hands the slot out again');
  assert.equal(scene.getByName('Door1'), null, 'the name meant the entity that left, not the new one');
});

test('entities that refer to each other in a loop: one reference is dropped, with one warning', async () => {
  await pools();
  Link.got.length = 0;
  const scene = sceneWith(
    [
      { name: 'L1', class: 'Link', x: 0, y: 0, config: { next: 'L2' } },
      { name: 'L2', class: 'Link', x: 0, y: 0, config: { next: 'L1' } },
    ],
    classes,
  );
  const warned = warnings(() => scene._spawnSceneFileEntities());
  assert.equal(warned.length, 1);
  assert.match(warned[0], /L1 → L2 refer to each other in a loop; L2 gets no entity for its reference back to L1/);
  const l1 = scene.getByName('L1');
  const l2 = scene.getByName('L2');
  assert.deepEqual(
    Link.got.map((g) => [g.index, g.next]),
    [
      [l2.index, null],
      [l1.index, l2],
    ],
  );
});

test('sceneFileSpawnOrder keeps the file order where no reference asks otherwise', () => {
  const byName = { Door, Lever, Rock };
  const { order, backRefs } = sceneFileSpawnOrder(
    [
      { name: 'R1', class: 'Rock', x: 0, y: 0 },
      { name: 'Lv', class: 'Lever', x: 0, y: 0, config: { door: 'D' } },
      { name: 'R2', class: 'Rock', x: 0, y: 0 },
      { name: 'D', class: 'Door', x: 0, y: 0 },
    ],
    (name) => byName[name],
  );
  assert.deepEqual(order, [0, 3, 1, 2]);
  assert.equal(backRefs.size, 0);
});

test('an unknown class, a missing name and a small pool warn once each, naming the file', async () => {
  await pools();
  Lever.got.length = 0;
  const scene = sceneWith(
    [
      { name: 'G1', class: 'Ghost', x: 0, y: 0 },
      { name: 'G2', class: 'Ghost', x: 0, y: 0 },
      { name: 'Lv', class: 'Lever', x: 0, y: 0, config: { door: 'Nope' } },
      { name: 'R1', class: 'Rock', x: 0, y: 0 },
      { name: 'R2', class: 'Rock', x: 0, y: 0 },
      { name: 'R3', class: 'Rock', x: 0, y: 0 },
    ],
    classes,
  );
  const warned = warnings(() => scene._spawnSceneFileEntities()).filter((w) => w.includes('test.scene.json'));
  assert.equal(warned.length, 3);
  assert.match(warned[0], /places 3 Rock, its pool holds 2: raise Rock's count in Scene\.entities/);
  assert.match(warned[1], /"Ghost" is not in Scene\.entities; its entities are skipped/);
  assert.match(warned[2], /Lv\.door names "Nope", which is not an entity of the file/);
  assert.equal(Lever.got[0].door, null);
  assert.equal(scene.getByName('R3'), null, 'the one the pool could not hold');
});

test('restoring a save: the classes the save brings back are not spawned from the file', async () => {
  await pools();
  const entities = [
    { name: 'Hero1', class: 'Hero', x: 0, y: 0 },
    { name: 'Rock1', class: 'Rock', x: 0, y: 0 },
  ];
  const save = sceneWith(entities, classes, { _restorePayload: {} });
  save._spawnSceneFileEntities();
  assert.equal(save.getByName('Hero1'), null, 'serializable: the save has it');
  assert.ok(save.getByName('Rock1') instanceof Rock);
  await pools();
  const hot = sceneWith(entities, classes, { _restorePayload: {}, _restoreAllTypes: true });
  hot._spawnSceneFileEntities();
  assert.equal(hot._namedEntities.size, 0, 'a hot reload brings every entity back');
});
