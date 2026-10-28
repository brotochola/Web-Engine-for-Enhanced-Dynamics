// Thread for tests/node/spatialKeptRowSkip.test.js (E-136). A still world on three spatial workers with the engine's
// reuse defaults (skin 0.04, 15 frames, no stagger), where a script moves, reshapes and hides a few entities, each
// in the rows of one worker; posts the neighbour rows' checksum and the rows published and rebuilt every frame.
// `skip` false hands the workers a layout without the sync region: every kept row is published again (the engine
// before E-136).
// Mutants the test must catch: `perWorker` gives each worker a generation of its own, so a pose another worker
// wrote goes unseen; `noClear` forgets that a row cleared for a range of 0 no longer holds what was published.
import { parentPort, workerData } from 'node:worker_threads';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';
import { variantClass } from '../bench/methodVariant.mjs';
import { SCOPE, setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const { skip, mutant = null, frames = 70 } = workerData;

const CFG = {
  worldWidth: 4096,
  worldHeight: 3072,
  cellSize: 128,
  maxNeighbors: 96,
  rowsPerBlock: 2,
  neighborReuseSkin: 0.04,
  neighborReuseMaxFrames: 15,
  neighborTickInterval: 1,
};
const N = 3000;

const k = await setupSpatialKernel({
  n: N,
  workers: 3,
  still: true,
  spatial: CFG,
  publishMemory: skip
    ? undefined
    : (n, maxN, workers, gm) => ({
        ...createSpatialPublishMemory(n, maxN, workers, {
          totalCells: gm.totalCells,
          cellByteSize: 4 + gm.maxEntitiesPerCell * gm.entityIdBytes,
        }),
        syncByte: 0,
      }),
  make:
    mutant === 'noClear'
      ? (Base) =>
          variantClass(
            Base,
            [{ method: '_findNeighbors', edits: [['rowPoseGen[entityA] = POSE_GEN_NONE;', '']] }],
            { ...SCOPE, POSE_GEN_NONE: 1 },
          )
      : undefined,
});
if (mutant === 'perWorker') {
  for (const w of k.workers) w._poseGen = new Int32Array(new SharedArrayBuffer(4));
}

// The worker whose rows hold every row an entity's circle covers (-1 when it spans two workers' rows).
const ownerOfRow = (row) => ((row / CFG.rowsPerBlock) | 0) % 3;
function soleOwner(i) {
  const r = Collider.radius[i];
  const y = Transform.y[i];
  const top = ownerOfRow(((y - r) / CFG.cellSize) | 0);
  return ownerOfRow(((y + r) / CFG.cellSize) | 0) === top ? top : -1;
}
/** The first entity with a visual range, at least `from`, that only worker `w` writes. */
function entityOf(w, from = 0) {
  for (let i = from; i < N; i++) if (Collider.visualRange[i] > 0 && soleOwner(i) === w) return i;
  throw new Error(`no entity in worker ${w}'s rows`);
}
const first = entityOf(0);
const last = entityOf(2);
const reshaped = entityOf(1);
const hidden = entityOf(0, first + 1);
const hiddenRange = Collider.visualRange[hidden];
const walker = entityOf(1, reshaped + 1);

function script(f) {
  // Within the skin (0.04 of a 150 px range is 6 px): the lists are kept, the poses are not the same.
  if (f === 10) Transform.x[first] += 3;
  // Written by the worker that updates last: the other two see it the frame after.
  if (f === 18) Transform.y[last] += 2;
  // The extent alone.
  if (f === 24) Collider.radius[reshaped] += 1;
  // A row cleared (range 0), then the same range again with the list still kept.
  if (f === 30) Collider.visualRange[hidden] = 0;
  if (f === 32) Collider.visualRange[hidden] = hiddenRange;
  // A move and its way back, a frame apart.
  if (f === 40) Transform.x[walker] += 1;
  if (f === 41) Transform.x[walker] -= 1;
  // One step every third frame.
  if (f >= 50 && f % 3 === 0) Transform.y[walker] += 0.5;
}

const sums = [];
const published = [];
const rebuilt = [];
for (let f = 0; f < frames; f++) {
  script(f);
  k.frame();
  sums.push(k.checksum());
  published.push(k.workers.map((w) => w.neighborsPublishedThisFrame));
  rebuilt.push(k.workers.map((w) => w.neighborsRebuiltThisFrame));
}
parentPort.postMessage({ sums, published, rebuilt, entities: { first, last, reshaped, hidden, walker } });
