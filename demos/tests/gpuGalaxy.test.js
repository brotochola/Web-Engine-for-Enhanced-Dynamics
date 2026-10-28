import test from 'node:test';
import assert from 'node:assert/strict';

import '../../tests/helpers/registerWebRoot.mjs';

// The GPU Galaxy demo's Arm: metered on the sim clock, it keeps its ring nearly full and never writes over a dot
// still alive, at the longest step a call covers, and with long frames, a clock that did not move and a stalled
// worker among the ticks. The draw is checked in Chromium.

const { GpuParticles } = await import('../../src/core/gpuParticles.js');
const { Layer } = await import('../../src/core/layer.js');
const { CLOCK_BYTES, Time } = await import('../../src/core/timeScale.js');
const { seededRandom } = await import('../../src/util/utils.js');
const { Arm, GpuGalaxyScene } = await import('../../demos/gpuGalaxyScene/gpuGalaxyScene.js');

const LIFE_MS = 5000;

test('an arm keeps its ring nearly full and never writes over a live dot, through long frames and stalls', () => {
  const layers = { galaxy: { ...GpuGalaxyScene.config.layers.galaxy, maxParticles: 8192 } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 1; // the logic worker's ring
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(3, 'galaxy');
  try {
    const arm = Object.create(Arm.prototype);
    arm.onSpawned({ arm: 0, arms: 1 });
    const ring = () => GpuParticles.stats('galaxy')[1];
    const published = []; // [sim ms, published] after each tick
    let now = 0;
    const run = (until, stepOf) => {
      for (let step = 0; now < until; step++) {
        const elapsed = stepOf(step);
        Time._advanceSimNow(elapsed);
        now += elapsed;
        arm.tick();
        published.push([now, ring().published]);
      }
    };
    const alive = () => ring().published - published.findLast(([t]) => t <= now - LIFE_MS)[1];
    arm.tick();

    // 20 fps: every call covers the longest step it may, the case the ring's margin is for.
    run(12000, () => 50);
    assert.ok(alive() >= 0.95 * ring().capacity, `${alive()} of ${ring().capacity} alive`);
    // Mostly 60 Hz; now and then the clock's longest step, a tick on a clock that did not move, or a worker that
    // misses 2 s of frames and then sees them all at once (it does not catch up, so the ring empties a little).
    run(30000, (step) => (step % 400 === 399 ? 2000 : step % 50 === 49 ? 100 : step % 7 === 6 ? 0 : 1000 / 60));

    assert.equal(ring().overflows, 0, 'no call wrote over a dot still alive');
  } finally {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  }
});
