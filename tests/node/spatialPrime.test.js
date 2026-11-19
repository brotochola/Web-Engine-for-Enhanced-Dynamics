import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../../src/core/scene.js';

// SST-21: before the start the scene primes the spatial workers beside physics (SST-15): every worker builds its rows of
// the grid, then, once all have (a search reads every worker's cells), every neighbour list its rows own. The start
// waits for both rounds; tests/node/neighborListsFromStart.test.js runs the rounds on real spatial workers.

function primeHost(spatialWorkers) {
  return {
    workers: { spatialWorkers },
    _spatialPrimeWaiter: null,
    _spatialPrimeSeq: 0,
    _loadMarks: { main: [], workers: {} },
    _askSpatialPrime: Scene.prototype._askSpatialPrime,
    _takeSpatialPrimeDone: Scene.prototype._takeSpatialPrimeDone,
    _takeWorkerLoadMarks: Scene.prototype._takeWorkerLoadMarks,
  };
}

const turn = () => new Promise((r) => setImmediate(r));

test('the scene primes every spatial worker: their grids, then, once all have answered, their lists', async () => {
  const sent = [[], []];
  const host = primeHost(sent.map((box) => ({ postMessage: (m) => box.push(m) })));
  let primed = false;
  const waiting = Scene.prototype._primeSpatial.call(host).then(() => (primed = true));
  const grid = { msg: 'spatialPrime', id: 1, phase: 'grid' };
  assert.deepEqual(sent, [[grid], [grid]]);
  host._takeSpatialPrimeDone(1);
  await turn();
  assert.equal(sent[0].length, 1, 'no search before every worker has built its rows');
  host._takeSpatialPrimeDone(7); // an answer to another round changes nothing
  await turn();
  assert.equal(sent[0].length, 1);
  host._takeSpatialPrimeDone(1);
  await turn();
  const neighbors = { msg: 'spatialPrime', id: 2, phase: 'neighbors' };
  assert.deepEqual(sent, [[grid, neighbors], [grid, neighbors]]);
  host._takeSpatialPrimeDone(2);
  await turn();
  assert.equal(primed, false, 'not before every worker has its lists');
  host._takeSpatialPrimeDone(2);
  await waiting;
  assert.equal(primed, true);
  assert.equal(host._spatialPrimeWaiter, null);
});

test('a spatial worker\'s answer reaches the prime, with its load marks', async () => {
  const host = primeHost([{ postMessage() {} }]);
  const waiting = Scene.prototype._primeSpatial.call(host);
  const answer = (id, mark) =>
    Scene.prototype.handleMessageFromWorker.call(host, {
      data: { msg: 'spatialPrimeDone', id, loadMarks: [mark, 1] },
      currentTarget: { name: 'spatial0' },
    });
  answer(1, 'grid primed');
  await turn();
  answer(2, 'neighbors primed');
  await waiting;
  assert.deepEqual(host._loadMarks.workers.spatial0, ['grid primed', 1, 'neighbors primed', 1]);
});

test('without spatial workers the start does not wait; a grid round some worker never answers ends the prime', async () => {
  await Scene.prototype._primeSpatial.call(primeHost([]));
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const sent = [];
    const host = primeHost([{ postMessage: (m) => sent.push(m) }, { postMessage: (m) => sent.push(m) }]);
    const t0 = performance.now();
    const waiting = Scene.prototype._primeSpatial.call(host, 30);
    host._takeSpatialPrimeDone(1); // one answer of two
    await waiting;
    assert.ok(performance.now() - t0 >= 25, 'waited for the timeout');
    assert.deepEqual(sent.map((m) => m.phase), ['grid', 'grid'], 'no search on a grid that may miss rows');
    assert.equal(host._spatialPrimeWaiter, null);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
  }
});
