import test from 'node:test';
import assert from 'node:assert/strict';

import { appendMismatches } from '../../tests/bench/runPredatorAbab.mjs';

// Review M9. --append pooled new pairs with an earlier sitting's pairs without
// checking they measured the same thing: a changed metric set (a load key
// added, a stat whose meaning changed), another scene, protocol, baseline or
// working tree all mixed silently into one median.

const stamp = () => ({
  schema: { kinds: ['logic', 'preRender'], loadKeys: ['BODY_COUNT'], subTimers: ['EMIT_MS'] },
  scene: { path: '/demos/predatorScene/predatorScene.js', exportName: 'PredatorScene' },
  protocol: { headed: true, detailedStats: false, warmupMs: 10000, durationMs: 10000, query: '', extraArgs: [] },
  vs: null,
  overrides: { 'src/a.js': 'C:/x/a.js' },
  tree: { head: 'abc123', diff: 'd1' },
});

test('a sitting written before the stamp existed cannot be appended to', () => {
  assert.deepEqual(appendMismatches({ pairs: [] }, stamp()).length, 1);
});

test('an identical stamp may be appended to', () => {
  assert.deepEqual(appendMismatches({ stamp: stamp(), pairs: [] }, stamp()), []);
});

test('each kind of difference is named', () => {
  const now = stamp();
  const prev = stamp();
  prev.schema.loadKeys = ['BODY_COUNT', 'RENDER_QUEUE_SIZE'];
  prev.tree.diff = 'd0';
  prev.protocol.warmupMs = 8000;
  assert.deepEqual(appendMismatches({ stamp: prev, pairs: [] }, now), ['schema', 'protocol', 'tree']);
});

// Review M9. readjudicateAbab read protocol.owner / protocol.metric, which no
// summary contains; a refused sitting's decision has no owner either, so the
// re-adjudication ran with none. redecide reads what the runner writes.
test('redecide takes the owner and metric the runner recorded', async () => {
  const { redecide } = await import('../../tests/bench/runPredatorAbab.mjs');
  const kinds = ['logic', 'spatial', 'physics', 'renderer', 'particle', 'preRender'];
  const side = (ms) => Object.fromEntries(kinds.map((k) => [`${k}_STEP_MS`, k === 'preRender' ? ms : 0.02]));
  const pairs = [0, 1, 2, 3].map(() => ({ A: side(7), B: side(7) }));
  const s = { owner: 'preRender', probe: { metric: 'EMIT_MS' }, decision: { verdict: 'REFUSED' }, pairs };
  const d = redecide(s);
  assert.equal(d.owner, 'preRender');
  assert.equal(d.metric, 'EMIT_MS');
});
