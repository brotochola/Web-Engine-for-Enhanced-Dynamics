// Microbenchmark for liquidfun-c's ComputeDepth (L1 isolated, WASM).
//
// ComputeDepth runs once when a SOLID group is created (needsUpdateDepth),
// then the flag clears. Steady-state `bench:feature:liquidfun` never sees that
// spawn-frame spike (same H6 caveat as CapturePairs). This times the first
// step_world after an ice (SOLID|RIGID) create, with a large tracked puddle
// already in the system (demo dulce blob analogue).
//
// Usage:
//   node tests/bench/liquidfun-computedepth-microbench.mjs
//   node tests/bench/liquidfun-computedepth-microbench.mjs --reps 11 --output tests/results/liquidfun-computedepth-micro.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeReport } from './microbench-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2d_wasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2d_wasm.js');

const args = parseArgs();
const PUDDLE_HALF_W = Number(args['puddle-half-w'] ?? 1200);
const PUDDLE_HALF_H = Number(args['puddle-half-h'] ?? 400);
const ICE_HALF_W = Number(args['ice-half-w'] ?? 180);
const ICE_HALF_H = Number(args['ice-half-h'] ?? 100);
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 11);
const WARMUP = Number(args.warmup ?? 2);
const OUTPUT = args.output ? String(args.output) : null;

const VISCOUS = 1 << 2;
const LF_SOLID_GROUP = 1 << 0;
const LF_RIGID_GROUP = 1 << 1;

function parseWasmExportMap(jsSource) {
  const map = Object.create(null);
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(jsSource))) {
    map[m[1]] = m[2];
  }
  return map;
}

function instantiateBox2dWasm() {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const jsSource = fs.readFileSync(JS_PATH, 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      imports[imp.module][imp.name] = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      imports[imp.module][imp.name] = () => 0;
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => {
    const exp = names[name];
    if (!exp || typeof instance.exports[exp] !== 'function') {
      throw new Error(`missing wasm export ${name} (${exp}) - rebuild box2d_wasm.js`);
    }
    return instance.exports[exp];
  };
  return fn;
}

function timeOneIceStep(fn) {
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const destroyParticleSystem = fn('destroy_particle_system');
  const getParticleCount = fn('get_particle_count');
  const setSubSteps = fn('set_particle_sub_steps');
  const stepWorld = fn('step_world');

  const spacing = 0.75 * (2 * RADIUS);
  const puddleEst =
    (Math.floor((2 * PUDDLE_HALF_W) / spacing) + 1) * (Math.floor((2 * PUDDLE_HALF_H) / spacing) + 1);
  const iceEst = (Math.floor((2 * ICE_HALF_W) / spacing) + 1) * (Math.floor((2 * ICE_HALF_H) / spacing) + 1);

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');
  const sysOk = createParticleSystem(worldId, RADIUS, 1.0, puddleEst + iceEst + 64, 0);
  if (!sysOk) throw new Error('create_particle_system failed');
  setSubSteps(1);

  const puddle = createParticleGroupBox(
    -PUDDLE_HALF_W,
    -PUDDLE_HALF_H,
    PUDDLE_HALF_W,
    PUDDLE_HALF_H,
    spacing,
    VISCOUS,
    0.5,
    0,
    0,
    0,
    1,
    1,
    0,
  );
  if (puddle < 0) throw new Error(`puddle create failed: ${puddle}`);
  const puddleCount = getParticleCount();
  stepWorld(worldId, 1 / 60, 1);

  const ice = createParticleGroupBox(
    -ICE_HALF_W,
    -ICE_HALF_H,
    ICE_HALF_W,
    ICE_HALF_H,
    spacing,
    0,
    0.5,
    0,
    0,
    0,
    1,
    1,
    LF_SOLID_GROUP | LF_RIGID_GROUP,
  );
  if (ice < 0) throw new Error(`ice create failed: ${ice}`);
  const totalCount = getParticleCount();
  const iceCount = totalCount - puddleCount;

  const t0 = performance.now();
  stepWorld(worldId, 1 / 60, 1);
  const elapsedMs = performance.now() - t0;

  destroyParticleSystem();
  return { elapsedMs, puddleCount, iceCount, totalCount };
}

const fn = instantiateBox2dWasm();

for (let i = 0; i < WARMUP; i++) {
  timeOneIceStep(fn);
}

const samples = [];
let last = { puddleCount: 0, iceCount: 0, totalCount: 0 };
for (let r = 0; r < REPS; r++) {
  const row = timeOneIceStep(fn);
  samples.push(row.elapsedMs);
  last = row;
}
samples.sort((a, b) => a - b);
const median = samples[(samples.length / 2) | 0];
const min = samples[0];
const max = samples[samples.length - 1];

console.log(
  `ComputeDepth (first step after SOLID ice, puddle=${last.puddleCount} ice=${last.iceCount}): ` +
    `median ${median.toFixed(3)} ms (min ${min.toFixed(3)}, max ${max.toFixed(3)}, n=${REPS})`,
);

if (OUTPUT) {
  writeReport(OUTPUT, {
    bench: 'liquidfun-computedepth-microbench',
    puddleCount: last.puddleCount,
    iceCount: last.iceCount,
    totalCount: last.totalCount,
    puddleHalfW: PUDDLE_HALF_W,
    puddleHalfH: PUDDLE_HALF_H,
    iceHalfW: ICE_HALF_W,
    iceHalfH: ICE_HALF_H,
    radius: RADIUS,
    reps: REPS,
    samplesMs: samples,
    medianMs: median,
    minMs: min,
    maxMs: max,
  });
}
