import test from 'node:test';
import assert from 'node:assert/strict';

import '../../tests/helpers/registerWebRoot.mjs';

// The Blastforge demo's explode(): every preset's GPU emits (fire, smoke, dust, embers) are accepted by
// GpuParticles with finite values, sort at the blast's ground y, and stay a few dozen calls per blast. The CPU
// pieces, decals and shake are counted, not run. The draw is checked in Chromium.

const { GpuParticles } = await import('../../src/core/gpuParticles.js');
const { Layer } = await import('../../src/core/layer.js');
const { ParticleEmitter } = await import('../../src/core/particleEmitter.js');
const { Decal } = await import('../../src/core/decal.js');
const { Camera } = await import('../../src/core/camera.js');
const { CLOCK_BYTES, Time } = await import('../../src/core/timeScale.js');
const { seededRandom } = await import('../../src/util/utils.js');
const { GPU_GROUP, GPU_GROUP_WORDS, GPU_RING } = await import('../../src/util/gpuParticleLayout.js');
const { FIELD_LAYER, EMBERS_LAYER, explode, explosionLayers, updateExplosions } = await import('../../demos/blastforgeScene/explosions.js');
const { PRESETS } = await import('../../demos/blastforgeScene/explosionPresets.js');

const BUILT_INS = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };

function setup() {
  const layers = explosionLayers({ pixelZoom: 3, palette: PRESETS.grenade.palette });
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_INS);
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 1; // the logic worker's ring, as the Detonator emits
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(9, 'blastforge');
  const calls = [];
  const cpu = { emit: 0, stamp: 0, shake: 0 };
  const saved = { emitGpu: ParticleEmitter.emitGpu, emit: ParticleEmitter.emit, stamp: Decal.stamp, shake: Camera.shake };
  ParticleEmitter.emitGpu = (cfg) => {
    calls.push(structuredClone(cfg));
    return saved.emitGpu.call(ParticleEmitter, cfg);
  };
  ParticleEmitter.emit = () => cpu.emit++;
  Decal.stamp = () => cpu.stamp++;
  Camera.shake = () => cpu.shake++;
  return {
    calls,
    cpu,
    restore() {
      Object.assign(ParticleEmitter, { emitGpu: saved.emitGpu, emit: saved.emit });
      Decal.stamp = saved.stamp;
      Camera.shake = saved.shake;
      GpuParticles.reset();
      Layer.reset();
      Time.unbind();
    },
  };
}

/** Every number in a config (ranges included) is finite. */
function finite(cfg, where = '') {
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${where}.${key} = ${value}`);
    else if (value && typeof value === 'object') finite(value, `${where}.${key}`);
  }
}

const groupsOf = (layer) => Atomics.load(GpuParticles.layerOf(layer).rings[1].header, GPU_RING.GROUPS);

for (const [key, preset] of Object.entries(PRESETS)) {
  test(`${preset.name}: GPU emits are finite, accepted and sorted at the blast`, { concurrency: false }, () => {
    const { calls, cpu, restore } = setup();
    try {
      explode(1000, 700, preset);
      assert.ok(calls.length > 0, 'something went off');
      assert.ok(calls.length < 160, `${calls.length} GPU emits for one blast`);
      for (const cfg of calls) {
        finite(cfg, key);
        assert.ok([FIELD_LAYER, EMBERS_LAYER].includes(cfg.layer));
        if (cfg.layer === FIELD_LAYER) assert.equal(cfg.sortY, 700, 'the field sorts at the blast\'s ground y');
        const delay = cfg.delay?.min ?? cfg.delay ?? 0;
        assert.ok(delay >= 0);
      }
      const field = GpuParticles.layerOf(FIELD_LAYER).rings[1];
      const written = Atomics.load(field.header, GPU_RING.PUBLISHED);
      if (preset.fire + preset.smoke + preset.dust > 0) assert.ok(written > 0, 'field puffs written');
      assert.equal(groupsOf(FIELD_LAYER) + groupsOf(EMBERS_LAYER), calls.length, 'one group per emit');
      for (let g = 0; g < groupsOf(FIELD_LAYER); g++) {
        const b = g * GPU_GROUP_WORDS;
        for (const word of [GPU_GROUP.BIRTH_F, GPU_GROUP.END_F, GPU_GROUP.MIN_X_F, GPU_GROUP.MAX_X_F, GPU_GROUP.MIN_Y_F, GPU_GROUP.MAX_Y_F]) {
          assert.ok(Number.isFinite(field.groups[b + word]), `group ${g} word ${word}`);
        }
      }
      if (preset.sparks + preset.debris > 0) assert.ok(cpu.emit > 0, 'sparks and debris on the CPU');
      if (preset.scorch > 0) assert.ok(cpu.stamp > 0, 'a scorch mark');
    } finally {
      restore();
    }
  });
}

test('follow-up blasts go off in game time, through updateExplosions', { concurrency: false }, () => {
  const { calls, restore } = setup();
  try {
    updateExplosions(1e9); // follow-ups the preset tests left pending
    calls.length = 0;
    explode(500, 500, PRESETS.chain);
    const first = calls.length;
    updateExplosions(10);
    assert.equal(calls.length, first, 'not yet');
    updateExplosions(PRESETS.chain.secondaryDelay * PRESETS.chain.secondary * 1.5 * 1000);
    assert.ok(calls.length > first * 4, 'the chain went off');
    const ys = new Set(calls.filter((c) => c.layer === FIELD_LAYER).map((c) => c.sortY));
    assert.deepEqual([...ys], [500], 'the chain\'s smoke is one cloud: it sorts at the first blast\'s ground y');
  } finally {
    restore();
  }
});
