// L1: ExtractParticles wall-clock. Current C is O(k·n) RotateBuffer per index.
//
// Usage:
//   node tests/bench/liquidFunExtractMicrobench.mjs
//   node tests/bench/liquidFunExtractMicrobench.mjs --k 512 --output tests/results/liquidfun-extract-micro.json
//   [--warmup-ms 1500] (time-based warm-up before each k, N-226)

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm } from './wasmLfBenchLib.mjs';
import { upperMedian } from './benchMath.js';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const KS = args.k != null ? [Number(args.k)] : [64, 512, 1024];
const REPS = Number(args.reps ?? 9);
const WARMUP = Number(args.warmup ?? 2);
// N-226: each sample is one extract on a fresh particle system, so two warm-up calls left the extract's WASM in Liftoff (V8 tiers a
// function up after enough of its own work, call by call): --no-liftoff read 2.8x faster at k=64 and 1.8x at k=1024 on
// the ASUS. The warm-up runs for this long first (and at least WARMUP calls), so the timed calls run TurboFan code.
const WARMUP_MS = Number(args['warmup-ms'] ?? 1500);
const OUTPUT = args.output ? String(args.output) : null;
const LF_RIGID = 1 << 1;

// One world for the process: the module has no world destroy, and N-226's warm-up makes more samples than its worlds.
let worldId = 0;

function timeExtract(fn, memory, k) {
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const destroyParticleSystem = fn('destroy_particle_system');
  const getParticleCount = fn('get_particle_count');
  const getCount = fn('get_particle_group_particle_count');
  const getFirst = fn('get_particle_group_first_index');
  const getIdxOff = fn('get_extract_indices_byte_offset');
  const extractParticles = fn('extract_particles');

  if (!worldId) {
    worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
    if (!worldId) throw new Error('create_world failed');
    if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');
  }
  if (!createParticleSystem(worldId, RADIUS, 1.0, 6000, 0)) throw new Error('create_particle_system failed');

  const gid = createParticleGroupBox(-500, -500, 500, 500, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_RIGID);
  if (gid < 0) throw new Error(`group ${gid}`);
  const n = getParticleCount();
  const nGroup = getCount(gid);
  if (nGroup <= k) throw new Error(`group too small: ${nGroup} need > ${k}`);

  const first = getFirst(gid);
  const idx = new Int32Array(memory.buffer, getIdxOff(), 4096);
  // Middle slice so rotate work is not the cheap "front" case.
  const start = first + (((nGroup - k) / 2) | 0);
  for (let i = 0; i < k; i++) idx[i] = start + i;

  const t0 = performance.now();
  const newId = extractParticles(gid, k, 0, 1);
  const elapsedMs = performance.now() - t0;
  if (newId < 0) throw new Error(`extract failed ${newId}`);

  destroyParticleSystem();
  return { elapsedMs, n, nGroup, k };
}

const { fn, memory } = instantiateBox2dWasm();
const report = { bench: 'liquidfun-extract-microbench', radius: RADIUS, reps: REPS, ks: {} };

for (const k of KS) {
  const warmUntil = performance.now() + WARMUP_MS;
  for (let i = 0; i < WARMUP || performance.now() < warmUntil; i++) timeExtract(fn, memory, k);
  const samples = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const row = timeExtract(fn, memory, k);
    samples.push(row.elapsedMs);
    last = row;
  }
  const med = upperMedian(samples);
  report.ks[k] = {
    k,
    nGroup: last.nGroup,
    medianMs: med,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples.slice().sort((a, b) => a - b),
  };
  console.log(
    `extract k=${k} from ${last.nGroup}: median ${med.toFixed(3)} ms ` +
      `(min ${Math.min(...samples).toFixed(3)}, max ${Math.max(...samples).toFixed(3)}, n=${REPS})`,
  );
}

if (OUTPUT) writeReport(OUTPUT, report);
