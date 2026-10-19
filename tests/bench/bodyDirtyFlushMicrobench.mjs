#!/usr/bin/env node
// Spawn-window close: the shipped flush scans every entity slot.
// The sparse case records the slots marked inside the window and walks only those.
//
//   node tests/bench/bodyDirtyFlushMicrobench.mjs --output tests/results/body-dirty-flush/kernel.json

import assert from 'node:assert/strict';

import {
  BODY_DIRTY,
  bindBodySyncBuffers,
  bumpBodyGeneration,
  markBodyDirty,
  withBodyDirtyDeferred,
} from '../../src/box2d/box2dBodySync.js';
import { checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const N = Number(args.entities ?? 65536);
const SEED = 0xb0d7f105;

function bind(n) {
  bindBodySyncBuffers({
    bodyDirtyFlags: new SharedArrayBuffer(n * 4),
    bodyDirtyWords: new SharedArrayBuffer(Math.ceil(n / 32) * 4),
    bodyGeneration: new SharedArrayBuffer(n * 4),
  });
}

// Sparse stand-in. Same publish rules as box2dBodySync, flush walks the mark list.
function makeSparse(n) {
  const dirtyFlags = new Int32Array(new SharedArrayBuffer(n * 4));
  const dirtyWords = new Int32Array(new SharedArrayBuffer(Math.ceil(n / 32) * 4));
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const pendingFlags = new Int32Array(n);
  const pendingIndex = new Int32Array(n);
  let pendingCount = 0;
  let depth = 0;

  function publish(i, flags) {
    const extra = pendingFlags[i];
    pendingFlags[i] = 0;
    Atomics.or(dirtyFlags, i, (flags | extra) | 0);
    Atomics.or(dirtyWords, i >>> 5, 1 << (i & 31));
  }

  function mark(entityIndex, flags, force) {
    const i = entityIndex | 0;
    if (depth > 0 && !force) {
      pendingFlags[i] |= flags;
      if (pendingCount < pendingIndex.length) pendingIndex[pendingCount++] = i;
      return;
    }
    publish(i, flags);
  }

  function bump(entityIndex) {
    const i = entityIndex | 0;
    Atomics.add(generation, i, 1);
    mark(i, 1, true);
  }

  function open(fn) {
    depth++;
    try {
      fn();
    } finally {
      depth--;
      if (depth !== 0) return;
      const count = pendingCount;
      pendingCount = 0;
      for (let k = 0; k < count; k++) {
        const i = pendingIndex[k];
        if (!pendingFlags[i]) continue;
        publish(i, 0);
      }
    }
  }

  return { dirtyFlags, dirtyWords, generation, open, mark, bump };
}

function denseScanFlush(pending, dirtyFlags, dirtyWords) {
  for (let i = 0; i < pending.length; i++) {
    if (!pending[i]) continue;
    const extra = pending[i];
    pending[i] = 0;
    Atomics.or(dirtyFlags, i, extra);
    Atomics.or(dirtyWords, i >>> 5, 1 << (i & 31));
  }
}

function makeDense(n) {
  const dirtyFlags = new Int32Array(new SharedArrayBuffer(n * 4));
  const dirtyWords = new Int32Array(new SharedArrayBuffer(Math.ceil(n / 32) * 4));
  const generation = new Int32Array(new SharedArrayBuffer(n * 4));
  const pendingFlags = new Int32Array(n);
  let depth = 0;

  function publish(i, flags) {
    const extra = pendingFlags[i];
    pendingFlags[i] = 0;
    Atomics.or(dirtyFlags, i, (flags | extra) | 0);
    Atomics.or(dirtyWords, i >>> 5, 1 << (i & 31));
  }

  function mark(entityIndex, flags, force) {
    const i = entityIndex | 0;
    if (depth > 0 && !force) {
      pendingFlags[i] |= flags;
      return;
    }
    publish(i, flags);
  }

  function bump(entityIndex) {
    const i = entityIndex | 0;
    Atomics.add(generation, i, 1);
    mark(i, 1, true);
  }

  function open(fn) {
    depth++;
    try {
      fn();
    } finally {
      depth--;
      if (depth === 0) denseScanFlush(pendingFlags, dirtyFlags, dirtyWords);
    }
  }

  return { dirtyFlags, dirtyWords, generation, open, mark, bump };
}

function runHot(side, iters) {
  for (let n = 0; n < iters; n++) {
    side.open(() => {
      side.mark(7, BODY_DIRTY.GEOMETRY, false);
      side.bump(7);
    });
  }
}

function runForeign(side, iters) {
  for (let n = 0; n < iters; n++) {
    side.open(() => {
      side.mark(4, BODY_DIRTY.LIFECYCLE, false);
      side.mark(9, BODY_DIRTY.GEOMETRY, false);
      side.bump(4);
    });
  }
}

function checkSame() {
  const dense = makeDense(N);
  const sparse = makeSparse(N);
  runForeign(dense, 1);
  runForeign(sparse, 1);
  assert.equal(dense.dirtyFlags[4] & BODY_DIRTY.LIFECYCLE, BODY_DIRTY.LIFECYCLE);
  assert.equal(sparse.dirtyFlags[4] & BODY_DIRTY.LIFECYCLE, BODY_DIRTY.LIFECYCLE);
  assert.equal(dense.dirtyFlags[9], sparse.dirtyFlags[9]);
  assert.equal(dense.dirtyWords[0], sparse.dirtyWords[0]);
  assert.equal(
    checksumInts(dense.dirtyFlags, 16),
    checksumInts(sparse.dirtyFlags, 16),
  );
}

function main() {
  checkSame();
  bind(N);
  // Shipped close, after the spawn bump already published slot 7.
  const shipped = timeIt('shipped_empty_flush', (iters) => {
    for (let n = 0; n < iters; n++) {
      withBodyDirtyDeferred(() => {
        markBodyDirty(7, BODY_DIRTY.GEOMETRY);
        bumpBodyGeneration(7);
      });
    }
  }, { iterations: 2000 });

  const dense = makeDense(N);
  const sparse = makeSparse(N);
  const denseHot = timeIt('dense_empty_flush', (iters) => runHot(dense, iters), { iterations: 2000 });
  const sparseHot = timeIt('sparse_empty_flush', (iters) => runHot(sparse, iters), { iterations: 2000 });
  const denseForeign = timeIt('dense_one_foreign', (iters) => runForeign(dense, iters), { iterations: 2000 });
  const sparseForeign = timeIt('sparse_one_foreign', (iters) => runForeign(sparse, iters), { iterations: 2000 });

  const report = {
    feature: 'body-dirty-flush',
    hypothesis: 'A full scan of pending body flags on every spawn-window close is slower than walking only the marked slots, at 65536 entities.',
    seed: SEED,
    entities: N,
    checksum: checksumInts(sparse.dirtyFlags, 16),
    cases: {
      shippedEmptyFlush: shipped,
      denseEmptyFlush: denseHot,
      sparseEmptyFlush: sparseHot,
      denseOneForeign: denseForeign,
      sparseOneForeign: sparseForeign,
    },
  };
  const out = args.output ? String(args.output) : null;
  if (out) writeReport(out, report);
  const ratio = sparseHot.opsPerSec / denseHot.opsPerSec;
  console.log(`sparse/dense empty-flush ops ratio ${ratio.toFixed(2)}`);
}

if (isCli(import.meta.url)) main();
