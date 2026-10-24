#!/usr/bin/env node
/**
 * Kernel (E-76 W19): the bullet tick in WASM (wasm/bulletTick.c) against the shipped BulletPool.tick with its
 * Ray.linecastDir, on bulletStressScene's world: 4000 × 3000 px, cells of 128, 240 circles and boxes inside four
 * walls, every column in one shared memory (bulletTickKernel.mjs). Each run starts the pool from the same bytes.
 *
 *   storm    40 000 live bullets at 1500 px/s, one frame (the scene's pool, full)
 *   sparse   4 000 live bullets in the same pool of 40 000 (the walk over idle slots)
 *
 *   js            BulletPool.tick
 *   wasm          bullet_tick, then the JS's returnToPool over the returned slots
 *   wasm_hoist    the same with the box test's reciprocals once per ray
 *   wasm_nostamp  without the stamps that skip an entity a ray already tested
 *   wasm_lean     both
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/bulletTickWasmMicrobench.mjs --variants js,wasm,wasm_hoist,wasm_nostamp,wasm_lean --rounds 5
 *   node tests/bench/bulletTickWasmMicrobench.mjs --variant wasm [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/bulletTickWasmMicrobench.mjs [--args '{"variants":["js","wasm","wasm_lean"]}']
 */
import { mulberry32 } from './benchMath.js';
import { bindBullets, bulletWorld } from './bulletTickKernel.mjs';
import { BulletPool } from '../../src/core/bulletPool.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { Grid } from '../../src/core/grid.js';
import { readyBulletStamps, writeBulletColumns } from '../../src/core/bulletTickClient.js';

/** Bench variant name → the kernel's export. */
const KERNELS = {
  wasm: 'bullet_tick',
  wasm_hoist: 'bullet_tick_hoist',
  wasm_nostamp: 'bullet_tick_nostamp',
  wasm_lean: 'bullet_tick_lean',
};
const SIDES = ['js', ...Object.keys(KERNELS)];

const POOL = 40000;
const WORLD_W = 4000;
const WORLD_H = 3000;
const WALL = 48;
const INTERIOR = 240;
const SPEED = 1500;
const IMPACTS = 256;
const SEED = 0xb011e7;

const CASES = {
  storm: { live: POOL },
  sparse: { live: 4000 },
};

export async function setupBulletKernel(caseName, seed = SEED, kernel = 'bullet_tick') {
  const c = CASES[caseName];
  const size = { bullets: POOL, entities: INTERIOR + 4, cols: 32, rows: 24, cellSize: 128, perCell: 96, impacts: IMPACTS };
  const w = bulletWorld(size);
  const v = w.views;
  const rng = mulberry32(seed);
  const box = (e, x, y, wd, ht) => {
    v.tActive[e] = 1;
    v.tX[e] = x;
    v.tY[e] = y;
    v.tRotC[e] = 1;
    v.tRotS[e] = 0;
    v.cActive[e] = 1;
    v.cShape[e] = 0;
    v.cWidth[e] = wd;
    v.cHeight[e] = ht;
    w.insert(e, x, y, wd * 0.5, ht * 0.5);
  };
  // The walls' boxes span the world: inserted in every cell along each edge, as their AABBs are.
  box(0, WORLD_W * 0.5, WALL * 0.5, WORLD_W, WALL);
  box(1, WORLD_W * 0.5, WORLD_H - WALL * 0.5, WORLD_W, WALL);
  box(2, WALL * 0.5, WORLD_H * 0.5, WALL, WORLD_H);
  box(3, WORLD_W - WALL * 0.5, WORLD_H * 0.5, WALL, WORLD_H);
  const inner = WALL * 2;
  for (let k = 0; k < INTERIOR; k++) {
    const e = 4 + k;
    const x = inner + rng() * (WORLD_W - 2 * inner);
    const y = inner + rng() * (WORLD_H - 2 * inner);
    if (rng() >= 0.7) {
      box(e, x, y, 12 + rng() * 28, 8 + rng() * 28);
    } else {
      v.tActive[e] = 1;
      v.tX[e] = x;
      v.tY[e] = y;
      v.tRotC[e] = 1;
      v.tRotS[e] = 0;
      v.cActive[e] = 1;
      v.cShape[e] = 1;
      v.cRadius[e] = 6 + rng() * 18;
      w.insert(e, x, y, v.cRadius[e]);
    }
  }
  for (let i = 0; i < POOL; i++) {
    const a = rng() * Math.PI * 2;
    v.bActive[i] = i < c.live ? 1 : 0;
    v.bX[i] = inner + rng() * (WORLD_W - 2 * inner);
    v.bY[i] = inner + rng() * (WORLD_H - 2 * inner);
    v.bRotC[i] = Math.cos(a);
    v.bRotS[i] = Math.sin(a);
    v.bVx[i] = v.bRotC[i] * SPEED;
    v.bVy[i] = v.bRotS[i] * SPEED;
    v.bSpeed[i] = SPEED;
    v.bDamage[i] = 1;
    v.bOwner[i] = 4 + (i % 8);
  }
  const start = ['bActive', 'bX', 'bY', 'bPrevX', 'bPrevY'].map((k) => [v[k], v[k].slice()]);
  const restore = () => {
    for (const [a, s] of start) a.set(s);
  };
  let returnedCount = 0;
  const countReturn = () => {
    returnedCount++;
  };
  const activeJs = new Uint16Array(POOL + 1);
  const header = new Int32Array(2);
  const impactsJs = new Float32Array(IMPACTS * 6);
  const k = await bindBullets(w, kernel);
  const dt = 1 / 60;

  // Several worlds share the components' statics (Chrome runs every variant in one page): each run binds its own.
  /** One tick of the first `bullets` slots from the starting bytes; returns the bullets left. */
  const js = (bullets = POOL) => {
    w.bind();
    BulletPool.returnToPool = countReturn;
    restore();
    BulletPool.maxCount = bullets;
    BulletPool.tick(1, activeJs, header, impactsJs, IMPACTS);
    BulletPool.maxCount = POOL;
    return activeJs[0];
  };
  const wasm = (bullets = POOL) => {
    w.bind();
    BulletPool.returnToPool = countReturn;
    restore();
    if (!writeBulletColumns(k, BulletComponent, Transform, Collider, v.activeOut, v.impacts, Grid)) {
      throw new Error('a column is not in the memory');
    }
    const res = k.results;
    res[0] = 1;
    res[1] = 0;
    res[2] = IMPACTS;
    res[3] = 0;
    readyBulletStamps(k, bullets);
    k.tick(k.tableByte, 0, bullets, dt, Grid.invCellSize, Grid.cellSize, Grid.gridWidth, Grid.gridHeight,
      Grid.cellByteSize, -1);
    const back = res[3];
    const returned = k.returned;
    for (let n = 0; n < back; n++) BulletPool.returnToPool(returned[n]);
    v.activeOut[0] = res[0] - 1;
    return v.activeOut[0];
  };
  const hash = (variant) => {
    let x = 2166136261;
    const kernelRun = variant !== 'js';
    const list = kernelRun ? v.activeOut : activeJs;
    const impacts = kernelRun ? v.impacts : impactsJs;
    const nImpacts = kernelRun ? k.results[1] : header[0];
    const parts = [v.bActive, v.bX, v.bY, v.bPrevX, v.bPrevY, list.subarray(0, list[0] + 1), impacts.subarray(0, nImpacts * 6)];
    for (const a of parts) {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.length * a.BYTES_PER_ELEMENT);
      for (let i = 0; i < bytes.length; i++) x = Math.imul(x ^ bytes[i], 16777619) >>> 0;
    }
    return Math.imul(x ^ returnedCount, 16777619) >>> 0;
  };
  return { k, js, wasm, hash, resetReturned: () => { returnedCount = 0; } };
}

// ---- Chrome: every variant in one page, alternating ----

function timeOps(op, iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) op();
  return (iterations / (performance.now() - t0)) * 1000;
}

function calibrate(op, minMs) {
  let n = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) op();
    const ms = performance.now() - t0;
    if (ms >= minMs) return n;
    n = Math.max(n + 1, Math.ceil((n * minMs * 1.2) / Math.max(ms, 0.01)));
  }
}

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** chromeKernel.mjs entry. */
export async function run(args = {}) {
  const cases = args.cases || Object.keys(CASES);
  const sides = args.variants || SIDES;
  const rounds = Number(args.rounds ?? 7);
  const minMs = Number(args.minMs ?? 40);
  const all = {};
  const checksums = {};
  for (const s of sides) {
    all[s] = {};
    checksums[s] = 2166136261;
    for (const c of cases) {
      const b = await setupBulletKernel(c, SEED, KERNELS[s]);
      const op = s === 'js' ? b.js : b.wasm;
      b.resetReturned();
      op();
      checksums[s] = Math.imul(checksums[s] ^ b.hash(s), 16777619) >>> 0;
      // Normal compiles, not OSR: short calls over the first 64 slots.
      for (let i = 0; i < 3000; i++) op(64);
      all[s][c] = op;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const iterations = {};
  for (const s of sides) {
    iterations[s] = {};
    for (const c of cases) iterations[s][c] = calibrate(() => all[s][c](), minMs);
  }
  const samples = Object.fromEntries(cases.map((c) => [c, Object.fromEntries(sides.map((s) => [s, []]))]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? sides : [...sides].reverse();
    for (const s of order) for (const c of cases) samples[c][s].push(timeOps(() => all[s][c](), iterations[s][c]));
  }
  const base = sides[0];
  const result = {};
  for (const c of cases) {
    result[c] = {};
    const baseMed = medianOf(samples[c][base]);
    for (const s of sides) {
      const med = medianOf(samples[c][s]);
      let wins = 0;
      for (let r = 0; r < rounds; r++) if (samples[c][s][r] > samples[c][base][r]) wins++;
      result[c][s] = {
        opsPerSec: med,
        deltaPct: ((med - baseMed) / baseMed) * 100,
        pairedWins: s === base ? null : wins,
        samples: samples[c][s],
      };
    }
  }
  return {
    feature: 'bullet-tick-wasm',
    seed: SEED,
    rounds,
    minMs,
    checksums,
    checksumsOk: sides.every((s) => checksums[s] === checksums[base]),
    cases: result,
  };
}

// ---- Node: one variant per process ----

if (typeof process !== 'undefined' && process.versions?.node) {
  const { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } = await import('./microbenchHelpers.mjs');
  if (isCli(import.meta.url)) {
    const { machineState, warmWasm } = await import('./wasmKernelHelpers.mjs');
    const args = parseArgs();
    const variant = String(args.variant || 'js');
    if (variant !== 'js' && !KERNELS[variant]) throw new Error(`unknown variant ${variant}`);
    const cases = {};
    let checksum = 2166136261;
    let tier = null;
    for (const name of Object.keys(CASES)) {
      const s = await setupBulletKernel(name, SEED, KERNELS[variant]);
      const op = variant === 'js' ? s.js : s.wasm;
      s.resetReturned();
      const left = op();
      checksum = Math.imul(checksum ^ s.hash(variant), 16777619) >>> 0;
      // Normal compiles, not OSR: short calls over the first 64 slots.
      if (variant !== 'js') tier = await warmWasm(s.k.tick, () => op(64));
      else warmNormalCompile(() => op(64));
      cases[name] = timeIt(`bullet tick ${variant} ${name} (${CASES[name].live} live, ${left} left)`, () => op(), { iterations: 10, warmup: 3 });
      cases[name].left = left;
    }
    const report = {
      feature: 'bullet-tick-wasm',
      variant,
      functions: ['BulletPool.tick', 'Ray.linecastDir', `bulletTick.${KERNELS[variant] || 'bullet_tick'}`],
      pool: POOL,
      seed: SEED,
      checksum,
      wasmTier: tier,
      machine: machineState(),
      cases,
    };
    if (args.output) writeReport(String(args.output), report);
    else {
      console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''}`);
      for (const [name, c] of Object.entries(cases)) console.log(`  ${name}: ${c.opsPerSec.toFixed(1)} ops/s (${c.left} left)`);
    }
  }
}
