#!/usr/bin/env node
/**
 * Kernel (E-76 W12): the particle integrate in WASM against the shipped JS, on the population
 * particleIntegrateStressScene?tween=1 spawns: its driver's emit configs through the shipped
 * ParticleEmitter.emit, seeded. 60 000 heighted particles fall for 8–20 s fading and shrinking
 * with seven eases, despawn on ground contact, and 4 000 more are emitted every frame.
 *
 *   base  updateParticlePhysicsBuffers (src/util/particleIntegrate.js)
 *   wasm  a hypothesis variant (here until it is decided): integrate_batch (wasm/particleIntegrate.c)
 *         on the same memory, then ParticleEmitter.returnToPool for its dead list, in order, and
 *         Math.cos / Math.sin for its trig list
 *
 * Both run on a ParticleComponent laid out in a shared WebAssembly.Memory, with the active list,
 * the stamp list and the kernel's scratch after it. One variant per process: runKernelVariants.mjs
 * alternates them and rejects a variant whose checksum differs; the checksum covers the particle
 * state after every frame.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleIntegrateWasmMicrobench.mjs --variants base,wasm --rounds 5
 *   node tests/bench/particleIntegrateWasmMicrobench.mjs --variant wasm [--case tween|spin] [--output path]
 *
 * tween: the stress scene's mix. spin: the same with a rotation tween, an angular velocity and a
 * tint tween on every particle, so the C sin/cos and the tint lerp run per particle.
 */
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { PARTICLE_DEFAULTS } from '../../src/util/configDefaults.js';
import { buildActiveListBuffers, updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';
import { seededRandom } from '../../src/util/utils.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { instantiateKernel, machineState, wasmTier } from './wasmKernelHelpers.mjs';

const MAX_PARTICLES = 65535;
const INITIAL_BURST = 60000;
const TOPUP_PER_FRAME = 4000;
const DT = 1000 / 60;
const EASES = ['lerp', 'quad.out', 'cubic.in', 'quad.inout', 'expo.out', 'back.in', 'bounce.out'];
const LUT_SIZE = PARTICLE_DEFAULTS.expoLutSize | 0;
// The column order of wasm/particleIntegrate.c's table.
const COLUMNS = [
  'active', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'lifespan', 'currentLife', 'gravity', 'scaleX', 'scaleY',
  'alpha', 'tint', 'baseTint', 'textureId', 'rotC', 'rotS', 'fadeOnTheFloor', 'timeOnFloor', 'initialAlpha',
  'stayOnTheFloor', 'despawnOnGroundContact', 'tweenMask', 'easeId', 'alphaFrom', 'alphaTo', 'scaleXFrom',
  'scaleXTo', 'scaleYFrom', 'scaleYTo', 'tintFrom', 'tintTo', 'rotFrom', 'rotTo', 'angularVelFrom',
  'angularVelTo', 'hasAngularVel', 'animCount', 'animMode', 'animFrames', 'flat', 'renderOnly',
];

/** The memory: ParticleComponent from byte 0 (its own layout), then the lists and the kernel's state. */
function particleMemory(n) {
  const layout = layoutRegions([
    { name: 'component', owner: 'every worker', bytes: ParticleComponent.getBufferSize(n) },
    { name: 'indices', owner: 'particle', bytes: n * 2 },
    { name: 'stamp', owner: 'particle', bytes: n * 2 },
    { name: 'flat', owner: 'particle', bytes: 65536 * 2 },
    { name: 'heighted', owner: 'particle', bytes: 65536 * 2 },
    { name: 'dead', owner: 'particle', bytes: n * 2 },
    { name: 'trig', owner: 'particle', bytes: n * 2 },
    { name: 'trigAngle', owner: 'particle', bytes: n * 8 },
    { name: 'luts', owner: 'particle, read only', bytes: 3 * (LUT_SIZE + 1) * 4 },
    { name: 'columns', owner: 'particle, read only', bytes: COLUMNS.length * 4 },
    { name: 'results', owner: 'particle', bytes: 16 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  return { memory, buffer: memory.buffer, regions: layout.regions };
}

/** The EXPO tables as particleTween.js builds them (same formulas, same engine). */
function expoLuts() {
  const build = (fn) => {
    const lut = new Float32Array(LUT_SIZE + 1);
    for (let i = 0; i <= LUT_SIZE; i++) lut[i] = fn(i / LUT_SIZE);
    return lut;
  };
  return [
    build((t) => Math.pow(2, 10 * (t - 1))),
    build((t) => 1 - Math.pow(2, -10 * t)),
    build((t) => (t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10))),
  ];
}

function emitConfig(mix, count, ease, area) {
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

function makeWasmIntegrate(mem) {
  const r = mem.regions;
  const columns = new Uint32Array(mem.buffer, r.columns.byte, COLUMNS.length);
  COLUMNS.forEach((name, k) => {
    columns[k] = ParticleComponent[name].byteOffset;
  });
  const luts = expoLuts();
  luts.forEach((lut, k) => new Float32Array(mem.buffer, r.luts.byte + k * (LUT_SIZE + 1) * 4, LUT_SIZE + 1).set(lut));
  const integrate = instantiateKernel('particleIntegrate', mem.memory).integrate_batch;
  const results = new Int32Array(mem.buffer, r.results.byte, 4);
  const dead = new Uint16Array(mem.buffer, r.dead.byte, MAX_PARTICLES);
  const trig = new Uint16Array(mem.buffer, r.trig.byte, MAX_PARTICLES);
  const trigAngle = new Float64Array(mem.buffer, r.trigAngle.byte, MAX_PARTICLES);
  const out = { activeCount: 0, stampedCount: 0 };
  const run = (count, deltaTime, dtRatio, decalsEnabled, particlesToStamp) => {
    const pc = ParticleComponent;
    const skipRenderOnly = pc.renderOnlyLive && Atomics.load(pc.renderOnlyLive, 0) > 0 ? 1 : 0;
    integrate(
      r.columns.byte, r.indices.byte, count, deltaTime, dtRatio, decalsEnabled && particlesToStamp ? 1 : 0,
      skipRenderOnly, r.stamp.byte, r.flat.byte, r.heighted.byte, r.dead.byte, r.trig.byte, r.trigAngle.byte,
      r.luts.byte, LUT_SIZE, r.results.byte,
    );
    const deadCount = results[2];
    for (let k = 0; k < deadCount; k++) ParticleEmitter.returnToPool(dead[k]);
    const trigCount = results[3];
    for (let k = 0; k < trigCount; k++) {
      const i = trig[k];
      pc.rotC[i] = Math.cos(trigAngle[k]);
      pc.rotS[i] = Math.sin(trigAngle[k]);
    }
    out.activeCount = results[0];
    out.stampedCount = results[1];
    return out;
  };
  return { run, integrate };
}

/** FNV-1a over the state the integrate writes, for every active particle. */
const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
function checksum(indices, count) {
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

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const mix = String(args.case || 'tween');
  if (!['base', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (!['tween', 'spin'].includes(mix)) throw new Error(`unknown case ${mix}`);

  const mem = particleMemory(MAX_PARTICLES);
  ParticleComponent.initializeArrays(mem.buffer, MAX_PARTICLES);
  ParticleEmitter.initialize(MAX_PARTICLES);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(MAX_PARTICLES * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved();
  globalThis.rng = seededRandom(0xc0de1234, 'kernel');
  const indices = new Uint16Array(mem.buffer, mem.regions.indices.byte, MAX_PARTICLES);
  const stamp = new Uint16Array(mem.buffer, mem.regions.stamp.byte, MAX_PARTICLES);
  const wasm = variant === 'wasm' ? makeWasmIntegrate(mem) : null;
  const integrate = wasm
    ? wasm.run
    : (count, deltaTime, dtRatio, decalsEnabled, particlesToStamp) =>
        updateParticlePhysicsBuffers(ParticleComponent, indices, count, deltaTime, dtRatio, decalsEnabled, particlesToStamp);

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
  const frame = () => {
    spawn();
    count = buildActiveListBuffers(MAX_PARTICLES, ParticleComponent.active, indices, null, MAX_PARTICLES);
    return integrate(count, DT, 1, false, stamp).activeCount;
  };

  // 60 frames: the burst, then a population whose oldest particles start landing.
  let sum = 2166136261;
  for (let f = 0; f < 60; f++) {
    frame();
    sum = Math.imul(sum ^ checksum(indices, count), 16777619) >>> 0;
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
    functions: ['updateParticlePhysicsBuffers', variant === 'wasm' ? 'particleIntegrate.integrate_batch' : null].filter(Boolean),
    n: count,
    seed: 0xc0de1234,
    checksum: sum,
    wasmTier: wasm ? wasmTier(wasm.integrate) : null,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${sum} active ${count}${wasm ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
