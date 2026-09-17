import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Query } from '../../src/core/query.js';
import { Box2d } from '../../src/core/box2d.js';
import { Decal } from '../../src/core/decal.js';
import { Flash } from '../../src/core/flash.js';
import { Decoration } from '../../src/core/decoration.js';
import { DEBUG_FLAGS } from '../../src/core/debug/debugFlags.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { mixSeed } from '../../src/util/utils.js';

test('public barrel symbols stay callable', () => {
  assert.equal(typeof GameEngine, 'function');
  assert.equal(typeof Query.query, 'function');
  assert.equal(typeof Query.reset, 'function');
  assert.equal(typeof Box2d.explode, 'function');
  assert.equal(typeof Decal.stamp, 'function');
  assert.equal(typeof Flash.spawn, 'function');
  assert.equal(Flash.create, undefined);
  assert.equal(typeof Decoration, 'function');
  assert.equal(typeof DEBUG_FLAGS.SHOW_JOINTS, 'number');
  assert.equal(ShapeType.Box, 0);
  assert.equal(typeof mixSeed, 'function');
  assert.equal(typeof mixSeed(1, 2), 'number');
});
