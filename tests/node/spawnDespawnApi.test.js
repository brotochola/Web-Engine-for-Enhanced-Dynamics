import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer, DEFAULT_ANIMATION_SPEED } from '../../src/components/spriteRenderer.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

// N-52: Enemy.spawn / Enemy.despawn are the same calls in the scene and in
// entities. N-45: a spawn starts sprite animations at a speed that plays.

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

  assert.ok(GameObject.spawn(Walker, {}));
  assert.ok(GameObject.spawn(Walker, {}));

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

test('on the main thread Enemy.despawn sends the index to the scene', { concurrency: false }, () => {
  const calls = bindPools();
  const sent = [];
  const prevWindow = globalThis.window;
  const prevSelf = globalThis.self;
  globalThis.window = { scene: { despawnEntity: (i) => sent.push(i) } };
  globalThis.self = globalThis.window;
  try {
    Transform.active[0] = 0; // spawn sent from this thread, not set up yet
    assert.equal(Enemy.despawn(0), true);
    assert.equal(Enemy.despawn({ index: 1 }), true);
    captureWarnings(() => assert.equal(Pickup.despawn(1), false));
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevSelf === undefined) delete globalThis.self;
    else globalThis.self = prevSelf;
  }
  assert.deepEqual(sent, [0, 1]);
  assert.deepEqual(calls, [], 'logic0 runs it, not this thread');
});
