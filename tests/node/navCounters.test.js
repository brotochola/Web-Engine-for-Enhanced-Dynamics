// E-37: the nav counters that decide whether E-11, E-12 and E-14 are real.
//
// E-35, written after E-13 and E-21 both burned a hypothesis: a static reading produced
// a *frequency* claim the source did not support. Twice the description of what the
// code does was right and the "how often it runs" was supplied by the reader.
//
// E-11's premise is exactly that shape. "`computeFlowfield` runs five full-size `fill()`s
// plus a post-pass and a smoothing pass per request" is a true reading of the code. But
// `_processNextFlowfieldRequest` checks `_findExistingFlowfieldSlot` first and returns on
// a hit without computing anything, and the `REQUEST_FLOWFIELD` message handler checks
// the same LRU before it even enqueues. So "per request" and "per computation" can
// differ by orders of magnitude, and only the second one costs anything.
//
// The counter that answers it -- `flowfieldsComputedThisFrame` -- existed since the nav
// system landed, was incremented and zeroed every frame, and **was published nowhere**.
// It could not answer the question it was written to answer.
//
// This file pins three things:
//   1. the counters are published (the ADOBE_MS failure mode, in a new costume),
//   2. serviced counts requests and computed counts misses, so their ratio is the miss
//      rate and not two copies of the same number,
//   3. the load keys reach the A/B gate, so a nav hypothesis can tell "my code ran"
//      from "the cache was warm".
//
// E-37 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const worker = 'src/workers/particleWorker.js';

// ---------------------------------------------------------------------------
// 1. The slots
// ---------------------------------------------------------------------------

test('the nav stat slots exist and the stride accounts for them', async () => {
  const { PARTICLE_STATS: S } = await import('../../src/util/workersUtils.js');
  assert.equal(S.FLOWFIELDS_COMPUTED, 16);
  assert.equal(S.PATHS_COMPUTED, 17);
  assert.equal(S.FLOWFIELDS_SERVICED, 18);
  assert.equal(S.STRIDE_FLOATS, 19);
  assert.equal(S.BUFFER_SIZE, 19 * 4);
});

test('every particle stat slot is distinct, integer, and inside the stride', async () => {
  const { PARTICLE_STATS: S } = await import('../../src/util/workersUtils.js');
  const DERIVED = new Set(['STRIDE_FLOATS', 'BUFFER_SIZE']);
  const slots = Object.entries(S).filter(([k]) => !DERIVED.has(k) && typeof S[k] === 'number');
  const seen = new Map();
  for (const [k, v] of slots) {
    assert.ok(Number.isInteger(v), `${k} = ${v} is not an integer slot`);
    assert.ok(v >= 0 && v < S.STRIDE_FLOATS, `${k} = ${v} is outside the ${S.STRIDE_FLOATS}-slot stride`);
    assert.ok(!seen.has(v), `${k} and ${seen.get(v)} both claim slot ${v}`);
    seen.set(v, k);
  }
  assert.equal(seen.size, S.STRIDE_FLOATS, `stride is ${S.STRIDE_FLOATS} but ${seen.size} slots are used`);
});

test('no pre-existing particle stat moved when the three slots were added', async () => {
  // Renumbering would silently change what a saved sitting's sub-timer means.
  const { PARTICLE_STATS: S } = await import('../../src/util/workersUtils.js');
  const expected = {
    FPS: 0, ACTIVE_PARTICLES: 1, TOTAL_PARTICLES: 2, PARTICLES_STAMPED: 3,
    FLASHES_UPDATED: 4, DECAL_STAMP_MS: 5, ACTIVE_ENTITIES: 6, TOTAL_ENTITIES: 7,
    MSG_MS: 8, BUILD_ACTIVE_VISIBLE_MS: 9, PARTICLE_PHYSICS_MS: 10, STEP_MS: 11,
    ACTIVE_BULLETS: 12, ACTIVE_DECORATIONS: 13, WAIT_MS: 14, IDLE_MS: 15,
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(S[k], v, `${k} moved from slot ${v} to ${S[k]}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The counters mean different things
// ---------------------------------------------------------------------------

test('serviced counts requests and computed counts misses', () => {
  // If both were incremented at the same place their ratio would be 1 or 0 and the
  // number would say nothing. The whole instrument is that serviced is the
  // denominator and computed is the numerator.
  const src = code(worker);
  const svc = src.indexOf('this.flowfieldsServicedThisFrame++');
  const comp = src.indexOf('this.flowfieldsComputedThisFrame++');
  assert.ok(svc >= 0, 'flowfieldsServicedThisFrame is never incremented');
  assert.ok(comp >= 0, 'flowfieldsComputedThisFrame is never incremented');
  assert.notEqual(svc, comp, 'both counters are incremented at the same site');

  // Serviced is counted where a request arrives, before the message handler
  // answers a cached target: hits and coalesced repeats never reach the
  // processing loop (M2; behaviour in flowfieldServicedCount.test.js).
  const handler = src.slice(src.indexOf("case 'REQUEST_FLOWFIELD'"));
  const svcAt = handler.indexOf('this.flowfieldsServicedThisFrame++');
  const hitAt = handler.indexOf('this._findExistingFlowfieldSlot(targetCell)');
  assert.ok(svcAt >= 0 && hitAt >= 0);
  assert.ok(svcAt < hitAt, 'serviced is counted after the cached-target answer, so cache hits are not counted');
  // And computed sits on the miss path of the processing loop. (Offsets are
  // both taken inside the function: an absolute offset against a relative one
  // always passed.)
  const fn = src.slice(src.indexOf('_processNextFlowfieldRequest()'));
  const lruAt = fn.indexOf('this._findExistingFlowfieldSlot(targetCell)');
  const compAt = fn.indexOf('this.flowfieldsComputedThisFrame++');
  assert.ok(lruAt >= 0 && compAt >= 0);
  assert.ok(compAt > lruAt, 'computed is counted before the LRU search, so hits are counted as computations');
});

test('the LRU hit path the premise depends on still exists', () => {
  // If someone removes the cache as "redundant", E-11's premise changes completely and
  // this file's whole reasoning inverts. Say so.
  const src = code(worker);
  const proc = src.slice(src.indexOf('_processNextFlowfieldRequest()'), src.indexOf('_findExistingFlowfieldSlot(targetCell) {'));
  assert.match(proc, /if \(existingSlot >= 0\)[\s\S]*?return true;/, 'the processing-stage LRU early-out is gone');
  // And the message handler checks it too, so most hits never even enqueue.
  const handler = src.slice(src.indexOf("case 'REQUEST_FLOWFIELD'"), src.indexOf("case 'REQUEST_PATH'"));
  assert.match(handler, /_findExistingFlowfieldSlot/, 'the message handler no longer filters hits before enqueueing');
  assert.match(handler, /flowfieldRequests\.enqueue/, 'the message handler no longer enqueues misses');
});

test('all three counters are zeroed in the constructor AND per frame', () => {
  const src = code(worker);
  for (const f of ['flowfieldsComputedThisFrame', 'flowfieldsServicedThisFrame', 'pathsComputedThisFrame']) {
    const zeroes = src.match(new RegExp(`this\\.${f} = 0`, 'g')) || [];
    assert.ok(zeroes.length >= 2, `${f} is zeroed ${zeroes.length}x; it needs a constructor init and a per-frame reset`);
  }
});

// ---------------------------------------------------------------------------
// 3. Published, and reachable
// ---------------------------------------------------------------------------

test('the counters are published, and before the detailed-stats gate', () => {
  // The ADOBE_MS failure mode in a new costume: incremented, zeroed, published nowhere,
  // so the panel shows 0 forever and the phase looks free. E-37 exists because that is
  // exactly what happened to these three counters.
  const src = code(worker);
  const block = src.slice(src.indexOf('reportFPS() {'), src.indexOf('reportFPS() {') + 8192);
  for (const k of ['FLOWFIELDS_COMPUTED', 'FLOWFIELDS_SERVICED', 'PATHS_COMPUTED']) {
    assert.match(block, new RegExp(`stats\\[PARTICLE_STATS\\.${k}\\]`), `${k} is never published`);
  }
  const gate = block.indexOf('if (!this.collectDetailedStats) return;');
  assert.ok(gate > 0, 'the detailed-stats gate is missing from reportFPS');
  for (const k of ['FLOWFIELDS_COMPUTED', 'FLOWFIELDS_SERVICED', 'PATHS_COMPUTED']) {
    assert.ok(block.indexOf(`stats[PARTICLE_STATS.${k}]`) < gate, `${k} is published after the detailed gate`);
  }
});

test('the nav counters reach the A/B load gate', () => {
  // A nav hypothesis changes only what the particle worker does with flowfields. Without
  // these load keys the gate cannot distinguish "my code ran" from "the cache was warm",
  // which is the same blind spot VISIBLE_ENTITIES was added for.
  const abab = read('tests/bench/runPredatorAbab.mjs');
  for (const k of ['FLOWFIELDS_COMPUTED', 'FLOWFIELDS_SERVICED', 'PATHS_COMPUTED']) {
    assert.match(abab, new RegExp(`'${k}'`), `${k} is not a load key`);
  }
  const ml = read('tests/bench/measureLib.mjs');
  for (const k of ['FLOWFIELDS_COMPUTED', 'FLOWFIELDS_SERVICED', 'PATHS_COMPUTED']) {
    assert.match(ml, new RegExp(`${k}: particle\\.${k}`), `measureLib does not collect ${k}`);
  }
});

test('the debug panel shows both sides of the ratio', () => {
  // One without the other is not interpretable, and a panel that shows the miss count
  // alone would report a warm cache as an idle system.
  const u = read('src/util/workersUtils.js');
  assert.match(u, /\{ key: 'FLOWFIELDS_COMPUTED', label: 'FlowCalc'/, 'no panel row for FLOWFIELDS_COMPUTED');
  assert.match(u, /\{ key: 'FLOWFIELDS_SERVICED', label: 'FlowReq'/, 'no panel row for FLOWFIELDS_SERVICED');
  for (const k of ['FLOWFIELDS_COMPUTED', 'FLOWFIELDS_SERVICED', 'PATHS_COMPUTED']) {
    const row = code('src/util/workersUtils.js').slice(code('src/util/workersUtils.js').indexOf(`{ key: '${k}'`));
    assert.match(row.slice(0, 140), /STAT_KIND\.COUNT/, `${k} is not a COUNT row`);
  }
});