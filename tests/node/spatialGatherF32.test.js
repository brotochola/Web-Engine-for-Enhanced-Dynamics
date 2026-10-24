// The float32 candidate gathers (tests/fixtures/wasm/spatialGatherF32.wasm, from wasm/test/spatialGatherF32.c)
// against the shipped double gather (spatialGather.wasm), on real spatial workers in WASM mode with
// spatialGatherWasm.test.js's Predator mix, in lock step: each gather call runs the shipped kernel and the
// variant on the same input (tests/bench/spatialGatherTolerance.mjs). The tolerance: a candidate only one side
// keeps lies on its range edge, |d^2 - er^2| <= 2^-20 er^2 (Q5: float32 and double disagree only there), and
// every other candidate is the same, in the same order, with the same truncation and cells checked.
//
// Predator's reuse settings, every list rebuilt every frame, and rows that truncate at maxNeighbors 6 (40
// frames each): no candidate flips, and a float32 gather left to run on its own publishes the shipped rows
// frame for frame. A frame built on the edge (786 entities moved onto another's search range, one float32
// step in or out or none) flips a few, each within the tolerance, also where rows truncate. f32x4 gathers what
// the scalar float32 kernel gathers, bit for bit. Mutant: the float32 gather with a search range 2^-12 wider
// is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { EDGE_REL } from '../bench/spatialGatherTolerance.mjs';

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/spatialGatherF32Worker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

const CONFIGS = {
  predator: {},
  rebuild: { neighborReuseSkin: 0, neighborTickInterval: 1 },
  // Rows that hit maxNeighbors: the scalar tail truncates them, the f32x4 blocks stop four short of it.
  truncate: { neighborReuseSkin: 0, neighborTickInterval: 1, maxNeighbors: 6 },
};

const tally = (s) => {
  const { problems, ...rest } = s;
  return JSON.stringify(rest);
};

for (const [name, spatial] of Object.entries(CONFIGS)) {
  test(`the float32 gathers keep the shipped candidates (${name})`, async (t) => {
    const base = { spatial, n: 4000, workers: 3, frames: 40 };
    const [shipped, f32, f32x4, free, x4] = await Promise.all([
      run(base),
      run({ ...base, variant: 'f32' }),
      run({ ...base, variant: 'f32x4' }),
      // The float32 gather's own rows standing, as the bench times it.
      run({ ...base, variant: 'f32', keep: 'variant' }),
      // f32x4 against the scalar float32 kernel, any difference a failure.
      run({ ...base, variant: 'f32x4', reference: 'f32', keep: 'variant' }),
    ]);
    assert.deepEqual(shipped.bound, [true, true, true], 'the WASM gather is bound in every spatial worker');
    assert.ok(shipped.published > 0, 'neighbours are published');
    for (const [label, r] of Object.entries({ f32, f32x4, free, x4 })) {
      assert.equal(r.stats.unexplained, 0, `${label}: ${r.stats.problems.join('; ')}`);
      assert.ok(r.stats.calls >= 3 * base.frames && r.stats.rows > 1000, `${label}: the lock step ran (${r.stats.calls} calls)`);
      assert.ok(r.stats.worstRelGap <= EDGE_REL, `${label}: worst flip ${r.stats.worstRelGap}`);
    }
    // The lock step restores the shipped rows: the same frames as the shipped gather alone.
    for (const [label, r] of Object.entries({ f32, f32x4 })) {
      const first = shipped.sums.findIndex((s, i) => s !== r.sums[i]);
      assert.equal(first, -1, `${label} in lock step: rows or counters differ from frame ${first}`);
    }
    assert.equal(x4.stats.identicalRows, x4.stats.rows, 'f32x4 writes the scalar float32 rows');
    // Away from built edges a flip is rare (none in these frames); without one the float32 gather alone
    // publishes the shipped rows frame for frame.
    assert.ok(f32.stats.flips <= Math.max(2, f32.stats.pairs * 1e-6), `flips ${f32.stats.flips} of ${f32.stats.pairs}`);
    const firstFree = shipped.sums.findIndex((s, i) => s !== free.sums[i]);
    if (free.stats.flips === 0) assert.equal(firstFree, -1, `the float32 gather alone: rows or counters differ from frame ${firstFree}`);
    t.diagnostic(`f32 ${tally(f32.stats)}; f32x4 ${tally(f32x4.stats)}; alone, the first frame that differs: ${firstFree}`);
  });
}

test('on a frame built on range edges the float32 gathers flip only edge pairs, and a wider range is caught', async (t) => {
  const base = { spatial: CONFIGS.rebuild, n: 4000, workers: 3, frames: 2, edge: true };
  const cut = { ...base, spatial: CONFIGS.truncate };
  const [f32, f32x4, x4, mutant, f32Cut, x4Cut] = await Promise.all([
    run({ ...base, variant: 'f32' }),
    run({ ...base, variant: 'f32x4' }),
    run({ ...base, variant: 'f32x4', reference: 'f32' }),
    run({ ...base, variant: 'f32', mutant: true }),
    // The same edges with rows that truncate: a flip moves the cut.
    run({ ...cut, variant: 'f32' }),
    run({ ...cut, variant: 'f32x4', reference: 'f32' }),
  ]);
  assert.ok(f32.placed > 500, `${f32.placed} entities on an edge`);
  for (const [label, r] of Object.entries({ f32, f32x4, x4, f32Cut, x4Cut })) {
    assert.equal(r.stats.unexplained, 0, `${label}: ${r.stats.problems.join('; ')}`);
  }
  assert.ok(f32Cut.stats.flips > 0 && f32Cut.stats.truncatedRows > 0, 'flips in truncated rows');
  assert.equal(x4Cut.stats.identicalRows, x4Cut.stats.rows, 'f32x4 writes the scalar float32 rows where rows truncate');
  assert.ok(f32.stats.flips > 0, 'float32 flips some edge pairs (the comparison is exercised)');
  assert.ok(f32.stats.flips < f32.stats.pairs * 1e-3, `few flips: ${f32.stats.flips} of ${f32.stats.pairs} pairs`);
  assert.ok(f32.stats.worstRelGap <= EDGE_REL, `worst flip ${f32.stats.worstRelGap}`);
  assert.deepEqual([f32x4.stats.flips, f32x4.stats.worstRelGap], [f32.stats.flips, f32.stats.worstRelGap], 'f32x4 flips the same pairs');
  assert.equal(x4.stats.identicalRows, x4.stats.rows, 'f32x4 writes the scalar float32 rows');
  assert.ok(mutant.stats.unexplained > 0, 'a search range 2^-12 wider is caught');
  t.diagnostic(`edge frame (${f32.placed} placed): f32 ${tally(f32.stats)}; truncating ${tally(f32Cut.stats)}; mutant unexplained ${mutant.stats.unexplained}`);
});
