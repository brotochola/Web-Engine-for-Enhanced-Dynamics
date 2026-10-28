import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-136: a kept neighbour row is left out of the publish when no pose changed since its last publish (the spatial
// workers share a generation that each moves after writing a pose that changed). The rows must be the ones the
// workers publish without the skip, frame after frame, in a still world where a script moves an entity in each
// worker's rows (one written by the worker that updates last), changes an extent, clears a row with a range of 0
// and gives it back, and moves an entity and back a frame apart. Each run is its own thread (Grid is static state).

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/spatialKeptRowSkipWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

const total = (frame) => frame.reduce((s, v) => s + v, 0);

test('kept rows left out of the publish leave the rows the full publish leaves', async () => {
  const [plain, skip] = await Promise.all([run({ skip: false }), run({ skip: true })]);
  const first = plain.sums.findIndex((s, i) => s !== skip.sums[i]);
  assert.equal(first, -1, `rows differ from frame ${first}`);

  // Still frames publish only the rows rebuilt (the list-age cap, and lists cut at maxNeighbors, which are never
  // kept); the plain run publishes every kept row too.
  const plainRows = plain.published.reduce((s, f) => s + total(f), 0);
  const skipRows = skip.published.reduce((s, f) => s + total(f), 0);
  assert.ok(plainRows > 0);
  assert.ok(skipRows < plainRows * 0.4, `published ${skipRows} rows against ${plainRows}`);
  assert.deepEqual(skip.published[5], skip.rebuilt[5], 'a still frame publishes the rows it rebuilt, no kept row');
  assert.ok(total(plain.published[5]) > total(plain.rebuilt[5]) * 5);

  // A move in worker 0's rows: all three publish their kept rows that frame (worker 0 updates first).
  assert.deepEqual(skip.published[10], plain.published[10]);
  // A move only worker 2 writes: worker 2 publishes that frame, workers 0 and 1 the frame after.
  assert.deepEqual(skip.published[18].slice(0, 2), skip.rebuilt[18].slice(0, 2));
  assert.equal(skip.published[18][2], plain.published[18][2]);
  assert.deepEqual(skip.published[19].slice(0, 2), plain.published[19].slice(0, 2));
  assert.equal(skip.published[19][2], skip.rebuilt[19][2]);
});

test('a mutant of the skip is caught', async () => {
  const [plain, perWorker, noClear] = await Promise.all([
    run({ skip: false }),
    run({ skip: true, mutant: 'perWorker' }),
    run({ skip: true, mutant: 'noClear' }),
  ]);
  for (const [name, r] of [['perWorker', perWorker], ['noClear', noClear]]) {
    const first = plain.sums.findIndex((s, i) => s !== r.sums[i]);
    assert.notEqual(first, -1, `mutant ${name} was not caught`);
  }
});
