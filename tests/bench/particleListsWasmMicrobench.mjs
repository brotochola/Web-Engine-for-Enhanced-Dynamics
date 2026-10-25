#!/usr/bin/env node
/**
 * Kernel (E-76 W13): the particle worker's list build in WASM against the shipped JS, on the
 * population particleIntegrateStressScene?tween=1 keeps alive: its driver's emits through the
 * shipped ParticleEmitter.emit, seeded, aged 300 frames by the shipped integrate so dead slots are
 * scattered the way the scene's free list scatters them (about 65 000 live of 65 535).
 *
 *   base  buildActiveAndVisibleListBuffers / …Turned (src/util/particleIntegrate.js), with the
 *         worker's local index list and the two published lists, as the particle worker calls them
 *   wasm  buildParticleListsWasm (src/workers/particleListsClient.js): build_lists /
 *         build_lists_turned (wasm/particleLists.c, f64x2 on full 16-slot blocks) writing the
 *         published lists only, the integrate's input being the published active list; what the
 *         particle worker binds with wasm.particleListsF32 false
 *   wasm-f32x4  the same wrapper around build_lists_f32x4 / build_lists_turned_f32x4 (wasm/particleLists.c):
 *               the screen test in float32, four particles per f32x4 on a full block; what the worker
 *               binds by default (bindParticleLists' `f32`)
 *
 * Both run on the particle memory the scene builds (createParticleMemory). E-80's kernel sitting
 * also timed a scalar build (every particle alone, in double): f64x2 beat it 25/25 in the dense cases.
 * The float32 pass (2026-10-24) also timed a scalar float32 build: -22.9 to -26.6 % against build_lists
 * (0/25), so only the f32x4 builds were kept.
 *
 * Cases, one process each variant (runKernelVariants.mjs alternates them and rejects a checksum that
 * differs; the checksum covers both lists and every isItOnScreen byte after each case). base and wasm
 * hash their own lists (E-80: identical). A float32 variant's test can put a particle within a float32
 * rounding of a box edge on the other side, so in its process the shipped kernel builds each case first
 * and gives the checksum, then the variant builds the same case and compareListBuilds checks it: the same
 * active list, every flag the same except for particles within listFlipSlack of an edge, and the visible
 * list its flags in active-list order. The checksum is the shipped kernel's (wasm's) when every case
 * passes, and a string naming the first difference when one does not.
 *   stress  the scene's camera: zoom 0.3 at the origin on 1920 × 1080, the whole world in view
 *   zoomed  zoom 1 at the world's centre: about a quarter of the particles in view, in no order
 *   turned  zoom 0.6 at the centre turned 0.785 rad (the turned loop)
 *   sparse  Predator's pool: 10 000 slots, 150 live ones scattered (the sweep over empty slots)
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleListsWasmMicrobench.mjs --variants base,wasm --rounds 5
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/particleListsWasmMicrobench.mjs --variants wasm,wasm-f32x4 --rounds 5
 *   node tests/bench/particleListsWasmMicrobench.mjs --variant wasm [--check] [--output path]
 *
 * --check builds each case once and prints the checksum: no warm-up, no timing.
 */
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import {
  buildActiveAndVisibleListBuffers,
  buildActiveAndVisibleListBuffersTurned,
  buildActiveListBuffers,
  updateParticlePhysicsBuffers,
} from '../reference/particleIntegrate.mjs';
import { calculateCameraScreenBounds, seededRandom } from '../../src/util/utils.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { bindParticleLists, buildParticleListsWasm } from '../../src/workers/particleListsClient.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { emitConfig, PARTICLE_EASES } from './particleIntegrateWasmMicrobench.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

/** The float32 builds of the shipped module (wasm/particleLists.c), by variant name. */
export const LISTS_F32_MODULE = 'particleLists';
export const LISTS_F32_EXPORTS = Object.freeze({
  'wasm-f32x4': { build: 'build_lists_f32x4', buildTurned: 'build_lists_turned_f32x4' },
});

/**
 * The shipped bindings, as the particle worker makes them: `wasm` with wasm.particleListsF32 off (the double
 * builds), `wasm-f32x4` with it on (bindParticleLists' `f32`). buildParticleListsWasm calls either.
 * `f32: false` leaves the float32 binding out.
 */
export async function bindListKernels(memory, layout, pc, { f32: withF32 = true } = {}) {
  const wasm = await bindParticleLists(memory, layout, pc, { f32: false });
  const out = { wasm };
  if (!withF32) return out;
  out['wasm-f32x4'] = await bindParticleLists(memory, layout, pc, { f32: true });
  return out;
}

const F32_STEP = 2 ** -24; // half a float32 step, relative

/**
 * How close to an edge of the box a live particle's double screen coordinate must be for the float32 test
 * to see it on the other side: four times a first-order bound on the float32 rounding of the camera terms,
 * the products and sums, and the bound itself. Returns null when no edge is that close (its flag must
 * then match the shipped kernel's), else { dist, slack } for the nearest such edge. `cam` is a case's
 * camera (caseCamera): bounds, rotation, rc, rs, limW, limH, and the canvas size w, h.
 */
export function listFlipSlack(x, y, cam) {
  const b = cam.bounds;
  const z = b.zoom;
  const xz = x * z;
  const yz = y * z;
  let best = null;
  const near = (coord, edge, err) => {
    const dist = Math.abs(coord - edge);
    const slack = 4 * (err + Math.abs(edge) * F32_STEP);
    // An infinite or NaN coordinate is no edge case: both tests see it outside.
    if (dist <= slack && slack < Infinity && (!best || dist / slack < best.dist / best.slack)) best = { dist, slack };
  };
  if (!cam.rotation) {
    const sx = xz - b.cameraOffsetX;
    const sy = yz - b.cameraOffsetY;
    const ex = F32_STEP * (2 * Math.abs(xz) + Math.abs(b.cameraOffsetX) + Math.abs(sx));
    const ey = F32_STEP * (2 * Math.abs(yz) + Math.abs(b.cameraOffsetY) + Math.abs(sy));
    near(sx, b.minX, ex);
    near(sx, b.maxX, ex);
    near(sy, b.minY, ey);
    near(sy, b.maxY, ey);
    return best;
  }
  const halfCw = cam.w * 0.5;
  const halfCh = cam.h * 0.5;
  const dx = xz - b.cameraOffsetX - halfCw;
  const dy = yz - b.cameraOffsetY - halfCh;
  const u = cam.rc * dx - cam.rs * dy;
  const v = cam.rs * dx + cam.rc * dy;
  const edx = F32_STEP * (3 * Math.abs(xz) + 2 * Math.abs(b.cameraOffsetX) + Math.abs(halfCw) + Math.abs(dx));
  const edy = F32_STEP * (3 * Math.abs(yz) + 2 * Math.abs(b.cameraOffsetY) + Math.abs(halfCh) + Math.abs(dy));
  const terms = 2 * F32_STEP * (Math.abs(cam.rc * dx) + Math.abs(cam.rs * dy) + Math.abs(cam.rs * dx) + Math.abs(cam.rc * dy));
  const eu = Math.abs(cam.rc) * edx + Math.abs(cam.rs) * edy + terms + F32_STEP * Math.abs(u);
  const ev = Math.abs(cam.rs) * edx + Math.abs(cam.rc) * edy + terms + F32_STEP * Math.abs(v);
  near(u, -cam.limW, eu);
  near(u, cam.limW, eu);
  near(v, -cam.limH, ev);
  near(v, cam.limH, ev);
  return best;
}

/** A build's output: both lists to their counts and the flags of the first n slots. */
export function snapshotLists(activeData, visibleData, on, n) {
  return {
    active: activeData.slice(0, 1 + activeData[0]),
    visible: visibleData.slice(0, 1 + visibleData[0]),
    on: on.slice(0, n),
  };
}

/**
 * A float32 build against the shipped one on the same positions: the same active list; every slot's flag
 * the same, except a live particle within listFlipSlack of an edge (counted in stats.flips, its distance
 * as a share of the slack in stats.worst); the visible list the live flags in active-list order. Returns
 * the first difference, or null.
 */
export function compareListBuilds(ref, got, x, y, cam, stats = { flips: 0, worst: 0 }) {
  if (ref.active.length !== got.active.length) return `active count: shipped ${ref.active[0]}, variant ${got.active[0]}`;
  for (let k = 1; k < ref.active.length; k++) {
    if (ref.active[k] !== got.active[k]) return `active[${k}]: shipped ${ref.active[k]}, variant ${got.active[k]}`;
  }
  const live = new Uint8Array(ref.on.length);
  for (let k = 1; k < ref.active.length; k++) live[ref.active[k]] = 1;
  for (let i = 0; i < ref.on.length; i++) {
    if (ref.on[i] === got.on[i]) continue;
    if (!live[i]) return `isItOnScreen[${i}] of a dead slot: shipped ${ref.on[i]}, variant ${got.on[i]}`;
    const near = listFlipSlack(x[i], y[i], cam);
    if (!near) return `isItOnScreen[${i}] at (${x[i]}, ${y[i]}): shipped ${ref.on[i]}, variant ${got.on[i]}, no edge within the slack`;
    stats.flips++;
    if (near.dist / near.slack > stats.worst) stats.worst = near.dist / near.slack;
  }
  let vc = 0;
  for (let k = 1; k < got.active.length; k++) {
    const i = got.active[k];
    if (!got.on[i]) continue;
    vc++;
    if (got.visible[vc] !== i) return `visible[${vc}]: ${got.visible[vc]}, the live flags say ${i}`;
  }
  if (got.visible[0] !== vc) return `visible count ${got.visible[0]}, the live flags say ${vc}`;
  return null;
}

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
export function checksum(activeData, visibleData, n) {
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
export function caseCamera(zoom, centerX, centerY, rotation, w = W, h = H, cull = CULL) {
  const camX = Math.max(0, centerX - w / (2 * zoom));
  const camY = Math.max(0, centerY - h / (2 * zoom));
  const bounds = calculateCameraScreenBounds(zoom, camX, camY, w, h, cull, {}, rotation);
  const marginScale = zoom < 1 ? zoom : 1;
  return {
    bounds,
    rotation,
    rc: Math.cos(rotation),
    rs: Math.sin(rotation),
    limW: w * 0.5 + w * cull * marginScale,
    limH: h * 0.5 + h * cull * marginScale,
    w,
    h,
    cull,
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
  if (!['base', 'wasm', ...Object.keys(LISTS_F32_EXPORTS)].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const f32 = variant in LISTS_F32_EXPORTS;

  const mem = createParticleMemory(MAX_PARTICLES, ParticleComponent.getBufferSize(MAX_PARTICLES));
  const L = mem.layout;
  const pc = ParticleComponent;
  pc.initializeArrays(mem.buffer, MAX_PARTICLES);
  ParticleEmitter.initialize(MAX_PARTICLES);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(MAX_PARTICLES * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved();
  globalThis.rng = seededRandom(0xc0de1234, 'kernel');
  // The JS path's local list (the particle worker with both switches off), and the published lists.
  const indices = new Uint16Array(MAX_PARTICLES);
  const activeData = new Uint16Array(mem.buffer, L.activeListByte, MAX_PARTICLES + 1);
  const visibleData = new Uint16Array(mem.buffer, L.visibleListByte, MAX_PARTICLES + 1);
  agePopulation(indices);
  const blocks = { dense: blockStats(pc.active, MAX_PARTICLES) };

  const kernels = variant === 'base' ? null : await bindListKernels(mem.memory, L, pc, { f32 });
  const lists = kernels ? kernels[variant] : null;
  const build = (n, cam, k = lists) => {
    const b = cam.bounds;
    if (k) return buildParticleListsWasm(k, n, b, cam.rotation, W, H, CULL);
    return cam.rotation
      ? buildActiveAndVisibleListBuffersTurned(pc, n, indices, activeData, visibleData, n, b, cam.rotation, W, H, CULL).activeCount
      : buildActiveAndVisibleListBuffers(pc, n, indices, activeData, visibleData, n, b).activeCount;
  };
  let violation = null;
  const flipStats = { flips: 0, worst: 0 };

  // Normal compiles, not OSR: short calls over the first 64 slots, every camera.
  const short = () => {
    for (const c of Object.values(CASES)) build(64, c.camera);
  };
  let tier = null;
  if (args.check) tier = null;
  else if (lists) tier = await warmWasm(lists.build, short);
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
    let activeCount;
    if (f32) {
      // The shipped kernel gives the checksum; the variant's build of the same case must agree with it.
      build(c.n, c.camera, kernels.wasm);
      sum = Math.imul(sum ^ checksum(activeData, visibleData, c.n), 16777619) >>> 0;
      const ref = snapshotLists(activeData, visibleData, pc.isItOnScreen, c.n);
      pc.isItOnScreen.fill(0);
      activeCount = build(c.n, c.camera);
      const bad = compareListBuilds(ref, snapshotLists(activeData, visibleData, pc.isItOnScreen, c.n), pc.x, pc.y, c.camera, flipStats);
      if (bad && !violation) violation = `tolerance: ${name}: ${bad}`;
    } else {
      activeCount = build(c.n, c.camera);
      sum = Math.imul(sum ^ checksum(activeData, visibleData, c.n), 16777619) >>> 0;
    }
    counts[name] = { active: activeCount, visible: visibleData[0] };
    if (args.check) continue;
    cases[name] = timeIt(`particle lists ${variant} ${name} (${activeCount} live, ${visibleData[0]} visible)`, () => build(c.n, c.camera), {
      iterations: 20,
      warmup: 10,
    });
  }
  if (args.check) {
    if (violation) console.error(violation);
    console.log(`checksum ${violation ?? sum} ${JSON.stringify(counts)}${f32 ? ` flips ${flipStats.flips}` : ''}`);
    return;
  }
  const report = {
    feature: 'particle-lists-wasm',
    variant,
    functions: [
      !lists ? 'buildActiveAndVisibleListBuffers / …Turned'
        : f32 ? `buildParticleListsWasm (${LISTS_F32_MODULE}.${LISTS_F32_EXPORTS[variant].build} / ${LISTS_F32_EXPORTS[variant].buildTurned})`
        : 'buildParticleListsWasm (particleLists.build_lists / build_lists_turned)',
    ],
    n: MAX_PARTICLES,
    counts,
    blocks,
    checksum: violation ?? sum,
    // Float32 variants: flags that differ from the shipped kernel's, each within listFlipSlack of an edge.
    flips: f32 ? flipStats : null,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (violation) console.error(violation);
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${report.checksum} ${JSON.stringify(counts)} blocks ${JSON.stringify(blocks)}${lists ? ` tier ${tier}` : ''}${f32 ? ` flips ${flipStats.flips}` : ''}`);
}

if (isCli(import.meta.url)) await main();
