import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

// The scene's config reached GameObject's prototype from the realm's first instance's constructor. A logic worker that
// makes no instance (types written ECS-style: static tickAll, static hooks, FSM states by index) read an empty config:
// Predator's people, pushed back from the world's edges by Person.tickAll, met the edges of a 1000 px world. The
// worker now binds it when it registers its types, and GameObject.config reads it from a static.

const PER_TYPE = 4;

class Static extends GameObject {
  static components = [SpriteRenderer];
  static tickAll() {}
}

test('a logic worker binds the scene config when it registers its types, before any instance', { concurrency: false }, async () => {
  const scene = buildPoolScene({ entities: PER_TYPE });
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  const config = { ...scene.config, worldWidth: 10000, worldHeight: 8000, logic: {} };
  lw.config = config;
  lw.globalEntityCount = PER_TYPE;
  lw.gameObjects = new Array(PER_TYPE).fill(null);
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  lw.registeredClasses = [{ name: 'Static', poolSize: PER_TYPE, startIndex: 0, endIndex: PER_TYPE - 1, entityType: 0 }];
  globalThis.self.Static = Static;
  Static._activeList = new (EntityIdArray())(1 + PER_TYPE);
  await quietly(() => lw.createGameObjectInstances());
  assert.ok(GameObject.instances.every((x) => x === null), 'no instance made');
  assert.equal(GameObject.config, config, 'GameObject.config is the scene config');
  assert.equal(Static.config.worldWidth, 10000, 'a subclass reads it through the static too');
  assert.equal(GameObject.prototype.config, config, "an entity's this.config, made later, is the same object");
});
