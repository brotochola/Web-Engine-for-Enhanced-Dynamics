/**
 * E-369: pre-render's applyKeyedLampFramesInto (DX-SHADOW3D), the frame each lamp sees of a directional caster in its
 * keyed stamp rows, on rows shaped as Predator crowd 2.5's: 48 shadow-casting lamps, `--stamps` rows (default 20 000;
 * each caster in up to three lamps' reach), the casters of six LPC sheets (four directions, three groups, eight frames).
 * Between calls a share of the casters walk a frame or turn (`--change`, default 0.25).
 *
 *   node tests/bench/lampFramesMicrobench.mjs [--stamps 20000] [--casters 38000] [--change 0.25] [--reps 7] [--output f]
 *     [--path keyed|full|wasm|wasm-full]
 *
 * --path full: the full stamp rows' pass (applyLampFramesInto: light3d scenes pack full rows), the row's entity in its
 * tint float and the frame written as its texture and the flip of its scale, both put back before each call (the stamp
 * copies the sun rows anew each frame).
 *
 * --path wasm, --path wasm-full (E-393): the same keyed or full rows with every column the pass reads in one shared
 * memory, as the render-queue memory holds them (the stamp rows, their u16 light index, DirectionalSprite's and
 * SpriteRenderer's columns, the entities' frames), and the pass as _applyLampFrames runs it: on a tree with E-393's kernel
 * (preRenderWorker.js applyLampFramesWasm, gpuPack.wasm lamp_frames on the sun frames' region), the kernel and the JS for
 * the rows it lists; before, applyKeyedLampFramesInto or applyLampFramesInto on the same memory.
 *
 * Calls the shipped functions (preRenderWorker.js exports) with the arguments _applyLampFrames hands them; the checksum
 * is the rows' floats after a fixed warm-up (two versions that write the same frames checksum the same).
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { GPU_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { checksumFloats, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker } from './workerHarness.mjs';

const SHEETS = 6;
const DIRS = 4;
const GROUPS = ['walk', 'idle', 'shoot'];
const FRAMES = 8;
const LAMPS = 48;
// The full rows' floats the pass reads and writes (preRenderWorker.js GPU_ROW_*; GPU_SPRITE_FLOATS the shadow height).
const ROW_SCALE_X = 2;
const ROW_TINT = 9;
const ROW_TEXTURE = 10;
const ROW_SHADOW_H = 15;

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

/**
 * --path wasm: one shared memory for the stamp rows and the columns, and the tree's gpuPackClient.js: an allocator on it,
 * and the bytes of the sun frames' region where the tree has one (laid last: every column sits at the same byte on both
 * trees).
 */
async function lampMemory(stamps, floats, slots) {
  const client = await import(pathToFileURL(path.resolve('src/render/gpuPackClient.js')).href);
  const region = typeof client.keyedSunRegionBytes === 'function' ? client.keyedSunRegionBytes() : 0;
  const pages = Math.ceil((stamps * (floats * 4 + 2) + slots * 8 + region + (1 << 20)) / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  let top = 64;
  const place = (bytes) => {
    top = (top + 63) & ~63;
    const at = top;
    top += bytes;
    if (top > memory.buffer.byteLength) throw new Error('lampFramesMicrobench: the memory is too small');
    return at;
  };
  const alloc = (Ctor, n) => new Ctor(memory.buffer, place(n * Ctor.BYTES_PER_ELEMENT), n);
  return { memory, client, region, place, alloc };
}

export async function setup({ stamps = 20000, casters = 38000, change = 0.25, seed = 0x1a4f, path: mode = 'keyed' } = {}) {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const mod = await import(pathToFileURL(path.resolve('src/workers/preRenderWorker.js')).href);
  const { applyKeyedLampFramesInto, applyLampFramesInto, applyLampFramesWasm, sunFrameTables } = mod;
  const full = mode === 'full' || mode === 'wasm-full';
  const inMemory = mode === 'wasm' || mode === 'wasm-full';
  const floats = full ? GPU_CASTER_FLOATS : GPU_KEYED_STAMP_FLOATS;
  const slots = casters + 1000;
  const mem = inMemory ? await lampMemory(stamps, floats, slots) : null;
  const column = (Ctor, n) => (mem !== null ? mem.alloc(Ctor, n) : new Ctor(n));
  const rng = mulberry32(seed);
  const tables = sunFrameTables(directionTables());
  const { proxy, starts, counts } = animationTables();
  const dsActive = column(Uint8Array, slots);
  const dsMode = column(Uint8Array, slots);
  const sheets = column(Uint8Array, slots);
  const dirs = column(Uint8Array, slots);
  const anims = column(Uint8Array, slots);
  const frames = column(Uint16Array, slots);
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
  // The rows: a caster near its lamp, in the lamps' order (as the stamp lists come). A full row names its entity in its
  // tint float and carries the sprite's texture and scale (mirrored at times), which the pass overwrites.
  const rows = column(Float32Array, stamps * floats);
  const lightIdx = mem !== null ? column(Uint16Array, stamps) : new Uint8Array(stamps);
  const baseTexture = new Float32Array(full ? stamps : 0);
  const baseScale = new Float32Array(full ? stamps : 0);
  for (let k = 0; k < stamps; k++) {
    const l = Math.floor((k * LAMPS) / stamps);
    const L = lights[l];
    const a = rng() * Math.PI * 2;
    const r = 20 + rng() * 260;
    const at = k * floats;
    rows[at] = L.x + Math.cos(a) * r;
    rows[at + 1] = L.y + Math.sin(a) * r * 0.74;
    const e = Math.floor(rng() * casters);
    if (full) {
      rows[at + ROW_TINT] = e;
      rows[at + ROW_SHADOW_H] = 30;
      baseTexture[k] = 1 + Math.floor(rng() * 500);
      baseScale[k] = (rng() < 0.3 ? -1 : 1) * (0.8 + rng() * 0.4);
    } else {
      rows[at + 2] = e;
      rows[at + 4] = 30;
    }
    lightIdx[k] = l;
  }
  const invG = 1 / 0.7364;
  // E-393: the shipped kernel path where the tree has it (the region and the columns in the memory, the kernel bound).
  let wasm = null;
  if (mem !== null && typeof applyLampFramesWasm === 'function') {
    const tableByte = mem.place(4 * mem.client.GPU_PACK_COLUMNS.length * 4);
    const indexByte = mem.place(64);
    const particlesByte = mem.place(144);
    const keyedSunByte = mem.region > 0 ? mem.place(mem.region) : -1;
    const b = await mem.client.bindGpuPack(mem.memory, {
      tableByte, tableSlots: 4, indexByte, indexCap: 16, particlesByte, inverseByte: 0, keyedSunByte,
    });
    const cols = {
      active: dsActive, mode: dsMode, dirs, anims, sheets, orients: null, kinds: null, frames, listed: 0,
    };
    wasm = { b, cols };
  }
  const moving = Math.round(casters * change);
  let cursor = 0;
  let calls = 0;
  let listed = 0;
  const frame = () => {
    for (let k = 0; k < moving; k++) {
      const e = cursor;
      cursor = cursor + 1 === casters ? 0 : cursor + 1;
      frames[e] = (frames[e] + 1) % FRAMES;
      if ((k & 15) === 0) dirs[e] = (dirs[e] + 1) % DIRS;
    }
    if (full) {
      // The stamp copied each sun row anew: its texture and scale as the pack left them.
      for (let k = 0; k < stamps; k++) {
        const at = k * GPU_CASTER_FLOATS;
        rows[at + ROW_TEXTURE] = baseTexture[k];
        rows[at + ROW_SCALE_X] = baseScale[k];
      }
    } else {
      // The pack wrote each keyed row's frame float as 0.
      for (let k = 0; k < stamps; k++) rows[k * GPU_KEYED_STAMP_FLOATS + 3] = 0;
    }
    calls++;
    if (wasm !== null) {
      const ran = applyLampFramesWasm(wasm.b, rows, stamps, lightIdx, lights, LAMPS, invG, tables, proxy, starts, counts,
        wasm.cols, !full);
      if (!ran) throw new Error('lampFramesMicrobench: the kernel did not take the call');
      listed += wasm.cols.listed;
      return;
    }
    const apply = full ? applyLampFramesInto : applyKeyedLampFramesInto;
    apply(rows, stamps, lightIdx, lights, invG, tables, proxy, starts, counts, frames, dsActive, dsMode, dirs, anims, sheets,
      null);
  };
  const checksum = () => checksumFloats(rows);
  const listedPerCall = () => (calls > 0 ? listed / calls : 0);
  return { frame, checksum, stamps, casters, full, kernel: wasm !== null, listedPerCall };
}

export async function run(opts = {}) {
  const s = await setup(opts);
  warmNormalCompile(s.frame, opts.warm ?? 400);
  const before = s.checksum();
  const rows = s.full ? 'full' : 'keyed';
  const what = s.kernel ? `${rows} rows: lamp_frames (E-393), the JS the rows it lists` : s.full ? 'applyLampFramesInto' : 'applyKeyedLampFramesInto';
  const where = opts.path === 'wasm' || opts.path === 'wasm-full' ? ', the columns in a shared memory' : '';
  const timed = timeIt(`${what} (${s.stamps} ${rows} stamp rows, ${LAMPS} lamps${where})`, s.frame, {
    iterations: 50,
    warmup: 10,
    reps: opts.reps ?? 7,
  });
  return { timed, checksumAfterWarm: before, checksum: s.checksum(), kernel: s.kernel, listedPerCall: s.listedPerCall() };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const result = await run({ stamps: args.stamps, casters: args.casters, change: args.change, reps: args.reps, path: args.path });
  console.log(`checksum after warm-up ${result.checksumAfterWarm}, after timing ${result.checksum}`);
  if (result.kernel) console.log(`rows left to the JS: ${result.listedPerCall.toFixed(2)} a call`);
  if (args.output) writeReport(args.output, { kernel: 'lampFrames', ...result });
}
