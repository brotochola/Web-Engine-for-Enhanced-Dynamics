// N-88: an entity class that extends another entity class has its own component flags. The flags were a static
// each class set on itself, and a subclass read the one it inherits: made after a parent instance, it took the
// parent's flags, so its own components read as absent (`this.rigidBody` null, hasComponent false).
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';

test('a subclass made after its parent has its own components, not the parent\'s', () => {
  class Enemy extends GameObject {
    static components = [SpriteRenderer];
  }
  class Boss extends Enemy {
    static components = [RigidBody];
  }
  for (const C of [Enemy, Boss]) GameObject._assignComponentClassMap(C);
  const enemy = new Enemy(0, {}, null, { page: true });
  const boss = new Boss(1, {}, null, { page: true });
  assert.equal(enemy._hasBox2dBody(), false, 'the parent has no body');
  assert.equal(boss._hasBox2dBody(), true, 'the subclass has its own (spawn and despawn read this)');
  assert.equal(boss._hasComponents.SpriteRenderer, true, 'and its parent\'s');
  assert.ok(boss.rigidBody instanceof RigidBody, 'its getter makes the component');
  assert.equal(boss.rigidBody.index, 1);
  assert.equal(enemy.rigidBody, undefined, 'the parent class has no rigidBody getter');
});
