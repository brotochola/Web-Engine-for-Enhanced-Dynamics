#!/usr/bin/env node
/**
 * Kernel (E-179): the particle worker's decoration screen test, ParticleWorker.updateDecorationScreenVisibility, on a
 * real particle worker with Predator's grass (setupSwayKernel: 20 000 blades at random points of a 10 000 x 5 000
 * world, the snapshot in spawn order). The view is the left part of the world (--on-screen, default 0.51: about 10 200
 * blades on screen), so the on-screen flags in snapshot order are as random as the positions, as in Predator.
 *
 * The frame's camera bounds are the worker's own (_cameraBounds, filled by calculateCameraScreenBounds) and marked valid
 * before each call, as update() leaves them after the particle lists. Checksum: the visible list and the flags.
 *
 * --order sorted puts the snapshot in x order, so the blades on screen are one run of it: the outcome of the screen
 * test is as predictable as in decorationSwayStressScene's grid, against Predator's random order (the default).
 *
 * --grid (E-335): Predator's view instead, a 1920 x 1080 canvas at zoom 1 over the middle of the world (--view-w,
 * --view-h; about 4 % of the blades on screen), with what a scene has and the default case lacks: DecorationSpatial's
 * grid at Predator's cell size (128, --cell-size) holding every blade, and the pool's list header with its counters
 * (64 bytes, as sceneSharedBuffers allocates). Each timed call stands for a frame the camera moved: E-179c's record of
 * the last bounds is cleared first, so the test runs. Before timing, a pan of 240 frames (37 px right and 23 px down a
 * frame, then back) checksums every frame's visible list and flags, decorations leaving the view included, into
 * panChecksum: a revision that walks the grid must print the same.
 *
 *   node tests/bench/decorationVisibilityMicrobench.mjs [--on-screen 0.51] [--order random|sorted] [--output path]
 *   node tests/bench/decorationVisibilityMicrobench.mjs --grid [--view-w 1920] [--view-h 1080] [--cell-size 128]
 */
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { PoolSlotArray, poolSlotBytes } from '../../src/util/poolSlotWidth.js';
import { checksumInts, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { setupSwayKernel } from './decorationSwayWasmMicrobench.mjs';

const args = parseArgs();
const ON_SCREEN = Number(args['on-screen'] ?? 0.51);
const ORDER = String(args.order ?? 'random');
if (ORDER !== 'random' && ORDER !== 'sorted') throw new Error(`--order random or sorted, not ${ORDER}`);
const GRID = Boolean(args.grid);
const VIEW_W = Number(args['view-w'] ?? 1920);
const VIEW_H = Number(args['view-h'] ?? 1080);
const CELL = Number(args['cell-size'] ?? 128);
const PAN_FRAMES = 240;
const WORLD_W = 10000;
const WORLD_H = 5000;

const { worker, n } = await setupSwayKernel(GRID ? { listCounters: true } : {});
if (!worker.cameraData) worker.cameraData = new Float32Array(16);
if (GRID) {
  // DecorationSpatial as sceneSharedBuffers lays it out, every blade indexed (setupSwayKernel spawned them before it).
  const gridWidth = Math.ceil(WORLD_W / CELL);
  const gridHeight = Math.ceil(WORLD_H / CELL);
  const slotBytes = poolSlotBytes(n);
  DecorationSpatial.initialize(
    {
      head: new SharedArrayBuffer(gridWidth * gridHeight * slotBytes),
      next: new SharedArrayBuffer(n * slotBytes),
      prev: new SharedArrayBuffer(n * slotBytes),
      cellOf: new SharedArrayBuffer(n * Int32Array.BYTES_PER_ELEMENT),
      lock: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    },
    { cellSize: CELL, gridWidth, gridHeight, maxDecorations: n },
    true
  );
  const snapshot = worker._activeDecorationSnapshot;
  for (let k = 0; k < n; k++) DecorationSpatial.insert(snapshot[k]);
}
if (ORDER === 'sorted') {
  const x = DecorationComponent.x;
  const snapshot = worker._activeDecorationSnapshot;
  const ids = Array.from(snapshot.subarray(0, n));
  ids.sort((a, b) => (x[a] < x[b] ? -1 : x[a] > x[b] ? 1 : a - b));
  snapshot.set(ids);
}
// The list pre-render reads, as abstractWorker binds it from the scene's buffers.
const SlotArray = PoolSlotArray(n);
worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
// Zoom 1, the camera at the origin, a canvas as wide as the view: no margin. --grid: Predator's canvas mid-world.
const CAM_X = GRID ? (WORLD_W - VIEW_W) / 2 : 0;
const CAM_Y = GRID ? (WORLD_H - VIEW_H) / 2 : 0;
const placeCamera = (cx, cy) =>
  GRID
    ? calculateCameraScreenBounds(1, cx, cy, VIEW_W, VIEW_H, 0, worker._cameraBounds, 0)
    : calculateCameraScreenBounds(1, 0, 0, WORLD_W * ON_SCREEN, WORLD_H, 0, worker._cameraBounds, 0);
placeCamera(CAM_X, CAM_Y);

// The worker's per-frame entry: E-179's updateDecorationScreen where the tree has it (it picks the copy and samples
// the flips), else the shipped method.
const test = typeof worker.updateDecorationScreen === 'function'
  ? () => worker.updateDecorationScreen()
  : () => worker.updateDecorationScreenVisibility();

function call() {
  worker._frameCamValid = true;
  // --grid: a frame the camera moved (E-179c holds the test while the bounds and the lists stand still).
  if (GRID && worker._decoScreenBounds) worker._decoScreenBounds[0] = NaN;
  test();
}

function checksum() {
  const visible = worker.visibleDecorationsData;
  return (checksumInts(visible, visible[0] + 1) ^ checksumInts(DecorationComponent.isItOnScreen, n)) >>> 0;
}

// --grid: a pan out and back, each frame's list and flags folded into one checksum.
let panChecksum = 0;
if (GRID) {
  for (let f = 0; f < PAN_FRAMES; f++) {
    const t = f < PAN_FRAMES / 2 ? f : PAN_FRAMES - f;
    placeCamera(CAM_X - 1500 + t * 37, CAM_Y - 900 + t * 23);
    call();
    panChecksum = (Math.imul(panChecksum, 31) + checksum()) >>> 0;
  }
  placeCamera(CAM_X, CAM_Y);
}

warmNormalCompile(call, 300);
call();
const visible = worker.visibleDecorationsData[0];
const sum = checksum();
const r = timeIt('updateDecorationScreenVisibility', call, { reps: 9 });
if (checksum() !== sum) throw new Error('the checksum moved between calls');
const report = {
  kernel: 'decorationVisibility',
  decorations: n,
  order: ORDER,
  grid: GRID,
  onScreen: visible,
  checksum: sum,
  panChecksum,
  ms: r.ms,
  opsPerSec: r.opsPerSec,
  nsPerDecoration: 1e9 / r.opsPerSec / n,
};
console.log(
  `decorations ${n} (${GRID ? 'grid view' : ORDER}), on screen ${visible}, checksum ${sum}` +
    `${GRID ? `, pan checksum ${panChecksum}` : ''}: ${r.opsPerSec.toFixed(1)} calls/s, ` +
    `${report.nsPerDecoration.toFixed(2)} ns a decoration`,
);
if (args.output) writeReport(String(args.output), report);
