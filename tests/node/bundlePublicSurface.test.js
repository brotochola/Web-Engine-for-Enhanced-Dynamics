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
