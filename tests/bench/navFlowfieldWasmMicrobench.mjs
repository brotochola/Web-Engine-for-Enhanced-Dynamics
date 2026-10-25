#!/usr/bin/env node
/**
 * Kernel (E-76 W14): the particle worker's flowfield in WASM (wasm/navFlowfield.c, src/workers/navFlowfield.wasm)
 * against the JS search the engine shipped (tests/reference/navFlowfield.mjs), on a real particle worker with
 * navStressScene's grid: a 2048 × 2048 world in 32 px cells (64 × 64), no walls, 64 flowfield slots.
 *
 *   js    the reference: the search, the walls' pass and the smoothing in a FlowScratch (the worker's
 *         NavScratch as it was), then the slot (allocateFlowfieldSlot, writeFlowfieldData)
 *   wasm  ParticleWorker.computeFlowfield (shipped), the kernel the worker bound on this memory:
 *         compute_flowfield, then the slot. flowfieldWasm below is the same around a table of the caller's,
 *         for the warm-up and the test
 *
 * The search reads the walkability and both sides write the slot, all in the nav buffer, which here is
 * the shared WebAssembly.Memory the kernel imports: NavGrid reads its header at byte 0 of the buffer it is
 * given, so the nav layout starts the memory and the kernel's scratch follows it. The JS scratch is the
 * reference's own. One op is one flowfield. The targets are navStressScene's, in the order its agents ask for
 * them: 256 agents on 40 targets that move every tick, so every request misses the cache and the scene's
 * 8 ms deadline loop computes flowfields back to back (E-38). In the scene a faster search shows as more
 * flowfields per frame (FLOWFIELDS_COMPUTED), not as a lower STEP_MS.
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum differs:
 * the target and the slot's vectors of each of two frames' flowfields (80), and the cached count. --check
 * prints that checksum and exits, without warm-up or timing.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/navFlowfieldWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/navFlowfieldWasmMicrobench.mjs --variant wasm [--map open|rooms] [--world 2048] [--cell 32] [--check] [--output path]
 *
 * rooms: the same grid walled into 8 × 8-cell rooms with a door in each wall and some rooms sealed, so
 * the walls' pass runs, targets land on walls and some searches cannot leave their room. A second data
 * point, not the scene.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NavGrid } from '../../src/core/navGrid.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { FLOWFIELD_SLOTS } from '../../src/workers/navFlowfieldClient.js';
import { computeFlowfieldReference, FlowScratch } from '../reference/navFlowfield.mjs';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { initWorker, loadWorker } from './workerHarness.mjs';
import { machineState, TIMING_MARKER, warmWasm } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/workers/navFlowfield.wasm'));
export { FLOWFIELD_SLOTS };
/** navFlowfield.c's QUOTIENT_BYTES. */
const QUOTIENT_BYTES = 190;
/** The bucket heads: scratch.maxDistance is at most 65535. */
const MAX_BUCKETS = 65536;
/** The short calls' grid: the first cells of the real one, read as WARM × WARM. */
const WARM = 4;
/** navStressScene's navigation config. */
export const STRESS_NAVIGATION = Object.freeze({
  enabled: true,
  cellSize: 32,
  maxFlowfields: 64,
  maxPaths: 64,
  maxPathLength: 128,
  maxProcessingMsPerFrame: 8,
});
const CHECK_FRAMES = 2;
const TIMED_FRAMES = 40;

/**
 * navStressScene's targets as cells, in the order its agents ask for them: NavStressAgent's (tx, ty) on
 * frame f for agents 0 .. 39 (agent i + 40k shares agent i's target), frame after frame.
 */
export function stressTargets(frames, gridWidth, gridHeight, cellSize) {
  const out = [];
  for (let f = 1; f <= frames; f++) {
    for (let i = 0; i < 40; i++) {
      const tx = 400 + ((i + f) % 40) * 32;
      const ty = 400 + ((i * 3 + f) % 40) * 32;
      const col = Math.min(gridWidth - 1, Math.floor(tx / cellSize));
      const row = Math.min(gridHeight - 1, Math.floor(ty / cellSize));
      out.push(row * gridWidth + col);
    }
  }
  return out;
}

/** Rooms of `size` cells a side, walls one cell thick, a door in the middle of each wall; a sealed room has none. */
export function roomWalls(walk, gridWidth, gridHeight, size = 8) {
  const sealed = (rx, ry) => (rx * 7 + ry * 3) % 11 === 5;
  const mid = size >> 1;
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const onX = x % size === 0;
      const onY = y % size === 0;
      if (!onX && !onY) continue;
      const rx = Math.floor(x / size);
      const ry = Math.floor(y / size);
      if (onX && !onY && y % size === mid && !sealed(rx, ry) && !sealed(rx - 1, ry)) continue;
      if (onY && !onX && x % size === mid && !sealed(rx, ry) && !sealed(rx, ry - 1)) continue;
      walk[y * gridWidth + x] = 0;
    }
  }
}

/**
 * A particle worker on a gridWidth × gridHeight nav grid whose buffer is the kernel's memory, and the
 * kernel bound to it. `walls(walk, gridWidth, gridHeight)` edits the walkability after the scene's fill
 * with 1.
 */
export async function setupFlowfieldKernel({ gridWidth, gridHeight, navigation = STRESS_NAVIGATION, walls = null }) {
  const cells = gridWidth * gridHeight;
  const layout = layoutRegions([
    // NavGrid reads its header at byte 0 of its buffer, so the nav buffer starts the memory. Its
    // walkability (at byte 32) and its slots are what both sides share; no table slot is 0.
    { name: 'nav', owner: 'every worker (NavGrid); the particle worker writes the slots', bytes: NavGrid.calculateSABSize(navigation, gridWidth, gridHeight) },
    { name: 'state', owner: 'particle', bytes: cells },
    { name: 'dist', owner: 'particle', bytes: cells * 2 },
    { name: 'dir', owner: 'particle', bytes: cells },
    { name: 'next', owner: 'particle', bytes: cells * 4 },
    { name: 'prev', owner: 'particle', bytes: cells * 4 },
    { name: 'head', owner: 'particle', bytes: MAX_BUCKETS * 4 },
    { name: 'sums', owner: 'particle', bytes: cells * 4 },
    { name: 'quotient', owner: 'particle', bytes: QUOTIENT_BYTES },
    { name: 'vectors', owner: 'particle', bytes: cells * 2 },
    { name: 'table', owner: 'particle', bytes: FLOWFIELD_SLOTS.length * 4 },
    { name: 'warmTable', owner: 'particle', bytes: FLOWFIELD_SLOTS.length * 4 },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  // sceneSharedBuffers' nav setup: the header, every cell walkable.
  NavGrid.writeHeader(buffer, navigation, gridWidth, gridHeight);
  const walk = new Uint8Array(buffer, NavGrid._HEADER_SIZE, cells).fill(1);
  if (walls) walls(walk, gridWidth, gridHeight);

  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: {
      worldWidth: gridWidth * navigation.cellSize,
      worldHeight: gridHeight * navigation.cellSize,
      navigation,
      particle: { maxParticles: 0, decals: false },
    },
    globalEntityCount: 0,
    buffers: { navigationData: buffer },
    // This memory in createNavigationMemory's layout, so the worker binds the kernel on it as on a scene's.
    extra: {
      navigationMemory: memory,
      navigationLayout: {
        cells,
        navBytes: R.nav.bytes,
        stateByte: R.state.byte,
        distByte: R.dist.byte,
        dirByte: R.dir.byte,
        nextByte: R.next.byte,
        prevByte: R.prev.byte,
        headByte: R.head.byte,
        sumsByte: R.sums.byte,
        quotientByte: R.quotient.byte,
        vectorsByte: R.vectors.byte,
        tableByte: R.table.byte,
      },
    },
  });
  if (!worker.navEnabled || NavGrid.getWalkabilityArray().buffer !== buffer || worker.totalCells !== cells || !worker._flowWasm) {
    throw new Error('the worker did not bind the nav buffer and the kernel');
  }

  const writeTable = (byte, width, height) => {
    const t = new Uint32Array(buffer, byte, FLOWFIELD_SLOTS.length);
    const put = (slot, value) => { t[FLOWFIELD_SLOTS.indexOf(slot)] = value; };
    put('walk', walk.byteOffset);
    put('width', width);
    put('height', height);
    put('maxDist', worker.scratch.maxDistance);
    for (const name of ['state', 'dist', 'dir', 'next', 'prev', 'head', 'sums', 'quotient']) put(name, R[name].byte);
    put('out', R.vectors.byte);
  };
  writeTable(R.table.byte, gridWidth, gridHeight);
  writeTable(R.warmTable.byte, Math.min(WARM, gridWidth), Math.min(WARM, gridHeight));

  const { compute_flowfield: computeFlowfield } = await loadWasmKernel('navFlowfield', KERNEL_URL, memory, ['compute_flowfield']);
  const vectors = new Int8Array(buffer, R.vectors.byte, cells * 2);
  /** What a product wrapper does per flowfield: computeFlowfield with the kernel for the search and the smoothing. */
  const flowfieldWasm = (targetCell, tableByte = R.table.byte) => {
    const willUseEmptySlot = worker._hasEmptyFlowfieldSlot();
    const settled = computeFlowfield(tableByte, targetCell);
    const slot = NavGrid.allocateFlowfieldSlot(targetCell);
    NavGrid.writeFlowfieldData(slot, vectors);
    if (willUseEmptySlot) worker.cachedFlowfieldsCount++;
    return settled;
  };
  /** The JS search the engine shipped, in a scratch of its own (the worker's NavScratch no longer has those arrays). */
  const flowScratch = new FlowScratch(cells, navigation.maxPathLength, gridWidth, gridHeight);
  const flowfieldJs = (targetCell) => computeFlowfieldReference(worker, targetCell, flowScratch);
  /** The shipped method: the kernel the worker bound. */
  const flowfieldShipped = (targetCell) => worker.computeFlowfield(targetCell);

  /** The vectors of the READY slot that holds `targetCell`'s flowfield. */
  const slotVectors = (targetCell) => {
    const slot = worker._findExistingFlowfieldSlot(targetCell);
    if (slot < 0) throw new Error(`no READY flowfield for cell ${targetCell}`);
    const byte = NavGrid._flowfieldHeadersOffset + slot * NavGrid._flowfieldSlotSize + NavGrid._FLOWFIELD_HEADER_SIZE;
    return new Uint8Array(buffer, byte, cells * 2);
  };

  /** Empty slots again, as after a rebuild (warm-up fills them with small grids' flowfields). */
  const clearSlots = () => {
    NavGrid.invalidate();
    worker.cachedFlowfieldsCount = 0;
  };
  /** Short calls for a normal compile: the reference on the grid's first cells read as a small grid. */
  const warmJs = (calls) => {
    const saved = [worker.gridWidth, worker.gridHeight, worker.totalCells];
    worker.gridWidth = Math.min(WARM, gridWidth);
    worker.gridHeight = Math.min(WARM, gridHeight);
    worker.totalCells = worker.gridWidth * worker.gridHeight;
    try {
      warmNormalCompile(() => flowfieldJs(worker.totalCells >> 1), calls);
    } finally {
      [worker.gridWidth, worker.gridHeight, worker.totalCells] = saved;
      clearSlots();
    }
  };
  /** The same for the kernel and its wrapper; resolves to the WASM tier. */
  const warmKernel = async (calls) => {
    const warmCell = (Math.min(WARM, gridWidth) * Math.min(WARM, gridHeight)) >> 1;
    const tier = await warmWasm(computeFlowfield, () => flowfieldWasm(warmCell, R.warmTable.byte), { calls });
    clearSlots();
    return tier;
  };

  return {
    worker,
    memory,
    buffer,
    regions: R,
    cells,
    gridWidth,
    gridHeight,
    walk,
    tableByte: R.table.byte,
    computeFlowfield,
    flowfieldJs,
    flowfieldShipped,
    flowfieldWasm,
    flowScratch,
    slotVectors,
    warmJs,
    warmKernel,
    /** The kernel's distances, directions and vectors after its last call. */
    kernelDist: new Uint16Array(buffer, R.dist.byte, cells),
    kernelDir: new Uint8Array(buffer, R.dir.byte, cells),
    kernelVectors: vectors,
  };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

/** Each target's flowfield, then its target and slot vectors into the hash; the cached count last. */
function checksumOf(k, flowfield, targets) {
  let h = 2166136261;
  for (const cell of targets) {
    flowfield(cell);
    h = Math.imul(h ^ cell, 16777619) >>> 0;
    h = hashBytes(h, k.slotVectors(cell));
  }
  return Math.imul(h ^ k.worker.cachedFlowfieldsCount, 16777619) >>> 0;
}

async function main() {
  const args = parseArgs();
  // The shipped path by default; js is the reference.
  const variant = String(args.variant || 'wasm');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const map = String(args.map || 'open');
  if (!['open', 'rooms'].includes(map)) throw new Error(`unknown map ${map}`);
  const world = Number(args.world ?? 2048);
  const cellSize = Number(args.cell ?? STRESS_NAVIGATION.cellSize);
  const gridWidth = Math.ceil(world / cellSize);
  const gridHeight = Math.ceil(world / cellSize);
  const k = await setupFlowfieldKernel({
    gridWidth,
    gridHeight,
    navigation: { ...STRESS_NAVIGATION, cellSize },
    walls: map === 'rooms' ? roomWalls : null,
  });
  const flowfield = variant === 'wasm' ? k.flowfieldShipped : k.flowfieldJs;
  const walls = k.walk.reduce((n, w) => n + (w === 0 ? 1 : 0), 0);
  const label = `${gridWidth} × ${gridHeight} ${map}`;

  const checkTargets = stressTargets(CHECK_FRAMES, gridWidth, gridHeight, cellSize);
  const checksum = checksumOf(k, flowfield, checkTargets);
  if (args.check) {
    console.log(`checksum ${checksum} (${variant}, ${checkTargets.length} flowfields, ${label}, ${walls} walls)`);
    return;
  }

  // Normal compiles, not OSR: short calls on a 4 × 4 grid.
  let tier = null;
  if (variant === 'wasm') tier = await k.warmKernel(3000);
  else k.warmJs(3000);
  const targets = stressTargets(TIMED_FRAMES, gridWidth, gridHeight, cellSize);
  let next = 0;
  const run = () => {
    flowfield(targets[next]);
    next = next + 1 === targets.length ? 0 : next + 1;
  };
  console.log(TIMING_MARKER);
  const cases = {
    flowfield: timeIt(`flowfield ${variant} (${label})`, run, { iterations: 30, warmup: 30 }),
  };
  const report = {
    feature: 'nav-flowfield-wasm',
    variant,
    functions: ['computeFlowfieldReference (tests/reference)', 'navFlowfield.compute_flowfield'],
    grid: { width: gridWidth, height: gridHeight, cellSize, map, walls },
    checksumFlowfields: checkTargets.length,
    checksum,
    flowfieldsPerSec: cases.flowfield.opsPerSec,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} (${label})${tier ? ` tier ${tier}` : ''} flowfield ${cases.flowfield.opsPerSec.toFixed(1)} per s`);
}

if (isCli(import.meta.url)) await main();
