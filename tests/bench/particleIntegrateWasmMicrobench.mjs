#!/usr/bin/env node
/**
 * Kernel (E-76 W12): the particle integrate in WASM against the shipped JS, on the population
 * particleIntegrateStressScene?tween=1 spawns: its driver's emit configs through the shipped
 * ParticleEmitter.emit, seeded. 60 000 heighted particles fall for 8–20 s fading and shrinking
 * with seven eases, despawn on ground contact, and 4 000 more are emitted every frame.
 *
 *   base        updateParticlePhysicsBuffers (src/util/particleIntegrate.js), the JS path
 *   wasm        integrateParticlesWasm (src/workers/particleIntegrateClient.js): integrate_batch
 *               (wasm/particleIntegrate.c), then returnToPool for its dead list, in order, and
 *               Math.cos / Math.sin for its trig list; what the particle worker binds with
 *               wasm.particleIntegrateF32 false
 *   wasm-f32x4  the same wrapper around integrate_batch_f32x4 (wasm/particleIntegrate.c): float32
 *               arithmetic where integrateF32Tolerance holds, f32x4 on runs of four slots in the position
 *               passes and on the staged rotations. (The float32 pass also timed a scalar float32
 *               integrate: +1.8 % tween, +5.7 % spin against integrate_batch, under f32x4's spin +24.3 %.)
 *               What the worker binds by default (bindParticleIntegrate's `f32`).
 *
 * Both run on the particle memory the scene builds (createParticleMemory: ParticleComponent from
 * byte 0 of a shared WebAssembly.Memory, the lists and the kernel's scratch after it). One variant per process: runKernelVariants.mjs
 * alternates them and rejects a variant whose checksum differs; the checksum covers the particle
 * state after every frame.
 *
 * base and wasm hash their own state, bit for bit (E-79: the two are identical). A float32 variant cannot
 * give those bits, so its checksum frames run in lock-step with the shipped kernel: each frame starts from
 * the shipped kernel's state, the variant integrates it, the shipped kernel integrates the same input, the
 * two states are compared (compareIntegrateStates: integers and the free list exactly, floats within
 * integrateF32Tolerance(1)), and the run goes on from the shipped kernel's state. Its checksum is the hash
 * of those shipped states, which is wasm's checksum, when every frame was within the tolerance, and a
 * string naming the first value outside it when one was not. So the checksum of base and wasm is as
 * strict as before, and `--variants wasm,wasm-f32x4` compares the float32 variant on the same
 * value. The timed calls run the variant alone. (This bench's frames all have dtRatio 1, where the float32
 * positions are the shipped ones bit for bit; the test drifts them.)
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleIntegrateWasmMicrobench.mjs --variants base,wasm --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleIntegrateWasmMicrobench.mjs --variants wasm,wasm-f32x4 --rounds 5 [-- --case spin]
 *   node tests/bench/particleIntegrateWasmMicrobench.mjs --variant wasm [--case tween|spin] [--check] [--output path]
 *
 * --check runs the 60 checksum frames only and prints the checksum: no timing.
 *
 * tween: the stress scene's mix. spin: the same with a rotation tween, an angular velocity and a
 * tint tween on every particle, so the C sin/cos and the tint lerp run per particle.
 */
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { buildActiveListBuffers, updateParticlePhysicsBuffers } from '../reference/particleIntegrate.mjs';
import { seededRandom } from '../../src/util/utils.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { bindParticleIntegrate, integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { machineState, wasmTier } from './wasmKernelHelpers.mjs';

const MAX_PARTICLES = 65535;
const INITIAL_BURST = 60000;
const TOPUP_PER_FRAME = 4000;
const DT = 1000 / 60;
const EASES = ['lerp', 'quad.out', 'cubic.in', 'quad.inout', 'expo.out', 'back.in', 'bounce.out'];
export const PARTICLE_EASES = EASES;

/** The float32 kernel of the shipped module (wasm/particleIntegrate.c), by variant name. */
export const INTEGRATE_F32_MODULE = 'particleIntegrate';
export const INTEGRATE_F32_EXPORTS = Object.freeze({ 'wasm-f32x4': 'integrate_batch_f32x4' });

export function emitConfig(mix, count, ease, area) {
  const cfg = {
    count,
    x: area.x,
    y: area.y,
    z: { min: -2000, max: -300 },
    vx: { min: -15, max: 15 },
    vy: { min: -15, max: 15 },
    vz: { min: -2, max: 2 },
    gravity: 0.08,
    despawnOnGroundContact: true,
    lifespan: { min: 8000, max: 20000 },
    scale: { from: { min: 0.4, max: 1 }, to: 0.2, ease },
    alpha: { from: 1, to: 0, ease },
  };
  if (mix === 'spin') {
    cfg.rotation = { from: { min: 0, max: 360 }, to: { min: -360, max: 720 }, ease };
    cfg.angularVelocity = { from: -90, to: 90, ease };
    cfg.tint = { from: 0xff2040, to: 0x20ff80, ease };
  }
  return cfg;
}

/** FNV-1a over the state the integrate writes, for every active particle. */
const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
export function checksum(indices, count) {
  const pc = ParticleComponent;
  let h = 2166136261;
  const mix = (v) => {
    h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
  };
  const f32 = (v) => {
    _f[0] = v;
    mix(_u[0]);
  };
  mix(count);
  for (let k = 0; k < count; k++) {
    const i = indices[k];
    mix(i);
    mix(pc.active[i]);
    mix(pc.currentLife[i]);
    f32(pc.x[i]);
    f32(pc.y[i]);
    f32(pc.z[i]);
    f32(pc.vz[i]);
    f32(pc.alpha[i]);
    f32(pc.scaleX[i]);
    f32(pc.rotC[i]);
    f32(pc.rotS[i]);
    mix(pc.tint[i]);
  }
  return h >>> 0;
}

/** One unit in the last place of v as a float32 (the spacing of float32 values at |v|). */
export function ulp32(v) {
  _f[0] = Math.abs(v);
  const exp = (_u[0] >>> 23) & 0xff;
  return 2 ** (Math.max(exp, 1) - 150);
}

/**
 * What a float32 integrate may differ by from the shipped kernel after `frames` frames from the same state
 * (1: the bench's lock-step frame; tests/node/particleIntegrateF32.test.js runs 60). wasm/
 * particleIntegrate.c (integrate_batch_f32x4) says where its arithmetic is float32. Integers are exact: the `exact` columns, the
 * free list (every death, in order) and, in the test, the lists and stamps. A column of `float` is within
 * max(abs, ulps · ulp32(shipped value)), NaN exactly where the shipped value is NaN; a channel of an `rgb`
 * column within `channel`.
 * - Positions and velocities: a frame whose dtRatio is not 1 rounds vx · dtRatio in float before the sum, so
 *   a sum within about 1e-7 px of a rounding midpoint can land one float32 step from the shipped one; the
 *   step stays (the next sums are on the same grid). So at most one step per frame (two for z, whose sum
 *   takes the new vz), 1e-3 px where that is finer: 2.4e-4 px a step at 2048–4096 px. With dtRatio 1 every
 *   sum is exact before its one rounding, as in the shipped kernel: no difference.
 * - Alpha and scale: a float32 lerp of a float32 ease, recomputed from the lifetime each frame.
 * - rotC and rotS: float polynomials on an argument reduced in double; the angle itself as shipped.
 * - Tint: a float32 lerp before `+ 0.5 | 0` can round a channel the other way.
 * @param {number} [frames]
 */
export function integrateF32Tolerance(frames = 1) {
  const drift = Object.freeze({ abs: 1e-3, ulps: Math.max(2, frames) });
  const tween = Object.freeze({ abs: 1e-6, ulps: 8 });
  const turn = Object.freeze({ abs: 2.5e-7, ulps: 0 });
  return Object.freeze({
    exact: ['active', 'currentLife', 'timeOnFloor', 'textureId'],
    float: {
      x: drift, y: drift, z: drift, vx: drift, vy: drift, vz: drift,
      alpha: tween, initialAlpha: tween, scaleX: tween, scaleY: tween,
      rotC: turn, rotS: turn,
    },
    rgb: ['tint', 'baseTint'],
    channel: 1,
  });
}

/** The columns compareIntegrateStates reads. */
const ONE_FRAME = integrateF32Tolerance(1);
export const INTEGRATE_COMPARED_COLUMNS = Object.freeze([...ONE_FRAME.exact, ...Object.keys(ONE_FRAME.float), ...ONE_FRAME.rgb]);

/**
 * Compare a variant's particle state with the shipped kernel's after the same frames, for the particles
 * of `list[0, count)`. `ref` and `got` map each of INTEGRATE_COMPARED_COLUMNS to a typed array, plus
 * `freeList` and `freeListTop`. Records the largest error of each float column (absolute, and the largest
 * share of its tolerance) into `worst` and returns the first value outside `tolerance`, or null.
 */
export function compareIntegrateStates(ref, got, list, count, worst = {}, tolerance = ONE_FRAME) {
  const T = tolerance;
  let bad = null;
  const fail = (msg) => {
    if (!bad) bad = msg;
  };
  for (const name of ['freeList', 'freeListTop']) {
    const a = ref[name];
    const b = got[name];
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k]) {
        fail(`${name}[${k}]: shipped ${a[k]}, variant ${b[k]}`);
        break;
      }
    }
  }
  for (const name of T.exact) {
    const a = ref[name];
    const b = got[name];
    for (let k = 0; k < count; k++) {
      const i = list[k];
      if (a[i] !== b[i]) {
        fail(`${name}[${i}]: shipped ${a[i]}, variant ${b[i]}`);
        break;
      }
    }
  }
  for (const [name, tol] of Object.entries(T.float)) {
    const a = ref[name];
    const b = got[name];
    const w = (worst[name] ??= { abs: 0, share: 0, at: -1 });
    for (let k = 0; k < count; k++) {
      const i = list[k];
      const r = a[i];
      const v = b[i];
      if (Number.isNaN(r) || Number.isNaN(v)) {
        if (Number.isNaN(r) !== Number.isNaN(v)) fail(`${name}[${i}]: shipped ${r}, variant ${v}`);
        continue;
      }
      const err = Math.abs(v - r);
      const allowed = Math.max(tol.abs, tol.ulps * ulp32(r));
      if (!(err <= allowed)) fail(`${name}[${i}]: shipped ${r}, variant ${v} (${err})`);
      if (err > w.abs) {
        w.abs = err;
        w.at = i;
      }
      if (err / allowed > w.share) w.share = err / allowed;
    }
  }
  for (const name of T.rgb) {
    const a = ref[name];
    const b = got[name];
    const w = (worst[name] ??= { channel: 0, at: -1 });
    for (let k = 0; k < count; k++) {
      const i = list[k];
      for (let shift = 0; shift <= 16; shift += 8) {
        const err = Math.abs(((a[i] >>> shift) & 0xff) - ((b[i] >>> shift) & 0xff));
        if (err > T.channel) fail(`${name}[${i}]: shipped 0x${a[i].toString(16)}, variant 0x${b[i].toString(16)}`);
        if (err > w.channel) {
          w.channel = err;
          w.at = i;
        }
      }
      if (a[i] >>> 24 !== b[i] >>> 24) fail(`${name}[${i}]: shipped 0x${a[i].toString(16)}, variant 0x${b[i].toString(16)}`);
    }
  }
  return bad;
}

/** The live columns compareIntegrateStates reads, with the pool's free list. */
export function liveIntegrateState() {
  const out = { freeList: ParticleEmitter.freeList, freeListTop: ParticleEmitter.freeListTop };
  for (const name of INTEGRATE_COMPARED_COLUMNS) out[name] = ParticleComponent[name];
  return out;
}

/**
 * The particle memory, ParticleComponent in it, the pool's free list and the kernels bound, as the stress
 * scene's particle worker has them; `save` and `restore` copy the whole state the integrate reads or
 * writes (the memory and the free list), `stateOf` views a saved copy as liveIntegrateState views the live one,
 * `pristine` is the state before the first spawn. `f32: false` leaves the float32 module out (kernels.wasm only).
 */
export async function createIntegrateRig(maxParticles = MAX_PARTICLES, { f32: withF32 = true } = {}) {
  const mem = createParticleMemory(maxParticles, ParticleComponent.getBufferSize(maxParticles));
  ParticleComponent.initializeArrays(mem.buffer, maxParticles);
  ParticleEmitter.initialize(maxParticles);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(maxParticles * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved();
  // As the particle worker binds them: wasm with wasm.particleIntegrateF32 off, wasm-f32x4 with it on.
  const binding = await bindParticleIntegrate(mem.memory, mem.layout, ParticleComponent, maxParticles, { f32: false });
  const kernels = { wasm: binding.integrate };
  if (withF32) {
    kernels['wasm-f32x4'] = (await bindParticleIntegrate(mem.memory, mem.layout, ParticleComponent, maxParticles, { f32: true })).integrate;
  }
  const bytes = new Uint8Array(mem.buffer);
  const save = () => ({ bytes: bytes.slice(), freeList: ParticleEmitter.freeList.slice(), freeListTop: ParticleEmitter.freeListTop.slice() });
  const restore = (s) => {
    bytes.set(s.bytes);
    ParticleEmitter.freeList.set(s.freeList);
    ParticleEmitter.freeListTop.set(s.freeListTop);
  };
  const stateOf = (s) => {
    const out = { freeList: s.freeList, freeListTop: s.freeListTop };
    for (const name of INTEGRATE_COMPARED_COLUMNS) {
      const live = ParticleComponent[name];
      out[name] = new live.constructor(s.bytes.buffer, live.byteOffset, live.length);
    }
    return out;
  };
  return { mem, binding, kernels, save, restore, stateOf, pristine: save() };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const mix = String(args.case || 'tween');
  if (!['base', 'wasm', ...Object.keys(INTEGRATE_F32_EXPORTS)].includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (!['tween', 'spin'].includes(mix)) throw new Error(`unknown case ${mix}`);

  const lockStep = variant in INTEGRATE_F32_EXPORTS;
  const rig = await createIntegrateRig(MAX_PARTICLES, { f32: lockStep });
  globalThis.rng = seededRandom(0xc0de1234, 'kernel');
  const binding = rig.binding;
  const indices = binding.indices;
  const stamp = binding.stamp;
  const integrate = variant === 'base'
    ? (count, deltaTime, dtRatio, decalsEnabled, particlesToStamp) =>
        updateParticlePhysicsBuffers(ParticleComponent, indices, count, deltaTime, dtRatio, decalsEnabled, particlesToStamp)
    : (count, deltaTime, dtRatio, decalsEnabled, particlesToStamp) =>
        integrateParticlesWasm(binding, ParticleComponent, count, deltaTime, dtRatio, decalsEnabled && particlesToStamp);

  // The driver: one burst in seven ease chunks, then 4 000 a frame in a random 400 × 400 area.
  const rnd = seededRandom(0x5eed, 'driver');
  let tick = 0;
  const spawn = () => {
    if (tick === 0) {
      for (let k = 0; k < EASES.length; k++) {
        ParticleEmitter.emit(emitConfig(mix, Math.floor(INITIAL_BURST / EASES.length), EASES[k], { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } }));
      }
    }
    const cx = 64 + rnd() * 3872;
    const cy = 64 + rnd() * 2872;
    ParticleEmitter.emit(emitConfig(mix, TOPUP_PER_FRAME, EASES[tick++ % EASES.length], { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } }));
  };
  let count = 0;
  let violation = null;
  const worst = {};
  const frame = () => {
    spawn();
    count = buildActiveListBuffers(MAX_PARTICLES, ParticleComponent.active, indices, null, MAX_PARTICLES);
    if (!lockStep) return integrate(count, DT, 1, false, stamp).activeCount;
    // The variant on the shipped kernel's state, then the shipped kernel on the same input; on from the latter.
    const before = rig.save();
    binding.integrate = rig.kernels[variant];
    integrate(count, DT, 1, false, stamp);
    const got = rig.save();
    rig.restore(before);
    binding.integrate = rig.kernels.wasm;
    const out = integrate(count, DT, 1, false, stamp).activeCount;
    const bad = compareIntegrateStates(liveIntegrateState(), rig.stateOf(got), indices, count, worst);
    if (bad && !violation) violation = `tolerance: frame ${tick - 1}: ${bad}`;
    return out;
  };

  // 60 frames: the burst, then a population whose oldest particles start landing.
  let sum = 2166136261;
  for (let f = 0; f < 60; f++) {
    frame();
    sum = Math.imul(sum ^ checksum(indices, count), 16777619) >>> 0;
  }
  if (lockStep) binding.integrate = rig.kernels[variant];
  if (args.check) {
    if (violation) console.error(violation);
    console.log(`checksum ${violation ?? sum} active ${count}${lockStep ? ` worst ${JSON.stringify(worst)}` : ''}`);
    return;
  }
  // Timed: the integrate alone, on a fixed frame's list (the population ages a step per call).
  const timed = () => integrate(count, DT, 1, false, stamp);
  const cases = {
    integrate: timeIt(`particle integrate ${variant} ${mix} (${count} active)`, timed, { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'particle-integrate-wasm',
    variant,
    case: mix,
    functions: [variant === 'base' ? 'updateParticlePhysicsBuffers' : `integrateParticlesWasm (${lockStep ? `${INTEGRATE_F32_MODULE}.${INTEGRATE_F32_EXPORTS[variant]}` : 'particleIntegrate.integrate_batch'})`],
    n: count,
    seed: 0xc0de1234,
    checksum: violation ?? sum,
    // Float32 variants: the largest difference from the shipped kernel over the checksum frames.
    worst: lockStep ? worst : null,
    wasmTier: variant === 'base' ? null : wasmTier(binding.integrate),
    machine: machineState(),
    cases,
  };
  if (violation) console.error(violation);
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${report.checksum} active ${count}${variant !== 'base' ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
