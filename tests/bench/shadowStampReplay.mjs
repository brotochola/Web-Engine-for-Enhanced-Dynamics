/**
 * E-160: the shadow stamp replayed on a capture of a scene's own inputs (captureStampInputs.mjs), frame after
 * frame. Browser-safe, so chromeKernel.mjs can run it; shadowStampReplayMicrobench.mjs times it in Node.
 *
 * - createStampReplay: one shared WebAssembly.Memory with every frame's sun rows and light table in regions of
 *   their own (a frame's call only points the table at them, as pre-render's packed rows are already in its
 *   memory), the stamp scratch and output shared, and a column table image per frame (shadowStampClient.js's
 *   slots, with the call's own limits and capacities).
 * - replayChecksum: every frame through a kernel, each frame's cursor, rows and light indices folded in; the
 *   capture's own output folds the same way (captureChecksum), so a replay that does not write what the scene's
 *   stamp wrote shows.
 * - run: chromeKernel.mjs's entry, variants of the kernel in alternating rounds.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/shadowStampReplay.mjs \
 *     --args '{"capture":"/tests/results/stamp-capture/predator.bin","rounds":7}'
 * With `"other": "/path/engine.wasm"` and `"variants": "other,wasm"`, `other` is the shipped stamp of that engine.wasm
 * (a copy from before a change, served from the repo).
 */
import { GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { STAMP_SLOTS } from '../../src/render/shadowStampClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES, STAMP_GRID_CELLS, STAMP_TABLE_SLOTS } from '../../src/util/wasmMemoryMap.js';
import { decodeStampCapture } from './stampCapture.mjs';

const SLOT = Object.fromEntries(STAMP_SLOTS.map((name, k) => [name, k]));
const LIGHT_DOUBLES = 5;

/** The variants: a module's export of the stamp (the shipped kernel is engine.wasm's). */
export const STAMP_REPLAY_VARIANTS = {
  wasm: { file: '../../src/wasm/engine.wasm', name: 'shadowStamp', fn: 'stamp_light_range' },
};

/** FNV-1a step over 32-bit words. */
const mix = (h, w) => Math.imul(h ^ w, 16777619) >>> 0;

function foldFrame(h, written, base, rows, floats, lightIdx) {
  h = mix(h, written >>> 0);
  const n = (written - base) * floats;
  const words = new Uint32Array(rows.buffer, rows.byteOffset, n > 0 ? n : 0);
  for (let i = 0; i < words.length; i++) h = mix(h, words[i]);
  if (lightIdx) for (let i = 0; i < written - base; i++) h = mix(h, lightIdx[i]);
  return h;
}

/** The capture's own output, folded as replayChecksum folds a replay. */
export function captureChecksum(capture) {
  let h = 2166136261;
  for (const f of capture.frames) h = foldFrame(h, f.written, f.stampBase, f.stamp, f.stampFloats, f.lightIdxOn ? f.lightIdx : null);
  return h;
}

/**
 * @param {{ meta: object, frames: object[] }} capture decodeStampCapture's result
 * @param {URL|string} kernelUrl the module that holds the shipped stamp (engine.wasm)
 */
export async function createStampReplay(capture, kernelUrl) {
  const frames = capture.frames;
  let maxSun = 1;
  let maxPE = 1;
  let maxCap = 1;
  let floats = 1;
  for (const f of frames) {
    maxSun = Math.max(maxSun, f.sunN, f.regionMaxSun, f.tmpLen, f.gridItemsLen);
    maxPE = Math.max(maxPE, f.maxPerEntity, f.regionMaxPerEntity);
    maxCap = Math.max(maxCap, f.stampCap);
    floats = Math.max(floats, f.stampFloats);
  }
  const regions = [{ name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES }];
  frames.forEach((f, i) => {
    regions.push({ name: `sun${i}`, owner: 'pre-render', bytes: Math.max(4, f.sun.byteLength) });
    regions.push({ name: `lights${i}`, owner: 'pre-render', bytes: Math.max(8, f.lights.byteLength) });
  });
  for (const name of ['tmpIdx', 'dist', 'order', 'keep', 'gridItems', 'nearCount']) {
    regions.push({ name, owner: 'pre-render', bytes: maxSun * 4 });
  }
  regions.push(
    { name: 'gridCounts', owner: 'pre-render', bytes: STAMP_GRID_CELLS * 4 },
    { name: 'gridStarts', owner: 'pre-render', bytes: (STAMP_GRID_CELLS + 1) * 4 },
    { name: 'nearDist', owner: 'pre-render', bytes: maxSun * maxPE * 4 },
    { name: 'nearSlot', owner: 'pre-render', bytes: maxSun * maxPE * 4 },
    { name: 'stamp', owner: 'pre-render', bytes: maxCap * floats * 4 },
    { name: 'stampLightIdx', owner: 'pre-render', bytes: maxCap * 2 },
    { name: 'table', owner: 'pre-render', bytes: STAMP_TABLE_SLOTS * 4 },
  );
  const layout = layoutRegions(regions);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  const images = frames.map((f, i) => {
    new Float32Array(buffer, R[`sun${i}`].byte, f.sun.length).set(f.sun);
    new Float64Array(buffer, R[`lights${i}`].byte, f.lights.length).set(f.lights);
    const t = new Uint32Array(STAMP_TABLE_SLOTS);
    const put = (slot, v) => {
      t[SLOT[slot]] = v;
    };
    const regionSun = f.regionMaxSun > 0 ? f.regionMaxSun : maxSun;
    put('sun', R[`sun${i}`].byte);
    put('sunN', f.sunN);
    put('sunFloats', f.sunFloats);
    put('lights', R[`lights${i}`].byte);
    put('lightBegin', f.lightBegin);
    put('lightEnd', f.lightEnd);
    put('lightStride', f.lightStride);
    put('maxPL', f.maxPerLight);
    put('maxPE', Math.max(0, f.maxPerEntity));
    put('tmpIdx', R.tmpIdx.byte);
    put('dist', R.dist.byte);
    put('order', R.order.byte);
    put('keep', R.keep.byte);
    put('tmpCap', Math.min(f.tmpLen, regionSun));
    if (f.gridCountsLen > 0) {
      put('gridCounts', R.gridCounts.byte);
      put('gridStarts', R.gridStarts.byte);
      put('gridItems', R.gridItems.byte);
      put('gridCountsCap', Math.min(f.gridCountsLen, STAMP_GRID_CELLS));
      put('gridItemsCap', Math.min(f.gridItemsLen, regionSun));
    }
    put('stamp', R.stamp.byte);
    put('stampFloats', f.stampFloats);
    put('stampCap', f.stampCap);
    put('stampBase', f.stampBase);
    put('stampLightIdx', f.lightIdxOn ? R.stampLightIdx.byte : 0);
    put('lightFloat', GPU_CASTER_LIGHT_FLOAT);
    put('nearDist', R.nearDist.byte);
    put('nearSlot', R.nearSlot.byte);
    put('nearCount', R.nearCount.byte);
    return t;
  });
  const table = new Uint32Array(buffer, R.table.byte, STAMP_TABLE_SLOTS);
  const tableByte = R.table.byte;
  const stamp = new Float32Array(buffer, R.stamp.byte, maxCap * floats);
  const lightIdx = new Uint16Array(buffer, R.stampLightIdx.byte, maxCap);
  const { stamp_light_range: shipped } = await loadWasmKernel('shadowStamp', kernelUrl, memory, ['stamp_light_range']);

  /** Every frame through `fn`, as the scene calls it; returns the last cursor. */
  const replay = (fn) => {
    let cursor = 0;
    for (let i = 0; i < images.length; i++) {
      table.set(images[i]);
      cursor = fn(tableByte);
    }
    return cursor;
  };
  /** Every frame through `fn`, folding each frame's output in. */
  const replayChecksum = (fn) => {
    let h = 2166136261;
    for (let i = 0; i < images.length; i++) {
      const f = frames[i];
      table.set(images[i]);
      const written = fn(tableByte);
      const rows = stamp.subarray(f.stampBase * f.stampFloats);
      h = foldFrame(h, written, f.stampBase, rows, f.stampFloats, f.lightIdxOn ? lightIdx.subarray(f.stampBase) : null);
    }
    return h;
  };
  /** A variant's export, instantiated on this memory. */
  const kernelOf = async (url, name, fn) => (await loadWasmKernel(name, url, memory, [fn]))[fn];
  return { memory, frames, shipped, replay, replayChecksum, kernelOf };
}

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** chromeKernel.mjs entry: each variant replays the capture, in alternating rounds of at least minMs. */
export async function run(args = {}) {
  const rounds = Number(args.rounds ?? 7);
  const minMs = Number(args.minMs ?? 300);
  const names = String(args.variants ?? 'wasm').split(',');
  const bytes = new Uint8Array(await (await fetch(new URL(String(args.capture ?? '/tests/results/stamp-capture/predator.bin'), location.href))).arrayBuffer());
  const capture = decodeStampCapture(bytes);
  const r = await createStampReplay(capture, new URL(STAMP_REPLAY_VARIANTS.wasm.file, import.meta.url));
  const fns = {};
  for (const n of names) {
    if (n === 'other') {
      fns[n] = await r.kernelOf(new URL(String(args.other), location.href), 'shadowStamp', 'stamp_light_range');
      continue;
    }
    const v = STAMP_REPLAY_VARIANTS[n];
    if (!v) throw new Error(`unknown variant ${n}`);
    fns[n] = await r.kernelOf(new URL(v.file, import.meta.url), v.name, v.fn);
  }
  const expected = captureChecksum(capture);
  const checksums = {};
  for (const n of names) {
    checksums[n] = r.replayChecksum(fns[n]);
    for (let i = 0; i < 30; i++) r.replay(fns[n]);
  }
  const iterations = {};
  for (const n of names) {
    let k = 1;
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < k; i++) r.replay(fns[n]);
      if (performance.now() - t0 >= minMs) break;
      k *= 2;
    }
    iterations[n] = k;
  }
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  for (let round = 0; round < rounds; round++) {
    for (const n of round % 2 === 0 ? names : [...names].reverse()) {
      const t0 = performance.now();
      for (let i = 0; i < iterations[n]; i++) r.replay(fns[n]);
      samples[n].push((performance.now() - t0) / (iterations[n] * capture.frames.length));
    }
  }
  return {
    feature: 'shadow-stamp-replay-chrome',
    frames: capture.frames.length,
    sceneMsPerCall: capture.meta.sceneMsPerCall,
    expected,
    checksums,
    matchesCapture: Object.fromEntries(names.map((n) => [n, checksums[n] === expected])),
    rounds,
    msPerFrame: Object.fromEntries(names.map((n) => [n, medianOf(samples[n])])),
    samples,
  };
}
