import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// BM-8 (docs/internal/BOX2D_MEMORY_PLAN.md). When Box2D runs out of memory (the memory never grows),
// the glue aborts with "OOM" and calls Module.onAbort. The physics host turns that into the scene's
// fatal error, naming physics.wasmMemoryMB, stops its loop, and stops calling into the dead module.

const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');

test('the message names the key and the size for "OOM", and passes other aborts through', () => {
  const start = host.indexOf('// bm8-abort-start');
  const end = host.indexOf('// bm8-abort-end');
  assert.ok(start > 0 && end > start, 'bm8-abort block missing');
  const box2dAbortMessage = new Function(`${host.slice(start, end)}\nreturn box2dAbortMessage;`)();
  assert.match(box2dAbortMessage('OOM', 64 * 1048576), /^Box2D ran out of memory: physics\.wasmMemoryMB is 64 MB\. Raise/);
  assert.equal(box2dAbortMessage('Assertion failed', 0), 'Box2D aborted: Assertion failed');
});

function loadHost() {
  const posted = [];
  let steps = 0;
  const context = vm.createContext({
    name: 'physics pages=1024',
    Module: { HEAPF32: { buffer: { byteLength: 64 * 1048576 } } },
    weedjsEnableHostMode() {},
    weedjsDoStep() {
      steps++;
    },
    WeedPhysicsConfig: { PHYSICS_SIM_DEFAULTS: {}, validatePhysicsConfig: (current, next) => next },
    // A copy made in this realm: the vm context has its own Object.prototype.
    postMessage: (message) => posted.push({ ...message }),
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext('var self = globalThis;', context);
  vm.runInContext(host, context);
  return { context, posted: () => posted.filter((m) => m.msg !== 'log'), steps: () => steps };
}

test('onAbort is set when the host loads, so helper threads started later proxy theirs to it', () => {
  const { context } = loadHost();
  assert.equal(typeof context.Module.onAbort, 'function');
  assert.ok(Object.keys(context.Module).includes('onAbort'), 'Emscripten passes only enumerable handlers');
});

test('an out-of-memory abort posts one fatal error and the host stops calling Box2D', () => {
  const { context, posted, steps } = loadHost();
  context.Module.onAbort('OOM');
  context.Module.onAbort('OOM');
  const errors = posted().filter((m) => m.msg === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].title, 'Box2D stopped');
  assert.match(errors[0].message, /physics\.wasmMemoryMB is 64 MB/);

  context.onmessage({ data: { msg: 'start' } });
  context.onmessage({ data: { msg: 'step', deltaTime: 16, id: 3 } });
  assert.equal(steps(), 0, 'the dead module was stepped');
  context.onmessage({ data: { msg: 'barrier', id: 7 } });
  assert.deepEqual(
    posted().filter((m) => m.msg !== 'error'),
    [{ msg: 'barrierDone', id: 7 }],
  );
});
