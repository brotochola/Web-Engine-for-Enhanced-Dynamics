import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// SST-21: every entity with a visualRange gets its neighbour list (that is what a visualRange is for), whatever its
// code has read so far, and an entity without one gets none. E-176 learnt the readers at run time instead: no type was
// marked before logic's first frame, so spatial's first frame built no list, its second built them all at once (Predator
// by night: 10 000 lists, 49 ms of search and 10 of publish), and logic's first frame read empty lists. On real spatial
// workers (spatialWorkerMicrobench's setupSpatialKernel), Predator's spatial settings and classes.

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
  let withRange = 0;
  for (let a = 0; a < k.n; a++) if (Collider.visualRange[a] > 0) withRange++;
  assert.equal(k.workers[0].neighborsRebuiltThisFrame, withRange, 'frame 1 searched every entity with a visualRange');
});
