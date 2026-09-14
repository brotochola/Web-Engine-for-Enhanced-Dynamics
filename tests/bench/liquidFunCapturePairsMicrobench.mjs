// Microbenchmark for liquidfun-c's CapturePairs (L1 isolated, WASM).
//
// CapturePairs only runs once per SPRING/BARRIER group creation - a cold path
// that happens during a scene's create()/warmup, before the integrated L2
// harness's measured window starts. Its O(n^2) vs grid-O(n) difference is
// invisible to `bench:feature:liquidfun`'s steady-state BOX2D_MS by
// construction, so this isolates just the one WASM export call that matters.
//
// Usage:
//   node tests/bench/liquidfun-capturepairs-microbench.mjs
//   node tests/bench/liquidfun-capturepairs-microbench.mjs --group-size 4000 --reps 11 --output tests/results/liquidfun-capturepairs-micro.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeReport } from './microbench-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2d_wasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2d_wasm.js');

const args = parseArgs();
const GROUP_HALF_W = Number(args['half-w'] ?? 800);
const GROUP_HALF_H = Number(args['half-h'] ?? 280);
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 11);
const WARMUP = Number(args.warmup ?? 2);
const OUTPUT = args.output ? String(args.output) : null;
const SPRING = 1 << 6; // lf_springParticle - only flag (with BARRIER) that triggers CapturePairs

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

function timeOneCreate(fn) {
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const destroyParticleSystem = fn('destroy_particle_system');
  const getParticleCount = fn('get_particle_count');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');

  const spacing = 0.75 * (2 * RADIUS);
  const estCount = (Math.floor((2 * GROUP_HALF_W) / spacing) + 1) * (Math.floor((2 * GROUP_HALF_H) / spacing) + 1);
  const sysOk = createParticleSystem(worldId, RADIUS, 1.0, estCount + 64, 0);
  if (!sysOk) throw new Error('create_particle_system failed');

  const t0 = performance.now();
  const gid = createParticleGroupBox(-GROUP_HALF_W, -GROUP_HALF_H, GROUP_HALF_W, GROUP_HALF_H, spacing, SPRING, 0, 0, 0, 1, 0);
  const elapsedMs = performance.now() - t0;
  if (gid < 0) throw new Error(`create_particle_group_box failed: ${gid}`);
  const count = getParticleCount();

  destroyParticleSystem();
  return { elapsedMs, count };
}

const fn = instantiateBox2dWasm();

for (let i = 0; i < WARMUP; i++) {
  timeOneCreate(fn);
}

const samples = [];
let lastCount = 0;
for (let r = 0; r < REPS; r++) {
  const { elapsedMs, count } = timeOneCreate(fn);
  samples.push(elapsedMs);
  lastCount = count;
}
samples.sort((a, b) => a - b);
const median = samples[(samples.length / 2) | 0];
const min = samples[0];
const max = samples[samples.length - 1];

console.log(
  `CapturePairs (SPRING group, ${lastCount} particles): median ${median.toFixed(3)} ms ` +
    `(min ${min.toFixed(3)}, max ${max.toFixed(3)}, n=${REPS})`
);

if (OUTPUT) {
  writeReport(OUTPUT, {
    bench: 'liquidfun-capturepairs-microbench',
    particleCount: lastCount,
    groupHalfW: GROUP_HALF_W,
    groupHalfH: GROUP_HALF_H,
    radius: RADIUS,
    reps: REPS,
    samplesMs: samples,
    medianMs: median,
    minMs: min,
    maxMs: max,
  });
}
