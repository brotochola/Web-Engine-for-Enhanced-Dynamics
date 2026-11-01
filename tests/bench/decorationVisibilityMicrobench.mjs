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
 *   node tests/bench/decorationVisibilityMicrobench.mjs [--on-screen 0.51] [--order random|sorted] [--output path]
 */
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { checksumInts, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { setupSwayKernel } from './decorationSwayWasmMicrobench.mjs';

const args = parseArgs();
const ON_SCREEN = Number(args['on-screen'] ?? 0.51);
const ORDER = String(args.order ?? 'random');
if (ORDER !== 'random' && ORDER !== 'sorted') throw new Error(`--order random or sorted, not ${ORDER}`);
const WORLD_W = 10000;
const WORLD_H = 5000;

const { worker, n } = await setupSwayKernel();
if (!worker.cameraData) worker.cameraData = new Float32Array(16);
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
// Zoom 1, the camera at the origin, a canvas as wide as the view: no margin.
calculateCameraScreenBounds(1, 0, 0, WORLD_W * ON_SCREEN, WORLD_H, 0, worker._cameraBounds, 0);

// The worker's per-frame entry: E-179's updateDecorationScreen where the tree has it (it picks the copy and samples
// the flips), else the shipped method.
const test = typeof worker.updateDecorationScreen === 'function'
  ? () => worker.updateDecorationScreen()
  : () => worker.updateDecorationScreenVisibility();

function call() {
  worker._frameCamValid = true;
  test();
}

function checksum() {
  const visible = worker.visibleDecorationsData;
  return (checksumInts(visible, visible[0] + 1) ^ checksumInts(DecorationComponent.isItOnScreen, n)) >>> 0;
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
  onScreen: visible,
  checksum: sum,
  ms: r.ms,
  opsPerSec: r.opsPerSec,
  nsPerDecoration: 1e9 / r.opsPerSec / n,
};
console.log(
  `decorations ${n} (${ORDER}), on screen ${visible}, checksum ${sum}: ${r.opsPerSec.toFixed(1)} calls/s, ` +
    `${report.nsPerDecoration.toFixed(2)} ns a decoration`,
);
if (args.output) writeReport(String(args.output), report);
