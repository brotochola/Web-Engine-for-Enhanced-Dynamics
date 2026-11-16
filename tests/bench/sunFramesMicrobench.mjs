/**
 * E-368: pre-render's computeSunFramesInto (DX-SHADOW3D), the frame each directional caster shows the sun, on columns
 * shaped as Predator crowd 2.5's: 57 633 slots, 38 000 directional casters of six LPC sheets (four directions, three
 * groups, eight frames an animation), 9 000 other entities, the rest free. A frame of the kernel is one call, as
 * pre-render makes once a frame; between calls a share of the casters turns and walks a frame (`--change`, default 0.25),
 * and the sun's turn moves every `--turnEvery` calls (default 600: about ten seconds at 60).
 *
 *   node tests/bench/sunFramesMicrobench.mjs [--slots 57633] [--casters 38000] [--change 0.25] [--reps 7] [--output f]
 *     [--path slots|keyed]
 *
 * --path keyed: the keyed rows' pass as a frame runs it: a render queue (the casters, the other sprites, some glows, in a
 * shuffled order) whose keyed rows the pack wrote (their frame float zeroed before each call, as the pack does), and the
 * frames put into them: computeSunFramesInto then applyKeyedSunFramesInto, or E-368's fused pass when the module has it
 * (prepareSunFrames, applyKeyedSunFramesFor). The checksum is the rows'.
 *
 * Calls the shipped function (preRenderWorker.js export), checksums what it writes (the sum of the out column), warms up
 * through short calls so the timed code is a normal compile.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { GPU_KEYED_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, checksumInts, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker } from './workerHarness.mjs';

const SHEETS = 6;
const DIRS = 4;
const GROUPS = ['walk', 'idle', 'shoot'];
const FRAMES = 8;

/** The scene's direction tables, as Scene sends them (by sheet id, from 1). */
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

/** proxyToGlobalAnim as the worker receives it (a cloned object, numeric keys), and the frame tables (plain arrays). */
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

export async function setup({ slots = 57633, casters = 38000, others = 9000, change = 0.25, turnEvery = 600, seed = 0x5e11, path: mode = 'slots' } = {}) {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const mod = await import(pathToFileURL(path.resolve('src/workers/preRenderWorker.js')).href);
  const { computeSunFramesInto, sunFrameTables, applyKeyedSunFramesInto, prepareSunFrames, applyKeyedSunFramesFor } = mod;
  const rng = mulberry32(seed);
  const tables = sunFrameTables(directionTables());
  const { proxy, starts, counts } = animationTables();
  const active = new Uint8Array(slots);
  const modeCol = new Uint8Array(slots);
  const casts = new Uint8Array(slots);
  const sheets = new Uint8Array(slots);
  const dirs = new Uint8Array(slots);
  const anims = new Uint8Array(slots);
  const frames = new Uint16Array(slots);
  const orients = new Uint8Array(slots);
  // Directional casters and others spread over the slots, as pools of several types fill them.
  const order = Array.from({ length: slots }, (_, k) => k);
  for (let k = slots - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const t = order[k];
    order[k] = order[j];
    order[j] = t;
  }
  const directional = new Int32Array(casters);
  for (let k = 0; k < casters + others && k < slots; k++) {
    const e = order[k];
    active[e] = 1;
    if (k < casters) {
      directional[k] = e;
      modeCol[e] = 1;
      casts[e] = 1;
      sheets[e] = 1 + Math.floor(rng() * SHEETS);
      dirs[e] = Math.floor(rng() * DIRS);
      anims[e] = Math.floor(rng() * GROUPS.length);
      frames[e] = Math.floor(rng() * FRAMES);
    } else {
      sheets[e] = 1 + Math.floor(rng() * SHEETS);
    }
  }
  const out = new Int32Array(slots);
  const shift = new Int16Array(256);
  const shiftTurn = new Float64Array(256).fill(Number.NaN);
  let call = 0;
  let turn = -Math.PI / 2 - Math.atan2(0.6, -0.8);
  const moving = Math.round(casters * change);
  let cursor = 0;
  // --path keyed: the queue rows (casters with a shadow height, other sprites without, a glow now and then), shuffled.
  const glows = 500;
  const count = casters + others + glows;
  const qType = new Uint8Array(count);
  const shadowH = new Float32Array(count);
  const types = new Uint8Array(count);
  const entities = new Int32Array(count);
  const rowOrder = Array.from({ length: count }, (_, k) => k);
  for (let k = count - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    const t = rowOrder[k];
    rowOrder[k] = rowOrder[j];
    rowOrder[j] = t;
  }
  for (let k = 0; k < count; k++) {
    const i = rowOrder[k];
    if (k < casters) {
      entities[i] = directional[k];
      shadowH[i] = 20 + rng() * 20;
    } else if (k < casters + others) {
      entities[i] = order[k];
    } else {
      qType[i] = 3;
      shadowH[i] = 10;
    }
  }
  const keyedN = casters;
  const rows = new Float32Array(keyedN * GPU_KEYED_CASTER_FLOATS);
  const fused = mode === 'keyed' && typeof applyKeyedSunFramesFor === 'function';
  /** One frame: some casters walk a frame or turn, the sun now and then, then the call. */
  const frame = () => {
    for (let k = 0; k < moving; k++) {
      const e = directional[cursor];
      cursor = cursor + 1 === casters ? 0 : cursor + 1;
      frames[e] = (frames[e] + 1) % FRAMES;
      if ((k & 15) === 0) dirs[e] = (dirs[e] + 1) % DIRS;
    }
    if (++call % turnEvery === 0) turn += 0.01;
    if (mode !== 'keyed') {
      computeSunFramesInto(out, slots, active, modeCol, casts, sheets, dirs, anims, frames, tables, proxy, starts, counts,
        shift, shiftTurn, turn, orients);
      return;
    }
    // The pack wrote each keyed row with 0 in its frame float.
    for (let k = 0; k < keyedN; k++) rows[k * GPU_KEYED_CASTER_FLOATS + 3] = 0;
    if (fused) {
      prepareSunFrames(tables, proxy, starts, counts, shift, shiftTurn, turn);
      applyKeyedSunFramesFor(rows, keyedN, count, qType, shadowH, types, entities, active, modeCol, casts, sheets, dirs,
        anims, frames, tables, shift, orients);
    } else {
      computeSunFramesInto(out, slots, active, modeCol, casts, sheets, dirs, anims, frames, tables, proxy, starts, counts,
        shift, shiftTurn, turn, orients);
      applyKeyedSunFramesInto(rows, keyedN, count, qType, shadowH, types, entities, out);
    }
  };
  const checksum = () => (mode === 'keyed' ? checksumFloats(rows) : checksumInts(out));
  return { frame, checksum, slots, casters, out, fused };
}

export async function run(opts = {}) {
  const s = await setup(opts);
  // A fixed sequence: the same calls from the same state checksum the same.
  warmNormalCompile(s.frame, opts.warm ?? 400);
  const before = s.checksum();
  const what = opts.path === 'keyed' ? (s.fused ? 'keyed rows, fused (E-368)' : 'keyed rows: computeSunFramesInto + applyKeyedSunFramesInto') : 'computeSunFramesInto';
  const timed = timeIt(`${what} (${s.slots} slots, ${s.casters} directional casters)`, s.frame, {
    iterations: 50,
    warmup: 10,
    reps: opts.reps ?? 7,
  });
  return { timed, checksumAfterWarm: before, checksum: s.checksum() };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const result = await run({
    slots: args.slots,
    casters: args.casters,
    change: args.change,
    turnEvery: args.turnEvery,
    reps: args.reps,
    path: args.path,
  });
  console.log(`checksum after warm-up ${result.checksumAfterWarm}, after timing ${result.checksum}`);
  if (args.output) writeReport(args.output, { kernel: 'sunFrames', ...result });
}
