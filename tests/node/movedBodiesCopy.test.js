import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindMovedBodies,
  copyMovedBodies,
  createMovedBodiesSab,
  getMovedBodiesViews,
  HDR_SEQ,
  publishMovedBodies,
  readMovedBodiesHeader,
  viewsFromSab,
} from '../../src/box2d/box2dMovedBodies.js';

// E-126. The spatial worker copies physics' moved list and must know whether the copy is the
// publish whose header it read: publishMovedBodies keeps the header's sequence odd while it writes,
// readMovedBodiesHeader returns that sequence (or -1 mid-publish), and copyMovedBodies says false
// when a publish started since.

const CAP = 64;

function bind() {
  const sab = createMovedBodiesSab(CAP);
  bindMovedBodies(sab);
  return viewsFromSab(sab).hdrI32;
}

function publish(slots) {
  return publishMovedBodies(new Int32Array(slots), null, slots.length, null, 0, null);
}

test('E-126: no buffer, no header', { concurrency: false }, () => {
  bindMovedBodies(null);
  assert.equal(readMovedBodiesHeader(new Int32Array(3)), false);
  assert.equal(copyMovedBodies(new Int32Array(4), 0, 0), false);
});

test('E-126: the header and the copy of one publish', { concurrency: false }, () => {
  bind();
  publish([5, 9, 2]);
  const head = new Int32Array(3);
  assert.equal(readMovedBodiesHeader(head), true);
  assert.equal(head[0], 1, 'generation');
  assert.equal(head[1], 3, 'count');
  assert.equal(head[2] & 1, 0, 'an even sequence: no publish was writing');
  assert.equal(head[0], getMovedBodiesViews().generation, 'the generation getMovedBodiesViews reports');
  const dst = new Int32Array(CAP);
  assert.equal(copyMovedBodies(dst, head[1], head[2]), true);
  assert.deepEqual(Array.from(dst.subarray(0, 3)), [5, 9, 2]);
});

test('E-126: a publish after the header read makes the copy false', { concurrency: false }, () => {
  bind();
  publish([1, 2, 3]);
  const head = new Int32Array(3);
  readMovedBodiesHeader(head);
  publish([7]);
  assert.equal(copyMovedBodies(new Int32Array(CAP), head[1], head[2]), false);
  readMovedBodiesHeader(head);
  assert.equal(head[0], 2);
  assert.equal(copyMovedBodies(new Int32Array(CAP), head[1], head[2]), true);
});

test('E-126: a header read while a publish writes has no sequence', { concurrency: false }, () => {
  const hdr = bind();
  publish([1]);
  Atomics.add(hdr, HDR_SEQ, 1);
  const head = new Int32Array(3);
  readMovedBodiesHeader(head);
  assert.equal(head[2], -1);
  assert.equal(copyMovedBodies(new Int32Array(CAP), head[1], head[2]), false);
  Atomics.sub(hdr, HDR_SEQ, 1);
});

test('E-126: a list longer than the destination is not copied', { concurrency: false }, () => {
  bind();
  publish([1, 2, 3, 4, 5]);
  const head = new Int32Array(3);
  readMovedBodiesHeader(head);
  assert.equal(copyMovedBodies(new Int32Array(4), head[1], head[2]), false);
});
