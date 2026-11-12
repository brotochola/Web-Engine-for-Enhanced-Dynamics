import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import {
  bindNavRequestRing,
  bindNavRequestRings,
  createNavRequestRings,
  drainNavRequests,
  NAV_REQUEST_FLOWFIELD,
  NAV_REQUEST_SLOTS,
  pushNavRequest,
} from '../../src/util/navRequestRing.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// E-213: NavGrid's path and flowfield requests go to the particle worker through a ring per logic worker instead of a
// postMessage each (10 % of the particle worker in astarStressScene). A full ring leaves the request to the message.

test('records come out in order, flowfields marked; a full ring refuses and keeps what it holds', () => {
  const buf = createNavRequestRings(2);
  const w0 = bindNavRequestRing(buf, 0);
  const w1 = bindNavRequestRing(buf, 1);
  assert.ok(pushNavRequest(w0, 5, 9));
  assert.ok(pushNavRequest(w0, 7 | NAV_REQUEST_FLOWFIELD, 0));
  assert.ok(pushNavRequest(w1, 3, 4));
  const [r0, r1] = bindNavRequestRings(buf);
  const got = [];
  drainNavRequests(r0, (a, b) => got.push([a >>> 0, b]));
  drainNavRequests(r1, (a, b) => got.push([a >>> 0, b]));
  assert.deepEqual(got, [[5, 9], [(7 | NAV_REQUEST_FLOWFIELD) >>> 0, 0], [3, 4]]);
  assert.equal(drainNavRequests(r0, () => assert.fail('nothing left')), 0);

  for (let i = 0; i < NAV_REQUEST_SLOTS; i++) assert.ok(pushNavRequest(w0, i, i + 1));
  assert.equal(pushNavRequest(w0, 1, 2), false, 'full');
  let n = 0;
  drainNavRequests(r0, (a, b) => {
    assert.equal(b, a + 1);
    n++;
  });
  assert.equal(n, NAV_REQUEST_SLOTS, 'every record across the wrap of the ring');
  assert.ok(pushNavRequest(w0, 1, 2), 'room again');
});

function makeGrid() {
  const config = { cellSize: 1, maxFlowfields: 2, maxPaths: 8, maxPathLength: 8 };
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(config, 16, 16));
  NavGrid.writeHeader(sab, config, 16, 16);
  NavGrid.initialize(sab, { worldWidth: 16, worldHeight: 16 });
}

test("NavGrid's requests take the ring, and the message only when it is full", { concurrency: false }, () => {
  makeGrid();
  const posted = [];
  NavGrid.setNavWorkerPort({ postMessage: (m) => posted.push(m) });
  const buf = createNavRequestRings(1);
  NavGrid.setNavRequestRing(bindNavRequestRing(buf, 0));
  try {
    NavGrid._pendingPathRequests.clear();
    NavGrid._pendingFlowfieldRequests.clear();
    NavGrid._requestPath(3, 40);
    NavGrid._requestFlowfield(77);
    NavGrid._requestPath(3, 40); // pending: no second request
    assert.equal(posted.length, 0, 'no message');
    const got = [];
    drainNavRequests(bindNavRequestRings(buf)[0], (a, b) => got.push([a >>> 0, b]));
    assert.deepEqual(got, [[3, 40], [(77 | NAV_REQUEST_FLOWFIELD) >>> 0, 0]]);

    const ring = bindNavRequestRing(buf, 0);
    for (let i = 0; i < NAV_REQUEST_SLOTS; i++) pushNavRequest(ring, 1, 2);
    NavGrid._requestPath(5, 50);
    assert.equal(posted.length, 1, 'a full ring: the message');
    assert.deepEqual(posted[0], { type: 'REQUEST_PATH', fromCell: 5, toCell: 50 });
  } finally {
    NavGrid.setNavRequestRing(null);
    NavGrid.setNavWorkerPort(null);
    NavGrid._pendingPathRequests.clear();
    NavGrid._pendingFlowfieldRequests.clear();
  }
});

test('the particle worker drains the rings into its queues at the start of its nav step', { concurrency: false }, async () => {
  makeGrid();
  const pw = await loadWorker('particleWorker.js', 'particleWorker');
  const buf = createNavRequestRings(2);
  pw._navRings = bindNavRequestRings(buf);
  pw.navEnabled = true;
  pw.scratch = { maxDistance: 100 };
  pw.totalCells = 256;
  const paths = [];
  const flows = [];
  pw.pathRequests = { enqueue: (f, t) => paths.push([f, t]), dequeue: () => false };
  pw.flowfieldRequests = { enqueue: (c) => flows.push(c), dequeue: () => -1 };
  pw._navDataView = new DataView(NavGrid._sab);
  pw.flowfieldsServicedThisFrame = 0;
  pushNavRequest(bindNavRequestRing(buf, 0), 3, 40);
  pushNavRequest(bindNavRequestRing(buf, 1), 12 | NAV_REQUEST_FLOWFIELD, 0);
  pushNavRequest(bindNavRequestRing(buf, 1), 300, 4); // off the grid: dropped as the message handler drops it
  pw.processNavigationRequests();
  assert.deepEqual(paths, [[3, 40]]);
  assert.deepEqual(flows, [12]);
  assert.equal(pw.flowfieldsServicedThisFrame, 1);
});
