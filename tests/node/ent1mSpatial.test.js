import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';
import { setActiveList } from '../bench/workerHarness.mjs';

// DX-ENT1M: neighbours at 1 048 575 entities. Two real spatial workers (spatialGather.wasm, spatialPublish.wasm) on a
// scene of 32-bit ids, every slot to 1 048 574, a few hundred of them active. The gather marks each candidate B with
// (frame, entityA) so a B listed in several cells joins A's row once; with the stamp's old 19 id bits, A and
// A + 2^19 marked alike, and the second of them in a batch lost every neighbour it shared with the first. Each cluster
// here holds such pairs, so each row must list every other member of its cluster, frame after frame, across the frame
// where the stamp's top bit turns on (2048) and the one where the marker is cleared (4095).

/** Every id the stamp's 20 bits hold (2^20 - 1 slots, ids 0 to 1 048 574). */
const N = (1 << 20) - 1;
const HALF = 1 << 19;
const CLUSTER_GAP = 400;

/** Clusters of entity ids, each a few (id, id ^ 2^19) pairs and the named edge ids. */
function clusters() {
  const out = [
    [1, 1 + HALF, 2, 2 + HALF, N - 1, 0],
    [65535, 65536, 65535 + HALF, 65536 + HALF, N - 2, HALF - 1],
    [HALF, N - 3, HALF + 3, 3, 700000, 700000 - HALF],
  ];
  const used = new Set(out.flat());
  const rng = mulberry32(0xe1);
  while (out.length < 120) {
    const c = [];
    while (c.length < 6) {
      const a = (rng() * HALF) | 0;
      const b = a + HALF;
      if (b >= N || used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      if (rng() < 0.5) c.push(a, b);
      else c.push(b, a);
    }
    out.push(c);
  }
  return out;
}

function rowOf(e) {
  const base = e * Grid._stride;
  return Array.from(Grid.neighborData.subarray(base + 1, base + 1 + Grid.neighborData[base])).sort((x, y) => x - y);
}

test('neighbours at 1 048 575 entities: ids 2^19 apart in one cluster each list the other and the rest', async (t) => {
  const k = await setupSpatialKernel({
    n: N,
    idWidth: 32,
    workers: 2,
    still: true,
    spatial: { maxNeighbors: 16, neighborReuseSkin: 0, neighborTickInterval: 1 },
  });
  t.after(() => bindEntityIdWidth(16));
  const groups = clusters();
  const ids = [];
  Transform.active.fill(0);
  Collider.active.fill(0);
  for (let g = 0; g < groups.length; g++) {
    const cx = 200 + CLUSTER_GAP * (g % 20);
    const cy = 300 + CLUSTER_GAP * ((g / 20) | 0);
    groups[g].forEach((e, j) => {
      Transform.active[e] = 1;
      Collider.active[e] = 1;
      Transform.x[e] = cx + 4 * j;
      Transform.y[e] = cy + 3 * (j & 1);
      Collider.radius[e] = 8;
      Collider.visualRange[e] = 100;
      ids.push(e);
    });
  }
  setActiveList(k.workers[0].activeEntitiesData.buffer, ids);

  const check = (label) => {
    let pairs = 0;
    for (const group of groups) {
      for (const e of group) {
        const want = group.filter((o) => o !== e).sort((x, y) => x - y);
        const got = rowOf(e);
        if (got.join() !== want.join()) assert.fail(`${label}: entity ${e}'s row ${got} is not ${want}`);
        pairs += got.length;
      }
    }
    return pairs;
  };

  let pairs = 0;
  for (let f = 0; f < 3; f++) {
    k.frame();
    pairs += check(`frame ${k.workers[0]._processedFrameCounter}`);
  }
  for (const start of [2046, 4094]) {
    for (const w of k.workers) w._processedFrameCounter = start;
    for (let f = 0; f < 3; f++) {
      k.frame();
      pairs += check(`stamp frame ${k.workers[0]._processedFrameCounter}`);
    }
  }
  assert.equal(k.workers[0]._processedFrameCounter, 2, 'the counter wrapped past 4095 to 1, then 2');
  assert.equal(pairs, 9 * 120 * 6 * 5, `rows were published (${pairs} entries)`);
  const owners = k.workers.map((w) => w.entitiesProcessedThisFrame);
  assert.ok(owners.every((c) => c > 0), `both workers own clusters (${owners})`);
});
