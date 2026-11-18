import { test } from 'node:test';
import assert from 'node:assert/strict';

import { armOrder, armPairs } from '../bench/runMultiArm.mjs';

// N-239: a multi-arm sitting's order and pairs.
test('the arms rotate from round to round and reverse on odd rounds, each arm first and last in turn', () => {
  const labels = ['A', 'e1', 'e2'];
  const orders = [0, 1, 2, 3, 4, 5].map((r) => armOrder(labels, r));
  assert.deepEqual(orders[0], ['A', 'e1', 'e2']);
  assert.deepEqual(orders[1], ['A', 'e2', 'e1']);
  assert.deepEqual(orders[2], ['e2', 'A', 'e1']);
  for (const o of orders) assert.deepEqual([...o].sort(), [...labels].sort());
  // Over six rounds every arm runs first twice and last twice.
  for (const l of labels) {
    assert.equal(orders.filter((o) => o[0] === l).length, 2, `${l} first`);
    assert.equal(orders.filter((o) => o[o.length - 1] === l).length, 2, `${l} last`);
  }
});

test('an arm\'s pairs are each round\'s A against that round\'s arm', () => {
  const rounds = [
    { A: { x: 1 }, e1: { x: 2 }, e2: { x: 3 } },
    { A: { x: 4 }, e1: { x: 5 } },
  ];
  assert.deepEqual(armPairs(rounds, 'e1'), [{ A: { x: 1 }, B: { x: 2 } }, { A: { x: 4 }, B: { x: 5 } }]);
  assert.deepEqual(armPairs(rounds, 'e2'), [{ A: { x: 1 }, B: { x: 3 } }]);
});

// N-278: srcOnly worktrees take src/ from their revision and the scenes and bundles from the runner's tree.
test('servedOutsideSrc keeps the files a page loads from outside src/', async () => {
  const { servedOutsideSrc } = await import('../bench/revWorktree.mjs');
  assert.deepEqual(
    servedOutsideSrc([
      'src/render/faceMap.js',
      'demos/buenosAiresScene/barrioLoader.js',
      'dist/weed.prod.bundle.esm.min.js',
      'tests/bench/stressScenes/houseLightScene.js',
      'tests/bench/runPredatorAbab.mjs',
      'docs/internal/hypotheses.json',
    ]),
    ['demos/buenosAiresScene/barrioLoader.js', 'dist/weed.prod.bundle.esm.min.js', 'tests/bench/stressScenes/houseLightScene.js'],
  );
});

test('srcOnlyGapCheck refuses a side whose scene folder differs, and lists the rest', async () => {
  const { srcOnlyGapCheck } = await import('../bench/revWorktree.mjs');
  const barrio = '/demos/buenosAiresScene/buenosAiresScene.js';
  // The barrio stack's arm (N-278's case): its loader differs, so it would run the runner's neighbourhood.
  const sides = [
    { label: 'A', srcOnlyGaps: [] },
    { label: 'stack', srcOnlyGaps: ['demos/buenosAiresScene/barrioLoader.js', 'demos/ballsScene/ballsScene.js'] },
  ];
  assert.deepEqual(srcOnlyGapCheck(sides, barrio, 'hour=22&dayMinutes=0'), {
    refuse: ['stack: demos/buenosAiresScene/barrioLoader.js'],
    warn: ['stack: demos/ballsScene/ballsScene.js'],
  });
  // dist/ matters only when a side times a bundle.
  const bundle = [{ label: 'B', srcOnlyGaps: ['dist/weed.prod.bundle.esm.min.js'] }];
  assert.deepEqual(srcOnlyGapCheck(bundle, barrio, 'crowd=1').refuse, []);
  assert.deepEqual(srcOnlyGapCheck(bundle, barrio, 'crowd=1&weedBundle=weed.prod.bundle.esm.min.js').refuse, [
    'B: dist/weed.prod.bundle.esm.min.js',
  ]);
  // A stress scene's folder is tests/bench/stressScenes/.
  const stress = [{ label: 'B', srcOnlyGaps: ['tests/bench/stressScenes/bunnyMarkStressScene.js'] }];
  assert.equal(srcOnlyGapCheck(stress, '/tests/bench/stressScenes/bunnyMarkStressScene.js', '').refuse.length, 1);
  // No differences: nothing to say.
  assert.deepEqual(srcOnlyGapCheck([{ label: 'A' }], barrio, ''), { refuse: [], warn: [] });
});

test('refuseSrcOnlyGaps throws on a refused side and names --full-rev', async () => {
  const { refuseSrcOnlyGaps } = await import('../bench/runPredatorAbab.mjs');
  const scene = { path: '/demos/buenosAiresScene/buenosAiresScene.js' };
  const log = console.log;
  console.log = () => {};
  try {
    assert.throws(
      () => refuseSrcOnlyGaps([{ label: 'B', srcOnlyGaps: ['demos/buenosAiresScene/parqueChas.json'] }], scene, { query: '' }),
      /N-278.*--full-rev/,
    );
    assert.doesNotThrow(() => refuseSrcOnlyGaps([{ label: 'B', srcOnlyGaps: ['demos/ballsScene/x.js'] }], scene, {}));
  } finally {
    console.log = log;
  }
});
