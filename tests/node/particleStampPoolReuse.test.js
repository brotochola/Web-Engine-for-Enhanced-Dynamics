import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';

const MAX = 1;

function setupPool() {
  const previous = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) {
    previous[key] = ParticleComponent[key];
  }
  previous.particleCount = ParticleComponent.particleCount;

  const buffer = new SharedArrayBuffer(ParticleComponent.getBufferSize(MAX));
  ParticleComponent.initializeArrays(buffer, MAX);
  ParticleComponent.particleCount = MAX;

  ParticleEmitter.reset();
  ParticleEmitter.initialize(MAX);
  ParticleEmitter.initializeFreeList(
    new SharedArrayBuffer(MAX * Uint16Array.BYTES_PER_ELEMENT),
    new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT)
  );
  ParticleEmitter.resetFreeListInterleaved(1);

  return () => {
    ParticleEmitter.reset();
    for (const [key, value] of Object.entries(previous)) {
      ParticleComponent[key] = value;
    }
  };
}

function spawnFloorStamp() {
  const i = ParticleEmitter.acquireIndex();
  ParticleComponent.active[i] = 1;
  ParticleComponent.x[i] = 0;
  ParticleComponent.y[i] = 0;
  ParticleComponent.z[i] = 0;
  ParticleComponent.vx[i] = 0;
  ParticleComponent.vy[i] = 0;
  ParticleComponent.vz[i] = 0;
  ParticleComponent.gravity[i] = 0;
  ParticleComponent.lifespan[i] = 1000;
  ParticleComponent.currentLife[i] = 0;
  ParticleComponent.alpha[i] = 1;
  ParticleComponent.fadeOnTheFloor[i] = 0;
  ParticleComponent.timeOnFloor[i] = 0;
  ParticleComponent.initialAlpha[i] = 0;
  ParticleComponent.stayOnTheFloor[i] = 1;
  ParticleComponent.despawnOnGroundContact[i] = 0;  ParticleComponent.flat[i] = 0;
  ParticleComponent.textureId[i] = 7;
  return i;
}

test('stayOnTheFloor stamp holds the pool slot until the caller recycles', { concurrency: false }, () => {
  const restore = setupPool();
  try {
    const i = spawnFloorStamp();
    assert.equal(i, 0);
    assert.equal(ParticleEmitter.acquireIndex(), -1);

    const activeIndices = new Uint16Array([i]);
    const particlesToStamp = new Uint16Array(MAX);
    const { stampedCount } = updateParticlePhysicsBuffers(
      ParticleComponent,
      activeIndices,
      1,
      16.67,
      1,
      true,
      particlesToStamp,
    );

    assert.equal(stampedCount, 1);
    assert.equal(particlesToStamp[0], i);
    assert.equal(ParticleComponent.active[i], 0);
    assert.equal(ParticleComponent.textureId[i], 7);
    assert.equal(ParticleEmitter.acquireIndex(), -1, 'stamped slot must stay reserved so logic cannot reuse it');

    ParticleEmitter.returnToPool(i);
    assert.equal(ParticleEmitter.acquireIndex(), i);
  } finally {
    restore();
  }
});

test('stayOnTheFloor without a stamp list still returns the slot', { concurrency: false }, () => {
  const restore = setupPool();
  try {
    const i = spawnFloorStamp();
    const activeIndices = new Uint16Array([i]);
    const { stampedCount } = updateParticlePhysicsBuffers(
      ParticleComponent,
      activeIndices,
      1,
      16.67,
      1,
      false,
      null,
    );

    assert.equal(stampedCount, 0);
    assert.equal(ParticleComponent.active[i], 0);
    assert.equal(ParticleEmitter.acquireIndex(), i);
  } finally {
    restore();
  }
});
