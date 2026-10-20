import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { readTextureUpload } from '../../src/core/layerTextureUpload.js';

// B29 (texture-upload seqlock is single-writer). Several logic workers can mark
// the same layer texture. Two writers merged into the pending rectangle at once
// and the later store dropped the other's region (4 of 200 contended rounds in
// a two-thread probe). A writer now claims the slot (GEN even -> odd, by CAS)
// and waits while another writer holds it.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const GEN = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a writer waits while another writer holds the slot, then lands its rectangle', async () => {
  const sab = new SharedArrayBuffer(64);
  const view = new Int32Array(sab);
  Atomics.store(view, GEN, 1); // another writer is mid-write
  const modUrl = pathToFileURL(join(root, 'src/core/layerTextureUpload.js')).href;
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     import(workerData.modUrl).then((m) => {
       m.writeTextureUpload(new Int32Array(workerData.sab), 7, 9, 2, 3, 100, 100, 0, 0);
       parentPort.postMessage('done');
     });`,
    { eval: true, workerData: { sab, modUrl } },
  );
  let done = false;
  worker.once('message', () => {
    done = true;
  });
  try {
    await wait(150);
    assert.equal(done, false, 'the writer must not run during another write');
    assert.equal(Atomics.load(view, GEN), 1);
    // The other writer finishes: its rectangle, then an even generation.
    view.set([50, 50, 1, 1], 1); // X, Y, W, H
    Atomics.store(view, GEN, 2);
    for (let i = 0; i < 100 && !done; i++) await wait(10);
    assert.equal(done, true);
    assert.equal(Atomics.load(view, GEN), 4, 'its own odd/even pair');
    const out = {};
    assert.ok(readTextureUpload(view, out));
    // Both writers' regions survive: the union of (50,50,1,1) and (7,9,2,3).
    assert.deepEqual([out.x, out.y, out.w, out.h], [7, 9, 44, 42]);
  } finally {
    await worker.terminate();
  }
});
