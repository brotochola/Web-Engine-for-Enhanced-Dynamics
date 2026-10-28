import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import { updateParticlePhysicsBuffers } from '../reference/particleIntegrate.mjs';
import { createIntegrateRig } from '../bench/particleIntegrateWasmMicrobench.mjs';

// Floor bounces (ParticleEmitter.emit `bounces`, `bounciness`, `bounceFriction`): the same scenarios on the JS
// reference integrate and on both shipped kernels (integrate_batch and integrate_batch_f32x4). The kernels' bit
// parity with the reference over a whole population is particleIntegrateWasm.test.js's 'bounce' mix.

const POOL = 64;

function saveComponent() {
  const previous = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) previous[key] = ParticleComponent[key];
  previous.particleCount = ParticleComponent.particleCount;
  return () => {
    ParticleEmitter.reset();
    for (const [key, value] of Object.entries(previous)) ParticleComponent[key] = value;
  };
}

/** The reference integrate on a plain SharedArrayBuffer pool. */
function jsSide() {
  const restore = saveComponent();
  const buffer = new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL));
  ParticleComponent.initializeArrays(buffer, POOL);
  ParticleComponent.particleCount = POOL;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(POOL);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved(1);
  const one = new Uint16Array(1);
  return {
    restore,
    step(i, decals = false, stamps = null) {
      one[0] = i;
      return updateParticlePhysicsBuffers(ParticleComponent, one, 1, 16, 1, decals, stamps);
    },
  };
}

/** A shipped kernel on the particle memory, as the particle worker binds it. */
async function wasmSide(variant) {
  const restore = saveComponent();
  ParticleEmitter.reset();
  const rig = await createIntegrateRig(POOL);
  ParticleComponent.particleCount = POOL;
  const binding = { ...rig.binding, integrate: rig.kernels[variant] };
  return {
    restore,
    step(i, decals = false) {
      binding.indices[0] = i;
      return integrateParticlesWasm(binding, ParticleComponent, 1, 16, 1, decals);
    },
  };
}

const SIDES = {
  js: () => jsSide(),
  wasm: () => wasmSide('wasm'),
  'wasm-f32x4': () => wasmSide('wasm-f32x4'),
};

/** Spawns one heighted particle through the public API and returns its index. */
function emitOne(cfg) {
  const before = new Set();
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i]) before.add(i);
  assert.equal(ParticleEmitter.emit({ count: 1, x: 0, y: 0, lifespan: 60000, ...cfg }), 1);
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i] && !before.has(i)) return i;
  throw new Error('no particle spawned');
}

/** Steps until the particle touches the floor (z >= 0). */
function fallToFloor(side, i, limit = 500) {
  for (let n = 1; n <= limit; n++) {
    side.step(i);
    if (ParticleComponent.z[i] >= 0) return n;
  }
  throw new Error('never reached the floor');
}

for (const [name, make] of Object.entries(SIDES)) {
  test(`${name}: a particle with bounces left rebounds instead of landing`, { concurrency: false }, async () => {
    const side = await make();
    try {
      const i = emitOne({ z: -40, vz: 0, vx: 2, gravity: 0.5, bounces: 1, bounciness: 0.5, bounceFriction: 0.5 });
      fallToFloor(side, i);
      const impact = ParticleComponent.vz[i] + ParticleComponent.gravity[i]; // the landing step adds gravity first
      side.step(i);
      assert.equal(ParticleComponent.active[i], 1);
      assert.equal(ParticleComponent.bounces[i], 0);
      assert.ok(ParticleComponent.z[i] < 0, 'left the floor on the bounce step');
      assert.ok(Math.abs(ParticleComponent.vz[i] + impact * 0.5) < 1e-5, 'kept half of the falling speed, upward');
      assert.ok(Math.abs(ParticleComponent.vx[i] - 1) < 1e-6, 'kept half of the ground speed');
    } finally {
      side.restore();
    }
  });

  test(`${name}: the floor behaviour runs on the landing with no bounces left`, { concurrency: false }, async () => {
    const side = await make();
    try {
      const i = emitOne({ z: -40, vz: 0, gravity: 0.5, bounces: 1, bounciness: 0.5, despawnOnGroundContact: true });
      fallToFloor(side, i);
      side.step(i); // bounce
      assert.equal(ParticleComponent.active[i], 1);
      fallToFloor(side, i);
      side.step(i); // second landing: despawns
      assert.equal(ParticleComponent.active[i], 0);
    } finally {
      side.restore();
    }
  });

  test(`${name}: a rebound weaker than two frames of gravity is a landing`, { concurrency: false }, async () => {
    const side = await make();
    try {
      const i = emitOne({ z: -1, vz: 0, gravity: 0.5, bounces: 3, bounciness: 0.1, stayOnTheFloor: true });
      fallToFloor(side, i);
      const { stampedCount } = side.step(i, true, new Uint16Array(4));
      assert.equal(stampedCount, 1, 'stamped like a landing without bounces');
      assert.equal(ParticleComponent.bounces[i], 0);
    } finally {
      side.restore();
    }
  });

  test(`${name}: a particle without bounces lands as before; a recycled slot keeps no count`, { concurrency: false }, async () => {
    const side = await make();
    try {
      const first = emitOne({ z: -10, vz: 0, gravity: 0.5, bounces: 5 });
      ParticleComponent.active[first] = 0;
      ParticleEmitter.returnToPool(first);
      const second = emitOne({ z: -10, vz: 0, gravity: 0.5 });
      assert.equal(second, first, 'the pool reused the slot');
      assert.equal(ParticleComponent.bounces[second], 0);
      fallToFloor(side, second);
      side.step(second);
      assert.equal(ParticleComponent.z[second], 0);
      assert.equal(ParticleComponent.vz[second], 0);
    } finally {
      side.restore();
    }
  });
}

test('emitFlat ignores bounces: flat particles have no floor', { concurrency: false }, () => {
  const side = jsSide();
  try {
    assert.equal(ParticleEmitter.emitFlat({ count: 1, x: 0, y: 0, lifespan: 500, bounces: 3 }), 1);
    let i = -1;
    for (let k = 0; k < POOL; k++) if (ParticleComponent.active[k]) i = k;
    assert.equal(ParticleComponent.bounces[i], 0);
  } finally {
    side.restore();
  }
});

test('bounce counts sample a { min, max } range once per particle, rounded and clamped', { concurrency: false }, () => {
  const side = jsSide();
  try {
    const seen = new Set();
    for (let n = 0; n < 48; n++) {
      const i = emitOne({ z: -10, bounces: { min: 1, max: 3 }, bounciness: { min: 0.2, max: 0.4 } });
      seen.add(ParticleComponent.bounces[i]);
      assert.ok(ParticleComponent.bounciness[i] >= 0.2 - 1e-6 && ParticleComponent.bounciness[i] <= 0.4 + 1e-6);
      ParticleComponent.active[i] = 0;
      ParticleEmitter.returnToPool(i);
    }
    for (const n of seen) assert.ok(n >= 1 && n <= 3);
    assert.ok(seen.size >= 2, 'the count varies across particles');
    const many = emitOne({ z: -10, bounces: 1000 });
    assert.equal(ParticleComponent.bounces[many], 255);
    const none = emitOne({ z: -10, bounces: -4 });
    assert.equal(ParticleComponent.bounces[none], 0);
    const defaults = emitOne({ z: -10, bounces: 2 });
    assert.ok(Math.abs(ParticleComponent.bounciness[defaults] - 0.5) < 1e-7, 'bounciness defaults to 0.5');
    assert.ok(Math.abs(ParticleComponent.bounceFriction[defaults] - 0.7) < 1e-7, 'bounceFriction defaults to 0.7');
  } finally {
    side.restore();
  }
});
