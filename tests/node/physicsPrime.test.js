import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../../src/core/scene.js';

// SST-15: before the start the scene asks the physics worker to make the bodies, joints and commands its spawns left
// (a 'prime' message), and waits for the answer, so the first step after the start has only its own work.

function primeHost(physics) {
  return { workers: { physics }, _primeWaiter: null, _primeSeq: 0, _takePrimeDone: Scene.prototype._takePrimeDone };
}

test('the start waits for the physics worker to answer its prime', async () => {
  const sent = [];
  const host = primeHost({ postMessage: (m) => sent.push(m) });
  let primed = false;
  const waiting = Scene.prototype._primePhysics.call(host).then(() => (primed = true));
  assert.deepEqual(sent, [{ msg: 'prime', id: 1 }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(primed, false, 'not before the answer');
  host._takePrimeDone(7); // an answer to another request changes nothing
  await new Promise((r) => setImmediate(r));
  assert.equal(primed, false);
  host._takePrimeDone(1);
  await waiting;
  assert.equal(primed, true);
  assert.equal(host._primeWaiter, null);
});

test('a scene without a physics worker starts at once; a worker that never answers is waited for until the timeout', async () => {
  await Scene.prototype._primePhysics.call(primeHost(undefined));
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const host = primeHost({ postMessage() {} });
    const t0 = performance.now();
    await Scene.prototype._primePhysics.call(host, 30);
    assert.ok(performance.now() - t0 >= 25, 'waited for the timeout');
    assert.equal(host._primeWaiter, null);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = warn;
  }
});
