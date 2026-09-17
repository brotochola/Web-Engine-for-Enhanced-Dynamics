import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';

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

test('alpha/scale from→to lerp at mid-life', () => {
  const cleanup = setupPool(4);
  try {
    const n = ParticleEmitter.emitFlat({
      count: 1,
      x: 0,
      y: 0,
      texture: '_whiteCircle',
      lifespan: 1000,
      gravity: 0,
      alpha: { from: 1, to: 0 },
      scale: { from: 2, to: 0 },
    });
    assert.equal(n, 1);

    let i = -1;
    for (let k = 0; k < 4; k++) {
      if (ParticleComponent.active[k]) {
        i = k;
        break;
      }
    }
    assert.ok(i >= 0);
    assert.equal(ParticleComponent.alpha[i], 1);
    assert.equal(ParticleComponent.scaleX[i], 2);
    assert.equal(ParticleComponent.easeId[i], PARTICLE_EASE.LERP);

    updateParticlePhysicsBuffers(
      ParticleComponent,
      new Uint16Array([i]),
      1,
      500,
      1,
      false,
      null,
    );

    assert.ok(Math.abs(ParticleComponent.alpha[i] - 0.5) < 1e-5);
    assert.ok(Math.abs(ParticleComponent.scaleX[i] - 1) < 1e-5);
    assert.ok(Math.abs(ParticleComponent.scaleY[i] - 1) < 1e-5);
  } finally {
    cleanup();
  }
});
