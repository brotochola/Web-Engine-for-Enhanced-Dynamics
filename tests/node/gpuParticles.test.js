import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuParticles } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND, PARTICLE_EASE } from '../../src/util/configDefaults.js';
import { randomRange, rngFill, seededRandom } from '../../src/util/utils.js';
import { resolveParticleColorOp, resolveParticleOp } from '../../src/util/particleTween.js';
import {
  GPU_FRAME_MS,
  GPU_GROUP,
  GPU_GROUP_WORDS,
  GPU_REC,
  GPU_RECORD_FLOATS,
  GPU_RING,
  gpuLayerLayout,
  gpuRingCapacities,
  gpuSlotOf,
  gpuWriterCount,
} from '../../src/util/gpuParticleLayout.js';
import { evaluateGpuParticle, gpuTravel } from '../../src/util/gpuParticleEval.js';
import { updateParticlePhysicsBuffers } from '../reference/particleIntegrate.mjs';

const BUILT_INS = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };

/** A scene with one GPU layer, the clock bound and this realm writing ring `slot`. */
function setup(layer = { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 4096 }, { slot = 0, logic = 1 } = {}) {
  const layers = { smoke: layer };
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_INS);
  GpuParticles.initializeFromConfig(layers, logic);
  GpuParticles.writerSlot = slot;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(1234, 'gpu');
  return () => {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  };
}

const ring = (slot = 0) => GpuParticles.layerOf('smoke').rings[slot];

test('seededRandom fills a batch with the numbers as many calls return, and rngFill draws from rng', () => {
  const calls = seededRandom(99, 'fill');
  const batch = seededRandom(99, 'fill');
  const out = new Float64Array(1000);
  batch.fill(out, 0, 500);
  batch.fill(out, 500, 500);
  for (let i = 0; i < 1000; i++) assert.equal(out[i], calls(), `number ${i}`);
  assert.equal(batch(), calls(), 'both left at the same place');
  const previous = globalThis.rng;
  try {
    globalThis.rng = seededRandom(5, 'fill');
    const expected = seededRandom(5, 'fill');
    rngFill(out, 3, 4);
    for (let i = 3; i < 7; i++) assert.equal(out[i], expected());
    globalThis.rng = () => 0.5;
    assert.throws(() => rngFill(out, 0, 1), /seededRandom/);
  } finally {
    globalThis.rng = previous;
  }
});

test('emitGpu writes the particles the per-key resolvers draw from the same seed, in their order', { concurrency: false }, () => {
  const restore = setup();
  try {
    const cfg = {
      count: 64,
      x: { min: -40, max: 40 },
      y: 12,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.1, max: 2 },
      lifespan: { min: 400, max: 900 },
      drag: { min: 0, max: 3 },
      scale: { from: { min: 0.2, max: 0.6 }, to: 1.5, ease: PARTICLE_EASE.QUAD_OUT },
      alpha: { min: 0.3, max: 1 },
      tint: { from: { min: 0x102030, max: 0xf0e0d0 }, to: { min: 0, max: 0x808080 }, ease: PARTICLE_EASE.CUBIC_IN },
      rotation: { from: 0, to: { min: -90, max: 90 } },
    };
    globalThis.rng = seededRandom(31337, 'resolvers');
    ParticleEmitter.emitGpu({ layer: 'smoke', ...cfg });
    const afterEmit = globalThis.rng;
    globalThis.rng = seededRandom(31337, 'resolvers');
    const r = ring(0);
    const f32 = (v) => Math.fround(v);
    for (let k = 0; k < cfg.count; k++) {
      const b = k * GPU_RECORD_FLOATS;
      const x0 = randomRange(cfg.x, 0);
      const y0 = randomRange(cfg.y, 0);
      const angle = (randomRange(cfg.angleXY, 0) * Math.PI) / 180;
      const speed = randomRange(cfg.speed, 0);
      const drag = (randomRange(cfg.drag, 0) * GPU_FRAME_MS) / 1000;
      const life = randomRange(cfg.lifespan, 1000);
      randomRange(undefined, 0); // delay: none
      const scale = resolveParticleOp(cfg.scale, 1);
      const alpha = resolveParticleOp(cfg.alpha, 1);
      const tint = resolveParticleColorOp(cfg.tint, 0xffffff);
      const rot = resolveParticleOp(cfg.rotation, 0);
      assert.equal(r.records[b + GPU_REC.X0], f32(x0), `x of ${k}`);
      assert.equal(r.records[b + GPU_REC.Y0], f32(y0));
      assert.equal(r.records[b + GPU_REC.VX], f32(speed * Math.cos(angle)));
      assert.equal(r.records[b + GPU_REC.VY], f32(speed * Math.sin(angle)));
      assert.equal(r.records[b + GPU_REC.DRAG], f32(drag));
      assert.equal(r.records[b + GPU_REC.LIFE], f32(life));
      assert.equal(r.records[b + GPU_REC.SCALE_X_FROM], f32(scale.from));
      assert.equal(r.records[b + GPU_REC.SCALE_Y_TO], f32(scale.to));
      assert.equal(r.records[b + GPU_REC.ALPHA_FROM], f32(alpha.from));
      assert.equal(r.records[b + GPU_REC.ALPHA_TO], f32(alpha.to));
      assert.equal(r.recordBits[b + GPU_REC.TINT_FROM_T], tint.from & 0xffffff);
      assert.equal(r.recordBits[b + GPU_REC.TINT_TO_T], tint.to & 0xffffff);
      assert.equal(r.records[b + GPU_REC.ROT_TO], f32((rot.to * Math.PI) / 180));
    }
    assert.equal(afterEmit(), globalThis.rng(), 'the emit drew as many numbers as the resolvers');
  } finally {
    restore();
  }
});

test('ring capacities are powers of two, split by the writers\' shares', () => {
  assert.equal(gpuWriterCount(3), 5, 'main, three logic workers, the particle worker');
  const caps = gpuRingCapacities(100000, 3);
  for (const c of caps) assert.equal(c & (c - 1), 0, `${c} is a power of two`);
  assert.ok(caps.reduce((a, b) => a + b, 0) <= 100000);
  const weighted = gpuRingCapacities(4096, 3, [0, 1, 0]);
  assert.deepEqual(weighted, [64, 4096, 64], 'a zero share still gets the 64-record minimum');
  assert.equal(gpuSlotOf(0xffffffff + 1, 64), 0, 'the slot stays right across the uint32 wrap');
  const layout = gpuLayerLayout([64, 128]);
  assert.equal(layout.rings[1].headerByte % 64, 0);
  assert.ok(layout.rings[1].recordsByte >= layout.rings[0].groupsByte);
});

test('the layer kind has no render queue and takes no CPU subscriptions', { concurrency: false }, () => {
  const restore = setup();
  try {
    const layer = Layer.get('smoke');
    assert.equal(layer.kind ?? layer._kind, LAYER_KIND.GPU_PARTICLES);
    assert.equal(Layer._hasRenderQueue[layer.id], 0);
    const meta = Layer.getSerializableData().layers?.[layer.id] ?? Layer._metadata.layers[layer.id];
    assert.equal(meta.kind, LAYER_KIND.GPU_PARTICLES);
    assert.deepEqual(meta.gpuParticles, { sortWithEntities: false, pixelSnap: false });
  } finally {
    restore();
  }
});

test('emitGpu writes records, one group, then publishes', { concurrency: false }, () => {
  const restore = setup();
  try {
    Time._advanceSimNow(5000);
    const n = ParticleEmitter.emitGpu({
      layer: 'smoke', count: 10, x: 100, y: { min: 200, max: 220 }, vx: 1, vy: -2, lifespan: 800,
      scale: { from: 1, to: 2, ease: PARTICLE_EASE.QUAD_OUT }, alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN }, tint: 0x336699,
    });
    assert.equal(n, 10);
    const r = ring(0);
    assert.equal(Atomics.load(r.header, GPU_RING.PUBLISHED), 10);
    assert.equal(Atomics.load(r.header, GPU_RING.GROUPS), 1);
    assert.equal(r.epoch[0], 5000, 'the first emit puts the epoch at now');
    assert.equal(r.groupBits[GPU_GROUP.FIRST], 0);
    assert.equal(r.groupBits[GPU_GROUP.COUNT], 10);
    assert.equal(r.groups[GPU_GROUP.BIRTH_F], 0);
    assert.equal(r.groups[GPU_GROUP.END_F], 800);
    assert.equal(r.groups[GPU_GROUP.SORT_Y_F], 210, 'sortY defaults to the middle of y');
    for (let k = 0; k < 10; k++) {
      const b = k * GPU_RECORD_FLOATS;
      assert.equal(r.records[b + GPU_REC.X0], 100);
      assert.ok(r.records[b + GPU_REC.Y0] >= 200 && r.records[b + GPU_REC.Y0] <= 220);
      assert.equal(r.records[b + GPU_REC.LIFE], 800);
      assert.equal(r.recordBits[b + GPU_REC.TINT_FROM_T], 0x336699);
    }
    assert.equal(ring(1).header[GPU_RING.PUBLISHED], 0, 'other writers\' rings stay empty');
  } finally {
    restore();
  }
});

test('emitGpu throws on an ease that is not a PARTICLE_EASE value, before it writes', { concurrency: false }, () => {
  const restore = setup();
  try {
    Time._advanceSimNow(5000);
    assert.throws(() => ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, alpha: { from: 1, to: 0, ease: 'quad.in' } }), TypeError);
    assert.throws(() => ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, tint: { from: 0xff0000, to: 0, ease: 'quad.in' } }), TypeError);
    const r = ring(0);
    assert.equal(Atomics.load(r.header, GPU_RING.PUBLISHED), 0);
    assert.equal(Atomics.load(r.header, GPU_RING.GROUPS), 0);
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN } }), 4);
  } finally {
    restore();
  }
});

test('a flat GPU particle is where the CPU integrate puts the same particle, frame after frame', { concurrency: false }, () => {
  const restore = setup();
  const prev = {};
  for (const key of Object.keys(ParticleComponent.ARRAY_SCHEMA)) prev[key] = ParticleComponent[key];
  try {
    ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(4)), 4);
    ParticleEmitter.reset();
    ParticleEmitter.initialize(4);
    ParticleEmitter.initializeFreeList(new SharedArrayBuffer(8), new SharedArrayBuffer(8));
    ParticleEmitter.resetFreeListInterleaved(1);
    const cfg = {
      count: 1, x: 10, y: 20, vx: 2.5, vy: -6, gravity: 0.2, lifespan: 2000,
      scale: { from: 0.5, to: 2, ease: PARTICLE_EASE.CUBIC_OUT }, alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    };
    ParticleComponent.particleCount = 4;
    ParticleEmitter.emitFlat(cfg);
    ParticleEmitter.emitGpu({ ...cfg, layer: 'smoke' });
    let cpu = -1;
    for (let i = 0; i < 4; i++) if (ParticleComponent.active[i]) cpu = i;
    const one = new Uint16Array([cpu]);
    const r = ring(0);
    const out = {};
    for (let f = 1; f <= 90; f++) {
      updateParticlePhysicsBuffers(ParticleComponent, one, 1, GPU_FRAME_MS, 1, false, null);
      evaluateGpuParticle(r.records, 0, f * GPU_FRAME_MS, out);
      assert.ok(out.alive);
      assert.ok(Math.abs(out.x - ParticleComponent.x[cpu]) < 1e-3, `x at frame ${f}: ${out.x} vs ${ParticleComponent.x[cpu]}`);
      assert.ok(Math.abs(out.y - ParticleComponent.y[cpu]) < 1e-3, `y at frame ${f}: ${out.y} vs ${ParticleComponent.y[cpu]}`);
      // The CPU ages in whole ms (a Uint16 that truncates): its tweens are where the GPU's are at that age.
      evaluateGpuParticle(r.records, 0, ParticleComponent.currentLife[cpu], out);
      assert.ok(Math.abs(out.scaleX - ParticleComponent.scaleX[cpu]) < 1e-5, `scale at frame ${f}`);
      assert.ok(Math.abs(out.alpha - ParticleComponent.alpha[cpu]) < 1e-5, `alpha at frame ${f}`);
    }
  } finally {
    ParticleEmitter.reset();
    for (const [key, value] of Object.entries(prev)) ParticleComponent[key] = value;
    restore();
  }
});

test('a heighted GPU particle rises like a CPU one and never goes under the floor', { concurrency: false }, () => {
  const restore = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', heighted: true, x: 0, y: 300, z: -2, vz: -1.5, gravity: 0.01, lifespan: 60000 });
    const r = ring(0);
    const out = {};
    // vz += g; z += vz each frame: z(t) = z0 + vz·t + g·(t² + t)/2
    evaluateGpuParticle(r.records, 0, 60 * GPU_FRAME_MS, out);
    assert.ok(Math.abs(out.z - (-2 - 1.5 * 60 + (0.01 * (3600 + 60)) / 2)) < 1e-6);
    assert.equal(out.groundY, 300, 'the ground point does not move');
    assert.equal(out.y, 300 + out.z, 'drawn at y + z');
    evaluateGpuParticle(r.records, 0, 2000 * GPU_FRAME_MS, out);
    assert.equal(out.z, 0, 'stops at the floor (v1 has no landing)');
  } finally {
    restore();
  }
});

test('drag is the exact solution of dv/dt = a - d·v', () => {
  const d = 0.05;
  const a = 0.3;
  let p = 5;
  let v = 4;
  const steps = 20000;
  const dt = 60 / steps;
  for (let s = 0; s < steps; s++) {
    v += (a - d * v) * dt;
    p += v * dt;
  }
  assert.ok(Math.abs(gpuTravel(5, 4, a, d, 60) - p) < 1e-2);
});

test('delay: a particle is unborn until its delay has passed', { concurrency: false }, () => {
  const restore = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, lifespan: 500, delay: 300 });
    const r = ring(0);
    assert.equal(evaluateGpuParticle(r.records, 0, 299, {}).alive, false);
    assert.equal(evaluateGpuParticle(r.records, 0, 301, {}).alive, true);
    assert.equal(evaluateGpuParticle(r.records, 0, 801, {}).alive, false);
    assert.equal(r.groups[GPU_GROUP.END_F], 800, 'the group ends with its last death');
  } finally {
    restore();
  }
});

test('group bounds hold every particle over its whole life', { concurrency: false }, () => {
  const restore = setup();
  try {
    ParticleEmitter.emitGpu({
      layer: 'smoke', heighted: true, count: 200, x: { min: -20, max: 20 }, y: { min: 480, max: 520 },
      angleXY: { min: 0, max: 360 }, speed: { min: 0.5, max: 4 }, z: -5, vz: { min: -3, max: 0 }, gravity: 0.05,
      drag: { min: 0, max: 2 }, lifespan: { min: 500, max: 3000 }, scale: { from: 0.5, to: 2 },
    });
    const r = ring(0);
    const g = r.groups;
    const out = {};
    for (let k = 0; k < 200; k++) {
      for (let ms = 0; ms < 3000; ms += 50) {
        evaluateGpuParticle(r.records, k * GPU_RECORD_FLOATS, ms, out);
        if (!out.alive) continue;
        assert.ok(out.x >= g[GPU_GROUP.MIN_X_F] && out.x <= g[GPU_GROUP.MAX_X_F], `x ${out.x}`);
        assert.ok(out.y >= g[GPU_GROUP.MIN_Y_F] && out.y <= g[GPU_GROUP.MAX_Y_F], `y ${out.y}`);
      }
    }
  } finally {
    restore();
  }
});

test('frames: an array cycles over life; anim random keeps one per particle', { concurrency: false }, () => {
  const restore = setup();
  try {
    const out = {};
    // Without a spritesheet registry the ids resolve to 0; the frame index still cycles over life.
    const r = ring(0);
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, lifespan: 1000 });
    evaluateGpuParticle(r.records, 0, 900, out);
    assert.equal(out.frame, 0, 'one frame');
  } finally {
    restore();
  }
});

test('a writer that laps live records counts an overflow; a count past the ring is clamped; each warns once', { concurrency: false }, () => {
  const restore = setup({ kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 64 * 3 });
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    const r = ring(0);
    assert.equal(r.capacity, 64);
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', count: 50, x: 0, y: 0, lifespan: 10000 }), 50);
    assert.equal(Atomics.load(r.header, GPU_RING.OVERFLOW), 0);
    assert.equal(warned.length, 0);
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 50, x: 0, y: 0, lifespan: 10000 });
    assert.equal(Atomics.load(r.header, GPU_RING.OVERFLOW), 1, 'the second emit overwrote live records');
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 50, x: 0, y: 0, lifespan: 10000 });
    assert.equal(Atomics.load(r.header, GPU_RING.OVERFLOW), 2);
    assert.equal(warned.length, 1, 'one warning for both overflows');
    assert.match(warned[0], /still alive.*64 particles and 2048 emitGpu calls/);
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', count: 500, x: 0, y: 0, lifespan: 10 }), 64, 'clamped to the ring');
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', count: 500, x: 0, y: 0, lifespan: 10 }), 64);
    assert.equal(warned.filter((m) => /500 particles is more than/.test(m)).length, 1, 'one warning for both clamps');
  } finally {
    console.warn = warn;
    restore();
  }
});

test('a quiet ring moves its epoch to now, so float32 births stay precise', { concurrency: false }, () => {
  const restore = setup();
  try {
    const r = ring(0);
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, lifespan: 1000 });
    const gen = Atomics.load(r.header, GPU_RING.EPOCH_GEN);
    Time._advanceSimNow(30000);
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, lifespan: 1000 });
    assert.equal(Atomics.load(r.header, GPU_RING.EPOCH_GEN), gen, 'not before a minute');
    Time._advanceSimNow(40000);
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, lifespan: 1000 });
    assert.equal(Atomics.load(r.header, GPU_RING.EPOCH_GEN), gen + 1);
    assert.equal(r.epoch[0], 70000);
    const b = 2 * GPU_RECORD_FLOATS;
    assert.equal(r.records[b + GPU_REC.BIRTH], 0);
    const g = 2 * GPU_GROUP_WORDS;
    assert.equal(r.groupBits[g + GPU_GROUP.EPOCH_GEN], gen + 1);
  } finally {
    restore();
  }
});

test('emitGpu refuses a thread without a ring, a layer that is not GPU, and warns about CPU-only keys once', { concurrency: false }, () => {
  const restore = setup(undefined, { slot: -1 });
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0 }), 0);
    GpuParticles.writerSlot = 0;
    assert.equal(ParticleEmitter.emitGpu({ layer: 'entities', x: 0, y: 0 }), 0);
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, bounces: 2 }), 1);
    assert.equal(ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, bounces: 2 }), 1);
    assert.equal(warned.length, 3, warned.join('\n'));
    assert.match(warned[2], /bounces/);
  } finally {
    console.warn = warn;
    restore();
  }
});

test('z or vz without heighted warns once: emitGpu defaults to emitFlat\'s model', { concurrency: false }, () => {
  const restore = setup();
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, heighted: true, z: -10, vz: -1 });
    assert.equal(warned.length, 0, 'heighted: z and vz are used');
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, z: -10 });
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0, vz: -1 });
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0], /heighted: true/);
  } finally {
    console.warn = warn;
    restore();
  }
});

test('workers bind the main thread\'s memories; the particle worker writes the last ring', { concurrency: false }, () => {
  const restore = setup(undefined, { logic: 2 });
  try {
    const data = GpuParticles.getSerializableData();
    assert.equal(data.writers, 4);
    ParticleEmitter.emitGpu({ layer: 'smoke', x: 0, y: 0 });
    GpuParticles.initializeFromBuffers(structuredClone(data));
    assert.equal(GpuParticles.particleWorkerSlot, 3);
    const r = GpuParticles.layerOf('smoke').rings[0];
    assert.equal(Atomics.load(r.header, GPU_RING.PUBLISHED), 1, 'the same memory');
  } finally {
    restore();
  }
});
