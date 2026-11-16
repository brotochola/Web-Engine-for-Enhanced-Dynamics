/**
 * E-369: pre-render's applyKeyedLampFramesInto (DX-SHADOW3D), the frame each lamp sees of a directional caster in its
 * keyed stamp rows, on rows shaped as Predator crowd 2.5's: 48 shadow-casting lamps, `--stamps` rows (default 20 000;
 * each caster in up to three lamps' reach), the casters of six LPC sheets (four directions, three groups, eight frames).
 * Between calls a share of the casters walk a frame or turn (`--change`, default 0.25).
 *
 *   node tests/bench/lampFramesMicrobench.mjs [--stamps 20000] [--casters 38000] [--change 0.25] [--reps 7] [--output f]
 *
 * Calls the shipped function (preRenderWorker.js export) with the arguments _applyLampFrames hands it; the checksum is the
 * rows' frame floats after a fixed warm-up (two versions that write the same frames checksum the same).
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { GPU_KEYED_STAMP_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker } from './workerHarness.mjs';

const SHEETS = 6;
const DIRS = 4;
const GROUPS = ['walk', 'idle', 'shoot'];
const FRAMES = 8;
const LAMPS = 48;

function directionTables() {
  const out = {};
  for (let s = 1; s <= SHEETS; s++) {
    out[s] = {
      count: DIRS,
      uniform: true,
      start: 0,
      step: Math.PI / 2,
      angles: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
      anim: Array.from({ length: GROUPS.length * DIRS }, (_, k) => k),
      flip: new Array(GROUPS.length * DIRS).fill(0),
      groups: GROUPS,
      solid: false,
    };
  }
  return out;
}

function animationTables() {
  const proxy = {};
  const starts = [];
  const counts = [];
  let offset = 0;
  for (let s = 1; s <= SHEETS; s++) {
    proxy[s] = {};
    for (let local = 0; local < GROUPS.length * DIRS; local++) {
      const global = (s - 1) * GROUPS.length * DIRS + local;
      proxy[s][local] = global;
      starts[global] = offset;
      counts[global] = FRAMES;
      offset += FRAMES;
    }
  }
  return { proxy: JSON.parse(JSON.stringify(proxy)), starts, counts };
}

export async function setup({ stamps = 20000, casters = 38000, change = 0.25, seed = 0x1a4f } = {}) {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const mod = await import(pathToFileURL(path.resolve('src/workers/preRenderWorker.js')).href);
  const { applyKeyedLampFramesInto, sunFrameTables } = mod;
  const rng = mulberry32(seed);
  const tables = sunFrameTables(directionTables());
  const { proxy, starts, counts } = animationTables();
  const slots = casters + 1000;
  const dsActive = new Uint8Array(slots);
  const dsMode = new Uint8Array(slots);
  const sheets = new Uint8Array(slots);
  const dirs = new Uint8Array(slots);
  const anims = new Uint8Array(slots);
  const frames = new Uint16Array(slots);
  for (let e = 0; e < casters; e++) {
    dsActive[e] = 1;
    dsMode[e] = 1;
    sheets[e] = 1 + Math.floor(rng() * SHEETS);
    dirs[e] = Math.floor(rng() * DIRS);
    anims[e] = Math.floor(rng() * GROUPS.length);
    frames[e] = Math.floor(rng() * FRAMES);
  }
  // The lamps, as pre-render's _stampLights records (the same fields, doubles from the start).
  const lights = [];
  for (let i = 0; i < LAMPS; i++) {
    lights.push({
      id: 100000 + i, x: rng() * 3000, y: rng() * 2000, intensity: 1.4, rangeSq: 300 * 300, sqrtI: 1.18, distSq: 0.5,
      maxShadows: 512, coneDirX: NaN, coneDirYW: NaN, coneCos: -2.5, coneInvSpan: 0.5, invG2: 1.8, shade: 1.0,
    });
  }
  // The rows: a caster near its lamp, in the lamps' order (as the stamp lists come).
  const rows = new Float32Array(stamps * GPU_KEYED_STAMP_FLOATS);
  const lightIdx = new Uint8Array(stamps);
  for (let k = 0; k < stamps; k++) {
    const l = Math.floor((k * LAMPS) / stamps);
    const L = lights[l];
    const a = rng() * Math.PI * 2;
    const r = 20 + rng() * 260;
    const at = k * GPU_KEYED_STAMP_FLOATS;
    rows[at] = L.x + Math.cos(a) * r;
    rows[at + 1] = L.y + Math.sin(a) * r * 0.74;
    rows[at + 2] = Math.floor(rng() * casters);
    rows[at + 4] = 30;
    lightIdx[k] = l;
  }
  const invG = 1 / 0.7364;
  const moving = Math.round(casters * change);
  let cursor = 0;
  const frame = () => {
    for (let k = 0; k < moving; k++) {
      const e = cursor;
      cursor = cursor + 1 === casters ? 0 : cursor + 1;
      frames[e] = (frames[e] + 1) % FRAMES;
      if ((k & 15) === 0) dirs[e] = (dirs[e] + 1) % DIRS;
    }
    // The pack wrote each keyed row's frame float as 0.
    for (let k = 0; k < stamps; k++) rows[k * GPU_KEYED_STAMP_FLOATS + 3] = 0;
    applyKeyedLampFramesInto(rows, stamps, lightIdx, lights, invG, tables, proxy, starts, counts, frames, dsActive, dsMode,
      dirs, anims, sheets, null);
  };
  const checksum = () => checksumFloats(rows);
  return { frame, checksum, stamps, casters };
}

export async function run(opts = {}) {
  const s = await setup(opts);
  warmNormalCompile(s.frame, opts.warm ?? 400);
  const before = s.checksum();
  const timed = timeIt(`applyKeyedLampFramesInto (${s.stamps} keyed stamp rows, ${LAMPS} lamps)`, s.frame, {
    iterations: 50,
    warmup: 10,
    reps: opts.reps ?? 7,
  });
  return { timed, checksumAfterWarm: before, checksum: s.checksum() };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const result = await run({ stamps: args.stamps, casters: args.casters, change: args.change, reps: args.reps });
  console.log(`checksum after warm-up ${result.checksumAfterWarm}, after timing ${result.checksum}`);
  if (args.output) writeReport(args.output, { kernel: 'lampFrames', ...result });
}
