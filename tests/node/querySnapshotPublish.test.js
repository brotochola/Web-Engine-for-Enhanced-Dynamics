import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateQueryResultBufferSize,
  createWorkerQueryFunctions,
  getQuerySnapshotBytes,
  getQuerySnapshotElements,
  QUERY_SNAPSHOT_COUNT,
} from '../../src/core/querySystem.js';

/**
 * B-02. The query result snapshot protocol publishes with the count first and
 * the snapshot index last, which is correct. The reader read them in the
 * opposite order:
 *
 *   publish: snapshot[n][0] = count;  Atomics.store(header,1,count);
 *            Atomics.store(header,2,frame);  Atomics.store(header,0,index);
 *   read:    Atomics.load(header,0) -> index;  Atomics.load(header,1) -> count;
 *
 * A publish landing between the reader's two loads hands it the OLD index with
 * the NEW count. It then reads old-snapshot data for new-count entries, so the
 * tail is stale entity ids from an earlier frame - slots that may since have
 * been despawned and recycled.
 *
 * These tests drive the real worker closures from createWorkerQueryFunctions and
 * assert the reader's contract: the count it returns must belong to the snapshot
 * it names. The torn state is constructed directly in the SAB, which is what the
 * race leaves behind.
 */

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;

function makeQueryData(capacity) {
  return {
    queryEntityCapacity: capacity,
    metadata: [
      {
        entityType: 0,
        className: 'Probe',
        componentMask: '1',
        startIndex: 0,
        endIndex: capacity,
        poolSize: capacity,
      },
    ],
    precomputedQueries: [
      { name: 'probe', components: [], queryMask: '1', typeMask: '1', resultOffset: 0 },
    ],
  };
}

/** Rebuild the SAB view layout the same way createQuerySnapshotViews does. */
function makeViews(sab, capacity) {
  const snapshotBytes = getQuerySnapshotBytes(capacity);
  const elements = getQuerySnapshotElements(capacity);
  const header = new Int32Array(sab, 0, HEADER_INTS);
  const snapshots = [];
  for (let i = 0; i < QUERY_SNAPSHOT_COUNT; i++) {
    snapshots.push(new Uint16Array(sab, HEADER_BYTES + i * snapshotBytes, elements));
  }
  return { header, snapshots };
}

function setup(capacity) {
  const sab = new SharedArrayBuffer(calculateQueryResultBufferSize(capacity));
  const buffers = { queryResultsSAB: sab };
  const activeEntitiesData = new Uint16Array(capacity + 1);
  const fns = createWorkerQueryFunctions(makeQueryData(capacity), buffers, activeEntitiesData);
  const view = makeViews(sab, capacity);
  const classes = [{ componentId: 0, name: 'Probe' }];
  return { view, fns, classes };
}

/** What a correct publisher leaves: data, then count, then index. */
function publish(view, snapshotIndex, ids) {
  const snap = view.snapshots[snapshotIndex];
  snap[0] = ids.length;
  for (let i = 0; i < ids.length; i++) snap[1 + i] = ids[i];
  Atomics.store(view.header, 1, ids.length);
  Atomics.store(view.header, 2, 1);
  Atomics.store(view.header, 0, snapshotIndex);
}

test('B-02: reader returns the published ids for a consistent publish', { concurrency: false }, () => {
  const { view, fns, classes } = setup(16);
  publish(view, 0, [3, 7, 11]);

  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [3, 7, 11]);
});

test('B-02: reader never returns more ids than the named snapshot holds', { concurrency: false }, () => {
  const { view, fns, classes } = setup(16);

  // Snapshot 0 holds 3 ids. A publish that bumps the count to 6 must land in a
  // different snapshot. Here we stage exactly the torn state the race produces:
  // header[0] still names snapshot 0, header[1] already says 6.
  publish(view, 0, [1, 2, 3]);
  view.snapshots[1][0] = 6;
  for (let i = 0; i < 6; i++) view.snapshots[1][1 + i] = 100 + i;
  Atomics.store(view.header, 1, 6); // count published...
  // ...but the index publish has not landed yet.
  assert.equal(Atomics.load(view.header, 0), 0);

  const got = fns.queryActiveEntities(classes);
  const named = view.snapshots[Atomics.load(view.header, 0)];
  assert.ok(
    got.length <= (named[0] | 0),
    `reader returned ${got.length} ids for a snapshot holding ${named[0]}`,
  );
  assert.deepEqual(Array.from(got), [1, 2, 3], 'must fall back to a consistent pair');
});

test('B-02: reader is consistent across a full snapshot rotation', { concurrency: false }, () => {
  const { view, fns, classes } = setup(16);

  publish(view, 0, [1, 2]);
  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [1, 2]);

  publish(view, 1, [4, 5, 6, 7]);
  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [4, 5, 6, 7]);

  publish(view, 2, [9]);
  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [9]);

  publish(view, 0, [11, 12, 13]);
  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [11, 12, 13]);
});

test('B-02: an empty publish reads back empty', { concurrency: false }, () => {
  const { view, fns, classes } = setup(16);
  publish(view, 0, [1, 2, 3]);
  assert.equal(fns.queryActiveEntities(classes).length, 3);

  publish(view, 1, []);
  assert.equal(fns.queryActiveEntities(classes).length, 0);
});

test('B-02: published frame advances with the snapshot', { concurrency: false }, () => {
  const { view, fns, classes } = setup(16);
  publish(view, 0, [1, 2]);
  assert.equal(fns.queryPublishedFrame(classes), 1);

  view.snapshots[1][0] = 4;
  for (let i = 0; i < 4; i++) view.snapshots[1][1 + i] = 20 + i;
  Atomics.store(view.header, 1, 4);
  Atomics.store(view.header, 2, 77);
  Atomics.store(view.header, 0, 1);

  assert.equal(fns.queryPublishedFrame(classes), 77);
  assert.deepEqual(Array.from(fns.queryActiveEntities(classes)), [20, 21, 22, 23]);
});
