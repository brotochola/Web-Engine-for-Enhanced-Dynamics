import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';

// E-209: every logic worker made `new EntityClass` for every pool slot at boot, and the page a frozen copy of each:
// about 40 ms and 12 MB per logic worker per 100 000 slots (R-0897). A slot's instance is made on its first use now.

const N = 1000;

class Walker extends GameObject {
  static components = [SpriteRenderer];
  steps = 0;
  started = 0;
  start() {
    this.started++;
  }
  tick() {
    this.steps++;
  }
}

async function bootLogic() {
  const scene = buildPoolScene({ entities: N });
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = N;
  lw.gameObjects = new Array(N).fill(null);
  globalThis.self.Walker = Walker;
  lw.registeredClasses = [{ name: 'Walker', poolSize: N, startIndex: 0, endIndex: N - 1, entityType: 0 }];
  Transform.active.fill(1); // whatever was there: boot writes "not active" for the pool
  Transform.entityType.fill(9);
  await quietly(() => lw.createGameObjectInstances());
  return lw;
}

test('a logic worker makes no instance at boot, and writes every slot\'s type and "not active"', { concurrency: false }, async () => {
  const lw = await bootLogic();
  assert.equal(lw.gameObjects.filter((o) => o !== null).length, 0, 'no instance made');
  assert.equal(Walker.instances.length, N);
  assert.ok(Walker.instances.every((o) => o === null));
  assert.ok(Transform.active.subarray(0, N).every((a) => a === 0), 'every slot not active');
  assert.ok(Transform.entityType.subarray(0, N).every((t) => t === 0), 'every slot typed');
});

test('a slot another worker made live gets its instance on first use, start() once, its Transform untouched', { concurrency: false }, async () => {
  const lw = await bootLogic();
  const i = 417;
  Transform.active[i] = 1; // spawned elsewhere (another logic worker, the page)
  const list = new Uint32Array([i]);
  const ticked = lw._tickBucketNoBody(list, 0, 1, 1, 16.6, 0, 1, Transform.active, lw.gameObjects);
  assert.equal(ticked, 1);
  const inst = lw.gameObjects[i];
  assert.ok(inst instanceof Walker);
  assert.equal(inst.index, i);
  assert.equal(inst.started, 1, 'start() on its first use');
  assert.equal(inst.steps, 1);
  assert.equal(Transform.active[i], 1, 'still live: the lazy instance does not reset its slot');
  assert.equal(GameObject.get(i), inst, 'the same object by index');
  assert.equal(Walker.instances[i], inst, 'and in its class\'s list');
  lw._tickBucketNoBody(list, 0, 1, 1, 16.6, 0, 2, Transform.active, lw.gameObjects);
  assert.equal(inst.started, 1, 'not again');
  assert.equal(inst.steps, 2);
  assert.equal(lw.gameObjects.filter((o) => o !== null).length, 1, 'the other slots still have none');
});

test('GameObject.get makes the instance in a logic worker; an index outside every pool gives none', { concurrency: false }, async () => {
  const lw = await bootLogic();
  const inst = GameObject.get(5);
  assert.ok(inst instanceof Walker);
  assert.equal(lw.gameObjects[5], inst);
  assert.equal(lw._makeInstance(N + 10), null);
});

test('the page makes no instance until one is asked for; it is frozen and checked once per class', { concurrency: false }, () => {
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
  assert.ok(GameObject.instances.every((o) => o === null), 'none made');
  const lamp = GameObject.get(3);
  assert.ok(lamp instanceof Lamp && Object.isFrozen(lamp) && lamp._onPage);
  assert.equal(Lamp.instances[0], lamp);
  assert.equal(GameObject.get(3), lamp, 'made once');
  assert.equal(GameObject.instances.filter((o) => o !== null).length, 1);
});
