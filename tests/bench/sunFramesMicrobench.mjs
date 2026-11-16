/**
 * E-368: pre-render's computeSunFramesInto (DX-SHADOW3D), the frame each directional caster shows the sun, on columns
 * shaped as Predator crowd 2.5's: 57 633 slots, 38 000 directional casters of six LPC sheets (four directions, three
 * groups, eight frames an animation), 9 000 other entities, the rest free. A frame of the kernel is one call, as
 * pre-render makes once a frame; between calls a share of the casters turns and walks a frame (`--change`, default 0.25),
 * and the sun's turn moves every `--turnEvery` calls (default 600: about ten seconds at 60).
 *
 *   node tests/bench/sunFramesMicrobench.mjs [--slots 57633] [--casters 38000] [--change 0.25] [--reps 7] [--output f]
 *     [--path slots|keyed|scan]
 *
 * --path keyed: the keyed rows' pass as a frame runs it: a render queue (the casters, the other sprites, some glows, in a
 * shuffled order) whose keyed rows the pack wrote (their frame float zeroed before each call, as the pack does), and the
 * frames put into them: computeSunFramesInto then applyKeyedSunFramesInto, or E-368's fused pass when the module has it
 * (prepareSunFrames, applyKeyedSunFramesFor). The checksum is the rows'.
 *
 * --path scan (E-372): the same queue's keyed rows written by the keyed caster scan (gpuPack.wasm, through
 * packKeyedCastersScanWasm) on one shared memory that holds every column it reads, as the render-queue memory does, with
 * their frames: the scan, then prepareSunFrames and applyKeyedSunFramesFor; or, on a tree whose scan writes the frames
 * (the sun frames' region, syncKeyedSunTables), prepareSunFrames, the tables brought into the region and the scan alone
 * (and the rows it lists, applyListedSunFramesFor). The checksum is the rows' (every float the scan writes).
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

/**
 * --path scan: a shared memory for every column the keyed caster scan reads (`rows` queue rows, `slots` entities, `keyed`
 * keyed rows), and the tree's gpuPackClient.js: an allocator on it, and the bytes of the sun frames' region where the tree
 * has one (E-372; 0 before).
 */
async function scanMemory(rows, slots, keyed) {
  const client = await import(pathToFileURL(path.resolve('src/render/gpuPackClient.js')).href);
  const region = typeof client.keyedSunRegionBytes === 'function' ? client.keyedSunRegionBytes() : 0;
  const pages = Math.ceil((rows * 96 + slots * 16 + keyed * GPU_KEYED_CASTER_FLOATS * 4 + region + (1 << 20)) / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  let top = 64;
  const place = (bytes) => {
    top = (top + 63) & ~63;
    const at = top;
    top += bytes;
    if (top > memory.buffer.byteLength) throw new Error('sunFramesMicrobench: the scan memory is too small');
    return at;
  };
  const alloc = (Ctor, n) => new Ctor(memory.buffer, place(n * Ctor.BYTES_PER_ELEMENT), n);
  return { memory, client, region, place, alloc };
}

export async function setup({ slots = 57633, casters = 38000, others = 9000, change = 0.25, turnEvery = 600, seed = 0x5e11, path: mode = 'slots' } = {}) {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const mod = await import(pathToFileURL(path.resolve('src/workers/preRenderWorker.js')).href);
  const { computeSunFramesInto, sunFrameTables, applyKeyedSunFramesInto, prepareSunFrames, applyKeyedSunFramesFor } = mod;
  const { syncKeyedSunTables, applyListedSunFramesFor } = mod;
  // --path scan: the columns in one shared memory, where the scan reads them (each column the same values).
  const glows = 500;
  const mem = mode === 'scan' ? await scanMemory(casters + others + glows, slots, casters) : null;
  const column = (Ctor, n) => (mem !== null ? mem.alloc(Ctor, n) : new Ctor(n));
  const rng = mulberry32(seed);
  const tables = sunFrameTables(directionTables());
  const { proxy, starts, counts } = animationTables();
  const active = column(Uint8Array, slots);
  const modeCol = column(Uint8Array, slots);
  const casts = column(Uint8Array, slots);
  const sheets = column(Uint8Array, slots);
  const dirs = column(Uint8Array, slots);
  const anims = column(Uint8Array, slots);
  const frames = column(Uint16Array, slots);
  const orients = column(Uint8Array, slots);
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
  const count = casters + others + glows;
  const qType = column(Uint8Array, count);
  const shadowH = column(Float32Array, count);
  const types = column(Uint8Array, count);
  const entities = column(Int32Array, count);
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
  const rows = column(Float32Array, keyedN * GPU_KEYED_CASTER_FLOATS);
  const fused = mode === 'keyed' && typeof applyKeyedSunFramesFor === 'function';
  // --path scan: the queue's other columns (each row's key its entity's, as the emit writes it; poses at random), the
  // kernel's scratch and, on a tree that has it, the sun frames' region; the scan bound on the memory.
  let scan = null;
  if (mem !== null) {
    const { client } = mem;
    const u16 = new Set(['textureId', 'tileOffsetU', 'tileOffsetV']);
    const q = { count, key: mem.alloc(Uint32Array, count), type: qType };
    for (const c of client.GPU_PACK_COLUMNS) {
      q[c] = c === 'shadowH' ? shadowH : mem.alloc(c === 'tint' ? Uint32Array : u16.has(c) ? Uint16Array : Float32Array, count);
    }
    for (let i = 0; i < count; i++) {
      q.key[i] = entities[i];
      q.x[i] = rng() * 4000;
      q.y[i] = rng() * 3000;
    }
    const tableByte = mem.place(4 * client.GPU_PACK_COLUMNS.length * 4);
    const indexByte = mem.place(count * 4);
    const particlesByte = mem.place(144);
    const keyedSunByte = mem.region > 0 ? mem.place(mem.region) : -1;
    const b = await client.bindGpuPack(mem.memory, {
      tableByte, tableSlots: 4, indexByte, indexCap: count, particlesByte, inverseByte: 0, keyedSunByte,
    });
    const framed = Boolean(b.keyedSun) && typeof syncKeyedSunTables === 'function';
    const sun = framed
      ? {
          types, entities, active, mode: modeCol, dirs, anims, casts, orients, kinds: null, sheets, frames, framed: false, listed: 0,
        }
      : null;
    scan = { b, q, pack: client.packKeyedCastersScanWasm, framed, sun };
  }
  /** One frame: some casters walk a frame or turn, the sun now and then, then the call. */
  const frame = () => {
    for (let k = 0; k < moving; k++) {
      const e = directional[cursor];
      cursor = cursor + 1 === casters ? 0 : cursor + 1;
      frames[e] = (frames[e] + 1) % FRAMES;
      if ((k & 15) === 0) dirs[e] = (dirs[e] + 1) % DIRS;
    }
    if (++call % turnEvery === 0) turn += 0.01;
    if (scan !== null) {
      // As _packGpuSun runs the keyed path: E-372's frames in the scan (the rows it lists, or every row past its list, in
      // JS), or the scan and then the keyed rows' pass.
      const { b, q, sun } = scan;
      if (scan.framed) {
        prepareSunFrames(tables, proxy, starts, counts, shift, shiftTurn, turn);
        syncKeyedSunTables(b.keyedSun, tables);
        const n = scan.pack(b, q, count, rows, slots, count, sun);
        if (sun.listed > b.keyedSun.listCap) {
          applyKeyedSunFramesFor(rows, n, count, qType, shadowH, types, entities, active, modeCol, casts, sheets, dirs, anims,
            frames, tables, shift, orients);
        } else if (sun.listed > 0) {
          applyListedSunFramesFor(rows, b.keyedSun.list, sun.listed, active, modeCol, casts, sheets, dirs, anims, frames,
            tables, shift, orients, null);
        }
      } else {
        const n = scan.pack(b, q, count, rows, slots, count);
        prepareSunFrames(tables, proxy, starts, counts, shift, shiftTurn, turn);
        applyKeyedSunFramesFor(rows, n, count, qType, shadowH, types, entities, active, modeCol, casts, sheets, dirs, anims,
          frames, tables, shift, orients);
      }
      return;
    }
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
  const checksum = () => (mode === 'keyed' || mode === 'scan' ? checksumFloats(rows) : checksumInts(out));
  return { frame, checksum, slots, casters, out, fused, framed: scan !== null && scan.framed };
}

export async function run(opts = {}) {
  const s = await setup(opts);
  // A fixed sequence: the same calls from the same state checksum the same.
  warmNormalCompile(s.frame, opts.warm ?? 400);
  const before = s.checksum();
  const keyedWhat = s.fused ? 'keyed rows, fused (E-368)' : 'keyed rows: computeSunFramesInto + applyKeyedSunFramesInto';
  const scanWhat = s.framed ? 'keyed caster scan writing the frames (E-372)' : 'keyed caster scan, then applyKeyedSunFramesFor';
  const what = opts.path === 'scan' ? scanWhat : opts.path === 'keyed' ? keyedWhat : 'computeSunFramesInto';
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
