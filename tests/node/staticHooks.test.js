import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { CollisionListener } from '../../src/components/collisionListener.js';
import { JointBreakListener } from '../../src/components/jointBreakListener.js';
import { DirectionalSprite } from '../../src/components/directionalSprite.js';
import { Messages, MESSAGE_ANIMATION_END } from '../../src/core/messages.js';
import { drainMessages } from '../../src/util/messageRing.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';
import { popFreeIndex, resetFreeList } from '../../src/util/atomicFreeList.js';
import { BOX2D_CONTACT_KIND, bindContactRing, createContactRingSab, publishContactEvent } from '../../src/box2d/box2dContactRing.js';
import { IMPACT_FLOATS, bindImpactRing, impactRingBytes, publishImpacts } from '../../src/util/impactRing.js';
import { ENTITY_HOOKS, definesHook, staticHookOf } from '../../src/core/entityHooks.js';
import { patchClass, shapeChange } from '../../src/core/debug/hotSwap.js';

// E-528: every entity hook has a static form, `static onCollisionEnter(entityIndex, otherIndex)`, with the class as
// `this` and no instance. A logic worker resolves each type's static forms when it registers the type; a type whose
// hooks are all static makes no instance in any dispatch. The static form wins over a method of the same name and is
// inherited down the extends chain. Through the real logic worker: createGameObjectInstances registers the types, the
// shipped contact flow, impact poll, message drain and ring callbacks dispatch.

const PER_TYPE = 8;
let heard = [];

/** A logic worker with `classes` registered in PER_TYPE pools from index 0, the contact ring bound, nothing spawned. */
async function setup(classes) {
  const n = classes.length * PER_TYPE;
  const scene = buildPoolScene({ entities: n });
  DirectionalSprite.initializeArrays(new SharedArrayBuffer(DirectionalSprite.getBufferSize(n)), n);
  // The pose fields live in the physics buffers in a scene.
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotation = new Float32Array(n);
  GameObject.forceProcessOnLogicWorker = null;
  GameObject.entityTypeHasForcedLogicWorker = null;
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = n;
  lw.gameObjects = new Array(n).fill(null);
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  lw.nonDecimatedTypes = [];
  lw.decimatedTypes = [];
  lw.tickAllTypes = [];
  lw.tickAllBucketTypes = [];
  lw.directionalTypes = [];
  lw.registeredClasses = classes.map((C, t) => {
    globalThis.self[C.name] = C;
    C._activeList = new (EntityIdArray())(1 + PER_TYPE);
    return { name: C.name, poolSize: PER_TYPE, startIndex: t * PER_TYPE, endIndex: (t + 1) * PER_TYPE - 1, entityType: t };
  });
  await quietly(() => lw.createGameObjectInstances());
  const ring = createContactRingSab(1024);
  bindContactRing(ring);
  lw.box2dContactRingI32 = new Int32Array(ring);
  lw.box2dContactCursor = 0;
  lw.useBox2dContacts = true;
  lw.bodyGeneration = new Int32Array(new SharedArrayBuffer(n * 4));
  heard = [];
  return lw;
}

const begin = (a, b) => publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_BEGIN, a, b, 0, 0);
const end = (a, b) => publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_END, a, b, 0, 0);
const made = (lw) => lw.gameObjects.filter((o) => o !== null && o !== undefined).length;

class Coin extends GameObject {
  static components = [CollisionListener, JointBreakListener, DirectionalSprite];
  static onCollisionEnter(i, other) {
    heard.push(['onCollisionEnter', this, i, other]);
  }
  static onCollisionStay(i, other) {
    heard.push(['onCollisionStay', this, i, other]);
  }
  static onCollisionExit(i, other) {
    heard.push(['onCollisionExit', this, i, other]);
  }
  static onCollisionHit(i, other, px, py, nx, ny, approachSpeed) {
    heard.push(['onCollisionHit', this, i, other, px, py, nx, ny, approachSpeed]);
  }
  static onJointBreak(i, jointIndex, entityA, entityB) {
    heard.push(['onJointBreak', this, i, jointIndex, entityA, entityB]);
  }
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    heard.push(['onGotShot', this, i, damage, hitX, hitY, ownerId, shooterEntityType]);
  }
  static onMessage(i, name, from, a, b, c, d) {
    heard.push(['onMessage', this, i, name, from, a, b, c, d]);
  }
  static onAnimationEnd(i, name) {
    heard.push(['onAnimationEnd', this, i, name]);
  }
  static onDirectionChanged(i, direction) {
    heard.push(['onDirectionChanged', this, i, direction]);
  }
}

test('a type with only static hooks gets each one with its index first and its class as this, and makes no instance', { concurrency: false }, async () => {
  const lw = await setup([Coin]);
  Transform.active.fill(1, 0, PER_TYPE);
  assert.equal(lw.collisionStayByType[0], 2, 'the stay walk calls the static form');

  begin(0, 1);
  lw.processCollisionCallbacks();
  lw.processCollisionCallbacks();
  end(0, 1);
  lw.processCollisionCallbacks();
  assert.deepEqual(heard, [
    ['onCollisionEnter', Coin, 0, 1],
    ['onCollisionEnter', Coin, 1, 0],
    ['onCollisionStay', Coin, 0, 1],
    ['onCollisionStay', Coin, 1, 0],
    ['onCollisionExit', Coin, 0, 1],
    ['onCollisionExit', Coin, 1, 0],
  ]);

  heard = [];
  lw._onHitRingEvent(2, 3, 0, 0, 10, 20, 0.5, 0.25, 50);
  lw._onJointBreakRingEvent(9, 4, 5, 0, 0);
  assert.deepEqual(heard, [
    ['onCollisionHit', Coin, 2, 3, 10, 20, 0.5, 0.25, 50],
    ['onCollisionHit', Coin, 3, 2, 10, 20, -0.5, -0.25, 50],
    ['onJointBreak', Coin, 4, 9, 4, 5],
    ['onJointBreak', Coin, 5, 9, 4, 5],
  ]);

  heard = [];
  const impacts = new SharedArrayBuffer(impactRingBytes(8));
  const writer = bindImpactRing(impacts, 8);
  lw._impactRing = bindImpactRing(impacts, 8);
  lw._impactData = lw._impactRing.data;
  lw._impactMask = lw._impactRing.mask;
  lw._impactRead = Atomics.load(lw._impactRing.header, 0);
  const shot = new Float32Array(IMPACT_FLOATS);
  shot.set([6, 25, 1, 2, 7, 0]);
  publishImpacts(writer, shot, 1);
  lw._pollImpacts();
  assert.deepEqual(heard, [['onGotShot', Coin, 6, 25, 1, 2, 7, 0]]);

  heard = [];
  Messages.bind(Messages.createBuffers(1, 32, PER_TYPE), ['hit']);
  try {
    Messages.send(7, 'hit', 2, 1.5, 0, 0, 0);
    Messages.sendSystem(7, MESSAGE_ANIMATION_END, 0, 3);
    drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], lw._onMessageEvent);
  } finally {
    Messages.unbind();
  }
  assert.deepEqual(heard, [
    ['onMessage', Coin, 7, 'hit', 2, 1.5, 0, 0, 0],
    ['onAnimationEnd', Coin, 7, ''],
  ]);

  heard = [];
  DirectionalSprite.directionIndex[3] = 2;
  lw._directionChanged(3, lw.directionalTypes[0].hook);
  assert.deepEqual(heard, [['onDirectionChanged', Coin, 3, DirectionalSprite.directionName(3)]]);

  assert.equal(made(lw), 0, 'no hook made an instance');
  assert.ok(Coin.instances.every((o) => o === null));
  Transform.active.fill(0);
});

class Gem extends GameObject {
  static components = [CollisionListener];
  static onSpawned(i, config) {
    heard.push(['onSpawned', this, i, config.value]);
    if (config.callOff) this.despawn(i);
  }
  static onDespawned(i) {
    heard.push(['onDespawned', this, i]);
  }
}

test('static onSpawned gets the index and the config, static onDespawned the index; a despawn with no instance makes none', { concurrency: false }, async () => {
  const lw = await setup([Gem]);
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new (EntityIdArray())(PER_TYPE);
  resetFreeList(top, links, PER_TYPE, 1);
  Gem.freeList = links;
  Gem.freeListTop = top;

  const gem = Gem.spawn({ x: 4, value: 7 });
  assert.ok(gem instanceof Gem, 'spawn still returns the entity');
  assert.equal(Transform.active[gem.index], 1);
  assert.deepEqual(heard, [['onSpawned', Gem, gem.index, 7]]);

  // An entity another thread spawned: no instance on this worker, and its despawn makes none.
  heard = [];
  const other = popFreeIndex(top, links, 0);
  Transform.active[other] = 1;
  assert.equal(lw.gameObjects[other], null);
  assert.equal(Gem.despawn(other), true);
  assert.deepEqual(heard, [['onDespawned', Gem, other]]);
  assert.equal(Transform.active[other], 0);
  assert.equal(lw.gameObjects[other], null, 'no instance made to despawn it');

  // A static onSpawned that despawns its own entity calls the spawn off, as this.despawn() in a method does.
  heard = [];
  assert.equal(Gem.spawn({ value: 1, callOff: true }), null);
  assert.equal(heard.length, 1);
  assert.equal(heard[0][0], 'onSpawned');
  assert.equal(Transform.active[heard[0][2]], 0, 'not live');

  heard = [];
  assert.equal(Gem.despawn(gem), true);
  assert.deepEqual(heard, [['onDespawned', Gem, gem.index]]);
  Transform.active.fill(0);
});

class Both extends GameObject {
  static components = [CollisionListener];
  static onCollisionEnter(i, other) {
    heard.push(['static', i, other]);
  }
  onCollisionEnter(other) {
    heard.push(['method', this.index, other]);
  }
}

class Plain extends GameObject {
  static components = [CollisionListener];
  onCollisionEnter(other) {
    heard.push(['plain method', this.index, other]);
  }
}

test('the static form wins over a method of the same name; a method-only type next to it keeps its instance path', { concurrency: false }, async () => {
  const lw = await setup([Both, Plain]);
  Transform.active.fill(1, 0, 2 * PER_TYPE);
  begin(0, 1);
  begin(2, PER_TYPE);
  lw.processCollisionCallbacks();
  assert.deepEqual(heard, [
    ['static', 0, 1],
    ['static', 1, 0],
    ['static', 2, PER_TYPE],
    ['plain method', PER_TYPE, 2],
  ]);
  assert.equal(lw.gameObjects[0], null, 'the static form made no instance');
  assert.equal(lw.gameObjects[2], null);
  assert.ok(lw.gameObjects[PER_TYPE] instanceof Plain, 'the method made its instance');
  Transform.active.fill(0);
});

class Animal extends GameObject {
  static onCollisionEnter(i, other) {
    heard.push(['animal', this, i, other]);
  }
}
class Dog extends Animal {
  static components = [CollisionListener];
}
class Cat extends Animal {
  static components = [CollisionListener];
  static onCollisionEnter(i, other) {
    heard.push(['cat', this, i, other]);
  }
}
class Bird extends Animal {
  static components = [CollisionListener];
  onCollisionEnter(other) {
    heard.push(['bird method', this.index, other]);
  }
}

test('a static hook is inherited down the extends chain, with the subclass as this; a subclass static overrides it', { concurrency: false }, async () => {
  const lw = await setup([Dog, Cat, Bird]);
  Transform.active.fill(1, 0, 3 * PER_TYPE);
  const dog = 0;
  const cat = PER_TYPE;
  const bird = 2 * PER_TYPE;
  begin(dog, cat);
  begin(bird, dog + 1);
  lw.processCollisionCallbacks();
  assert.deepEqual(heard, [
    ['animal', Dog, dog, cat],
    ['cat', Cat, cat, dog],
    // Bird's method loses to the static it inherits: a static wins over a method of the same name.
    ['animal', Bird, bird, dog + 1],
    ['animal', Dog, dog + 1, bird],
  ]);
  assert.equal(made(lw), 0);
  Transform.active.fill(0);
});

test('the hook table: every hook is a GameObject method with no static of its name, and definesHook sees both forms', () => {
  for (const hook of ENTITY_HOOKS) {
    assert.equal(typeof GameObject.prototype[hook.name], 'function', `GameObject.prototype.${hook.name}`);
    assert.equal(staticHookOf(GameObject, Object, hook.name), null, `GameObject has no static ${hook.name}`);
    assert.ok(Array.isArray(hook.params) && typeof hook.summary === 'string' && typeof hook.runs === 'string');
  }
  assert.equal(new Set(ENTITY_HOOKS.map((h) => h.name)).size, ENTITY_HOOKS.length, 'one row per hook');
  assert.ok(definesHook(Dog, GameObject, 'onCollisionEnter'), 'an inherited static');
  assert.ok(definesHook(Plain, GameObject, 'onCollisionEnter'), 'a method');
  assert.ok(!definesHook(Plain, GameObject, 'onCollisionExit'), "GameObject's own empty method does not count");
  assert.equal(staticHookOf(Bird, GameObject, 'onCollisionEnter'), Animal.onCollisionEnter);
});

test('hot swap: a static hook added is a shape change; one moved from a method to a static swaps in place and the old static leaves', () => {
  class Old extends GameObject {
    static components = [CollisionListener];
    static onCollisionEnter(i, other) {
      return ['old', i, other];
    }
  }
  const added = class Old extends GameObject {
    static components = [CollisionListener];
    static onCollisionEnter(i, other) {
      return ['new', i, other];
    }
    static onCollisionExit() {}
  };
  assert.match(shapeChange(Old, added), /onCollisionExit\(\) was added/);
  const moved = class Old extends GameObject {
    static components = [CollisionListener];
    onCollisionEnter(other) {
      return ['method', other];
    }
  };
  assert.equal(shapeChange(Old, moved), null);
  patchClass(Old, moved);
  assert.equal(Object.prototype.hasOwnProperty.call(Old, 'onCollisionEnter'), false, 'the dropped static is gone');
  assert.equal(typeof Old.prototype.onCollisionEnter, 'function');
});
