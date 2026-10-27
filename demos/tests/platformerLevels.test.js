// VISUAL_EDITOR_PLAN.md ED-37: the platformer's two levels, 1-1 and 1-2, each with a goal naming the other. Reaching
// a goal loads the level it names with what carries over in data; another level of the running scene class is a
// fast swap. What a browser shows (the swap's console line absent, the next level on screen) waits for browser runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../../tests/helpers/registerWebRoot.mjs';

import { parseSceneFile } from '../../src/core/sceneFile.js';
import { describeSpawnParams } from '../../src/core/spawnParams.js';
import { Messages } from '../../src/core/messages.js';
import { GameObject } from '../../src/core/gameObject.js';

const { PlatformerGameScene } = await import('../platformerGameScene/platformerGameScene.js');
const { Goal } = await import('../platformerGameScene/gameObjects/goal.js');

const levelUrl = (name) => new URL(`../platformerGameScene/levels/${name}`, import.meta.url);
const level = (name) => parseSceneFile(readFileSync(fileURLToPath(levelUrl(name)), 'utf8'), name);

test('each level has one goal, naming the other level', () => {
  for (const [name, other] of [['1-1.scene.json', '1-2.scene.json'], ['1-2.scene.json', '1-1.scene.json']]) {
    const goals = level(name).entities.filter((e) => e.class === 'Goal');
    assert.equal(goals.length, 1, name);
    assert.equal(new URL(goals[0].config.next, levelUrl(name)).href, levelUrl(other).href, `${name} leads to ${other}`);
  }
});

test('every class a level places is in the scene, within its pool', () => {
  const pools = new Map(PlatformerGameScene.entities.map(([C, n]) => [C.name, n]));
  for (const name of ['1-1.scene.json', '1-2.scene.json']) {
    const placed = new Map();
    for (const e of level(name).entities) placed.set(e.class, (placed.get(e.class) || 0) + 1);
    for (const [cls, n] of placed) {
      assert.ok(pools.has(cls), `${name}: ${cls} is in PlatformerGameScene.entities`);
      assert.ok(n <= pools.get(cls), `${name}: ${n} ${cls} fit the pool of ${pools.get(cls)}`);
    }
  }
});

test('each level places the player as Player, where it starts; its tuning is spawn params, and a save does not keep it', async () => {
  const { BluePlatformerPlayer } = await import('../platformerGameScene/gameObjects/bluePlatformerPlayer.js');
  for (const name of ['1-1.scene.json', '1-2.scene.json']) {
    const players = level(name).entities.filter((e) => e.class === 'BluePlatformerPlayer');
    assert.deepEqual(players.map((e) => e.name), ['Player'], `${name}: one, by the name the scene finds it by`);
  }
  const d = describeSpawnParams(BluePlatformerPlayer);
  for (const key of ['jumpSpeed', 'moveAcceleration', 'scale', 'radius', 'friction', 'linearDamping', 'lightIntensity']) {
    assert.ok(d.indexOf[key] >= 0, `${key}: a field of the editor's inspector`);
  }
  assert.equal(d.defaults[d.indexOf.jumpSpeed], 1333);
  assert.equal(d.defaults[d.indexOf.scale], 0.35, 'what its ticks draw it at, so the editor shows it as it plays');
  assert.notEqual(BluePlatformerPlayer.serializable, true, 'a level places it: a save does not keep it');
});

test('Goal declares next as a string param, for the editor', () => {
  const d = describeSpawnParams(Goal);
  assert.equal(d.kindNames[d.indexOf.next], 'string');
  assert.equal(d.defaults[d.indexOf.next], '');
});

test('reaching a goal loads the level it names, with the levels done so far', () => {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(128) }, []);
  const scene = Object.create(PlatformerGameScene.prototype);
  const calls = [];
  Object.assign(scene, {
    sceneFile: level('1-1.scene.json'),
    sceneFileUrl: levelUrl('1-1.scene.json').href,
    data: { levelsDone: 2 },
    game: { isTransitioning: false, loadScene: (url, options) => calls.push([url, options]) },
    // Goal1 was placed at index 70.
    _namedEntities: new Map([['Goal1', 70 * 65536 + Messages.spawnGen[70]]]),
  });
  const instances = GameObject.instances;
  GameObject.instances = [];
  GameObject.instances[70] = { index: 70 };
  try {
    scene.goToNextLevel(70);
    assert.deepEqual(calls, [[levelUrl('1-2.scene.json').href, { data: { levelsDone: 3 } }]]);
    scene.goToNextLevel(12);
    assert.equal(calls.length, 1, 'an index that is no goal of this level loads nothing');
    scene.game.isTransitioning = true;
    scene.goToNextLevel(70);
    assert.equal(calls.length, 1, 'a touch while a level loads loads nothing');
  } finally {
    GameObject.instances = instances;
  }
});
