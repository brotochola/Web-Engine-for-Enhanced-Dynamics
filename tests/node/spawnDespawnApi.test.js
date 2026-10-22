import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer, DEFAULT_ANIMATION_SPEED } from '../../src/components/spriteRenderer.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// N-52: Enemy.spawn / Enemy.despawn are the same calls in the scene and in
// entities, and spawn returns the entity there too (N-55: the page holds an
// instance per slot). N-45: a spawn starts sprite animations at a speed that plays.

const N = 4;
Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
Transform.x = new Float32Array(N); // pose fields live in the physics buffers
Transform.y = new Float32Array(N);
Transform.rotation = new Float32Array(N);
SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);

class Enemy extends GameObject {}
class Boss extends Enemy {}
class Pickup extends GameObject {}

/** Slots 0-1 Enemy, 2 Boss, 3 Pickup; instances record their despawn() calls. */
function bindPools() {
  const calls = [];
  const pools = [
    [Enemy, 0, 2, 1],
    [Boss, 2, 1, 2],
    [Pickup, 3, 1, 3],
  ];
  GameObject.classByType = [];
  for (const [C, start, size, type] of pools) {
    C.startIndex = start;
    C.endIndex = start + size;
    C.poolSize = size;
    C.entityType = type;
    C.instances = [];
    GameObject.classByType[type] = C;
    for (let i = start; i < start + size; i++) {
      Transform.entityType[i] = type;
      Transform.active[i] = 1;
      C.instances.push({ index: i, despawn: () => calls.push(i) });
    }
  }
  return calls;
}

function captureWarnings(fn) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return warnings;
}

test('spawn starts a sprite animation at the default speed, a reused slot too', { concurrency: false }, () => {
  class Walker extends GameObject {}
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(2);
  resetFreeList(top, links, 2, 1);
  Walker.startIndex = 0;
  Walker.poolSize = 2;
  Walker.entityType = 0;
  Walker.freeList = links;
  Walker.freeListTop = top;
  Walker._componentClassMap = {};
  Walker.instances = [0, 1].map((index) => ({ index, _hasComponents: { SpriteRenderer: true } }));
  SpriteRenderer.animationSpeed[0] = 0; // never spawned
  SpriteRenderer.animationSpeed[1] = 0.9; // the previous life's speed
  Transform.active[0] = 0;
  Transform.active[1] = 0;

  assert.ok(Walker.spawn({}));
  assert.ok(Walker.spawn({}));

  assert.ok(DEFAULT_ANIMATION_SPEED > 0);
  assert.equal(SpriteRenderer.animationSpeed[0], Math.fround(DEFAULT_ANIMATION_SPEED));
  assert.equal(SpriteRenderer.animationSpeed[1], Math.fround(DEFAULT_ANIMATION_SPEED));
});

test('Enemy.despawn(index) in a worker despawns a live entity of the class', { concurrency: false }, () => {
  const calls = bindPools();
  assert.equal(Enemy.despawn(1), true);
  assert.equal(Enemy.despawn({ index: 0 }), true, 'takes what spawn returned');
  assert.equal(Enemy.despawn(2), true, 'a Boss is an Enemy');
  assert.equal(GameObject.despawn(3), true, 'GameObject.despawn takes any class');
  assert.deepEqual(calls, [1, 0, 2, 3]);
});

test('Enemy.despawn does nothing for a dead slot or a bad index', { concurrency: false }, () => {
  const calls = bindPools();
  Transform.active[1] = 0;
  assert.equal(Enemy.despawn(1), false, 'already despawned');
  for (const bad of [-1, N, 0.5, NaN, null, undefined, {}]) {
    assert.equal(Enemy.despawn(bad), false, `index ${bad}`);
  }
  assert.deepEqual(calls, []);
});

test('Enemy.despawn of another class does nothing and warns once', { concurrency: false }, () => {
  const calls = bindPools();
  const warnings = captureWarnings(() => {
    assert.equal(Boss.despawn(0), false, 'an Enemy is not a Boss');
    assert.equal(Boss.despawn(3), false);
  });
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Boss\.despawn\(0\).*Enemy\.despawn\(index\)/);
});

/** Run fn as the page: a window whose scene is `scene`, no logic worker here. */
function onPage(scene, fn) {
  const prevWindow = globalThis.window;
  const prevSelf = globalThis.self;
  globalThis.window = { scene };
  globalThis.self = globalThis.window;
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevSelf === undefined) delete globalThis.self;
    else globalThis.self = prevSelf;
  }
}

test('on the page Enemy.despawn sends the index to logic0', { concurrency: false }, () => {
  const calls = bindPools();
  const sent = [];
  onPage({ _despawnFromPage: (i) => sent.push(i) }, () => {
    Transform.active[0] = 0; // spawn sent from this thread, not set up yet
    assert.equal(Enemy.despawn(0), true);
    assert.equal(Enemy.despawn({ index: 1 }), true);
    captureWarnings(() => assert.equal(Pickup.despawn(1), false));
  });
  assert.deepEqual(sent, [0, 1]);
  assert.deepEqual(calls, [], 'logic0 runs it, not this thread');
});

// The page holds one instance per pool slot, as each logic worker does.

class Crate extends GameObject {}
class Lamp extends GameObject {}

/** Page instances for Crate (slots 0-2) and Lamp (slot 3), through the scene's own code. */
function buildPageInstances() {
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
}

test('the page builds one instance per slot and resets no shared state', { concurrency: false }, () => {
  Transform.active.fill(1);
  Transform.entityType.fill(7);
  buildPageInstances();
  assert.equal(Crate.instances.length, 3);
  assert.equal(Lamp.instances.length, 1);
  assert.ok(GameObject.get(1) instanceof Crate);
  assert.ok(GameObject.get(3) instanceof Lamp);
  assert.equal(GameObject.get(1), Crate.instances[1], 'one object per slot');
  assert.equal(GameObject.get(2).index, 2);
  assert.ok(GameObject.get(0)._onPage);
  assert.deepEqual([...Transform.active], [1, 1, 1, 1], 'workers own the slots');
  assert.deepEqual([...Transform.entityType], [7, 7, 7, 7]);

  Crate._activeList = new Uint16Array([2, 2, 0]);
  assert.equal(Crate.getFirstActiveInstance(), Crate.instances[2]);
  assert.deepEqual(Crate.getAllActiveInstances(), [Crate.instances[2], Crate.instances[0]]);
});

test('a page instance takes writes through accessors; a plain field throws', { concurrency: false }, () => {
  buildPageInstances();
  const crate = GameObject.get(1);
  crate.x = 42; // an accessor: shared memory, seen by the tick on a logic worker
  assert.equal(Transform.x[1], 42);
  // A plain field would stay on the page, where no tick reads it.
  assert.throws(() => { crate.hp = 2; }, TypeError, 'a new field');
  assert.throws(() => { crate.index = 2; }, TypeError, 'an existing one');
  assert.ok(Object.isFrozen(crate));
});

test('on the page Enemy.spawn returns the entity (null when the pool is full)', { concurrency: false }, () => {
  buildPageInstances();
  const configs = [];
  let next = 1;
  const scene = {
    _spawnFromPage(C, config) {
      configs.push([C, config]);
      return next;
    },
  };
  onPage(scene, () => {
    assert.equal(Crate.spawn({ x: 5 }), Crate.instances[1]);
    next = 3;
    assert.equal(Lamp.spawn(), Lamp.instances[0]);
    next = -1;
    assert.equal(Crate.spawn({ x: 6 }), null);
  });
  assert.deepEqual(configs.map(([C, c]) => [C.name, c.x]), [['Crate', 5], ['Lamp', undefined], ['Crate', 6]]);
});

test('a page instance despawns through logic0 and emits to the scene directly', { concurrency: false }, () => {
  buildPageInstances();
  Transform.entityType.fill(0);
  GameObject.classByType = [Crate];
  const despawned = [];
  const events = [];
  const scene = {
    _despawnFromPage: (i) => despawned.push(i),
    _dispatchEntityEvent: (name, data, index, className) => events.push([name, data, index, className]),
  };
  onPage(scene, () => {
    const crate = GameObject.get(2);
    crate.despawn();
    assert.equal(crate.emit('opened', { gold: 3 }), true);
  });
  assert.deepEqual(despawned, [2]);
  assert.deepEqual(events, [['opened', { gold: 3 }, 2, 'Crate']]);
});

test('spawn is called on the entity class', { concurrency: false }, () => {
  const errors = [];
  const error = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    assert.equal(GameObject.spawn(Crate, { x: 1 }), null);
    assert.equal(GameObject.spawn({ x: 1 }), null);
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Crate\.spawn\(config\)/);
});
