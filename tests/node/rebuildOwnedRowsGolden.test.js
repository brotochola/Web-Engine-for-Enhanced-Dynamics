import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-471, E-472: SpatialWorker.rebuildOwnedRows' bytes on a scripted world (tests/helpers/rebuildOwnedRowsGoldenWorker.mjs):
// sprite-only points (NaN offsets among them), circles (radius 0 and NaN), turned boxes, polygons through
// getColliderBounds, entities with neither, colliders without a sprite, points a hair from a row's edge (float32
// home row and cell row differ), places past every edge, cells over their cap, a frame where nothing moves, the
// detailed stats on and off, a frame with no active list. Each frame hashes the grid, the poses, each worker's owned
// list, its count of sprites without a body, its pose-changed flag and the counts it wrote. The hashes were taken with
// the rebuild as it was before E-471 (its arrays checked inside the entity loop, the cell range through
// _cellRangeResult); a change that moves a byte changes them. Each run is its own thread (Grid is static state).

const GOLDEN = {
  'w2 id16 rpb2': [2753429207, 1488400095, 4175410110, 1779043642, 2730719813, 447048854, 578882480, 1156268621, 623033402, 2727828197],
  'w3 id32 rpb1': [498342257, 1016484432, 1292081224, 995006252, 85095667, 1856432777, 3008765941, 2918066885, 3724977066, 86623368],
};

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/rebuildOwnedRowsGoldenWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

for (const [workers, idWidth, rowsPerBlock] of [
  [2, 16, 2],
  [3, 32, 1],
]) {
  const key = `w${workers} id${idWidth} rpb${rowsPerBlock}`;
  test(`rebuildOwnedRows writes the bytes it wrote before E-471 (${key})`, async () => {
    const r = await run({ workers, idWidth, rowsPerBlock });
    // The world reaches the cases it is meant to hold.
    assert.ok(r.crossers >= 10, `${r.crossers} points whose float32 home row is not their cell's row`);
    assert.ok(r.capped >= 5, `${r.capped} cells at their cap`);
    assert.ok(r.points >= 500, `${r.points} sprite-only points`);
    assert.deepEqual(r.sums, GOLDEN[key]);
  });
}
