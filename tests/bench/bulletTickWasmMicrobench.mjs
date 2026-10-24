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
 */
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
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

const ARGS = parseArgs();
const POOL = 40000;
const WORLD_W = 4000;
const WORLD_H = 3000;
const WALL = 48;
const INTERIOR = 240;
const SPEED = 1500;
const IMPACTS = 256;

const CASES = {
  storm: { live: POOL },
  sparse: { live: 4000 },
};

export async function setupBulletKernel(caseName, seed = 0xb011e7, kernel = 'bullet_tick') {
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
  BulletPool.returnToPool = () => {
    returnedCount++;
  };
  const activeJs = new Uint16Array(POOL + 1);
  const header = new Int32Array(2);
  const impactsJs = new Float32Array(IMPACTS * 6);
  const k = await bindBullets(w, kernel);
  const dt = 1 / 60;

  /** One tick of the first `bullets` slots from the starting bytes; returns the bullets left. */
  const js = (bullets = POOL) => {
    restore();
    BulletPool.maxCount = bullets;
    BulletPool.tick(1, activeJs, header, impactsJs, IMPACTS);
    BulletPool.maxCount = POOL;
    return activeJs[0];
  };
  const wasm = (bullets = POOL) => {
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

async function main() {
  const variant = String(ARGS.variant || 'js');
  if (variant !== 'js' && !KERNELS[variant]) throw new Error(`unknown variant ${variant}`);
  const cases = {};
  let checksum = 2166136261;
  let tier = null;
  for (const name of Object.keys(CASES)) {
    const s = await setupBulletKernel(name, undefined, KERNELS[variant]);
    const run = variant === 'js' ? s.js : s.wasm;
    s.resetReturned();
    const left = run();
    checksum = Math.imul(checksum ^ s.hash(variant), 16777619) >>> 0;
    // Normal compiles, not OSR: short calls over the first 64 slots.
    if (variant !== 'js') tier = await warmWasm(s.k.tick, () => run(64));
    else warmNormalCompile(() => run(64));
    cases[name] = timeIt(`bullet tick ${variant} ${name} (${CASES[name].live} live, ${left} left)`, () => run(), { iterations: 10, warmup: 3 });
    cases[name].left = left;
  }
  const report = {
    feature: 'bullet-tick-wasm',
    variant,
    functions: ['BulletPool.tick', 'Ray.linecastDir', `bulletTick.${KERNELS[variant] || 'bullet_tick'}`],
    pool: POOL,
    seed: 0xb011e7,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (ARGS.output) writeReport(String(ARGS.output), report);
  else {
    console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''}`);
    for (const [name, c] of Object.entries(cases)) console.log(`  ${name}: ${c.opsPerSec.toFixed(1)} ops/s (${c.left} left)`);
  }
}

if (isCli(import.meta.url)) await main();
