import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Grid } from '../../src/core/grid.js';
import { NeighborAggregates } from '../../src/core/neighborAggregates.js';
import { publishAggregatesJs } from '../reference/neighborAggregates.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// E-199 on the real SpatialWorker: a scene whose types ask for neighbour aggregates publishes, with each row, what
// the JS reference computes from that row's candidates and poses; the other types' rows are the plain ones; a row
// cleared (its visualRange gone) takes its aggregates' counts to 0.

const AGGREGATES = (c) => ({
  Civilian: { separation: { ofType: c.Soldier, floor: 10 }, nearest: { ofType: c.Soldier, count: 4 } },
  Soldier: { nearest: { ofType: c.Civilian, count: 4 } },
  Boid: { separation: { radius: 40, falloff: 'linear' }, cohesion: { minDistance: 40 } },
});

test('the spatial worker publishes each row of a type with aggregates together with them, as the reference computes', async () => {
  // One worker: with more, a later worker's poses move after an earlier one published, so a row is not recomputable.
  const k = await setupSpatialKernel({ n: 3000, workers: 1, types: 'predator', aggregates: AGGREGATES });
  assert.ok(k.aggregates, 'the memory has the aggregates');
  assert.equal(NeighborAggregates.nearestSlots, 4, 'NeighborAggregates bound by the worker\'s Grid.initialize');
  for (let f = 0; f < 40; f++) k.frame();
  const w = k.workers[0];
  const n = w.neighborsPublishedThisFrame;
  assert.ok(n > 100, `rows published on the last frame (${n})`);
  const stride = Grid._stride;
  const maxN = Grid.maxNeighbors;
  const pos = w.entityPosData;
  const io = { pos, range: w._wasmPub.range, cand: w._neighborCandidateData, rows: new Uint16Array(k.n * stride) };
  const ref = {
    separationX: new Float32Array(k.n),
    separationY: new Float32Array(k.n),
    separationCount: new Uint16Array(k.n),
    centroidX: new Float32Array(k.n),
    centroidY: new Float32Array(k.n),
    cohesionCount: new Uint16Array(k.n),
    averageVelocityX: new Float32Array(k.n),
    averageVelocityY: new Float32Array(k.n),
    nearestIndex: new Int32Array(k.n * 4),
    nearestDistanceSq: new Float32Array(k.n * 4),
    nearestCount: new Uint16Array(k.n),
    nearestSlots: 4,
  };
  const byIndex = (i) => k.aggregates.classes.find((t) => i >= t.startIndex && i < t.endIndex);
  const seen = { plain: 0, withAggregates: 0, nearest: 0 };
  for (let q = 0; q < n; q++) {
    const a = w._wasmPub.list[q];
    const t = byIndex(a);
    const label = `entity ${a}`;
    if (!t) {
      seen.plain++;
      continue;
    }
    seen.withAggregates++;
    publishAggregatesJs(a, io, maxN, t, ref, null, null);
    const row = Array.from(Grid.neighborData.subarray(a * stride, a * stride + 1 + Grid.neighborData[a * stride]));
    assert.deepEqual(row, Array.from(io.rows.subarray(a * stride, a * stride + 1 + io.rows[a * stride])), `${label}: row`);
    if (t.flags & 1) {
      assert.equal(NeighborAggregates.separationCount[a], ref.separationCount[a], `${label}: separationCount`);
      assert.ok(Object.is(NeighborAggregates.separationX[a], ref.separationX[a]), `${label}: separationX`);
      assert.ok(Object.is(NeighborAggregates.separationY[a], ref.separationY[a]), `${label}: separationY`);
    }
    if (t.flags & 2) {
      assert.equal(NeighborAggregates.cohesionCount[a], ref.cohesionCount[a], `${label}: cohesionCount`);
      assert.ok(Object.is(NeighborAggregates.centroidX[a], ref.centroidX[a]), `${label}: centroidX`);
      assert.ok(Object.is(NeighborAggregates.centroidY[a], ref.centroidY[a]), `${label}: centroidY`);
    }
    if (t.flags & 8) {
      const c = ref.nearestCount[a];
      assert.equal(NeighborAggregates.nearestCount[a], c, `${label}: nearestCount`);
      for (let s = 0; s < c; s++) {
        assert.equal(NeighborAggregates.nearestIndex[a * 4 + s], ref.nearestIndex[a * 4 + s], `${label}: nearest ${s}`);
        assert.ok(Object.is(NeighborAggregates.nearestDistanceSq[a * 4 + s], ref.nearestDistanceSq[a * 4 + s]));
      }
      seen.nearest += c;
    }
  }
  assert.ok(seen.plain > 0 && seen.withAggregates > 50 && seen.nearest > 0, JSON.stringify(seen));
});

test('a row cleared takes its aggregates\' counts to 0', async () => {
  const k = await setupSpatialKernel({ n: 2000, workers: 1, types: 'predator', aggregates: AGGREGATES });
  for (let f = 0; f < 20; f++) k.frame();
  const civilian = k.aggregates.classes.find((t) => t.name === 'Civilian');
  let target = -1;
  for (let i = civilian.startIndex; i < civilian.endIndex; i++) {
    if (NeighborAggregates.nearestCount[i] > 0 && Collider.visualRange[i] > 0) {
      target = i;
      break;
    }
  }
  assert.ok(target >= 0, 'a civilian with a soldier near');
  Collider.visualRange[target] = 0;
  k.frame();
  assert.equal(Grid.getNeighborCount(target), 0, 'its row is cleared');
  assert.equal(NeighborAggregates.nearestCount[target], 0);
  assert.equal(NeighborAggregates.separationCount[target], 0);
});
