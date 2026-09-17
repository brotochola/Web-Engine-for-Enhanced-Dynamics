import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';

function setupPool(max) {
  const previous = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) {
    previous[key] = ParticleComponent[key];
  }
  previous.particleCount = ParticleComponent.particleCount;

  const buffer = new SharedArrayBuffer(ParticleComponent.getBufferSize(max));
  ParticleComponent.initializeArrays(buffer, max);
  ParticleComponent.particleCount = max;

  ParticleEmitter.reset();
  ParticleEmitter.initialize(max);
  ParticleEmitter.initializeFreeList(
    new SharedArrayBuffer(max * Uint16Array.BYTES_PER_ELEMENT),
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

function integrate(indices, dtRatio = 1) {
  return updateParticlePhysicsBuffers(
    ParticleComponent,
    indices,
    indices.length,
    16.67,
    dtRatio,
    false,
    null,
  );
}

function spawnFlat(i, { gravity, vy = 0 } = {}) {
  ParticleComponent.active[i] = 1;
  ParticleComponent.x[i] = 0;
  ParticleComponent.y[i] = 0;
  ParticleComponent.z[i] = 0;
  ParticleComponent.vx[i] = 0;
  ParticleComponent.vy[i] = vy;
  ParticleComponent.vz[i] = 0;
  ParticleComponent.gravity[i] = gravity;
  ParticleComponent.lifespan[i] = 1000;
  ParticleComponent.currentLife[i] = 0;
  ParticleComponent.alpha[i] = 1;
  ParticleComponent.fadeOnTheFloor[i] = 0;
  ParticleComponent.timeOnFloor[i] = 0;
  ParticleComponent.initialAlpha[i] = 0;
  ParticleComponent.stayOnTheFloor[i] = 0;
  ParticleComponent.despawnOnGroundContact[i] = 0;  ParticleComponent.flat[i] = 1;
}

test('emitFlat gravity accelerates vy; zero gravity stays put', { concurrency: false }, () => {
  const restore = setupPool(2);
  try {
    const falling = ParticleEmitter.acquireIndex();
    const hovering = ParticleEmitter.acquireIndex();
    spawnFlat(falling, { gravity: 0.5 });
    spawnFlat(hovering, { gravity: 0 });

    integrate(new Uint16Array([falling, hovering]));

    assert.equal(ParticleComponent.vy[falling], 0.5);
    assert.equal(ParticleComponent.y[falling], 0.5);
    assert.equal(ParticleComponent.x[falling], 0);
    assert.equal(ParticleComponent.z[falling], 0);
    assert.equal(ParticleComponent.vz[falling], 0);
    assert.equal(ParticleComponent.active[falling], 1);

    assert.equal(ParticleComponent.vy[hovering], 0);
    assert.equal(ParticleComponent.y[hovering], 0);
    assert.equal(ParticleComponent.active[hovering], 1);
  } finally {
    restore();
  }
});

test('emitFlat scale range writes the same value to scaleX and scaleY', { concurrency: false }, () => {
  const restore = setupPool(4);
  try {
    const n = ParticleEmitter.emitFlat({
      count: 3,
      x: 0,
      y: 0,
      scale: { min: 0.5, max: 1 },
      lifespan: 1000,
    });
    assert.equal(n, 3);
    let seen = 0;
    for (let i = 0; i < 4; i++) {
      if (!ParticleComponent.active[i]) continue;
      seen++;
      assert.equal(ParticleComponent.scaleX[i], ParticleComponent.scaleY[i]);
      assert.ok(ParticleComponent.scaleX[i] >= 0.5);
      assert.ok(ParticleComponent.scaleX[i] <= 1);
    }
    assert.equal(seen, 3);
  } finally {
    restore();
  }
});

test('emitFlat scaleX-only still locks aspect', { concurrency: false }, () => {
  const restore = setupPool(2);
  try {
    const n = ParticleEmitter.emitFlat({
      count: 1,
      x: 0,
      y: 0,
      scaleX: { min: 0.2, max: 0.4 },
      lifespan: 1000,
    });
    assert.equal(n, 1);
    let i = -1;
    for (let k = 0; k < 2; k++) {
      if (ParticleComponent.active[k]) {
        i = k;
        break;
      }
    }
    assert.ok(i >= 0);
    assert.equal(ParticleComponent.scaleX[i], ParticleComponent.scaleY[i]);
    assert.ok(ParticleComponent.scaleX[i] >= 0.2);
    assert.ok(ParticleComponent.scaleX[i] <= 0.4);
  } finally {
    restore();
  }
});
