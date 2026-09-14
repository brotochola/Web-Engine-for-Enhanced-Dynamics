// L1: ExtractParticles wall-clock. Current C is O(k·n) RotateBuffer per index.
//
// Usage:
//   node tests/bench/liquidFunExtractMicrobench.mjs
//   node tests/bench/liquidFunExtractMicrobench.mjs --k 512 --output tests/results/liquidfun-extract-micro.json

import { parseArgs, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm, median } from './wasmLfBenchLib.mjs';

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const KS = args.k != null ? [Number(args.k)] : [64, 512, 1024];
const REPS = Number(args.reps ?? 9);
const WARMUP = Number(args.warmup ?? 2);
const OUTPUT = args.output ? String(args.output) : null;
const LF_RIGID = 1 << 1;

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

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');
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
  for (let i = 0; i < WARMUP; i++) timeExtract(fn, memory, k);
  const samples = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const row = timeExtract(fn, memory, k);
    samples.push(row.elapsedMs);
    last = row;
  }
  const med = median(samples);
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
