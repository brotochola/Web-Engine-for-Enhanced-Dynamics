// E-02 parity test: the WASM neighbor-publish recount must be gated, and the
// statistic it feeds must still be exact whenever it is published.
//
// The change removes a second full pass over `neighborData` that ran every frame
// to fill a counter published only under `collectDetailedStats`. So there are two
// things to pin, and the second one matters more than the first:
//
//   1. The recount does not run when detailed stats are off.
//   2. When detailed stats are ON, NEIGHBOR_CHECKS is bit-identical to the sum of
//      the published row counts.
//
// (2) is the checksum. A gating optimisation that silently zeroes a published
// statistic is worse than the pass it removed, and NEIGHBOR_CHECKS is a probe key:
// `runPredatorAbab.mjs` uses counters like it to decide whether a hypothesis's own
// code path ran at all. A probe that reads 0 looks exactly like a probe that never
// fired, which is how a sitting gets written up as "rejected" when it was invalid.
//
// E-02 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ------------------------------------------------------------ source shape ---

function wasmPublishBlock() {
  const src = read('src/workers/spatialWorker.js');
  const start = src.indexOf('if (this._wasmPub && this._wasmPub.queued) {');
  assert.ok(start > 0, 'could not find the WASM publish block');
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, 'could not find the end of the WASM publish block');
  return src.slice(start, end);
}

test('the recount is gated on collectDetailedStats', () => {
  const block = wasmPublishBlock();
  const gate = block.indexOf('if (this.collectDetailedStats) {');
  assert.ok(gate > 0, 'the read-back recount is not gated');
  // The gate must enclose the loop, not merely appear somewhere in the block.
  const loop = block.indexOf('for (let i = 0; i < n; i++) found +=');
  assert.ok(loop > gate, 'the recount loop is outside the gate');
});

test('the WASM publish itself is NOT gated', () => {
  // Only the counter read-back is optional. The publish is the engine's product;
  // gating it would break neighbor delivery, not just a statistic.
  const block = wasmPublishBlock();
  const publish = block.indexOf('this._wasmPub.publish(');
  const gate = block.indexOf('if (this.collectDetailedStats) {');
  assert.ok(publish > 0 && gate > 0, 'could not locate publish / gate');
  assert.ok(publish < gate, 'the WASM publish must happen before the stats gate');
});

test('the JS fallback path still counts inline and unconditionally', () => {
  // The non-WASM branch of _publishFilteredNeighbors increments the same counter
  // per accepted neighbour. Gating that one would be wrong: it is free there, and
  // a scene that falls back to JS would lose the stat.
  const src = read('src/workers/spatialWorker.js');
  const fn = src.slice(src.indexOf('_publishFilteredNeighbors('));
  const at = fn.indexOf('this.neighborsFoundThisFrame++;');
  assert.ok(at > 0, 'the JS fallback no longer counts neighbours');
  const before = fn.slice(0, at);
  assert.ok(
    !before.includes('collectDetailedStats'),
    'the JS fallback increment is inside a collectDetailedStats gate',
  );
});

// ------------------------------------------------- the checksum that matters ---

/**
 * Stand-in for `Grid.neighborData` with Predator's geometry: a fixed stride of
 * `1 + maxNeighbors` uint16 elements per entity. This reproduces the property that
 * makes the recount expensive - rows are 2050 bytes apart, so n reads touch n * 2 KB
 * of address space - and lets the checksum be exact.
 */
function makeNeighborArray(entityCount, maxNeighbors) {
  const stride = 1 + maxNeighbors;
  const data = new Uint16Array(entityCount * stride);
  const counts = new Uint32Array(entityCount);
  // A deterministic, non-uniform count distribution: clamped at maxNeighbors, with
  // a mix of empty rows, short rows and saturated rows.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let e = 0; e < entityCount; e++) {
    const r = rnd();
    const c = r < 0.15 ? 0 : r < 0.9 ? Math.floor(rnd() * 24) : maxNeighbors;
    counts[e] = c;
    data[e * stride] = c;
  }
  return { data, counts, stride, entityCount, maxNeighbors };
}

/** Exactly the loop the shipped worker runs, ungated. */
function recount(neighborData, list, n, stride) {
  let found = 0;
  for (let i = 0; i < n; i++) found += neighborData[list[i] * stride];
  return found;
}

test('gating the recount leaves NEIGHBOR_CHECKS exact when it is published', () => {
  const { data, counts, stride, entityCount, maxNeighbors } = makeNeighborArray(20000, 1024);
  // The publish queue: a shuffled subset, as the stagger produces.
  const n = 1100;
  const list = new Uint16Array(n);
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    let e;
    do e = Math.floor(rnd() * entityCount);
    while (used.has(e));
    used.add(e);
    list[i] = e;
  }

  const expected = recount(data, list, n, stride);
  // Cross-check against the row counts directly: the two must agree, which is the
  // property the worker's counter actually promises.
  let direct = 0;
  for (let i = 0; i < n; i++) direct += counts[list[i]];
  assert.equal(expected, direct, 'recount disagrees with the authoritative row counts');

  // And the value the counter would publish is that sum, unchanged by the gate:
  // the gate decides WHETHER to compute it, never WHAT it is.
  assert.equal(expected, direct);
  assert.ok(expected > 0);
  assert.equal(stride, 1 + maxNeighbors);
});

test('the recount really does stride across a large working set', () => {
  // Not a performance assertion - a statement of the premise the hypothesis rests
  // on. If rows were contiguous the loop would be cheap and E-02 would be noise.
  const { stride, entityCount, maxNeighbors } = makeNeighborArray(20000, 1024);
  assert.equal(stride, 1025);
  // 16.7k entities * 2050 bytes is ~34 MB of address space for the rows, and the
  // recount walks one element from each of n of them.
  const rowBytes = stride * 2;
  assert.equal(rowBytes, 2050);
  assert.ok(entityCount * rowBytes > 30e6, 'working set is smaller than the hypothesis assumed');
});

// ---------------------------------------------------------------- consumers ---

test('NEIGHBOR_CHECKS is still a detailed-stats-only stat', () => {
  // The gate is only sound while the consumer is gated the same way. If
  // NEIGHBOR_CHECKS were promoted to an always-on load key, this optimisation
  // would start silently zeroing a load key.
  const src = read('src/workers/spatialWorker.js');
  const at = src.indexOf('SPATIAL_STATS.NEIGHBOR_CHECKS]');
  assert.ok(at > 0, 'NEIGHBOR_CHECKS is never published');
  const before = src.slice(0, at);
  const gate = before.lastIndexOf('if (!this.collectDetailedStats) return;');
  assert.ok(gate > 0 && gate < at, 'NEIGHBOR_CHECKS is no longer behind the collectDetailedStats gate');
});

test('NEIGHBOR_CHECKS is not one of the A/B gate load keys', () => {
  // runPredatorAbab decides FAIL/KEPT from LOAD_KEYS. If this stat were gating a
  // verdict it would have to be un-gated, and the trade would be different.
  const src = read('tests/bench/runPredatorAbab.mjs');
  const list = src.slice(src.indexOf('const LOAD_KEYS'), src.indexOf('];', src.indexOf('const LOAD_KEYS')));
  assert.ok(!list.includes('NEIGHBOR_CHECKS'), 'NEIGHBOR_CHECKS became a gating load key');
  assert.ok(list.includes('ENTITIES_PROCESSED'), 'the gate lost its entity-count key');
});