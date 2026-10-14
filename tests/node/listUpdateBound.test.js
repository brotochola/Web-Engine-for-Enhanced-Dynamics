import test from 'node:test';
import assert from 'node:assert/strict';

// logicWorker is a worker script: it posts on import and expects a `self` with
// a port. Stub just enough of the worker global to load the module.
const posted = [];
globalThis.self = {
  postMessage: (m) => posted.push(m),
  onmessage: null,
  close() {},
  WorkerGlobalScope: function WorkerGlobalScope() {},
  name: '',
};
globalThis.WorkerGlobalScope = globalThis.self.WorkerGlobalScope;
globalThis.postMessage = globalThis.self.postMessage;

// logicWorker.js has no named exports - it self-registers as `self.logicWorker`
// at the bottom of the file, the same shape pixiWorker.js uses. The instance
// constructs cleanly under this stub, so the real object is under test rather
// than a hand-rolled one.
await import('../../src/workers/logicWorker.js');
const worker = globalThis.self.logicWorker;
assert.ok(worker, 'logicWorker must self-register');

/**
 * B-09 / H-17. `receivedListUpdates` grew without bound.
 *
 * Every non-logic0 worker pushes one batch per frame via `sendListUpdatesToLogic0`,
 * and the queue is only drained inside `processListUpdates`, which runs from
 * logic0's own frame loop. So the queue is a producer/consumer pair with no bound
 * on the producer side:
 *
 *     case 'listUpdates':
 *       ...
 *       this.receivedListUpdates.push({ spawns, despawns });   // unbounded
 *
 * Anything that stops logic0's loop from running - logic0 paused, a manual-step
 * worker waiting on the main thread, the tab throttled - turns that into
 * unbounded growth. Each entry is an object holding two arrays of objects, so it
 * is not a slow leak: it is fast allocation growth landing exactly when the
 * frame budget is already gone, ending in an OOM rather than a visible stall.
 *
 * Fix, in two stages so the common case is free:
 *   1. coalesce into the tail batch while it has room - no allocation at all;
 *   2. past the cap, drop and count.
 *
 * Dropping a despawn is destructive (the body stays in the active list forever),
 * which is why the drop count is exposed rather than merely incremented and why
 * the cap sits far above anything a healthy frame produces.
 */

const MAX_BATCHES = 64;
const MAX_BATCH_PENDING = 2048;

function makeWorker() {
  // Reset the queue state on the real instance. The behaviour under test touches
  // no shared buffer, so nothing else needs isolating.
  worker.receivedListUpdates = [];
  worker.listUpdatesDropped = 0;
  worker.listUpdatesCoalesced = 0;
  return worker;
}

function rec(i) {
  return { entityIndex: i, entityType: 0, EntityClass: function E() {} };
}

function fill(n, start = 0) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = rec(start + i);
  return a;
}

test('B-09: an empty queue drains to zero', { concurrency: false }, () => {
  const w = makeWorker();
  assert.equal(w.getPendingListUpdateCount(), 0);
});

test('B-09: the first batch is queued, not coalesced', { concurrency: false }, () => {
  const w = makeWorker();
  assert.equal(w.enqueueListUpdateBatch(fill(3), []), 'queued');
  assert.equal(w.receivedListUpdates.length, 1);
  assert.equal(w.getPendingListUpdateCount(), 3);
  assert.equal(w.listUpdatesCoalesced, 0);
});

test('B-09: a small second batch coalesces into the tail and allocates nothing', { concurrency: false }, () => {
  const w = makeWorker();
  w.enqueueListUpdateBatch(fill(3), []);
  const tail = w.receivedListUpdates[0];

  assert.equal(w.enqueueListUpdateBatch(fill(2, 10), []), 'coalesced');

  assert.equal(w.receivedListUpdates.length, 1, 'no second batch wrapper was allocated');
  assert.equal(tail.spawns.length, 5, 'the tail array grew in place');
  assert.deepEqual(
    tail.spawns.map((u) => u.entityIndex),
    [0, 1, 2, 10, 11],
    'the coalesced records are appended in arrival order',
  );
  assert.equal(w.listUpdatesCoalesced, 1);
});

test('B-09: coalescing preserves spawn/despawn separation and order', { concurrency: false }, () => {
  const w = makeWorker();
  w.enqueueListUpdateBatch(fill(2, 0), fill(3, 100));
  w.enqueueListUpdateBatch(fill(1, 5), fill(1, 200));

  const tail = w.receivedListUpdates[0];
  assert.deepEqual(
    tail.spawns.map((u) => u.entityIndex),
    [0, 1, 5],
  );
  assert.deepEqual(
    tail.despawns.map((u) => u.entityIndex),
    [100, 101, 102, 200],
    'despawns must not interleave into the spawn array',
  );
});

test('B-09: the queue stops growing at the batch cap', { concurrency: false }, () => {
  const w = makeWorker();
  // Each batch is over MAX_BATCH_PENDING, so coalescing can never apply and the
  // queue must fill to the cap and then stop.
  const big = fill(MAX_BATCH_PENDING + 1);
  for (let i = 0; i < MAX_BATCHES + 50; i++) {
    w.enqueueListUpdateBatch(big, []);
  }
  assert.equal(w.receivedListUpdates.length, MAX_BATCHES, 'capped at MAX_BATCHES');
});

test('B-09: past the cap updates are dropped and COUNTED, not silently lost', { concurrency: false }, () => {
  const w = makeWorker();
  const big = fill(MAX_BATCH_PENDING + 1);
  for (let i = 0; i < MAX_BATCHES; i++) w.enqueueListUpdateBatch(big, []);

  assert.equal(w.listUpdatesDropped, 0, 'nothing dropped while under the cap');

  const r = w.enqueueListUpdateBatch(fill(7), []);
  assert.equal(r, 'dropped');
  assert.equal(w.listUpdatesDropped, 7, 'the drop count records how many updates were lost');
  assert.equal(w.receivedListUpdates.length, MAX_BATCHES, 'and the queue did not grow');
});

test('B-09: one full tail batch must not wedge the queue shut', { concurrency: false }, () => {
  // Regression guard on the fix's own ordering. If coalescing were tried before
  // checking the batch cap, a single batch that exactly fills the tail would
  // make every later update fall to the drop path until logic0 drained - which
  // is unbounded growth in all but name, and silent.
  const w = makeWorker();
  w.enqueueListUpdateBatch(fill(MAX_BATCH_PENDING), []);

  const r = w.enqueueListUpdateBatch(fill(1), []);
  assert.equal(r, 'queued', 'a second batch must still get through');
  assert.equal(w.receivedListUpdates.length, 2);
  assert.equal(w.listUpdatesDropped, 0, 'and nothing was dropped');
});

test('B-09: a batch larger than the per-batch cap still gets a wrapper', { concurrency: false }, () => {
  const w = makeWorker();
  const r = w.enqueueListUpdateBatch(fill(MAX_BATCH_PENDING + 500), []);
  assert.equal(r, 'queued');
  assert.equal(w.getPendingListUpdateCount(), MAX_BATCH_PENDING + 500, 'no records were lost');
});

test('B-09: a transient hiccup costs no allocation at all', { concurrency: false }, () => {
  // The shape a healthy engine actually sees: logic0 is one frame behind, the
  // workers each send one small batch. All of it should land in a single wrapper.
  const w = makeWorker();
  for (let i = 0; i < 30; i++) w.enqueueListUpdateBatch(fill(4, i * 4), fill(2, i * 2));

  assert.equal(w.receivedListUpdates.length, 1, 'one batch wrapper for 30 messages');
  assert.equal(w.getPendingListUpdateCount(), 180);
  assert.equal(w.listUpdatesCoalesced, 29);
  assert.equal(w.listUpdatesDropped, 0);
});

test('B-09: dropping resumes after a drain', { concurrency: false }, () => {
  const w = makeWorker();
  const big = fill(MAX_BATCH_PENDING + 1);
  for (let i = 0; i < MAX_BATCHES + 10; i++) w.enqueueListUpdateBatch(big, []);
  assert.ok(w.listUpdatesDropped > 0, 'we dropped while wedged');

  // Drain, as processListUpdates does.
  w.receivedListUpdates.length = 0;

  assert.equal(w.enqueueListUpdateBatch(fill(1), []), 'queued', 'the queue works again after a drain');
});

test('B-09: the drop counter is monotonic and never resets silently', { concurrency: false }, () => {
  const w = makeWorker();
  const big = fill(MAX_BATCH_PENDING + 1);
  for (let i = 0; i < MAX_BATCHES; i++) w.enqueueListUpdateBatch(big, []);
  const before = w.listUpdatesDropped;
  w.enqueueListUpdateBatch(fill(3), []);
  w.enqueueListUpdateBatch(fill(4), []);
  assert.equal(w.listUpdatesDropped, before + 7, 'each lost record is counted');
});