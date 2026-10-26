#!/usr/bin/env node
/**
 * Kernel (E-76 W10): the painter sort in WASM (wasm/painterRadix.c, in src/wasm/engine.wasm) against the
 * JS radixPainterOrder and reinsertChangedSlots (src/util/sortIndexByKey.js), on the bytes both read: the
 * float32 sort key columns live in one shared WebAssembly.Memory (as in the render-queue memory, where
 * pre-render writes them), the JS keeps its createPainterState arrays and its own copy of the slot list, the
 * kernel its state in the memory (src/render/painterRadixClient.js; the workers bind PAINTER_VARIANT there).
 *
 * Cases, one op each (keys are spriteYSortKey(foot y, 128) as pre-render writes them):
 *   predator-rebuild    radixPainterOrder on Predator's queue: the first 13 000 active entities of the
 *                       Predator fixture in slot order, a glow row after each light (left out of the slot
 *                       list, as the main queue's type filter leaves glow out); their keys bail out of the
 *                       runs, so it is the full radix
 *   predator-reinsert   reinsertChangedSlots frame after frame on that queue. The fixture is one frame, so
 *                       the motion is a model: the Person classes (Civilian and MySoldier, entity types 5
 *                       and 11) walk a periodic path of 16 frames, 2 to 6 px from their pose, 0.8 to 2.4 px
 *                       a frame; the rest stands still
 *   stress-rebuild      radixPainterOrder on painterSortStressScene's 300 000 rows (400 columns, rows 22 px
 *                       apart, five scales of the 14 px ball anchored at its centre: the runs bail, a full
 *                       radix)
 *   stress-static       reinsertChangedSlots on those rows, nothing moving (the scene's steady state: the
 *                       scan, no slot changed)
 *   stress-move         reinsertChangedSlots on painterMoveStressScene's rows: every tenth swings 24 px on
 *                       sin(phase + 0.35 a frame), here a period of 18 frames (0.349 a frame) so the frames
 *                       repeat; about 29 000 slots change a frame (Predator's model: about 8 200 of 13 000)
 *
 * Variants, one per process (runKernelVariants.mjs rejects a variant whose checksum differs from base's):
 *   base       the shipped JS
 *   scalar, kv8, kv11, adaptive, simd, inplace, simd_inplace   the kernel's exports (painter_order_* for the
 *              rebuilds, reinsert_* for the reinserts; inplace is the scalar rebuild with reinsert_inplace,
 *              simd_inplace the simd rebuild with reinsert_simd_inplace: simd's radix, inplace's merge)
 * The checksum: each case from a fresh state, the rebuild once and the reinsert one period plus a frame,
 * the order (and what reinsert returned) after each. JS warms with warmNormalCompile, WASM with warmWasm,
 * both through short calls on the first 64 rows of each case. --check prints the checksum and exits.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/painterRadixWasmMicrobench.mjs --variants base,scalar,kv8,kv11,adaptive,simd,inplace,simd_inplace --rounds 5
 *   node tests/bench/painterRadixWasmMicrobench.mjs --variant kv8 [--check] [--cases a,b] [--stress-rows N] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/painterRadixWasmMicrobench.mjs [--args '{"rounds":7}']
 *
 * In Chrome (`run(args)`, browser-safe) every variant runs in one page, alternating rounds, each sample at
 * least `minMs` (default 20); args: variants, cases, rounds, minMs, stressRows.
 */
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { layoutRegions, NULL_GUARD_BYTES, painterStateLayout, painterStateRegions } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from './benchMath.js';
import { VARIANTS, loadPainterRadix, painterRadixVariant, wasmPainterState } from '../../src/render/painterRadixClient.js';
import { createPainterState, radixPainterOrder, reinsertChangedSlots } from '../reference/painterJs.mjs';

export const SEED = 0x9a1e7;
export const PREDATOR_ROWS = 13000;
export const STRESS_ROWS = 300000;
const PREDATOR_FRAMES = 16;
const MOVE_FRAMES = 18;
const WARM_ROWS = 64;
const WARM_CAP = 1024;
export const CASES = ['predator-rebuild', 'predator-reinsert', 'stress-rebuild', 'stress-static', 'stress-move'];
export const SIDES = ['base', ...VARIANTS];
/** Civilian and MySoldier in the Predator fixture (Scene registers each Person class after its parents). */
const PREDATOR_MOVERS = new Set([5, 11]);

/** The Predator fixture's bytes as tests/bench/predatorFixture.mjs writes them: u32 header length, JSON, arrays. */
export function parsePredatorFixture(bytes) {
  // A plain view, whose slice copies (a Node Buffer's slice is a view on the whole file).
  const u8 = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + headerLen)).replace(/\0+$/, ''));
  const types = { Float32Array, Uint8Array, Uint16Array, Uint32Array, Int32Array };
  const arrays = {};
  for (const a of header.arrays) {
    const T = types[a.type];
    const start = 4 + headerLen + a.offset;
    arrays[a.name] = new T(u8.slice(start, start + a.length * T.BYTES_PER_ELEMENT).buffer);
  }
  const { arrays: _layout, ...meta } = header;
  return { meta, arrays };
}

/**
 * Predator's queue: rows, the slot list without the glow rows, and each frame's keys (Float32Array per frame).
 */
export function predatorQueue(fx, spriteRows, frames, seed) {
  const { y, active, lightActive, entityType } = fx.arrays;
  const entity = [];
  const glow = [];
  let sprites = 0;
  for (let i = 0; i < fx.meta.n && sprites < spriteRows; i++) {
    if (!active[i]) continue;
    entity.push(i);
    glow.push(false);
    sprites++;
    if (lightActive[i]) {
      entity.push(i);
      glow.push(true);
    }
  }
  const rows = entity.length;
  const idxE = [];
  for (let r = 0; r < rows; r++) if (!glow[r]) idxE.push(r);
  const rng = mulberry32(seed);
  const amp = new Float64Array(fx.meta.n);
  const phase = new Float64Array(fx.meta.n);
  for (const e of entity) {
    if (!PREDATOR_MOVERS.has(entityType[e]) || amp[e]) continue;
    amp[e] = 2 + 4 * rng();
    phase[e] = 2 * Math.PI * rng();
  }
  const keys = [];
  for (let f = 0; f < frames; f++) {
    const k = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      const e = entity[r];
      k[r] = spriteYSortKey(y[e] + amp[e] * Math.sin((2 * Math.PI * f) / frames + phase[e]), 128);
    }
    keys.push(k);
  }
  return { rows, idxE: Uint32Array.from(idxE), keys };
}

/** painterSortStressScene's / painterMoveStressScene's grid: the foot of a centre-anchored 14 px ball. */
const gridFoot = (i, y) => y + 0.5 * 14 * (0.75 + (i % 5) * 0.06);
const gridY = (i) => 40 + Math.floor(i / 400) * 22;

export function stressKeys(rows) {
  const k = new Float32Array(rows);
  for (let i = 0; i < rows; i++) k[i] = spriteYSortKey(gridFoot(i, gridY(i)), 128);
  return k;
}

/** painterMoveStressScene: every tenth row swings 24 px, phase (index % 17) * 0.4, one period of `frames`. */
export function moveKeys(rows, frames) {
  const keys = [];
  for (let f = 0; f < frames; f++) {
    const k = new Float32Array(rows);
    const t = (2 * Math.PI * f) / frames;
    for (let i = 0; i < rows; i++) {
      const y = i % 10 === 0 ? gridY(i) + Math.sin((i % 17) * 0.4 + t) * 24 : gridY(i);
      k[i] = spriteYSortKey(gridFoot(i, y), 128);
    }
    keys.push(k);
  }
  return keys;
}

/** A painter state (either side's) as createPainterState leaves it: every array 0, cold. */
function resetState(st) {
  for (const value of Object.values(st)) if (ArrayBuffer.isView(value)) value.fill(0);
  st.ready = false;
  st.n = 0;
  st.gen = 0;
  st.frame = 0;
}

function fnv(h, v) {
  return Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
}

function hashOrder(h, order, n) {
  for (let i = 0; i < n; i++) h = Math.imul(h ^ order[i], 16777619) >>> 0;
  return h;
}

/**
 * Every case's data in one memory, both sides' states, and the kernel. `side(name)` gives each case's
 * prepare (fresh state; a reinsert case rebuilt on its first frame), op, short (the warm-up call),
 * checksum and the export it times.
 */
export async function setupPainterBench({ fixtureBytes, stressRows = STRESS_ROWS, predatorRows = PREDATOR_ROWS, cases = CASES, url } = {}) {
  for (const c of cases) if (!CASES.includes(c)) throw new Error(`painterRadix bench: no case ${c}`);
  const fx = parsePredatorFixture(fixtureBytes);
  const pred = predatorQueue(fx, predatorRows, PREDATOR_FRAMES, SEED);
  const stress = stressKeys(stressRows);
  const move = cases.includes('stress-move') ? moveKeys(stressRows, MOVE_FRAMES) : [];
  const stressList = Uint32Array.from({ length: stressRows }, (_, i) => i);

  /** Per case: rows (slots), the slot list (null: dense), each frame's keys, rebuild or reinsert. */
  const spec = {
    'predator-rebuild': { rows: pred.rows, list: pred.idxE, frames: [pred.keys[0]], reinsert: false },
    'predator-reinsert': { rows: pred.rows, list: pred.idxE, frames: pred.keys, reinsert: true },
    'stress-rebuild': { rows: stressRows, list: stressList, frames: [stress], reinsert: false },
    'stress-static': { rows: stressRows, list: stressList, frames: [stress], reinsert: true },
    'stress-move': { rows: stressRows, list: stressList, frames: move, reinsert: true },
  };
  const regions = [{ name: 'guard', owner: 'nobody: offset 0 is null', bytes: NULL_GUARD_BYTES }];
  for (const c of cases) {
    const s = spec[c];
    regions.push({ name: `${c}.keys`, owner: 'pre-render writes the sort keys', bytes: s.frames.length * s.rows * 4 });
    regions.push({ name: `${c}.list`, owner: 'the type-filtered slot list', bytes: s.list.length * 4 });
    regions.push(...painterStateRegions(`${c}.`, s.rows, 'the case\'s kernel state'));
  }
  regions.push(...painterStateRegions('warm.', WARM_CAP, 'the warm-up calls\' kernel state'));
  const layout = layoutRegions(regions);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  const kernel = await loadPainterRadix(memory, url);

  const data = {};
  for (const c of cases) {
    const s = spec[c];
    const keyBytes = s.frames.map((_, f) => R[`${c}.keys`].byte + f * s.rows * 4);
    const keyViews = s.frames.map((k, f) => {
      const v = new Uint32Array(buffer, keyBytes[f], s.rows);
      v.set(new Uint32Array(k.buffer, k.byteOffset, s.rows));
      return v;
    });
    new Uint32Array(buffer, R[`${c}.list`].byte, s.list.length).set(s.list);
    const warmList = s.list.subarray(0, WARM_ROWS);
    for (let i = 0; i < warmList.length; i++) if (warmList[i] >= WARM_CAP) throw new Error(`${c}: warm slot ${warmList[i]}`);
    data[c] = {
      ...s,
      ne: s.list.length,
      keyBytes,
      keyViews,
      listByte: R[`${c}.list`].byte,
      listJs: Uint32Array.from(s.list),
      warmListJs: Uint32Array.from(warmList),
      // Shared by every WASM variant (they leave the same state), and the JS's own.
      wasmState: wasmPainterState(buffer, painterStateLayout(R, `${c}.`, s.rows)),
      jsState: null,
      wasmFrame: { f: 0 },
      jsFrame: { f: 0 },
    };
  }
  const warmWasmState = wasmPainterState(buffer, painterStateLayout(R, 'warm.', WARM_CAP));
  const warmJsState = createPainterState(WARM_CAP);

  function jsCase(d) {
    if (!d.jsState) d.jsState = createPainterState(d.rows);
    const st = d.jsState;
    const fr = d.jsFrame;
    const F = d.frames.length;
    const rebuild = (f) => radixPainterOrder(st, d.listJs, d.ne, d.keyViews[f]);
    const reinsert = (f) => {
      const c = reinsertChangedSlots(st.order, d.ne, d.keyViews[f], st.prevKey, st.slotMoved, st.moved, st.merge, st.scratch, st.hist);
      if (c < 0) radixPainterOrder(st, d.listJs, d.ne, d.keyViews[f]);
      return c;
    };
    const w = warmJsState;
    let wf = 0;
    return {
      order: () => st.order,
      prepare() {
        resetState(st);
        fr.f = 0;
        if (d.reinsert) rebuild(0);
      },
      op: d.reinsert
        ? () => {
          fr.f = fr.f + 1 === F ? 0 : fr.f + 1;
          return reinsert(fr.f);
        }
        : () => {
          rebuild(0);
          return 0;
        },
      short: d.reinsert
        ? () => {
          wf = wf + 1 === F ? 0 : wf + 1;
          const c = reinsertChangedSlots(w.order, WARM_ROWS, d.keyViews[wf], w.prevKey, w.slotMoved, w.moved, w.merge, w.scratch, w.hist);
          if (c < 0) radixPainterOrder(w, null, WARM_ROWS, d.keyViews[wf]);
        }
        : () => radixPainterOrder(w, d.warmListJs, d.warmListJs.length, d.keyViews[0]),
      warmPrepare() {
        wf = 0;
        if (d.reinsert) radixPainterOrder(w, null, WARM_ROWS, d.keyViews[0]);
      },
      fn: null,
    };
  }

  function wasmCase(d, v) {
    const st = d.wasmState;
    const fr = d.wasmFrame;
    const F = d.frames.length;
    const rebuild = (f) => v.painterOrder(st, d.listByte, d.ne, d.keyBytes[f]);
    const reinsert = (f) => {
      const c = v.reinsert(st.table, d.ne, d.keyBytes[f]);
      if (c < 0) rebuild(f);
      return c;
    };
    const w = warmWasmState;
    let wf = 0;
    return {
      order: () => st.order,
      prepare() {
        resetState(st);
        fr.f = 0;
        if (d.reinsert) rebuild(0);
      },
      op: d.reinsert
        ? () => {
          fr.f = fr.f + 1 === F ? 0 : fr.f + 1;
          return reinsert(fr.f);
        }
        : () => {
          rebuild(0);
          return 0;
        },
      short: d.reinsert
        ? () => {
          wf = wf + 1 === F ? 0 : wf + 1;
          if (v.reinsert(w.table, WARM_ROWS, d.keyBytes[wf]) < 0) v.painterOrder(w, 0, WARM_ROWS, d.keyBytes[wf]);
        }
        : () => v.painterOrder(w, d.listByte, WARM_ROWS, d.keyBytes[0]),
      warmPrepare() {
        wf = 0;
        if (d.reinsert) v.painterOrder(w, 0, WARM_ROWS, d.keyBytes[0]);
      },
      fn: d.reinsert ? v.reinsert : v.order,
    };
  }

  /** One side's cases. */
  function side(name) {
    if (!SIDES.includes(name)) throw new Error(`painterRadix bench: no variant ${name}`);
    const v = name === 'base' ? null : painterRadixVariant(kernel, name, buffer);
    const out = {};
    for (const c of cases) {
      const d = data[c];
      const k = v ? wasmCase(d, v) : jsCase(d);
      /** From a fresh state: the rebuild once, or the reinsert for a period and a frame; the order after each. */
      k.checksum = () => {
        k.prepare();
        let h = 2166136261;
        let changed = 0;
        const ops = d.reinsert ? d.frames.length + 1 : 1;
        for (let i = 0; i < ops; i++) {
          const ret = k.op();
          changed += ret;
          h = hashOrder(fnv(h, ret), k.order(), d.ne);
        }
        k.prepare();
        return { checksum: h, meanChanged: d.reinsert ? changed / ops : null };
      };
      out[c] = k;
    }
    return out;
  }

  const regimes = {};
  for (const c of cases) {
    const d = data[c];
    regimes[c] = { rows: d.rows, slotList: d.ne, frames: d.frames.length, op: d.reinsert ? 'reinsertChangedSlots' : 'radixPainterOrder' };
  }
  return { cases, regimes, side, memoryPages: layout.pages };
}

/** Every case's checksum into one. */
function combinedChecksum(sideCases, cases, regimes) {
  let h = 2166136261;
  for (const c of cases) {
    const r = sideCases[c].checksum();
    h = fnv(h, r.checksum);
    if (r.meanChanged != null) regimes[c].meanChanged = r.meanChanged;
  }
  return h;
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
  const fixtureBytes = new Uint8Array(await (await fetch(new URL('../fixtures/predator-frame.bin', import.meta.url))).arrayBuffer());
  const cases = args.cases || CASES;
  const sides = args.variants || SIDES;
  const rounds = Number(args.rounds ?? 7);
  const minMs = Number(args.minMs ?? 20);
  const bench = await setupPainterBench({ fixtureBytes, stressRows: Number(args.stressRows ?? STRESS_ROWS), cases });
  const all = Object.fromEntries(sides.map((s) => [s, bench.side(s)]));
  const checksums = Object.fromEntries(sides.map((s) => [s, combinedChecksum(all[s], cases, bench.regimes)]));
  const base = sides[0];
  for (const s of sides) {
    for (const c of cases) {
      all[s][c].warmPrepare();
      for (let i = 0; i < 3000; i++) all[s][c].short();
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const iterations = {};
  for (const s of sides) {
    iterations[s] = {};
    for (const c of cases) {
      all[s][c].prepare();
      iterations[s][c] = calibrate(all[s][c].op, minMs);
    }
  }
  const samples = Object.fromEntries(cases.map((c) => [c, Object.fromEntries(sides.map((s) => [s, []]))]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? sides : [...sides].reverse();
    for (const s of order) for (const c of cases) samples[c][s].push(timeOps(all[s][c].op, iterations[s][c]));
  }
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
    feature: 'painter-radix-wasm',
    seed: SEED,
    rounds,
    minMs,
    regimes: bench.regimes,
    checksums,
    checksumsOk: sides.every((s) => checksums[s] === checksums[base]),
    cases: result,
  };
}

// ---- Node: one variant per process ----

if (typeof process !== 'undefined' && process.versions?.node) {
  const { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } = await import('./microbenchHelpers.mjs');
  if (isCli(import.meta.url)) {
    const fs = await import('node:fs');
    const { PREDATOR_FIXTURE_PATH } = await import('./predatorFixture.mjs');
    const { machineState, TIMING_MARKER, warmWasm } = await import('./wasmKernelHelpers.mjs');
    const args = parseArgs();
    const variant = String(args.variant || 'base');
    const cases = args.cases ? String(args.cases).split(',').map((s) => s.trim()).filter(Boolean) : CASES;
    const stressRows = Number(args['stress-rows'] ?? STRESS_ROWS);
    if (!fs.existsSync(PREDATOR_FIXTURE_PATH)) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
    const bench = await setupPainterBench({ fixtureBytes: fs.readFileSync(PREDATOR_FIXTURE_PATH), stressRows, cases });
    const side = bench.side(variant);
    const checksum = combinedChecksum(side, cases, bench.regimes);
    if (args.check) {
      console.log(`checksum ${checksum} variant ${variant} cases ${cases.join(',')} stress rows ${stressRows}`);
      for (const c of cases) console.log(`  ${c}: ${JSON.stringify(bench.regimes[c])}`);
    } else {
      // Normal compiles, not OSR: short calls on each case's first 64 rows.
      const tiers = {};
      for (const c of cases) {
        side[c].warmPrepare();
        if (variant === 'base') warmNormalCompile(side[c].short);
        else tiers[c] = await warmWasm(side[c].fn, side[c].short);
      }
      console.log(TIMING_MARKER);
      const out = {};
      for (const c of cases) {
        side[c].prepare();
        const heavy = bench.regimes[c].rows > 50000;
        out[c] = timeIt(`painter ${variant} ${c} (${bench.regimes[c].rows} rows)`, side[c].op, { warmup: heavy ? 3 : 20 });
      }
      const report = {
        feature: 'painter-radix-wasm',
        variant,
        functions: ['radixPainterOrder', 'reinsertChangedSlots', 'radixSortIndicesBySortKey', 'painterRadix.painter_order_*', 'painterRadix.reinsert_*'],
        n: stressRows,
        seed: SEED,
        checksum,
        regimes: bench.regimes,
        wasmTier: variant === 'base' ? null : tiers,
        machine: machineState(),
        cases: out,
      };
      if (args.output) writeReport(String(args.output), report);
      else console.log(`checksum ${checksum} variant ${variant}`);
    }
  }
}
