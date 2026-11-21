// E-540: a realm's instance tables (a logic worker's this.gameObjects and GameObject.instances, the same array; each
// class's EntityClass.instances; the page's) were allocated whole when the realm registered its types: about 1.8 MB of
// nulls at 57 600 slots, in a scene written ECS-style that makes no instance. They are empty until the realm's first
// instance, which allocates them whole. The empty table has the elements kind the full one has, so a tick loop's load
// from it sees one map.
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject, emptyInstanceTable } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

const N = 12;
const HALF = N / 2;

class Herd extends GameObject {
  static components = [SpriteRenderer];
  static tickAll() {}
}
class Hero extends GameObject {
  static components = [SpriteRenderer];
  tick() {}
}

async function bootLogic(classes) {
  const scene = buildPoolScene({ entities: N });
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = { ...scene.config, logic: {} };
  lw.globalEntityCount = N;
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  lw.registeredClasses = classes.map((C, k) => ({
    name: C.name,
    poolSize: HALF,
    startIndex: k * HALF,
    endIndex: k * HALF + HALF - 1,
    entityType: k,
  }));
  for (const C of classes) {
    globalThis.self[C.name] = C;
    C._activeList = new (EntityIdArray())(1 + HALF);
  }
  await quietly(() => lw.createGameObjectInstances());
  return lw;
}

test('E-540: an empty instance table has the map of a full one; an empty literal does not', () => {
  v8.setFlagsFromString('--allow-natives-syntax');
  const sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)');
  const full = new Array(57600).fill(null);
  const empty = emptyInstanceTable();
  assert.equal(empty.length, 0);
  assert.equal(sameMap(empty, full), true);
  assert.equal(sameMap([], full), false, 'the literal is PACKED_SMI_ELEMENTS');
});

test('E-540: a logic worker of ECS types allocates no instance table; the first instance allocates them whole', { concurrency: false }, async () => {
  const lw = await bootLogic([Herd, Hero]);
  assert.equal(lw.gameObjects, GameObject.instances, 'one table for the worker and the realm');
  assert.equal(GameObject.instances.length, 0);
  assert.equal(Herd.instances.length, 0);
  assert.equal(Hero.instances.length, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(Herd, 'instances'), 'each class its own table');

  // Asking for an instance makes it, and the tables it goes in.
  const hero = GameObject.get(HALF + 2);
  assert.ok(hero instanceof Hero);
  assert.equal(GameObject.instances.length, N, 'the realm\'s table, whole');
  assert.equal(lw.gameObjects, GameObject.instances, 'the worker follows it');
  assert.equal(lw.gameObjects[HALF + 2], hero);
  assert.equal(Hero.instances.length, HALF);
  assert.equal(Hero.instances[2], hero);
  assert.equal(Herd.instances.length, 0, 'a class none of whose entities has an instance has no table');
  assert.equal(GameObject.get(HALF + 2), hero, 'made once');
  assert.ok(Hero.instances.every((o, k) => (k === 2 ? o === hero : o === null)));
});

test('E-540: the tick loop of an instance type finds its instances whatever table it was handed', { concurrency: false }, async () => {
  const lw = await bootLogic([Herd, Hero]);
  const handed = lw.gameObjects; // the loop reads the table once a frame: empty on the first one
  const list = new Uint32Array([HALF, HALF + 1]);
  const before = lw._tickBucketNoBody(list, 0, 2, 1, 16.6, 0, 1, new Uint8Array(N).fill(1), handed);
  assert.equal(before, 2);
  assert.equal(handed.length, 0, 'the table it was handed stays empty');
  assert.ok(lw.gameObjects[HALF] instanceof Hero && lw.gameObjects[HALF + 1] instanceof Hero);
  const again = lw._tickBucketNoBody(list, 0, 2, 1, 16.6, 0, 2, new Uint8Array(N).fill(1), handed);
  assert.equal(again, 2);
  assert.equal(lw.gameObjects.filter((o) => o !== null).length, 2, 'no second instance for a slot');
});

test('E-540: the page allocates no instance table until an instance is asked for', { concurrency: false }, () => {
  class Crate extends GameObject {}
  class Lamp extends GameObject {}
  GameObject._assignComponentClassMap(Crate);
  GameObject._assignComponentClassMap(Lamp);
  Crate.startIndex = 0;
  Lamp.startIndex = 3;
  const scene = {
    config: {},
    totalEntityCount: 4,
    registeredClasses: [
      { class: Crate, count: 3, startIndex: 0 },
      { class: Lamp, count: 1, startIndex: 3 },
    ],
  };
  Scene.prototype._createPageInstances.call(scene);
  assert.equal(GameObject.instances.length, 0);
  assert.equal(Crate.instances.length, 0);
  const lamp = GameObject.get(3);
  assert.equal(GameObject.instances.length, 4);
  assert.equal(Lamp.instances.length, 1, 'its pool\'s count, from the scene (Lamp.poolSize is not set here)');
  assert.equal(Lamp.instances[0], lamp);
  assert.equal(Crate.instances.length, 0);
});

test('E-540: a class with no table of its own gets one at its first instance, not its parent\'s', () => {
  class Base extends GameObject {}
  class Child extends Base {}
  Base.instances = emptyInstanceTable();
  Child.startIndex = 2;
  Child.poolSize = 3;
  const table = GameObject._classInstanceTable(Child);
  assert.ok(Object.prototype.hasOwnProperty.call(Child, 'instances'));
  assert.notEqual(table, Base.instances);
  assert.equal(table.length, 3);
  assert.equal(Base.instances.length, 0);
});
