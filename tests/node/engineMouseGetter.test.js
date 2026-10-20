import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Mouse } from '../../src/core/mouse.js';

// Review D7. weed.d.ts documents GameEngine.mouse as the Mouse static API while
// a scene is active, but it returned scene.mouse, which no Scene has, so it was
// always undefined.

test('GameEngine.mouse is the Mouse API while a scene is active', () => {
  const get = Object.getOwnPropertyDescriptor(GameEngine.prototype, 'mouse').get;
  assert.equal(get.call({ currentScene: {} }), Mouse);
  assert.equal(get.call({ currentScene: null }), undefined);
});
