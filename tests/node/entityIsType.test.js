import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { CollisionListener } from '../../src/components/collisionListener.js';

// DX 3.1. A collision callback gets an index; asking "is it a Coin?" meant
// Transform.entityType[other] === Coin.entityType, which misses subclasses.

class Person extends GameObject {
  static components = [RigidBody, Collider];
}
class Soldier extends Person {
  static components = [CollisionListener];
}
class Coin extends GameObject {
  static components = [Collider];
}

function register() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(6)), 6);
  GameObject.classByType.length = 0;
  const types = [
    [Person, 0, 0, 2],
    [Soldier, 1, 2, 4],
    [Coin, 2, 4, 6],
  ];
  for (const [C, type, from, to] of types) {
    C.entityType = type;
    GameObject.classByType[type] = C;
    GameObject._assignComponentClassMap(C);
    Transform.entityType.fill(type, from, to);
  }
}

function at(index) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  return go;
}

test('is(): exact class, subclass of a base class, not a sibling', () => {
  register();
  const soldier = at(2);
  assert.equal(soldier.is(3, Soldier), true);
  assert.equal(soldier.is(3, Person), true, 'a Soldier is a Person');
  assert.equal(soldier.is(0, Soldier), false, 'a Person is not a Soldier');
  assert.equal(soldier.is(4, Person), false);
  assert.equal(soldier.is(at(5), Coin), true, 'a GameObject works as well as an index');
  assert.equal(GameObject.isType(1, Person), true);
});

test('hasComponent(): own type, another entity, tags and inherited components', () => {
  register();
  const soldier = at(2);
  assert.equal(soldier.hasComponent(CollisionListener), true);
  assert.equal(soldier.hasComponent(RigidBody), true, 'inherited from Person');
  assert.equal(soldier.hasComponent(RigidBody, 4), false, 'a Coin has no RigidBody');
  assert.equal(soldier.hasComponent(Collider, at(4)), true);
  assert.equal(GameObject.hasComponent(0, CollisionListener), false);
});

test('an unregistered type answers false instead of throwing', () => {
  register();
  GameObject.classByType.length = 0;
  assert.equal(GameObject.isType(4, Person), false);
  assert.equal(GameObject.hasComponent(4, Collider), false);
});
