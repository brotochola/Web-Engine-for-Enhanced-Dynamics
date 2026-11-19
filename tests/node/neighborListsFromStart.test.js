import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';
import { postedMessages } from '../bench/workerHarness.mjs';

// SST-21: every entity with a visualRange gets its neighbour list (that is what a visualRange is for), whatever its
// code has read so far, and an entity without one gets none. E-176 learnt the readers at run time instead: no type was
// marked before logic's first frame, so spatial's first frame built no list, its second built them all at once (Predator
// by night: 10 000 lists, 49 ms of search and 10 of publish), and logic's first frame read empty lists. And the scene
// primes the spatial workers before the start (Scene._primeSpatial): every worker's grid, then every list, so the first
// frames after it rebuild only what their schedule says. On real spatial workers (spatialWorkerMicrobench's
// setupSpatialKernel), Predator's spatial settings and classes.

const N = 2000;
const WORLD = { worldWidth: 3000, worldHeight: 2000 };

/** Entity a's published row, sorted. */
function row(a) {
  const base = a * Grid._stride;
  const out = [];
  for (let i = 0; i < Grid.neighborData[base]; i++) out.push(Grid.neighborData[base + 1 + i]);
  return out.sort((x, y) => x - y);
}

/**
 * Entity a's neighbours by brute force, as the publish filters them (tests/reference/spatialGather.mjs): every other
 * active entity whose latched pose is within a's visualRange plus its own half extent. The search walks a circle of
 * whole cells around a's cell, which leaves out a few far corners, so a list is a subset of this (nearly all of it).
 */
function inRange(k, a) {
  const pos = k.workers[0].entityPosData;
  const vr = Collider.visualRange[a];
  const ax = pos[a * 4];
  const ay = pos[a * 4 + 1];
  const out = new Set();
  for (let b = 0; b < k.n; b++) {
    if (b === a || !Transform.active[b]) continue;
    const dx = pos[b * 4] - ax;
    const dy = pos[b * 4 + 1] - ay;
    const r = vr + pos[b * 4 + 2];
    if (dx * dx + dy * dy < r * r) out.add(b);
  }
  return out;
}

/**
 * Every entity with a visualRange has its list (only entities in range, and nearly all of them), every other row is
 * clear. Returns the lists with a neighbour.
 */
function assertRowsComplete(k, label) {
  let lists = 0;
  let clear = 0;
  let published = 0;
  let expected = 0;
  for (let a = 0; a < k.n; a++) {
    if (Collider.visualRange[a] > 0) {
      const got = row(a);
      const want = inRange(k, a);
      for (const b of got) assert.ok(want.has(b), `${label}: entity ${a}'s list holds ${b}, out of its range`);
      published += got.length;
      expected += want.size;
      if (got.length > 0) lists++;
    } else {
      assert.equal(Grid.neighborData[a * Grid._stride], 0, `${label}: entity ${a} has no visualRange, and a list`);
      clear++;
    }
  }
  assert.ok(published >= expected * 0.97, `${label}: ${published} neighbours published of ${expected} in range`);
  assert.ok(lists > k.n / 2, `${label}: ${lists} lists with neighbours`);
  assert.ok(clear > 0, `${label}: some entities have no visualRange`);
  return lists;
}

test('the first frame builds the list of every entity with a visualRange, of any class, and none for the others', async () => {
  const k = await setupSpatialKernel({ n: N, workers: 1, types: 'predator', spatial: WORLD });
  k.frame();
  assertRowsComplete(k, 'frame 1');
  assert.equal(rebuilt(k), withRange(k), 'frame 1 searched every entity with a visualRange');
});

/** Lists the workers searched in their last frame or prime round. */
function rebuilt(k) {
  let n = 0;
  for (const w of k.workers) n += w.neighborsRebuiltThisFrame;
  return n;
}

function withRange(k) {
  let n = 0;
  for (let a = 0; a < k.n; a++) if (Transform.active[a] && Collider.visualRange[a] > 0) n++;
  return n;
}

/**
 * Scene._primeSpatial's two rounds, through the workers' own message handler: every worker's grid, then every worker's
 * lists. Each round's answers come back with their id and load marks.
 */
async function prime(k) {
  const posted = postedMessages();
  let id = 0;
  for (const phase of ['grid', 'neighbors']) {
    id++;
    const from = posted.length;
    for (const w of k.workers) await w.handleMessage({ data: { msg: 'spatialPrime', id, phase } });
    const answers = posted.slice(from).filter((m) => m && m.msg === 'spatialPrimeDone');
    assert.equal(answers.length, k.workers.length, `every worker answers the ${phase} round`);
    for (const m of answers) {
      assert.equal(m.id, id);
      assert.ok(m.loadMarks.includes(`${phase} primed`), `the ${phase} round's mark`);
    }
  }
}

test('the prime builds every list before the first frame, on two spatial workers, and the first frame rebuilds few', async () => {
  const k = await setupSpatialKernel({ n: N, workers: 2, types: 'predator', spatial: WORLD });
  await prime(k);
  const primed = rebuilt(k);
  assert.equal(primed, withRange(k), 'the prime searched every entity with a visualRange');
  assertRowsComplete(k, 'after the prime');
  // Spatial's first frame after the start (logic's frame 1): the lists its schedule and the skin say, where without the
  // prime it searched every one (the test above).
  k.frame();
  const first = rebuilt(k);
  assert.ok(first < primed / 4, `the first frame after the prime rebuilt ${first} lists of ${primed}`);
});

test('the prime\'s lists are the ones a frame builds when every list is due, every worker\'s rows read', async () => {
  const k = await setupSpatialKernel({ n: N, workers: 2, still: true, types: 'predator', spatial: WORLD });
  await prime(k);
  const primedRows = [];
  for (let a = 0; a < k.n; a++) primedRows.push(row(a));
  // Every list due again: none kept by the schedule or the skin.
  for (const w of k.workers) {
    w._candidateCountOf.fill(0);
    w._entityReuseInitialized.fill(0);
  }
  k.frame();
  assert.equal(rebuilt(k), withRange(k));
  for (let a = 0; a < k.n; a++) assert.deepEqual(row(a), primedRows[a], `entity ${a}'s list`);
});
