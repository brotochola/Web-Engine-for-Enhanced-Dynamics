import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';

// E-214: allocatePathSlot read every slot for an empty one or the least recently used one, for each new path (with
// 8000 slots, about 0.5 ms a path in astarStressScene). The slots never given a path since the last invalidate are a
// stack now, and once they are gone the eviction takes the oldest of a few slots from a moving hand.

const W = 16;
const H = 16;

function makeGrid(maxPaths) {
  const config = { cellSize: 1, maxFlowfields: 1, maxPaths, maxPathLength: 8 };
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(config, W, H));
  NavGrid.writeHeader(sab, config, W, H);
  NavGrid.initialize(sab, { worldWidth: W, worldHeight: H });
}

function computePath(from, to) {
  const slot = NavGrid.allocatePathSlot(from, to);
  NavGrid.writePathData(slot, new Uint32Array([from, to]), 2);
  return slot;
}

function withClock(clock, fn) {
  const real = NavGrid.lruNow;
  NavGrid.lruNow = () => clock.now >>> 0;
  try {
    return fn();
  } finally {
    NavGrid.lruNow = real;
  }
}

test('free slots are given in order, then counted as gone; invalidate frees them all', { concurrency: false }, () => {
  makeGrid(5);
  assert.equal(NavGrid._pathFreeCount, 5);
  const slots = [];
  for (let i = 0; i < 5; i++) slots.push(computePath(i, 100 + i));
  assert.deepEqual(slots, [0, 1, 2, 3, 4]);
  assert.equal(NavGrid._pathFreeCount, 0);
  NavGrid.invalidate();
  assert.equal(NavGrid._pathFreeCount, 5);
  assert.equal(computePath(9, 109), 0, 'slot 0 again after invalidate');
});

test('with every slot taken, the eviction takes the oldest of the slots the hand samples', { concurrency: false }, () => {
  makeGrid(8);
  const clock = { now: 500 };
  withClock(clock, () => {
    // Eight paths, one a tick: slot k stamped 500 + k.
    for (let i = 0; i < 8; i++) {
      computePath(i, 100 + i);
      clock.now++;
    }
    // Walkers keep slots 0 and 1 young.
    NavGrid._touchPathSlot(0);
    NavGrid._touchPathSlot(1);
    clock.now++;
    const s = computePath(20, 120);
    assert.equal(s, 2, 'slot 2 is now the oldest of the eight the hand reads');
    assert.ok(NavGrid._findPathSlot(0, 100) >= 0 && NavGrid._findPathSlot(1, 101) >= 0, 'the walked paths stay');
  });
});

test('many slots: each new path reads a few of them, and a path read every tick is not evicted', { concurrency: false }, () => {
  makeGrid(4000);
  const clock = { now: 1 };
  withClock(clock, () => {
    const walked = computePath(1, 200);
    for (let i = 0; i < 20000; i++) {
      NavGrid._touchPathSlot(walked);
      computePath(2 + (i % 50), 1000 + i);
      if (i % 60 === 0) clock.now++;
    }
    assert.equal(NavGrid._findPathSlot(1, 200), walked, 'the walked path survived 20 000 new ones');
  });
});
