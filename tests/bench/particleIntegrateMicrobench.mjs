// Microbenchmark + correctness check for src/core/particleIntegrate.js (L1 isolated).
//
// Exercises the exact functions particle_worker.js calls (updateParticlePhysicsBuffers,
// buildActiveListBuffers, buildActiveAndVisibleListBuffers) against a real
// ParticleComponent SoA + ParticleEmitter free list, with no workers/camera involved.
//
// Usage:
//   node tests/bench/particle-integrate-microbench.mjs
//   node tests/bench/particle-integrate-microbench.mjs --particles 8192 --steps 3000 --output tests/results/particle-integrate-micro.json

import { ParticleComponent } from '../../src/components/ParticleComponent.js';
import { ParticleEmitter } from '../../src/core/ParticleEmitter.js';
import {
  updateParticlePhysicsBuffers,
  buildActiveListBuffers,
  buildActiveAndVisibleListBuffers,
} from '../../src/core/particleIntegrate.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const args = parseArgs();
const MAX_PARTICLES = Number(args.particles ?? 8192);
const STEPS = Number(args.steps ?? 3000);
const SEED = Number(args.seed ?? 0xc0ffee);
const OUTPUT = args.output ? String(args.output) : null;

const DT = 1000 / 60; // ms, fixed-step frame
const DT_RATIO = 1;

// ============================================================================
// SETUP
// ============================================================================
const bufferSize = ParticleComponent.getBufferSize(MAX_PARTICLES);
ParticleComponent.initializeArrays(new SharedArrayBuffer(bufferSize), MAX_PARTICLES);

ParticleEmitter.initialize(MAX_PARTICLES);
ParticleEmitter.initializeFreeList(new SharedArrayBuffer(MAX_PARTICLES * 2), new SharedArrayBuffer(8));
ParticleEmitter.resetFreeListInterleaved();

const rng = mulberry32(SEED);

const components = {
  active: ParticleComponent.active,
  x: ParticleComponent.x,
  y: ParticleComponent.y,
  z: ParticleComponent.z,
  vx: ParticleComponent.vx,
  vy: ParticleComponent.vy,
  vz: ParticleComponent.vz,
  lifespan: ParticleComponent.lifespan,
  currentLife: ParticleComponent.currentLife,
  gravity: ParticleComponent.gravity,
  alpha: ParticleComponent.alpha,
  fadeOnTheFloor: ParticleComponent.fadeOnTheFloor,
  timeOnFloor: ParticleComponent.timeOnFloor,
  initialAlpha: ParticleComponent.initialAlpha,
  stayOnTheFloor: ParticleComponent.stayOnTheFloor,
  despawnOnGroundContact: ParticleComponent.despawnOnGroundContact,
  flat: ParticleComponent.flat,
};

/**
 * Spawn `n` particles directly into the SoA via the real free list (bypasses
 * ParticleEmitter._spawn — this L1 bench isolates integrate, not emit).
 */
function spawnDirect(n, { flat, x0, y0, vx0, vy0, z0 = 0, vz0 = 0, gravity = 0, lifespan = 65535, despawnOnGroundContact = 0, stayOnTheFloor = 0, fadeOnTheFloor = 0 }) {
  const indices = [];
  for (let k = 0; k < n; k++) {
    const i = ParticleEmitter.acquireIndex();
    if (i < 0) break;
    components.active[i] = 1;
    components.x[i] = x0;
    components.y[i] = y0;
    components.z[i] = flat ? 0 : z0;
    components.vx[i] = vx0;
    components.vy[i] = vy0;
    components.vz[i] = flat ? 0 : vz0;
    components.gravity[i] = gravity;
    components.lifespan[i] = lifespan;
    components.currentLife[i] = 0;
    components.alpha[i] = 1;
    components.fadeOnTheFloor[i] = fadeOnTheFloor;
    components.timeOnFloor[i] = 0;
    components.initialAlpha[i] = 0;
    components.stayOnTheFloor[i] = stayOnTheFloor ? 1 : 0;
    components.despawnOnGroundContact[i] = despawnOnGroundContact ? 1 : 0;    components.flat[i] = flat ? 1 : 0;
    indices.push(i);
  }
  return indices;
}

function despawnIndices(indices) {
  for (const i of indices) {
    if (components.active[i]) {
      components.active[i] = 0;
      ParticleEmitter.returnToPool(i);
    }
  }
}

// ============================================================================
// CORRECTNESS — mixed categories run through the real per-frame sequence
// (buildActiveListBuffers -> updateParticlePhysicsBuffers) for N steps.
// ============================================================================
let mismatches = 0;
function check(cond, msg) {
  if (!cond) {
    mismatches++;
    console.error(`CORRECTNESS: ${msg}`);
  }
}

{
  const CNT = 50;
  const CORRECTNESS_STEPS = 300;

  // A: flat survivor — never despawns, exact-integer checksum (Float32 exact for small ints).
  const catA = spawnDirect(CNT, { flat: true, x0: 0, y0: 0, vx0: 3, vy0: 5, lifespan: 65535 });
  // B: heighted, despawns on ground contact.
  const catB = spawnDirect(CNT, { flat: false, x0: 0, y0: 0, vx0: 0, vy0: 0, z0: -50, vz0: 0, gravity: 2, despawnOnGroundContact: 1, lifespan: 65535 });
  // C: heighted, stamps once on ground contact then despawns (stayOnTheFloor).
  const catC = spawnDirect(CNT, { flat: false, x0: 0, y0: 0, vx0: 0, vy0: 0, z0: -50, vz0: 0, gravity: 2, stayOnTheFloor: 1, lifespan: 65535 });
  // D: heighted, fades out on the floor then despawns.
  const catD = spawnDirect(CNT, { flat: false, x0: 0, y0: 0, vx0: 0, vy0: 0, z0: -50, vz0: 0, gravity: 2, fadeOnTheFloor: 200, lifespan: 65535 });
  // E: short lifespan — despawns by lifetime almost immediately, independent of z/flat.
  const catE = spawnDirect(CNT, { flat: true, x0: 0, y0: 0, vx0: 0, vy0: 0, lifespan: 50 });

  check(catA.length === CNT && catB.length === CNT && catC.length === CNT && catD.length === CNT && catE.length === CNT, 'setup: not all correctness particles were spawned (pool too small?)');

  const activeIndices = new Uint16Array(MAX_PARTICLES);
  const stampScratch = new Uint16Array(MAX_PARTICLES);
  let totalStamped = 0;

  for (let step = 0; step < CORRECTNESS_STEPS; step++) {
    const expectedActive = ParticleEmitter.getActiveCount();
    const count = buildActiveListBuffers({
      maxParticles: MAX_PARTICLES,
      active: components.active,
      localIndices: activeIndices,
      activeData: null,
      expectedActive,
    });
    const { stampedCount } = updateParticlePhysicsBuffers({
      activeIndices,
      count,
      deltaTime: DT,
      dtRatio: DT_RATIO,
      decalsEnabled: true,
      particlesToStamp: stampScratch,
      components,
    });
    totalStamped += stampedCount;
    for (let s = 0; s < stampedCount; s++) {
      ParticleEmitter.returnToPool(stampScratch[s]);
    }
  }

  for (const i of catA) {
    check(components.active[i] === 1, `catA[${i}] flat survivor should still be active`);
  }
  let sumX = 0;
  let sumY = 0;
  for (const i of catA) {
    sumX += components.x[i];
    sumY += components.y[i];
  }
  check(sumX === CNT * 3 * CORRECTNESS_STEPS, `catA sumX ${sumX} !== ${CNT * 3 * CORRECTNESS_STEPS} (exact flat-integrate checksum)`);
  check(sumY === CNT * 5 * CORRECTNESS_STEPS, `catA sumY ${sumY} !== ${CNT * 5 * CORRECTNESS_STEPS} (exact flat-integrate checksum)`);

  for (const i of catB) check(components.active[i] === 0, `catB[${i}] should have despawned on ground contact`);
  for (const i of catC) check(components.active[i] === 0, `catC[${i}] should have despawned after stamping`);
  for (const i of catD) check(components.active[i] === 0, `catD[${i}] should have despawned after fade-out`);
  for (const i of catE) check(components.active[i] === 0, `catE[${i}] should have despawned by lifetime`);

  check(totalStamped === CNT, `totalStamped ${totalStamped} !== ${CNT} (each stayOnTheFloor particle stamps exactly once)`);

  despawnIndices([...catA, ...catB, ...catC, ...catD, ...catE]);
  check(ParticleEmitter.getFreeCount() === MAX_PARTICLES, 'pool should be fully free after correctness recycle');
}

if (mismatches > 0) {
  console.error(`CORRECTNESS: FAILED (${mismatches} issues)`);
  process.exit(1);
}
console.log(`CORRECTNESS: OK (flat checksum + ground/stamp/fade/lifetime despawn round-trip, ${MAX_PARTICLES} particles)`);
console.log(`config: maxParticles=${MAX_PARTICLES} steps=${STEPS} seed=${SEED}`);

// ============================================================================
// TIMING
// ============================================================================
const PARTICLES_PER_CASE = Math.min(2048, MAX_PARTICLES);
const cases = {};

function resetLife(indices) {
  for (const i of indices) components.currentLife[i] = 0;
}

// --- flat_N: pure XY integration, no ground/floor branches ever taken ---
{
  const N = PARTICLES_PER_CASE;
  const indices = spawnDirect(N, {
    flat: true,
    x0: 0,
    y0: 0,
    vx0: 0, // overwritten per-particle below for variety
    vy0: 0,
    lifespan: 65535,
  });
  for (const i of indices) {
    components.vx[i] = (rng() - 0.5) * 80;
    components.vy[i] = (rng() - 0.5) * 80;
  }
  const activeIndices = new Uint16Array(indices);

  cases.flat_N = timeIt(
    `flat_N physics (${N} particles/step)`,
    (steps) => {
      resetLife(indices);
      for (let s = 0; s < steps; s++) {
        updateParticlePhysicsBuffers({
          activeIndices,
          count: N,
          deltaTime: DT,
          dtRatio: DT_RATIO,
          decalsEnabled: false,
          particlesToStamp: null,
          components,
        });
      }
    },
    { iterations: STEPS }
  );

  despawnIndices(indices);
}

// --- heighted_N: airborne the whole run (deep z start) — falling branch dominated ---
{
  const N = PARTICLES_PER_CASE;
  const indices = spawnDirect(N, {
    flat: false,
    x0: 0,
    y0: 0,
    vx0: 0,
    vy0: 0,
    z0: 0,
    vz0: 0,
    gravity: 0,
    lifespan: 65535,
  });
  for (const i of indices) {
    components.x[i] = (rng() - 0.5) * 800;
    components.y[i] = (rng() - 0.5) * 600;
    components.z[i] = -500 - rng() * 1500;
    components.vx[i] = (rng() - 0.5) * 40;
    components.vy[i] = (rng() - 0.5) * 40;
    components.vz[i] = (rng() - 0.5) * 10;
    components.gravity[i] = 0.1 + rng() * 0.2;
  }
  const activeIndices = new Uint16Array(indices);

  cases.heighted_N = timeIt(
    `heighted_N physics (${N} particles/step, airborne)`,
    (steps) => {
      resetLife(indices);
      for (let s = 0; s < steps; s++) {
        updateParticlePhysicsBuffers({
          activeIndices,
          count: N,
          deltaTime: DT,
          dtRatio: DT_RATIO,
          decalsEnabled: false,
          particlesToStamp: null,
          components,
        });
      }
    },
    { iterations: STEPS }
  );

  despawnIndices(indices);
}

// --- mixed: 50/50 flat + heighted in one activeIndices batch ---
{
  const N = PARTICLES_PER_CASE;
  const half = N >> 1;
  const flatIndices = spawnDirect(half, { flat: true, x0: 0, y0: 0, vx0: 0, vy0: 0, lifespan: 65535 });
  const heightedIndices = spawnDirect(N - half, {
    flat: false,
    x0: 0,
    y0: 0,
    vx0: 0,
    vy0: 0,
    z0: 0,
    vz0: 0,
    gravity: 0,
    lifespan: 65535,
  });
  for (const i of flatIndices) {
    components.vx[i] = (rng() - 0.5) * 80;
    components.vy[i] = (rng() - 0.5) * 80;
  }
  for (const i of heightedIndices) {
    components.x[i] = (rng() - 0.5) * 800;
    components.y[i] = (rng() - 0.5) * 600;
    components.z[i] = -500 - rng() * 1500;
    components.vx[i] = (rng() - 0.5) * 40;
    components.vy[i] = (rng() - 0.5) * 40;
    components.vz[i] = (rng() - 0.5) * 10;
    components.gravity[i] = 0.1 + rng() * 0.2;
  }
  const allIndices = [...flatIndices, ...heightedIndices];
  const activeIndices = new Uint16Array(allIndices);
  const totalN = allIndices.length;

  cases.mixed = timeIt(
    `mixed physics (${totalN} particles/step, 50% flat)`,
    (steps) => {
      resetLife(allIndices);
      for (let s = 0; s < steps; s++) {
        updateParticlePhysicsBuffers({
          activeIndices,
          count: totalN,
          deltaTime: DT,
          dtRatio: DT_RATIO,
          decalsEnabled: false,
          particlesToStamp: null,
          components,
        });
      }
    },
    { iterations: STEPS }
  );

  despawnIndices(allIndices);
}

// --- build_lists_N: active-list scan cost alone (no physics), ~30% of the pool active ---
{
  const localIndices = new Uint16Array(MAX_PARTICLES);
  const activeArr = components.active;
  activeArr.fill(0);
  let targetActive = 0;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (rng() < 0.3) {
      activeArr[i] = 1;
      targetActive++;
    }
  }

  cases.build_lists_N = timeIt(
    `buildActiveListBuffers (${MAX_PARTICLES} maxParticles, ~${targetActive} active)`,
    (iters) => {
      for (let n = 0; n < iters; n++) {
        buildActiveListBuffers({
          maxParticles: MAX_PARTICLES,
          active: activeArr,
          localIndices,
          activeData: null,
          expectedActive: targetActive,
        });
      }
    },
    { iterations: STEPS }
  );

  // Also exercise the camera-fused variant once so it's known to run cleanly (not separately timed).
  const isItOnScreen = ParticleComponent.isItOnScreen;
  buildActiveAndVisibleListBuffers({
    maxParticles: MAX_PARTICLES,
    active: activeArr,
    x: components.x,
    y: components.y,
    isItOnScreen,
    localIndices,
    activeData: null,
    visibleData: null,
    expectedActive: targetActive,
    camZoom: 1,
    camOffX: 0,
    camOffY: 0,
    camMinX: -1e6,
    camMaxX: 1e6,
    camMinY: -1e6,
    camMaxY: 1e6,
  });

  activeArr.fill(0);
}

if (OUTPUT) {
  const caseSummary = {};
  for (const [key, result] of Object.entries(cases)) {
    caseSummary[key] = {
      ms: result.ms,
      opsPerSec: result.opsPerSec, // steps/sec (each step processes the case's whole particle set)
      iterations: result.iterations,
    };
  }
  writeReport(OUTPUT, {
    feature: 'particle-integrate',
    layer: 'L1',
    seed: SEED,
    maxParticles: MAX_PARTICLES,
    particlesPerCase: PARTICLES_PER_CASE,
    steps: STEPS,
    cases: caseSummary,
  });
}
