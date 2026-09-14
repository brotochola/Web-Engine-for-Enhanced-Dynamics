// Microbenchmark + correctness check for ParticleEmitter.js (L1 isolated).
//
// Sets up ParticleComponent SoA + ParticleEmitter free list in-process (no workers),
// then times burst-spawn hot paths and the raw free-list acquire/release.
// Every burst is fully recycled (deactivated + returned to the pool) before the next
// one so the pool never exhausts mid-benchmark, matching real gameplay recycling.
//
// Usage:
//   node tests/bench/particle-emit-microbench.mjs
//   node tests/bench/particle-emit-microbench.mjs --particles 4096 --bursts 2000 --burst-size 256 --output tests/results/particle-emit-micro.json

import { ParticleComponent } from '../../src/components/ParticleComponent.js';
import { ParticleEmitter } from '../../src/core/ParticleEmitter.js';
import { seededRandom } from '../../src/core/utils.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const args = parseArgs();
const MAX_PARTICLES = Number(args.particles ?? 4096);
const BURSTS = Number(args.bursts ?? 2000);
const BURST_SIZE = Number(args['burst-size'] ?? 256);
const SEED = Number(args.seed ?? 0xc0ffee);
const OUTPUT = args.output ? String(args.output) : null;

if (BURST_SIZE > MAX_PARTICLES) {
  throw new Error(`--burst-size (${BURST_SIZE}) must be <= --particles (${MAX_PARTICLES})`);
}

// ParticleEmitter._spawn uses core/utils.js rng() -> globalThis.rng (set by AbstractWorker in
// real workers). Seed it here so randomRange() calls are deterministic and quiet in Node.
globalThis.rng = seededRandom(SEED);

// ============================================================================
// SETUP — mirrors what the logic worker does during scene init
// ============================================================================
const bufferSize = ParticleComponent.getBufferSize(MAX_PARTICLES);
ParticleComponent.initializeArrays(new SharedArrayBuffer(bufferSize), MAX_PARTICLES);

ParticleEmitter.initialize(MAX_PARTICLES);
ParticleEmitter.initializeFreeList(
  new SharedArrayBuffer(MAX_PARTICLES * 2), // Uint16Array next-links
  new SharedArrayBuffer(8) // Int32Array[2]: packed head + free count
);
ParticleEmitter.resetFreeListInterleaved();

const active = ParticleComponent.active;
const _acquireScratch = new Uint16Array(BURST_SIZE);

/** Deactivate + return every currently-active particle to the free list. */
function recycleAllActive() {
  let recycled = 0;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (active[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      recycled++;
    }
  }
  return recycled;
}

// ============================================================================
// CORRECTNESS — full-pool spawn / exhaustion / recycle round-trip
// ============================================================================
let mismatches = 0;

function check(cond, msg) {
  if (!cond) {
    mismatches++;
    console.error(`CORRECTNESS: ${msg}`);
  }
}

{
  const spawned = ParticleEmitter.emitFlat({
    count: MAX_PARTICLES,
    x: { min: 0, max: 800 },
    y: { min: 0, max: 600 },
    vx: { min: -40, max: 40 },
    vy: { min: -40, max: 40 },
    lifespan: { min: 400, max: 1200 },
  });
  check(spawned === MAX_PARTICLES, `emitFlat full-pool spawn: got ${spawned}, want ${MAX_PARTICLES}`);
  check(ParticleEmitter.isExhausted(), 'pool should be exhausted after full-pool spawn');

  let activeCount = 0;
  for (let i = 0; i < MAX_PARTICLES; i++) if (active[i]) activeCount++;
  check(activeCount === MAX_PARTICLES, `active count ${activeCount} !== ${MAX_PARTICLES}`);

  const overflow = ParticleEmitter.emitFlat({ count: 1, x: 0, y: 0 });
  check(overflow === 0, `exhausted pool should refuse spawn, got ${overflow}`);

  const recycled = recycleAllActive();
  check(recycled === MAX_PARTICLES, `recycled ${recycled} !== ${MAX_PARTICLES}`);
  check(ParticleEmitter.getFreeCount() === MAX_PARTICLES, 'free count not restored after recycle');
}

// Heighted emit() + emitZenithal() round-trip (also exercises z/vz/gravity fields).
{
  const spawned = ParticleEmitter.emitZenithal({
    count: BURST_SIZE,
    x: { min: 0, max: 800 },
    y: { min: 0, max: 600 },
    z: { min: -200, max: -20 },
    vx: { min: -20, max: 20 },
    vy: { min: -20, max: 20 },
    vz: { min: -5, max: 5 },
    gravity: 0.15,
    lifespan: { min: 600, max: 1500 },
    scale: { min: 0.5, max: 1.5 },
  });
  check(spawned === BURST_SIZE, `emitZenithal burst spawn: got ${spawned}, want ${BURST_SIZE}`);
  const recycled = recycleAllActive();
  check(recycled === BURST_SIZE, `emitZenithal recycle: got ${recycled}, want ${BURST_SIZE}`);
}

if (mismatches > 0) {
  console.error(`CORRECTNESS: FAILED (${mismatches} issues)`);
  process.exit(1);
}
console.log(`CORRECTNESS: OK (full-pool spawn/exhaust/recycle round-trip, ${MAX_PARTICLES} particles)`);
console.log(`config: maxParticles=${MAX_PARTICLES} burstSize=${BURST_SIZE} bursts=${BURSTS} seed=${SEED}`);

// ============================================================================
// TIMING
// ============================================================================
const rng = mulberry32(SEED);
void rng; // reserved for future param jitter; emit's own randomRange already varies fields

const cases = {};
let sink = 0;

cases.emitFlat_burst = timeIt(
  `emitFlat burst (${BURST_SIZE}/burst, recycled)`,
  (iters) => {
    for (let b = 0; b < iters; b++) {
      sink += ParticleEmitter.emitFlat({
        count: BURST_SIZE,
        x: { min: 0, max: 800 },
        y: { min: 0, max: 600 },
        vx: { min: -40, max: 40 },
        vy: { min: -40, max: 40 },
        lifespan: { min: 400, max: 1200 },
        scale: { min: 0.5, max: 1.5 },
        alpha: 1,
      });
      recycleAllActive();
    }
  },
  { iterations: BURSTS }
);

cases.emit_zenithal_burst = timeIt(
  `emitZenithal burst (${BURST_SIZE}/burst, recycled)`,
  (iters) => {
    for (let b = 0; b < iters; b++) {
      sink += ParticleEmitter.emitZenithal({
        count: BURST_SIZE,
        x: { min: 0, max: 800 },
        y: { min: 0, max: 600 },
        z: { min: -200, max: -20 },
        vx: { min: -20, max: 20 },
        vy: { min: -20, max: 20 },
        vz: { min: -5, max: 5 },
        gravity: 0.15,
        lifespan: { min: 600, max: 1500 },
        scale: { min: 0.5, max: 1.5 },
      });
      recycleAllActive();
    }
  },
  { iterations: BURSTS }
);

cases.acquire_only = timeIt(
  `acquireIndex+returnToPool (${BURST_SIZE}/burst, no field writes)`,
  (iters) => {
    for (let b = 0; b < iters; b++) {
      let count = 0;
      for (let i = 0; i < BURST_SIZE; i++) {
        const idx = ParticleEmitter.acquireIndex();
        if (idx < 0) break;
        _acquireScratch[count++] = idx;
      }
      sink += count;
      for (let i = 0; i < count; i++) ParticleEmitter.returnToPool(_acquireScratch[i]);
    }
  },
  { iterations: BURSTS }
);

console.log(`(sink=${sink})`);

if (OUTPUT) {
  const caseSummary = {};
  for (const [key, result] of Object.entries(cases)) {
    caseSummary[key] = {
      ms: result.ms,
      opsPerSec: result.opsPerSec, // bursts/sec
      particlesPerSec: result.opsPerSec * BURST_SIZE,
      iterations: result.iterations,
    };
  }
  writeReport(OUTPUT, {
    feature: 'particle-emit',
    layer: 'L1',
    seed: SEED,
    maxParticles: MAX_PARTICLES,
    burstSize: BURST_SIZE,
    bursts: BURSTS,
    cases: caseSummary,
  });
}
