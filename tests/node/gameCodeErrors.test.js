import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';
import { ErrorReporter, ERROR_REPORT_MAX_KEYS } from '../../src/util/errorReport.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// One throw in game code used to stop that worker's frame loop for good (the
// next frame was only scheduled after a clean update) and named no entity.
// Now the loop keeps going, the throwing entity is reported once by class,
// index and phase, and the entities after it still tick that frame.

function silenced(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

test('ErrorReporter: one report per distinct error, then a count at most once a second', () => {
  const posted = [];
  let now = 0;
  const r = new ErrorReporter((m) => posted.push(m), 'logic0', () => now);
  silenced(() => {
    for (let k = 0; k < 100; k++) r.report(new Error('boom'), 'tick', 'Zombie', 7);
    now = 1500;
    r.report(new Error('boom'), 'tick', 'Zombie', 7);
    r.report(new Error('other'), 'tick', 'Zombie', 7);
  });
  assert.deepEqual(
    posted.map((m) => [m.msg, m.count]),
    [['entityError', 1], ['entityErrorCount', 101], ['entityError', 1]]
  );
  assert.equal(posted[0].className, 'Zombie');
  assert.equal(posted[0].entityIndex, 7);
  assert.equal(posted[0].phase, 'tick');
  assert.equal(posted[0].workerName, 'logic0');
});

test('ErrorReporter: distinct messages past the cap share one overflow row', () => {
  const posted = [];
  const r = new ErrorReporter((m) => posted.push(m), 'logic0', () => 0);
  silenced(() => {
    for (let k = 0; k < ERROR_REPORT_MAX_KEYS + 50; k++) r.report(new Error(`bad ${k}`), 'tick', 'Z', k);
  });
  assert.equal(r._seen.size, ERROR_REPORT_MAX_KEYS + 1);
  assert.equal(posted.filter((m) => m.msg === 'entityError').length, ERROR_REPORT_MAX_KEYS + 1);
});

test('a worker frame that throws still schedules the next frame', async () => {
  const w = await loadWorker('particleWorker.js', 'particleWorker');
  let scheduled = 0;
  w.usesCustomScheduler = false;
  w.scheduleNextFrame = () => {
    scheduled++;
  };
  w.update = () => {
    throw new Error('engine bug');
  };
  w.reportFPS = () => {};
  w.isPaused = false;
  const before = postedMessages().length;
  silenced(() => w.gameLoop());
  assert.equal(scheduled, 1);
  const msgs = postedMessages().slice(before);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].msg, 'entityError');
  assert.equal(msgs[0].phase, 'frame');
  assert.equal(msgs[0].message, 'engine bug');
});

test('a throwing tick names the entity and the rest of the type still ticks', async () => {
  const N = 4;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  const ticked = [];
  class Walker {
    constructor(index) {
      this.index = index;
    }
    tick() {
      if (this.index === 1) throw new Error('walker broke');
      ticked.push(this.index);
    }
  }
  const activeList = new Uint16Array([3, 0, 1, 2]);
  w.gameObjects = [new Walker(0), new Walker(1), new Walker(2)];
  for (let i = 0; i < 3; i++) Transform.active[i] = 1;
  w.nonDecimatedTypes = [{ activeList, needsScreenCallbacks: false, entityType: 0 }];
  w.decimatedTypes = [];
  w.tickAllTypes = [];
  w.totalLogicWorkers = 1;
  w.workerIndex = 0;
  w._drainSpawnCommandRing = () => {};
  w.processListUpdates = () => {};
  w._latchDisplayPose = () => {};
  w.sendListUpdatesToLogic0 = () => {};
  const before = postedMessages().length;
  silenced(() => {
    w.update(16.67, 1, false);
    w.update(16.67, 1, false);
  });
  assert.deepEqual(ticked, [0, 2, 0, 2], 'entities 0 and 2 tick both frames');
  const msgs = postedMessages().slice(before);
  assert.equal(msgs.length, 1, 'the second frame only counts');
  assert.equal(msgs[0].className, 'Walker');
  assert.equal(msgs[0].entityIndex, 1);
  assert.equal(msgs[0].phase, 'tick');
});
