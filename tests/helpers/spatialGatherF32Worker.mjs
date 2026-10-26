// Thread for tests/node/spatialGatherF32.test.js: real spatial workers in WASM mode (spatialWorkerMicrobench's
// Predator mix), the gather shipped or a float32 one in lock step with a reference
// (tests/bench/spatialGatherTolerance.mjs). Posts every frame's checksum of the neighbour rows and counters,
// and the lock step's tally. Each thread has its own Grid statics.
//
// workerData: spatial, n, workers, frames; variant: null (the shipped gather alone), 'f32' or 'f32x4';
// reference: 'shipped' or 'f32' (f32x4 against the scalar float32 kernel, strict); keep: whose rows stay;
// edge: put candidates on their range edge first (frames then run without drift); mutant: the variant's
// search range 2^-12 wider.
import { parentPort, workerData } from 'node:worker_threads';

import { Grid } from '../../src/core/grid.js';
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { lockstepGather, loadGatherF32, newGatherStats } from '../bench/spatialGatherTolerance.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const { spatial, n, workers, frames, variant = null, reference = 'shipped', keep = 'reference', edge = false, mutant = false } = workerData;
const k = await setupSpatialKernel({ n, workers, spatial, wasm: { spatialGather: true }, publishMemory: 'product' });
const stats = newGatherStats();
if (variant) {
  const fns = await loadGatherF32(k.mem.memory);
  const fn = fns[`gather_batch_${variant}`];
  const v = mutant ? (...a) => fn(...a.map((x, q) => (q === 13 ? x + 2 ** -13 : x))) : fn;
  for (const w of k.workers) {
    lockstepGather(w, { reference: reference === 'f32' ? fns.gather_batch_f32 : null, variant: v, keep, stats, strict: reference === 'f32' });
  }
}

/**
 * Edge pairs: for a third of the entities with a range, another entity moved onto its range edge (the search
 * range plus that entity's half extent, as the gather has it), then one float32 step in or out or none.
 */
function placeOnEdges() {
  const pos = k.workers[0].entityPosData;
  const r = mulberry32(0xed6e);
  const used = new Uint8Array(k.n);
  const f = Math.fround;
  let placed = 0;
  for (let a = 0; a < k.n; a++) {
    if (used[a] || r() > 0.33) continue;
    const range = Collider.visualRange[a];
    if (!(range > 0)) continue;
    const b = (r() * k.n) | 0;
    if (b === a || used[b]) continue;
    const skinFrac = k.workers[0]._neighborReuseSkin;
    const er = range + 2 * (range * skinFrac) + pos[b * 4 + 2];
    const ang = r() * Math.PI * 2;
    let x = f(pos[a * 4] + er * Math.cos(ang));
    const y = f(pos[a * 4 + 1] + er * Math.sin(ang));
    const step = Math.max(Math.abs(x) * 2 ** -23, 2 ** -126);
    const nudge = r();
    x = f(x + (nudge < 0.33 ? step : nudge < 0.66 ? -step : 0));
    if (!(x > 1 && y > 1 && x < k.cfg.worldWidth - 1 && y < k.cfg.worldHeight - 1)) continue;
    Transform.x[b] = x;
    Transform.y[b] = y;
    used[a] = 1;
    used[b] = 1;
    placed++;
  }
  return placed;
}

const sums = [];
let placed = 0;
if (edge) {
  k.frame(); // poses, ranges and half extents in the memory
  placed = placeOnEdges();
  stats.calls = 0;
  for (const key of Object.keys(stats)) if (typeof stats[key] === 'number') stats[key] = 0;
  stats.problems.length = 0;
  for (let f = 0; f < frames; f++) {
    for (const w of k.workers) w.update(16.67, 1, false);
    sums.push(k.checksum());
  }
} else {
  for (let f = 0; f < frames; f++) {
    k.frame();
    sums.push(k.checksum());
  }
}
let published = 0;
for (let i = 0; i < k.n; i++) published += Grid.neighborData[i * Grid._stride];
parentPort.postMessage({ sums, stats, published, placed, bound: k.workers.map((w) => Boolean(w._wasmGather)) });
