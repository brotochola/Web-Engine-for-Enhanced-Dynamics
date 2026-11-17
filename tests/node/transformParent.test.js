import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

import { GameObject } from '../../src/core/gameObject.js';
import { Box2d } from '../../src/core/box2d.js';
import {
  Transform,
  LINK_COUNT,
  LINK_LIST_COUNT,
  LINK_LIST_SEQ,
  LINK_ORPHAN_HEAD,
  LINK_ORPHAN_TAIL,
  LINK_VERSION,
  LINK_WORDS,
  LINK_ORPHAN_CAP,
  linkRegionLayout,
} from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { bindBodySyncBuffers } from '../../src/box2d/box2dBodySync.js';
import { readEntityComponents } from '../../src/core/save/entitySaveSnapshot.js';
import { resetFreeList, getFreeListCount, popFreeIndex } from '../../src/util/atomicFreeList.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// DX-PARENT (Transform.parent): an entity follows another (a car's lights follow the car). Physics writes each linked
// child's pose after its step, before it publishes the pose (weedjsPost.js, its child-links block, run here as
// shipped); it finds the children whose parent despawned (the parent's body generation moved, or it is not active) and
// queues them for logic0, which despawns them (the real logic worker's _drainOrphanedChildren). Pre-render composes a
// child from its parent's drawn pose (the real pre-render worker's _composeChildren and _displayPose). Logic links and
// unlinks through GameObject: spawn keys, transform.parent, the warnings, and the slot claimed once per despawn.

const NONE = 0xffff;
const N = 10;

const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');

function block(src, name) {
  const start = src.indexOf(`// ${name}-start`);
  const end = src.indexOf(`// ${name}-end`);
  assert.ok(start >= 0 && end > start, `${name} block missing`);
  return src.slice(start, end);
}

/** weedjsPost's child-links block as shipped, on the given physics views and body generations. */
function physicsChildLinks(views, generation) {
  return new Function(
    'views',
    'bodyGeneration',
    `${block(post, 'child-links')}
    return { useChildLinks, writeChildPoses, counts: () => ({ childCount, childVersion }) };`,
  )(views, generation);
}

const logic = await loadWorker('logicWorker.js', 'logicWorker');
const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');

class Car extends GameObject {}
Car.components = [RigidBody, Collider];
class Light extends GameObject {}
class Crate extends GameObject {}
Crate.components = [Collider];
class Sign extends GameObject {}
/** A car whose onSpawned spawns its two lights, as a game spawns a car with its headlights. */
class LitCar extends GameObject {
  onSpawned() {
    Light.spawn({ parent: this, localX: 20, localY: -6 });
    Light.spawn({ parent: this, localX: 20, localY: 6 });
  }
}
LitCar.components = [RigidBody, Collider];

function pool(C, start, size, type) {
  GameObject._assignComponentClassMap(C);
  C.startIndex = start;
  C.endIndex = start + size;
  C.poolSize = size;
  C.entityType = type;
  C.freeListTop = new Int32Array(new SharedArrayBuffer(8));
  C.freeList = new Uint16Array(new SharedArrayBuffer(size * 2));
  resetFreeList(C.freeListTop, C.freeList, size, 1);
  C.instances = [];
  GameObject.classByType[type] = C;
  for (let i = start; i < start + size; i++) new C(i);
}

/**
 * A scene of N entities: Car 0-1, Light 2-6, Crate 7, Sign 8, LitCar 9 (no room for its lights in the Light pool's
 * own test). Physics' child-links block on the same columns. Returns the body generations and physics.
 */
function world() {
  bindEntityIdWidth(16);
  resetWarnOnce();
  Box2d.physicsWorkerAbsent = false;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  // The pose and the velocities live on Box2D's heap in a scene (bindBox2dHotFields).
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotation = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  RigidBody.sleeping = new Uint8Array(N);
  const sync = {
    bodyDirtyFlags: new SharedArrayBuffer(N * 4),
    bodyDirtyWords: new SharedArrayBuffer(8),
    bodyGeneration: new SharedArrayBuffer(N * 4),
    bodyGenEpoch: new SharedArrayBuffer(4),
  };
  bindBodySyncBuffers(sync);
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  GameObject.classByType = [];
  GameObject.instances = [];
  pool(Car, 0, 2, 0);
  pool(Light, 2, 5, 1);
  pool(Crate, 7, 1, 2);
  pool(Sign, 8, 1, 3);
  pool(LitCar, 9, 1, 4);
  const generation = new Int32Array(sync.bodyGeneration);
  const physics = physicsChildLinks(
    {
      entityActive: Transform.active,
      x: Transform.x,
      y: Transform.y,
      rotation: Transform.rotation,
      rotC: Transform.rotC,
      rotS: Transform.rotS,
    },
    generation,
  );
  physics.useChildLinks(
    Transform.links,
    Transform.parent,
    NONE,
    Transform.localX,
    Transform.localY,
    Transform.localRotation,
    Transform.parentGen,
    Transform.childList,
    Transform.orphans,
    N,
  );
  return { generation, physics };
}

/** What Box2D's step leaves for a body: its pose on the heap. */
function moveBody(i, x, y, angle) {
  Transform.x[i] = x;
  Transform.y[i] = y;
  Transform.rotation[i] = angle;
  Transform.rotC[i] = Math.cos(angle);
  Transform.rotS[i] = Math.sin(angle);
}

function near(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${what}: ${actual}, expected ${expected}`);
}

/** The child's pose is its parent's turned local offset. */
function assertFollows(child, parent, lx, ly, lr = 0) {
  const pc = Math.cos(Transform.rotation[parent]);
  const ps = Math.sin(Transform.rotation[parent]);
  near(Transform.x[child], Transform.x[parent] + pc * lx - ps * ly, 'x');
  near(Transform.y[child], Transform.y[parent] + ps * lx + pc * ly, 'y');
  near(Transform.rotC[child], Math.cos(Transform.rotation[parent] + lr), 'rotC');
  near(Transform.rotS[child], Math.sin(Transform.rotation[parent] + lr), 'rotS');
  near(Math.cos(Transform.rotation[child]), Math.cos(Transform.rotation[parent] + lr), 'rotation');
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

function publishedList() {
  assert.equal(Atomics.load(Transform.links, LINK_LIST_SEQ) & 1, 0, 'the published list is not being written');
  return Array.from(Transform.childList.subarray(0, Atomics.load(Transform.links, LINK_LIST_COUNT)));
}

test("Transform's link region: physics binds the same bytes (16- and 32-bit ids, at a byte offset)", () => {
  const schemaStart = host.indexOf('  var TRANSFORM_SCHEMA = {');
  const schemaEnd = host.indexOf('\n  };', schemaStart) + '\n  };'.length;
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart, 'TRANSFORM_SCHEMA missing');
  const h = new Function(
    `${host.slice(schemaStart, schemaEnd)}
    ${block(host, 'transform-links')}
    return { transformSchema, bindTransformLinks, LINK_WORDS, LINK_ORPHAN_CAP };`,
  )();
  assert.equal(h.LINK_WORDS, LINK_WORDS);
  assert.equal(h.LINK_ORPHAN_CAP, LINK_ORPHAN_CAP);
  try {
    for (const width of [16, 32]) {
      bindEntityIdWidth(width);
      const n = 37;
      const byte = 64 * 5;
      const sab = new SharedArrayBuffer(byte + Transform.getBufferSize(n));
      Transform.initializeArrays(sab, n, byte);
      const schema = h.transformSchema(width);
      assert.deepEqual(Object.keys(schema), Object.keys(Transform.ARRAY_SCHEMA), 'the same columns');
      assert.equal(schema.parent, width === 32 ? Uint32Array : Uint16Array);
      assert.equal(Transform.parent.constructor, schema.parent);
      assert.equal(Transform.parent[0], width === 32 ? 0xffffffff : 0xffff, 'no parent at first');
      const links = h.bindTransformLinks(sab, n, byte, schema);
      for (const [name, mine] of [
        ['links', links.words],
        ['parentGen', links.parentGen],
        ['childList', links.list],
        ['orphans', links.orphans],
      ]) {
        assert.equal(mine.byteOffset, Transform[name].byteOffset, `${name} at the same byte (${width}-bit ids)`);
        assert.equal(mine.length, Transform[name].length, `${name} the same length`);
      }
      const end = Transform.orphans.byteOffset + Transform.orphans.byteLength;
      assert.equal(end, sab.byteLength, 'the region ends the block getBufferSize sized');
      assert.equal(linkRegionLayout(n).bytes, LINK_WORDS * 4 + n * 8 + LINK_ORPHAN_CAP * 4);
    }
  } finally {
    bindEntityIdWidth(16);
  }
});

test('with no link physics reads one word and walks nothing; an entity without a parent pays nothing', () => {
  const { physics } = world();
  const car = Car.spawn({ x: 10, y: 20, width: 40, height: 20 });
  assert.ok(car);
  moveBody(car.index, 50, 60, 0.5);
  physics.writeChildPoses();
  assert.deepEqual(physics.counts(), { childCount: 0, childVersion: 0 }, 'no rebuild: the version never moved');
  assert.equal(Atomics.load(Transform.links, LINK_LIST_SEQ), 0, 'nothing published');
  assert.equal(car.transform.parent, null);
});

test('a child follows its rotated parent in the same frame', () => {
  const { physics } = world();
  const car = Car.spawn({ x: 100, y: 50, width: 40, height: 20 });
  const front = Light.spawn({ parent: car, localX: 30, localY: -8 });
  const turned = Light.spawn({ parent: car.index, localX: -12, localY: 4, localRotation: Math.PI / 4 });
  assert.ok(car && front && turned);
  assert.equal(front.transform.parent, car.index);
  assert.equal(turned.transform.parent, car.index, 'an index links as the entity does');
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 2);
  // Linked, it is where its parent puts it before physics' next step.
  near(front.x, 130, 'x at the link');
  near(front.y, 42, 'y at the link');

  for (const [x, y, angle] of [
    [200, 100, Math.PI / 2],
    [210, 90, -2.5],
    [-40, 300, 3.1],
  ]) {
    // The step moves and turns the car; physics writes the children right after it, before the pose is published.
    moveBody(car.index, x, y, angle);
    physics.writeChildPoses();
    assertFollows(front.index, car.index, 30, -8);
    assertFollows(turned.index, car.index, -12, 4, Math.PI / 4);
    assert.ok(Transform.rotation[turned.index] > -Math.PI && Transform.rotation[turned.index] <= Math.PI, 'rotation wrapped');
  }
  assert.deepEqual(publishedList().sort(), [front.index, turned.index].sort(), 'the list pre-render composes');

  // A new local offset is taken at the next step.
  front.transform.localX = 0;
  front.transform.localY = 10;
  physics.writeChildPoses();
  assertFollows(front.index, car.index, 0, 10);
  assert.equal(car.transform.parent, null, 'the parent has none');
});

test('transform.parent on a live entity links it; null unlinks it, and it stays where it is', () => {
  const { physics } = world();
  const car = Car.spawn({ x: 0, y: 0, width: 40, height: 20 });
  const light = Light.spawn({ x: 5, y: 5 });
  light.transform.localX = 10;
  light.transform.parent = car;
  moveBody(car.index, 100, 100, 0);
  physics.writeChildPoses();
  near(light.x, 110, 'follows');
  light.transform.parent = null;
  assert.equal(light.transform.parent, null);
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 0);
  moveBody(car.index, 400, 400, 1);
  physics.writeChildPoses();
  near(light.x, 110, 'stays where it was unlinked');
  assert.deepEqual(publishedList(), []);
  light.x = 7;
  near(light.x, 7, 'its own again: logic moves it');
});

test("the parent's despawn takes the child within a frame", () => {
  const { physics } = world();
  const car = Car.spawn({ x: 100, y: 50, width: 40, height: 20 });
  const light = Light.spawn({ parent: car, localX: 30 });
  moveBody(car.index, 120, 50, 0);
  physics.writeChildPoses();
  near(light.x, 150, 'follows');

  // Frame n: logic despawns the car. Physics' step finds the light orphaned, leaves it where it was and queues it.
  car.despawn();
  physics.writeChildPoses();
  near(light.x, 150, 'not written once orphaned');
  assert.equal(Transform.active[light.index], 1, 'still alive this frame');
  assert.equal(Transform.links[LINK_ORPHAN_HEAD] - Transform.links[LINK_ORPHAN_TAIL], 1, 'queued for logic0');
  assert.deepEqual(publishedList(), [], 'out of the published list');

  // Frame n + 1: logic0 despawns it first thing.
  assert.equal(logic._drainOrphanedChildren(), 1);
  assert.equal(Transform.active[light.index], 0, 'gone');
  assert.equal(Transform.parent[light.index], NONE, 'its link released');
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 0);
  assert.equal(Transform.links[LINK_ORPHAN_TAIL], Transform.links[LINK_ORPHAN_HEAD]);
  physics.writeChildPoses();
  assert.equal(physics.counts().childCount, 0, 'physics no longer lists it');
});

test('a reused slot inherits nothing: no child follows the next car in its slot, and a new light has no parent', () => {
  const { physics, generation } = world();
  const car = Car.spawn({ x: 100, y: 50, width: 40, height: 20 });
  const carIndex = car.index;
  const light = Light.spawn({ parent: car, localX: 30, localY: 2, localRotation: 1 });
  const lightIndex = light.index;
  moveBody(carIndex, 100, 50, 0);
  physics.writeChildPoses();
  const before = { x: light.x, y: light.y };

  // In one logic frame the car despawns and another spawns into its slot (the free list hands the same one back).
  const gen0 = generation[carIndex];
  car.despawn();
  const next = Car.spawn({ x: 900, y: 900, width: 40, height: 20 });
  assert.equal(next.index, carIndex, 'the same slot');
  assert.equal(generation[carIndex], gen0 + 2, 'two new body lives');
  moveBody(carIndex, 905, 900, 0.3);
  physics.writeChildPoses();
  near(light.x, before.x, 'did not jump to the new car');
  near(light.y, before.y, 'did not jump to the new car');
  assert.equal(logic._drainOrphanedChildren(), 1, 'despawned at the next frame');
  assert.equal(Transform.active[lightIndex], 0);

  // A light spawned into the old light's slot: no parent, no offset.
  const fresh = Light.spawn({ x: 1, y: 2 });
  assert.equal(fresh.index, lightIndex, 'the same slot');
  assert.equal(fresh.transform.parent, null);
  assert.equal(fresh.transform.localX, 0);
  assert.equal(fresh.transform.localY, 0);
  assert.equal(fresh.transform.localRotation, 0);
  physics.writeChildPoses();
  near(fresh.x, 1, 'its own pose');
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 0);
});

test("a link made in the parent's onSpawned waits for its activation, and then follows it", () => {
  const { physics, generation } = world();
  // The light pool has room for LitCar's two lights.
  const car = LitCar.spawn({ x: 300, y: 200, width: 40, height: 20 });
  assert.ok(car);
  const lights = [];
  for (let i = Light.startIndex; i < Light.endIndex; i++) if (Transform.parent[i] === car.index) lights.push(i);
  assert.equal(lights.length, 2);
  for (const l of lights) assert.equal(Transform.parentGen[l], generation[car.index], 'the life it activated with');
  assert.ok(Atomics.load(Transform.links, LINK_VERSION) > 0);
  moveBody(car.index, 320, 210, Math.PI);
  physics.writeChildPoses();
  assertFollows(lights[0], car.index, 20, Transform.localY[lights[0]]);
  assertFollows(lights[1], car.index, 20, Transform.localY[lights[1]]);
  assert.equal(Transform.links[LINK_ORPHAN_HEAD], 0, 'no orphan on the way');
});

test('a waiting link (its parent still spawning) is neither written nor orphaned; an aborted parent orphans it', () => {
  const { physics } = world();
  // Physics steps in the middle of the parent's onSpawned, after its light spawned and linked: the link waits.
  let midSpawn = null;
  class StepCar extends GameObject {
    onSpawned() {
      const light = Light.spawn({ parent: this, localX: 5 });
      midSpawn = { light: light.index, gen: Transform.parentGen[light.index] };
      Transform.bumpLinks(); // another link changed meanwhile: physics lists this one too
      physics.writeChildPoses();
    }
  }
  StepCar.components = [RigidBody, Collider];
  pool(StepCar, 9, 1, 4);
  const car = StepCar.spawn({ x: 10, y: 10, width: 40, height: 20 });
  assert.equal(midSpawn.gen, 0, 'the link waited at generation 0');
  assert.equal(Transform.links[LINK_ORPHAN_HEAD], 0, 'not taken for an orphan mid-spawn');
  assert.equal(logic._drainOrphanedChildren(), 0);
  moveBody(car.index, 60, 10, 0);
  physics.writeChildPoses();
  near(Transform.x[midSpawn.light], 65, 'follows once its parent is active');

  // That car goes, and its light with it.
  car.despawn();
  physics.writeChildPoses();
  assert.equal(logic._drainOrphanedChildren(), 1);

  // A parent whose onSpawned spawns a light and then gives up (despawns itself): the light is an orphan.
  let orphan = -1;
  class GiveUpCar extends GameObject {
    onSpawned() {
      orphan = Light.spawn({ parent: this, localX: 5 }).index;
      this.despawn();
    }
  }
  GiveUpCar.components = [RigidBody, Collider];
  pool(GiveUpCar, 9, 1, 4);
  assert.equal(GiveUpCar.spawn({ x: 0, y: 0, width: 40, height: 20 }), null, 'its spawn aborted');
  assert.equal(Transform.parent[orphan], GiveUpCar.startIndex, 'the light is still linked to the slot');
  assert.equal(Transform.parentGen[orphan], -1, 'to no life of it');
  physics.writeChildPoses();
  assert.equal(logic._drainOrphanedChildren(), 1, 'physics queued it and logic0 despawned it');
  assert.equal(Transform.active[orphan], 0);
});

test("a parent whose body is made again (its sensor flag changed) keeps its children", () => {
  const { physics, generation } = world();
  const car = Car.spawn({ x: 0, y: 0, width: 40, height: 20 });
  const light = Light.spawn({ parent: car, localX: 15 });
  const gen0 = generation[car.index];
  car.collider.isTrigger = true; // remakeBody: a new generation for a live entity
  assert.equal(generation[car.index], gen0 + 1);
  assert.equal(Transform.parentGen[light.index], generation[car.index], 'its children take it');
  moveBody(car.index, 50, 0, 0);
  physics.writeChildPoses();
  near(light.x, 65, 'still follows');
  assert.equal(Transform.links[LINK_ORPHAN_HEAD], 0, 'not an orphan');
});

test('the warnings, once each: a child with a body, a parent without one, physics off, a write to a child', () => {
  const { physics } = world();
  const car = Car.spawn({ x: 0, y: 0, width: 40, height: 20 });
  const crate = Crate.spawn({ x: 1, y: 1, width: 4, height: 4 });
  const sign = Sign.spawn({ x: 2, y: 2 });
  const light = Light.spawn({ x: 3, y: 3 });

  let warnings = captureWarnings(() => {
    crate.transform.parent = car;
    crate.transform.parent = car;
  });
  assert.equal(warnings.length, 1, 'once');
  assert.match(warnings[0], /^WeedJS: Crate: a body's position belongs to physics; attach it with a joint/);
  assert.equal(crate.transform.parent, null, 'not linked');

  warnings = captureWarnings(() => {
    light.transform.parent = sign;
    light.transform.parent = sign.index;
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Light: its parent, a Sign, has no body/);
  assert.equal(light.transform.parent, null);

  Box2d.physicsWorkerAbsent = true;
  try {
    warnings = captureWarnings(() => {
      light.transform.parent = car;
    });
  } finally {
    Box2d.physicsWorkerAbsent = false;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Light: transform\.parent needs physics/);
  assert.equal(light.transform.parent, null);
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 0, 'no link made by any of them');

  light.transform.localX = 10;
  light.transform.parent = car;
  moveBody(car.index, 100, 0, 0);
  physics.writeChildPoses();
  warnings = captureWarnings(() => {
    light.x = 500;
    light.setPosition(600, 600);
    light.rotation = 2;
    light.setRotationCS(0, 1);
    light.transform.y = 700;
  });
  assert.equal(warnings.length, 1, 'said once for the class');
  assert.match(warnings[0], /Light: its position and rotation come from its parent .*The write was ignored\./);
  near(light.x, 110, 'x put back');
  near(light.y, 0, 'y untouched');
  near(Transform.rotC[light.index], 1, 'rotation untouched');
});

test('a despawn from inside onDespawned finds the slot claimed and frees nothing', () => {
  // onDespawned despawns itself again, as logic0's orphan pass could while the entity's own despawn runs.
  world();
  let inner = null;
  class Twice extends GameObject {
    onDespawned() {
      inner = GameObject.despawn(this.index);
      this.despawn();
    }
  }
  pool(Twice, 7, 1, 2);
  const once = Twice.spawn({});
  const free = getFreeListCount(Twice.freeListTop);
  once.despawn();
  assert.equal(inner, false, 'the slot is claimed: the second despawn finds it so');
  assert.equal(getFreeListCount(Twice.freeListTop), free + 1, 'pushed back once');
  assert.equal(Transform.active[once.index], 0);
});

test('two despawns at once, on two threads, free the slot once', async () => {
  // As two logic workers despawning the same entity (logic0's orphan pass and the child's own worker).
  bindEntityIdWidth(16);
  const n = 1;
  const transform = new SharedArrayBuffer(Transform.getBufferSize(n));
  const sync = {
    bodyDirtyFlags: new SharedArrayBuffer(4),
    bodyDirtyWords: new SharedArrayBuffer(4),
    bodyGeneration: new SharedArrayBuffer(4),
    bodyGenEpoch: new SharedArrayBuffer(4),
  };
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(new SharedArrayBuffer(2));
  resetFreeList(top, links, n, 1);
  const go = new Int32Array(new SharedArrayBuffer(8));
  const active = new Uint8Array(transform, 0, n);
  const url = new URL('../helpers/parentDespawnRaceWorker.mjs', import.meta.url);
  const data = { n, transform, sync, top: top.buffer, links: links.buffer, go: go.buffer, holdMs: 0.3 };
  const threads = [new Worker(url, { workerData: data }), new Worker(url, { workerData: data })];
  try {
    await Promise.all(threads.map((w) => new Promise((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
    })));
    const rounds = 60;
    let doubled = 0;
    for (let round = 1; round <= rounds; round++) {
      assert.equal(popFreeIndex(top, links, 0), 0, 'the slot is free for this round');
      active[0] = 1;
      Atomics.store(go, 1, 0);
      Atomics.store(go, 0, round);
      Atomics.notify(go, 0);
      let done = Atomics.load(go, 1);
      while (done < 2) {
        Atomics.wait(go, 1, done, 2000);
        done = Atomics.load(go, 1);
      }
      if (getFreeListCount(top) !== 1) {
        doubled++;
        resetFreeList(top, links, n, 1);
      }
      assert.equal(active[0], 0, 'despawned');
    }
    assert.equal(doubled, 0, `rounds whose slot went back twice: ${doubled} of ${rounds}`);
  } finally {
    Atomics.store(go, 0, -1);
    Atomics.notify(go, 0);
    await Promise.all(threads.map((w) => w.terminate()));
  }
});

test('a saved game remaps parent: the child follows its parent at their new indices', () => {
  const { physics, generation } = world();
  const other = Car.spawn({ x: 0, y: 0, width: 40, height: 20 });
  const car = Car.spawn({ x: 100, y: 0, width: 40, height: 20 });
  const light = Light.spawn({ parent: car, localX: 25, localY: 5 });
  assert.notEqual(other.index, car.index);
  const records = [
    { typeName: 'Car', entityIndex: car.index, components: readEntityComponents(Car, car.index) },
    { typeName: 'Light', entityIndex: light.index, components: readEntityComponents(Light, light.index) },
  ];
  assert.equal(records[1].components.Transform.fields.parent, car.index, 'the save holds the parent');
  assert.equal(records[1].components.Transform.fields.localX, 25);

  const saved = { self: globalThis.self.Car, light: globalThis.self.Light, process: logic.processListUpdates };
  globalThis.self.Car = Car;
  globalThis.self.Light = Light;
  logic.processListUpdates = () => {};
  let reply;
  try {
    reply = logic._restoreSave({
      serializableClassNames: ['Car', 'Light'],
      entities: records,
      chains: null,
      fixtures: null,
      meshes: null,
    });
  } finally {
    globalThis.self.Car = saved.self;
    globalThis.self.Light = saved.light;
    logic.processListUpdates = saved.process;
  }
  assert.equal(reply.restored, 2);
  const map = new Map();
  for (let k = 0; k < reply.idPairs.length; k += 2) map.set(reply.idPairs[k], reply.idPairs[k + 1]);
  const newCar = map.get(car.index);
  const newLight = map.get(light.index);
  assert.notEqual(newCar, car.index, 'the car came back at another index');
  assert.equal(Transform.parent[newLight], newCar, 'parent remapped');
  assert.equal(Transform.parentGen[newLight], generation[newCar], 'linked to its parent\'s life now');
  assert.equal(Atomics.load(Transform.links, LINK_COUNT), 1, 'one link, counted once');
  moveBody(newCar, 40, 40, Math.PI / 2);
  physics.writeChildPoses();
  assertFollows(newLight, newCar, 25, 5);
  assert.equal(Transform.links[LINK_ORPHAN_HEAD], 0, 'not an orphan');
});

test("pre-render composes a child from its parent's drawn pose (interpolated), in a pass of its own", () => {
  const { physics } = world();
  const car = Car.spawn({ x: 0, y: 0, width: 40, height: 20 });
  const light = Light.spawn({ parent: car, localX: 10, localY: 0 });
  moveBody(car.index, 100, 0, Math.PI / 2);
  physics.writeChildPoses();

  // The latched pose: the car's previous publish at (0, 0) facing 0, this one at (100, 0) facing pi/2, drawn halfway.
  const pose = (x, y, c, s) => {
    const arrays = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    arrays[0][car.index] = x;
    arrays[1][car.index] = y;
    arrays[2][car.index] = c;
    arrays[3][car.index] = s;
    return arrays;
  };
  const saved = {
    poseX: pre._poseX, poseY: pre._poseY, poseRotC: pre._poseRotC, poseRotS: pre._poseRotS,
    prevX: pre._prevPoseX, prevY: pre._prevPoseY, prevC: pre._prevPoseRotC, prevS: pre._prevPoseRotS,
    rb: pre._rbActive, interp: pre.interpolatePhysicsPose, alpha: pre._poseAlpha, mark: pre._childMark,
  };
  [pre._poseX, pre._poseY, pre._poseRotC, pre._poseRotS] = pose(100, 0, 0, 1);
  [pre._prevPoseX, pre._prevPoseY, pre._prevPoseRotC, pre._prevPoseRotS] = pose(0, 0, 1, 0);
  pre._rbActive = RigidBody.active;
  pre.interpolatePhysicsPose = true;
  pre._poseAlpha = 0.5;
  pre._childMark = new Uint8Array(N); // what init sizes
  pre._childMarkedCount = 0;
  try {
    const parent = new Float64Array(4);
    pre._displayPose(car.index, parent);
    near(parent[0], 50, 'the car is drawn halfway');
    const live = new Float64Array(4);
    pre._displayPose(light.index, live);
    near(live[0], Transform.x[light.index], 'before the pass: its live pose');

    pre._composeChildren();
    const drawn = new Float64Array(4);
    pre._displayPose(light.index, drawn);
    near(drawn[0], parent[0] + parent[2] * 10, 'x from the drawn parent');
    near(drawn[1], parent[1] + parent[3] * 10, 'y from the drawn parent');
    near(drawn[2], parent[2], 'facing the drawn parent');
    near(drawn[3], parent[3], 'facing the drawn parent');

    // Unlinked: its live pose again from the next frame on.
    light.transform.parent = null;
    physics.writeChildPoses();
    pre._composeChildren();
    pre._displayPose(light.index, drawn);
    near(drawn[0], Transform.x[light.index], 'live again');
  } finally {
    pre._poseX = saved.poseX;
    pre._poseY = saved.poseY;
    pre._poseRotC = saved.poseRotC;
    pre._poseRotS = saved.poseRotS;
    pre._prevPoseX = saved.prevX;
    pre._prevPoseY = saved.prevY;
    pre._prevPoseRotC = saved.prevC;
    pre._prevPoseRotS = saved.prevS;
    pre._rbActive = saved.rb;
    pre.interpolatePhysicsPose = saved.interp;
    pre._poseAlpha = saved.alpha;
    pre._childMark = saved.mark;
    pre._childMarkedCount = 0;
  }
});
