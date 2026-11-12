import test from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import { mulberry32 } from '../bench/benchMath.js';

// E-212: path slots are found through an index in NavGrid's buffer (from, to -> slot), which the particle worker keeps
// as it gives slots paths, evicts them and clears them. With few slots and many pairs, every eviction moves entries
// back (backward-shift deletion): after each step every ready slot must be found under its pair, and no evicted pair.

const W = 16;
const H = 16;

function makeGrid(maxPaths) {
  const config = { cellSize: 1, maxFlowfields: 1, maxPaths, maxPathLength: 8 };
  const sab = new SharedArrayBuffer(NavGrid.calculateSABSize(config, W, H));
  NavGrid.writeHeader(sab, config, W, H);
  NavGrid.initialize(sab, { worldWidth: W, worldHeight: H });
  return config;
}

/** What the slots' headers say is ready: pair key -> slot. */
function readySlots(maxPaths) {
  const out = new Map();
  const u32 = NavGrid._u32;
  const base = NavGrid._pathHeadersOffset >> 2;
  const stride = NavGrid._pathSlotSize >> 2;
  for (let s = 0; s < maxPaths; s++) {
    const idx = base + s * stride;
    if (u32[idx + 4] === 2) out.set(`${u32[idx]}_${u32[idx + 1]}`, s);
  }
  return out;
}

function computePath(from, to) {
  const slot = NavGrid.allocatePathSlot(from, to);
  NavGrid.writePathData(slot, new Uint32Array([from, to]), 2);
  return slot;
}

test('every ready slot is found by its pair through the index, under heavy eviction', { concurrency: false }, () => {
  for (const maxPaths of [1, 3, 8, 24]) {
    makeGrid(maxPaths);
    const rnd = mulberry32(212 + maxPaths);
    const seen = new Set();
    const cells = W * H;
    for (let step = 0; step < 4000; step++) {
      // A small pool of pairs, so pairs come back after being evicted.
      const from = Math.floor(rnd() * 12);
      const to = 12 + Math.floor(rnd() * 12);
      seen.add(`${from}_${to}`);
      computePath(from, to);
      if (step % 7 === 0 || maxPaths <= 3) {
        const ready = readySlots(maxPaths);
        for (const key of seen) {
          const [f, t] = key.split('_').map(Number);
          const expect = ready.has(key) ? ready.get(key) : -1;
          assert.equal(NavGrid._findPathSlot(f, t), expect, `maxPaths ${maxPaths} step ${step}: ${key}`);
        }
        // Each slot listed at most once.
        const listed = new Map();
        for (const e of NavGrid._pathIndex) if (e !== 0) listed.set(e, (listed.get(e) || 0) + 1);
        for (const [e, n] of listed) assert.equal(n, 1, `slot ${e - 1} listed ${n} times`);
        assert.ok(cells > 0);
      }
    }
  }
});

test('a pair asked for again keeps its slot; invalidate empties the index', { concurrency: false }, () => {
  makeGrid(8);
  const a = computePath(1, 40);
  const b = computePath(2, 41);
  assert.notEqual(a, b);
  assert.equal(NavGrid.allocatePathSlot(1, 40), a, 'the same pair, the same slot');
  NavGrid.writePathData(a, new Uint32Array([1, 40]), 2);
  assert.equal(NavGrid._findPathSlot(1, 40), a);
  assert.equal(NavGrid._findPathSlot(2, 41), b);
  NavGrid.invalidate();
  assert.equal(NavGrid._findPathSlot(1, 40), -1);
  assert.equal(NavGrid._findPathSlot(2, 41), -1);
  assert.ok(NavGrid._pathIndex.every((e) => e === 0), 'the index is empty');
  const c = computePath(1, 40);
  assert.equal(NavGrid._findPathSlot(1, 40), c);
});

test('a slot being computed is not found until its path is ready', { concurrency: false }, () => {
  makeGrid(4);
  const slot = NavGrid.allocatePathSlot(3, 50);
  assert.equal(NavGrid._findPathSlot(3, 50), -1, 'COMPUTING is not ready');
  NavGrid.writePathData(slot, new Uint32Array([3, 50]), 2);
  assert.equal(NavGrid._findPathSlot(3, 50), slot);
});
