#!/usr/bin/env node
/**
 * Kernel (E-76 W13): the particle worker's list build in WASM against the shipped JS, on the
 * population particleIntegrateStressScene?tween=1 keeps alive: its driver's emits through the
 * shipped ParticleEmitter.emit, seeded, aged 300 frames by the shipped integrate so dead slots are
 * scattered the way the scene's free list scatters them (about 65 000 live of 65 535).
 *
 *   base  buildActiveAndVisibleListBuffers / …Turned (src/util/particleIntegrate.js), with the
 *         worker's local index list and the two published lists, as the particle worker calls them
 *   wasm  a hypothesis variant (here until it is decided): build_lists / build_lists_turned
 *         (wasm/particleLists.c) writing the published lists only, the integrate's input being the
 *         published active list
 *   simd  the same with the full 16-slot blocks tested two particles at a time (f64x2, the same
 *         doubles) and their flags and active indices stored as vectors
 *
 * Cases, one process each variant (runKernelVariants.mjs alternates them and rejects a checksum that
 * differs; the checksum covers both lists and every isItOnScreen byte after each case):
 *   stress  the scene's camera: zoom 0.3 at the origin on 1920 × 1080, the whole world in view
 *   zoomed  zoom 1 at the world's centre: about a quarter of the particles in view, in no order
 *   turned  zoom 0.6 at the centre turned 0.785 rad (the turned loop)
 *   sparse  Predator's pool: 10 000 slots, 150 live ones scattered (the sweep over empty slots)
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleListsWasmMicrobench.mjs --variants base,wasm,simd --rounds 5
 *   node tests/bench/particleListsWasmMicrobench.mjs --variant wasm [--output path]
 */
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import {
  buildActiveAndVisibleListBuffers,
  buildActiveAndVisibleListBuffersTurned,
  buildActiveListBuffers,
  updateParticlePhysicsBuffers,
} from '../../src/util/particleIntegrate.js';
import { calculateCameraScreenBounds, seededRandom } from '../../src/util/utils.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { emitConfig, PARTICLE_EASES } from './particleIntegrateWasmMicrobench.mjs';
import { instantiateKernel, machineState, warmWasm, wasmTier } from './wasmKernelHelpers.mjs';

const MAX_PARTICLES = 65535;
const INITIAL_BURST = 60000;
const TOPUP_PER_FRAME = 4000;
const AGE_FRAMES = 300;
const DT = 1000 / 60;
const W = 1920;
const H = 1080;
const CULL = 0.1;
const SPARSE_POOL = 10000;
const SPARSE_LIVE = 150;

/** The memory: ParticleComponent from byte 0, the worker's local list, then the two published lists. */
function particleMemory(n) {
  const layout = layoutRegions([
    { name: 'component', owner: 'every worker', bytes: ParticleComponent.getBufferSize(n) },
    { name: 'indices', owner: 'particle', bytes: n * 2 },
    // [count, index …] and one index past the count.
    { name: 'activeList', owner: 'particle; pre-render and Pixi read', bytes: (n + 2) * 2 },
    { name: 'visibleList', owner: 'particle; pre-render reads', bytes: (n + 2) * 2 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  return { memory, buffer: memory.buffer, regions: layout.regions };
}

/** The stress scene's population after AGE_FRAMES frames. */
function agePopulation(indices) {
  const rnd = seededRandom(0x5eed, 'driver');
  for (let tick = 0; tick < AGE_FRAMES; tick++) {
    if (tick === 0) {
      for (let k = 0; k < PARTICLE_EASES.length; k++) {
        ParticleEmitter.emit(emitConfig('tween', Math.floor(INITIAL_BURST / PARTICLE_EASES.length), PARTICLE_EASES[k], { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } }));
      }
    }
    const cx = 64 + rnd() * 3872;
    const cy = 64 + rnd() * 2872;
    ParticleEmitter.emit(emitConfig('tween', TOPUP_PER_FRAME, PARTICLE_EASES[tick % PARTICLE_EASES.length], { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } }));
    const count = buildActiveListBuffers(MAX_PARTICLES, ParticleComponent.active, indices, null, MAX_PARTICLES);
    updateParticlePhysicsBuffers(ParticleComponent, indices, count, DT, 1, false, null);
  }
}

/** Live 16-slot blocks: empty, full, partial (what the kernel's block test sees). */
function blockStats(active, n) {
  const s = { empty: 0, full: 0, partial: 0 };
  for (let i = 0; i + 16 <= n; i += 16) {
    let live = 0;
    for (let k = i; k < i + 16; k++) live += active[k] ? 1 : 0;
    if (live === 0) s.empty++;
    else if (live === 16) s.full++;
    else s.partial++;
  }
  return s;
}

/** FNV-1a over both lists up to their counts and every isItOnScreen byte of the pool. */
function checksum(activeData, visibleData, n) {
  let h = 2166136261;
  const mix = (v) => {
    h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
  };
  for (let k = 0, m = 1 + activeData[0]; k < m; k++) mix(activeData[k]);
  for (let k = 0, m = 1 + visibleData[0]; k < m; k++) mix(visibleData[k]);
  const on = ParticleComponent.isItOnScreen;
  for (let i = 0; i < n; i++) mix(on[i]);
  return h;
}

/** The camera of a case: bounds as the particle worker builds them, and the turned loop's terms. */
function caseCamera(zoom, centerX, centerY, rotation) {
  const camX = Math.max(0, centerX - W / (2 * zoom));
  const camY = Math.max(0, centerY - H / (2 * zoom));
  const bounds = calculateCameraScreenBounds(zoom, camX, camY, W, H, CULL, {}, rotation);
  const marginScale = zoom < 1 ? zoom : 1;
  return {
    bounds,
    rotation,
    rc: Math.cos(rotation),
    rs: Math.sin(rotation),
    limW: W * 0.5 + W * CULL * marginScale,
    limH: H * 0.5 + H * CULL * marginScale,
  };
}

const CASES = {
  stress: { n: MAX_PARTICLES, camera: caseCamera(0.3, 0, 0, 0) },
  zoomed: { n: MAX_PARTICLES, camera: caseCamera(1, 2000, 1500, 0) },
  turned: { n: MAX_PARTICLES, camera: caseCamera(0.6, 2000, 1500, 0.785) },
  sparse: { n: SPARSE_POOL, camera: caseCamera(1, 2000, 1500, 0) },
};

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!['base', 'wasm', 'simd'].includes(variant)) throw new Error(`unknown variant ${variant}`);

  const mem = particleMemory(MAX_PARTICLES);
  const r = mem.regions;
  const pc = ParticleComponent;
  pc.initializeArrays(mem.buffer, MAX_PARTICLES);
  ParticleEmitter.initialize(MAX_PARTICLES);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(MAX_PARTICLES * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved();
  globalThis.rng = seededRandom(0xc0de1234, 'kernel');
  const indices = new Uint16Array(mem.buffer, r.indices.byte, MAX_PARTICLES);
  const activeData = new Uint16Array(mem.buffer, r.activeList.byte, MAX_PARTICLES + 2);
  const visibleData = new Uint16Array(mem.buffer, r.visibleList.byte, MAX_PARTICLES + 2);
  agePopulation(indices);
  const blocks = { dense: blockStats(pc.active, MAX_PARTICLES) };

  const exportsOf = variant === 'base' ? null : instantiateKernel('particleLists', mem.memory);
  const kernel = !exportsOf
    ? null
    : variant === 'simd'
      ? { build_lists: exportsOf.build_lists_simd, build_lists_turned: exportsOf.build_lists_turned_simd }
      : exportsOf;
  const B = { active: pc.active.byteOffset, x: pc.x.byteOffset, y: pc.y.byteOffset, on: pc.isItOnScreen.byteOffset };
  const build = (n, cam) => {
    const b = cam.bounds;
    if (kernel) {
      return cam.rotation
        ? kernel.build_lists_turned(B.active, B.x, B.y, B.on, n, r.activeList.byte, r.visibleList.byte, b.zoom,
          b.cameraOffsetX, b.cameraOffsetY, W * 0.5, H * 0.5, cam.rc, cam.rs, cam.limW, cam.limH)
        : kernel.build_lists(B.active, B.x, B.y, B.on, n, r.activeList.byte, r.visibleList.byte, b.zoom,
          b.cameraOffsetX, b.cameraOffsetY, b.minX, b.maxX, b.minY, b.maxY);
    }
    return cam.rotation
      ? buildActiveAndVisibleListBuffersTurned(pc, n, indices, activeData, visibleData, n, b, cam.rotation, W, H, CULL).activeCount
      : buildActiveAndVisibleListBuffers(pc, n, indices, activeData, visibleData, n, b).activeCount;
  };

  // Normal compiles, not OSR: short calls over the first 64 slots, every camera.
  const short = () => {
    for (const c of Object.values(CASES)) build(64, c.camera);
  };
  let tier = null;
  if (kernel) tier = await warmWasm(kernel.build_lists, short);
  else warmNormalCompile(short);

  let sum = 2166136261;
  const cases = {};
  const counts = {};
  for (const [name, c] of Object.entries(CASES)) {
    if (name === 'sparse') {
      // Predator's pool size with a few live particles in it, scattered.
      pc.active.fill(0);
      const pick = seededRandom(0x5a5a, 'sparse');
      for (let k = 0; k < SPARSE_LIVE; k++) pc.active[Math.floor(pick() * SPARSE_POOL)] = 1;
      blocks.sparse = blockStats(pc.active, SPARSE_POOL);
    }
    pc.isItOnScreen.fill(0);
    const activeCount = build(c.n, c.camera);
    counts[name] = { active: activeCount, visible: visibleData[0] };
    sum = Math.imul(sum ^ checksum(activeData, visibleData, c.n), 16777619) >>> 0;
    cases[name] = timeIt(`particle lists ${variant} ${name} (${activeCount} live, ${visibleData[0]} visible)`, () => build(c.n, c.camera), {
      iterations: 20,
      warmup: 10,
    });
  }
  const report = {
    feature: 'particle-lists-wasm',
    variant,
    functions: [kernel ? `particleLists.build_lists${variant === 'simd' ? '_simd' : ''} / build_lists_turned${variant === 'simd' ? '_simd' : ''}` : 'buildActiveAndVisibleListBuffers / …Turned'],
    n: MAX_PARTICLES,
    counts,
    blocks,
    checksum: sum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${sum} ${JSON.stringify(counts)} blocks ${JSON.stringify(blocks)}${kernel ? ` tier ${tier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
