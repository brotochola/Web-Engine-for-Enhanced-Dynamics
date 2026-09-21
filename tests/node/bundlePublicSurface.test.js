import test from 'node:test';
import assert from 'node:assert/strict';

import WEED, {
  GameEngine,
  Query,
  Box2d,
  Decal,
  Flash,
  Decoration,
  SharedResource,
  SharedResourceMailbox,
  ColliderFixture,
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
  logicWorkerThatShouldTick,
  mixSeed,
  saveGame,
  DEBUG_FLAGS,
  ShapeType,
} from '../../src/index.js';

test('public barrel symbols stay callable', () => {
  assert.equal(typeof GameEngine, 'function');
  assert.equal(typeof Query.query, 'function');
  assert.equal(typeof Query.reset, 'function');
  assert.equal(typeof Box2d.explode, 'function');
  assert.equal(typeof Decal.stamp, 'function');
  assert.equal(typeof Flash.spawn, 'function');
  assert.equal(Flash.create, undefined);
  assert.equal(typeof Decoration, 'function');
  assert.equal(typeof SharedResource, 'function');
  assert.equal(WEED.SharedResource, SharedResource);
  assert.equal(typeof SharedResourceMailbox, 'function');
  assert.equal(WEED.SharedResourceMailbox, SharedResourceMailbox);
  assert.equal(typeof ColliderFixture.forEach, 'function');
  assert.equal(WEED.ColliderFixture, ColliderFixture);
  assert.equal(FORCE_PROCESS_ON_LOGIC_WORKER_NONE, -1);
  assert.equal(typeof resolveForceProcessOnLogicWorker, 'function');
  assert.equal(typeof logicWorkerThatShouldTick, 'function');
  assert.equal(WEED.FORCE_PROCESS_ON_LOGIC_WORKER_NONE, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
  assert.equal(typeof DEBUG_FLAGS.SHOW_JOINTS, 'number');
  assert.equal(ShapeType.Box, 0);
  assert.equal(typeof mixSeed, 'function');
  assert.equal(typeof mixSeed(1, 2), 'number');
  assert.equal(typeof saveGame, 'function');
  assert.equal(WEED.GameEngine, GameEngine);
  assert.equal(WEED.Query, Query);
  assert.equal(WEED.Box2d, Box2d);
  assert.equal(WEED.saveGame, saveGame);
  assert.equal(WEED.bindMovedBodies, undefined);
  assert.equal(WEED.collectSerializableEntities, undefined);
  assert.equal(WEED.AbstractWorker, undefined);
});
