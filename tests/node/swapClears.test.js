import test from 'node:test';
import assert from 'node:assert/strict';

import { Joint } from '../../src/core/joint.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Decal } from '../../src/core/decal.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { Camera } from '../../src/core/camera.js';
import { Sun } from '../../src/core/sun.js';
import { applySunBoot, restoreBootCamera } from '../../src/util/sceneSharedBuffers.js';
import {
  bindPoolExhaustion,
  droppedSpawns,
  poolExhaustionBytes,
  reportPoolExhausted,
  resetPoolExhaustion,
  unbindPoolExhaustion,
} from '../../src/util/poolExhaustion.js';

// VISUAL_EDITOR_PLAN.md ED-35: the in-place clears a fast swap uses, where a full load drops the buffers instead.

/** A Uint16 free list of n slots, as the scene makes them. */
function freeListBuffers(n) {
  const freeList = new SharedArrayBuffer(n * 2);
  const freeListTop = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTop), new Uint16Array(freeList), n, 1);
  return { freeList, freeListTop };
}

function bootJoints(maxJoints = 8, entities = 8) {
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(maxJoints, entities)), maxJoints, entities);
  const { freeList, freeListTop } = freeListBuffers(maxJoints);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeList, freeListTop);
}

/** What physics does when a joint breaks (weedjsPost.js removeWeedJoint): off the active list, links and slot kept. */
function breakJoint(idx) {
  const count = Atomics.load(Joint.activeCount, 0);
  const slot = Joint.activeIndexPositions[idx];
  const last = count - 1;
  Joint.active[idx] = 0;
  if (slot !== last) {
    const lastIdx = Joint.activeIndices[last];
    Joint.activeIndices[slot] = lastIdx;
    Joint.activeIndexPositions[lastIdx] = slot;
  }
  Joint.activeIndices[last] = Joint.INVALID_INDEX;
  Joint.activeIndexPositions[idx] = Joint.INVALID_INDEX;
  Atomics.store(Joint.activeCount, 0, last);
}

test('Joint.resetAll gives back every slot and link, a broken joint\'s included', () => {
  bootJoints();
  const a = Joint.addRevolute({ entityA: 1, entityB: 2 });
  const b = Joint.addRevolute({ entityA: 2, entityB: 3 });
  Joint.addWeld({ entityA: 4, entityB: 5 });
  breakJoint(b);
  assert.equal(Joint.getFreeCount(), 5);
  assert.equal(Joint.getJointCount(3), 1, 'the broken joint is still linked to entity 3');
  Joint.resetAll();
  assert.equal(Joint.getDenseActiveCount(), 0);
  assert.equal(Joint.getFreeCount(), 8);
  for (let e = 0; e < 8; e++) assert.equal(Joint.getJointCount(e), 0, `entity ${e} keeps no link`);
  assert.equal(Joint.active[a], 0);
  const again = Joint.addRevolute({ entityA: 6, entityB: 7 });
  assert.ok(again >= 0);
  assert.equal(Joint.getJointCount(6), 1);
});

test('ChainPoints.clearAll frees every chain and rewinds the pool', () => {
  const maxPoints = 32;
  const entities = 4;
  // setForEntity also writes the entity's collider shape and mass.
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entities)), entities);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entities)), entities);
  ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(maxPoints, entities)), maxPoints, entities);
  const square = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100]);
  assert.equal(ChainPoints.setForEntity(0, square, 4, true), true);
  assert.equal(ChainPoints.setForEntity(1, square, 4, true), true);
  ChainPoints.clearForEntity(0);
  assert.equal(ChainPoints.bump[0], 8, 'freeing a chain does not rewind the pool');
  ChainPoints.clearAll();
  assert.equal(ChainPoints.bump[0], 0);
  assert.equal(ChainPoints.freeTop[0], 0);
  for (let e = 0; e < entities; e++) assert.equal(ChainPoints.begin[e], -1);
  assert.equal(ChainPoints.setForEntity(2, square, 4, true), true);
  assert.equal(ChainPoints.begin[2], 0, 'the next chain starts at the pool\'s start');
});

test('ParticleEmitter.despawnAll and BulletPool.despawnAll return every live slot to its pool', () => {
  const n = 16;
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(n)), n);
  ParticleEmitter.initialize(n);
  const particles = freeListBuffers(n);
  ParticleEmitter.initializeFreeList(particles.freeList, particles.freeListTop);
  for (let k = 0; k < 5; k++) ParticleComponent.active[ParticleEmitter.acquireIndex()] = 1;
  assert.equal(ParticleEmitter.getFreeCount(), n - 5);
  assert.equal(ParticleEmitter.despawnAll(), 5);
  assert.equal(ParticleEmitter.getFreeCount(), n);
  assert.equal(ParticleComponent.active.indexOf(1), -1);

  BulletComponent.initializeArrays(new SharedArrayBuffer(BulletComponent.getBufferSize(n)), n);
  BulletPool.initialize(n);
  const bullets = freeListBuffers(n);
  BulletPool.initializeFreeList(bullets.freeList, bullets.freeListTop);
  for (let k = 0; k < 3; k++) BulletComponent.active[BulletPool.acquireIndex()] = 1;
  assert.equal(BulletPool.despawnAll(), 3);
  assert.equal(BulletPool.getFreeCount(), n);
});

test('Decal.clearAll wipes the tiles that hold something, marks only those dirty, and drops queued stamps', () => {
  const tilePixelSize = 4;
  const totalTiles = 3;
  const bytesPerTile = tilePixelSize * tilePixelSize * 4;
  const scene = {
    config: { particle: { decalsTilePixelSize: tilePixelSize } },
    decalsTotalTiles: totalTiles,
    buffers: {
      decalsTilesRGBA: new SharedArrayBuffer(totalTiles * bytesPerTile),
      decalsTilesDirty: new SharedArrayBuffer(totalTiles),
    },
  };
  const rgba = new Uint8Array(scene.buffers.decalsTilesRGBA);
  rgba[bytesPerTile + 7] = 200; // tile 1: one pixel's alpha
  rgba[bytesPerTile + 4] = 90;
  Decal.bindStampRing(Decal.createStampRingSab(64));
  Decal.enqueueStamp(10, 10, 1, 1, 1, 0xffffff, 1, 0);
  assert.equal(Decal.clearAll(scene), 1);
  assert.equal(rgba.some((v) => v !== 0), false);
  assert.deepEqual([...new Uint8Array(scene.buffers.decalsTilesDirty)], [0, 1, 0]);
  let stamped = 0;
  Decal.drainStampRing(() => stamped++);
  assert.equal(stamped, 0, 'the queued stamp was dropped');
  Decal.bindStampRing(null);
});

test('resetPoolExhaustion: every pool warns again and counts from 0, as in a new scene', () => {
  bindPoolExhaustion(new SharedArrayBuffer(poolExhaustionBytes(2)));
  const Enemy = { name: 'Enemy', entityType: 1, poolSize: 4 };
  const warned = [];
  const original = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    reportPoolExhausted(Enemy);
    reportPoolExhausted(Enemy);
    assert.equal(droppedSpawns(Enemy), 2);
    resetPoolExhaustion();
    assert.equal(droppedSpawns(Enemy), 0);
    reportPoolExhausted(Enemy);
  } finally {
    console.warn = original;
    unbindPoolExhaustion();
  }
  assert.equal(warned.length, 2, 'once before the reset, once after');
});

test('restoreBootCamera puts the camera back as the load left it', () => {
  const view = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  view[0] = 1;
  view[3] = Number.NaN;
  view[4] = Number.NaN;
  view[5] = 1;
  Camera.initialize(view, 800, 600);
  view[1] = 100;
  view[2] = 50;
  const scene = { views: { camera: view }, _bootCamera: Float32Array.from(view), config: { worldWidth: 4000, worldHeight: 3000 } };
  Camera.x = 700;
  Camera.zoom = 2.5;
  assert.equal(Camera.x, 700);
  restoreBootCamera(scene);
  assert.equal(Camera.x, 100);
  assert.equal(Camera.y, 50);
  assert.equal(Camera.zoom, 1);
  // Every value but the seqlock word, which the bounds write advanced (an even count: unlocked).
  const unlocked = (values) => [...values].filter((_, i) => i !== Camera.IDX_FOLLOW_SEQ);
  assert.deepEqual(unlocked(view), unlocked(scene._bootCamera));
});

test('applySunBoot puts the sun back at its configured settings and start hour', () => {
  Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  const config = { lighting: { sun: { enabled: true, angle: 1.2, intensity: 0.8, startHour: 7, dayCycle: { enabled: true } } } };
  applySunBoot(config);
  const boot = { hour: Sun.hour, angle: Sun.angle, intensity: Sun.intensity };
  Sun.setTimeOfDay(21);
  Sun.angle = 3;
  Sun.intensity = 0.1;
  applySunBoot(config);
  assert.deepEqual({ hour: Sun.hour, angle: Sun.angle, intensity: Sun.intensity }, boot);
  assert.equal(Sun.hour, 7);
});
