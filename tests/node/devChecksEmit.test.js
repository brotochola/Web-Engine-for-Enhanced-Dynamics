// DX-GUARDS E5, E6 (debug build): particle emits that do not do what they say. E5: a heighted particle born at z >= 0
// is on the floor, and the integrate lands it on its first step (its velocity zeroed), shown here on the shipped
// float32 kernel. E6: animation or frame without what they need are ignored.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { checkEmit, setDevChecks } from '../../src/core/debug/devChecks.js';
import { integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { seededRandom } from '../../src/util/utils.js';
import { createIntegrateRig } from '../bench/particleIntegrateWasmMicrobench.mjs';

const POOL = 16;
globalThis.rng = seededRandom(7, 'devChecksEmit');

function warningsOf(fn) {
  const saved = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    resetWarnOnce();
    setDevChecks(true);
    return { lines, value: fn() };
  } finally {
    console.warn = saved;
  }
}

/** The shipped float32 kernel on the particle memory, as the particle worker binds it. */
async function kernel() {
  const saved = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) saved[key] = ParticleComponent[key];
  saved.particleCount = ParticleComponent.particleCount;
  ParticleEmitter.reset();
  const rig = await createIntegrateRig(POOL);
  ParticleComponent.particleCount = POOL;
  const binding = { ...rig.binding, integrate: rig.kernels['wasm-f32x4'] };
  return {
    step(i) {
      binding.indices[0] = i;
      integrateParticlesWasm(binding, ParticleComponent, 1, 16, 1, false);
    },
    restore() {
      ParticleEmitter.reset();
      for (const [key, value] of Object.entries(saved)) ParticleComponent[key] = value;
    },
  };
}

function emitOne(call, cfg) {
  const before = new Set();
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i]) before.add(i);
  assert.equal(call({ count: 1, x: 100, y: 100, lifespan: 60000, ...cfg }), 1);
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i] && !before.has(i)) return i;
  throw new Error('no particle spawned');
}

test('E5: an emit with z unset and a velocity is named; its particle stops on its first step', { concurrency: false }, async () => {
  const k = await kernel();
  try {
    const { lines, value: i } = warningsOf(() => emitOne((c) => ParticleEmitter.emit(c), { angleXY: 30, speed: 3, gravity: 0.2 }));
    assert.deepEqual(lines, [
      'WeedJS: ParticleEmitter: an emit has z unset (0): a heighted particle at z >= 0 is on the floor, so it ' +
        'stops on its first step. Give z a value below 0 (in the air), or use emitFlat for particles in the screen plane.',
    ]);
    const x0 = ParticleComponent.x[i];
    k.step(i);
    k.step(i);
    assert.equal(ParticleComponent.vx[i], 0, 'landed: no velocity');
    assert.equal(ParticleComponent.x[i], x0, 'and it never moved');
  } finally {
    k.restore();
  }
});

test('E5: z below 0, a still particle on the floor, or emitFlat are silent', { concurrency: false }, async () => {
  const k = await kernel();
  try {
    const { lines, value: i } = warningsOf(() => {
      const air = emitOne((c) => ParticleEmitter.emit(c), { z: { min: -30, max: -10 }, angleXY: 30, speed: 3 });
      emitOne((c) => ParticleEmitter.emit(c), { z: 0, fadeOnTheFloor: 400 }); // a decal-like stamp: meant
      emitOne((c) => ParticleEmitter.emitFlat(c), { angleXY: 30, speed: 3 });
      emitOne((c) => ParticleEmitter.emit(c), { speed: 3 }); // speed with no direction: no velocity, nothing to stop
      emitOne((c) => ParticleEmitter.emitZenithal(c), { z: -5, vx: 1 });
      return air;
    });
    assert.deepEqual(lines, []);
    const x0 = ParticleComponent.x[i];
    k.step(i);
    assert.notEqual(ParticleComponent.x[i], x0, 'in the air it moves');
  } finally {
    k.restore();
  }
});

test('E5: off, nothing is said', () => {
  const { lines } = warningsOf(() => {
    setDevChecks(false);
    checkEmit({ vx: 3 }, false);
  });
  assert.deepEqual(lines, []);
});
