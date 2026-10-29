// E-172: emitGpu checks the CPU emit keys GPU particles ignore with one named read each, and warns once per key. The
// named checks and UNSUPPORTED_KEYS are two lists of the same keys: every listed key must warn, once.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuParticles, UNSUPPORTED_KEYS } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';
import { seededRandom } from '../../src/util/utils.js';

test('each key GPU particles ignore warns once, and a config without them warns of nothing', { concurrency: false }, () => {
  const layers = { smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 4096 } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(11, 'unsupported');
  Time._advanceSimNow(1000);
  const warned = [];
  const warn = console.warn;
  console.warn = (message) => warned.push(String(message));
  try {
    const base = { layer: 'smoke', count: 1, x: 10, y: 20, lifespan: 300 };
    assert.equal(ParticleEmitter.emitGpu(base), 1);
    assert.deepEqual(warned, [], 'a config without them');
    for (const key of UNSUPPORTED_KEYS) {
      assert.equal(ParticleEmitter.emitGpu({ ...base, [key]: 1 }), 1, `${key} is ignored, the particle written`);
      ParticleEmitter.emitGpu({ ...base, [key]: 1 });
    }
    assert.equal(warned.length, UNSUPPORTED_KEYS.length, 'one warning a key');
    for (const key of UNSUPPORTED_KEYS) assert.ok(warned.some((m) => m.includes(`"${key}"`)), `${key} warned`);
  } finally {
    console.warn = warn;
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  }
});
