import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';
import { PARTICLE_EASE_SHIFT, PARTICLE_TWEEN } from '../../src/util/particleTween.js';
import { integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import { updateParticlePhysicsBuffers } from '../reference/particleIntegrate.mjs';
import { createIntegrateRig } from '../bench/particleIntegrateWasmMicrobench.mjs';

// Each tweened property eases with its own `ease`. The emitter used to keep one ease per particle, the last
// tweened property's, so `alpha: { ease: 'quad.in' }` next to `scale: { ease: 'quad.out' }` eased both 'quad.out'.
// The same scenario on the JS reference and both shipped kernels; population parity is the 'mixed' mix of
// particleIntegrateWasm.test.js and particleIntegrateF32.test.js.

const POOL = 16;

function saveComponent() {
  const previous = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) previous[key] = ParticleComponent[key];
  previous.particleCount = ParticleComponent.particleCount;
  return () => {
    ParticleEmitter.reset();
    for (const [key, value] of Object.entries(previous)) ParticleComponent[key] = value;
  };
}

function jsSide() {
  const restore = saveComponent();
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)), POOL);
  ParticleComponent.particleCount = POOL;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(POOL);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved(1);
  const one = new Uint16Array(1);
  return {
    restore,
    advance(i, ms) {
      one[0] = i;
      updateParticlePhysicsBuffers(ParticleComponent, one, 1, ms, ms / 16.67, false, null);
    },
  };
}

async function wasmSide(variant) {
  const restore = saveComponent();
  ParticleEmitter.reset();
  const rig = await createIntegrateRig(POOL);
  ParticleComponent.particleCount = POOL;
  const binding = { ...rig.binding, integrate: rig.kernels[variant] };
  return {
    restore,
    advance(i, ms) {
      binding.indices[0] = i;
      integrateParticlesWasm(binding, ParticleComponent, 1, ms, ms / 16.67, false);
    },
  };
}

const SIDES = { js: () => jsSide(), wasm: () => wasmSide('wasm'), 'wasm-f32x4': () => wasmSide('wasm-f32x4') };

function emitOne(cfg) {
  assert.equal(ParticleEmitter.emitFlat({ count: 1, x: 0, y: 0, lifespan: 1000, ...cfg }), 1);
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i]) return i;
  throw new Error('no particle spawned');
}

for (const [name, make] of Object.entries(SIDES)) {
  test(`${name}: alpha, scale, tint and rotation each ease with their own ease`, { concurrency: false }, async () => {
    const side = await make();
    try {
      const i = emitOne({
        alpha: { from: 1, to: 0, ease: 'quad.in' },
        scale: { from: 1, to: 3, ease: 'quad.out' },
        tint: { from: 0x000000, to: 0xff0000, ease: 'lerp' },
        rotation: { from: 0, to: 90, ease: 'cubic.in' },
      });
      assert.ok(ParticleComponent.tweenMask[i] & PARTICLE_TWEEN.MIXED_EASE, 'the eases differ');
      side.advance(i, 500); // half the life
      const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-5, `${msg}: ${a} vs ${b}`);
      near(ParticleComponent.alpha[i], 1 - 0.25, 'alpha eased quad.in');
      near(ParticleComponent.scaleX[i], 1 + 2 * 0.75, 'scaleX eased quad.out');
      near(ParticleComponent.scaleY[i], 1 + 2 * 0.75, 'scaleY eased quad.out');
      assert.ok(Math.abs(((ParticleComponent.tint[i] >>> 16) & 0xff) - 128) <= 1, 'tint red channel eased lerp');
      const angle = (Math.PI / 2) * 0.125; // cubic.in at 0.5
      near(ParticleComponent.rotC[i], Math.cos(angle), 'rotation eased cubic.in (cos)');
      near(ParticleComponent.rotS[i], Math.sin(angle), 'rotation eased cubic.in (sin)');
    } finally {
      side.restore();
    }
  });
}

test('properties that share an ease keep the single-ease path', { concurrency: false }, () => {
  const side = jsSide();
  try {
    const i = emitOne({
      alpha: { from: 1, to: 0, ease: 'quad.out' },
      scale: { from: 1, to: 3, ease: 'quad.out' },
      angularVelocity: { from: 0, to: 1, ease: 'quad.out' },
    });
    assert.equal(ParticleComponent.tweenMask[i] & PARTICLE_TWEEN.MIXED_EASE, 0);
    assert.equal(ParticleComponent.easeId[i], PARTICLE_EASE.QUAD_OUT);
    assert.equal(ParticleComponent.easeIds[i], 0);
  } finally {
    side.restore();
  }
});

test('easeIds packs each property at its PARTICLE_EASE_SHIFT', { concurrency: false }, () => {
  const side = jsSide();
  try {
    const i = emitOne({
      alpha: { from: 1, to: 0, ease: 'back.in' },
      scaleX: { from: 1, to: 2, ease: 'expo.out' },
      scaleY: { from: 1, to: 2, ease: 'cubic.inout' },
      angularVelocity: { from: 0, to: 1, ease: 'bounce.out' },
    });
    const ids = ParticleComponent.easeIds[i];
    const at = (shift) => (ids >>> shift) & 15;
    assert.equal(at(PARTICLE_EASE_SHIFT.ALPHA), PARTICLE_EASE.BACK_IN);
    assert.equal(at(PARTICLE_EASE_SHIFT.SCALEX), PARTICLE_EASE.EXPO_OUT);
    assert.equal(at(PARTICLE_EASE_SHIFT.SCALEY), PARTICLE_EASE.CUBIC_INOUT);
    assert.equal(at(PARTICLE_EASE_SHIFT.ANGULAR_VELOCITY), PARTICLE_EASE.BOUNCE_OUT);
  } finally {
    side.restore();
  }
});
