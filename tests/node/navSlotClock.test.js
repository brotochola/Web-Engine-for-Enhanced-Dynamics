import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';

// N-139: the path and flowfield slots' LRU clock counted whole seconds. With more paths made in one second than
// slots, every slot held the same stamp and the eviction took slot 0, a path an agent was reading every tick. The clock
// counts 16 ms ticks now, and evictions compare ages ((now - stamp) >>> 0), which the u32's wrap does not upset.

const W = 16;
const H = 16;

function makeGrid(maxPaths, maxFlowfields = 1) {
  const config = { cellSize: 1, maxFlowfields, maxPaths, maxPathLength: 8 };
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(config, W, H));
  NavGrid.writeHeader(sab, config, W, H);
  NavGrid.initialize(sab, { worldWidth: W, worldHeight: H });
}

function computePath(from, to) {
  const slot = NavGrid.allocatePathSlot(from, to);
  NavGrid.writePathData(slot, new Uint32Array([from, to]), 2);
  return slot;
}

/** Run `fn` with NavGrid.lruNow() reading `clock.now`. */
function withClock(clock, fn) {
  const real = NavGrid.lruNow;
  NavGrid.lruNow = () => clock.now >>> 0;
  try {
    return fn();
  } finally {
    NavGrid.lruNow = real;
  }
}

test('the clock moves within a second', () => {
  const a = NavGrid.lruNow();
  const t0 = Date.now();
  while (Date.now() - t0 < 40);
  assert.ok(NavGrid.lruNow() !== a, 'two reads 40 ms apart differ');
});

test('a path read every tick outlives the paths nobody reads, made in the same second', { concurrency: false }, () => {
  makeGrid(4);
  const clock = { now: 1000 };
  withClock(clock, () => {
    const walked = computePath(1, 100);
    computePath(2, 101);
    computePath(3, 102);
    computePath(4, 103);
    clock.now += 1; // a tick later, within the same second
    NavGrid._touchPathSlot(walked);
    computePath(5, 104);
    assert.ok(NavGrid._findPathSlot(1, 100) >= 0, 'the walked path is still there');
  });
});

test('evictions compare ages across the u32 wrap', { concurrency: false }, () => {
  makeGrid(2);
  const clock = { now: 0xfffffff0 };
  withClock(clock, () => {
    computePath(1, 100); // stamped just before the wrap: the older
    clock.now = 0x100000002; // after the wrap: reads 2
    computePath(2, 101);
    computePath(3, 102);
    assert.equal(NavGrid._findPathSlot(1, 100), -1, 'the pre-wrap path, the older, was evicted');
    assert.ok(NavGrid._findPathSlot(2, 101) >= 0);
    assert.ok(NavGrid._findPathSlot(3, 102) >= 0);
  });
});

test('flowfield slots: a touched one outlives an untouched one across the wrap', { concurrency: false }, () => {
  makeGrid(1, 2);
  const clock = { now: 0xfffffff8 };
  withClock(clock, () => {
    const a = NavGrid.allocateFlowfieldSlot(10);
    NavGrid.writeFlowfieldData(a, new Int8Array(W * H * 2));
    const b = NavGrid.allocateFlowfieldSlot(11);
    NavGrid.writeFlowfieldData(b, new Int8Array(W * H * 2));
    clock.now = 0x100000001;
    NavGrid._touchFlowfieldSlot(a);
    const c = NavGrid.allocateFlowfieldSlot(12);
    assert.equal(c, b, 'the untouched slot is the one reused');
  });
});
