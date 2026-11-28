import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { bindEntityIdWidth, entityIdNone } from '../../src/util/entityIdWidth.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { customLayerCollector } from '../bench/workerHarness.mjs';
import { setupDecorationCollect } from '../bench/decorationCollectMicrobench.mjs';

// E-520, the decoration collect kernel (wasm/preRenderCollect.c collect_decorations). On the same bytes, the worker's
// collectVisibleDecorations through the kernel must leave the main collector, a custom layer's collector, every
// decoration's depthFootDy, the visible count and the overflow warning exactly as its JS loops leave them (the path it
// takes without the kernel): the world-owned decorations with no layer mask written by the kernel, every attached or
// masked one handed back and collected by the JS at its place in the list.

const D = DecorationComponent;
const SENTINEL = 12345.5;

/** Decoration columns the collect reads, made less tidy than the microbench's: draw offsets, negative sort offsets, -0. */
function roughen(n, seed, { masked = 0, idleParents = 0 } = {}) {
  const rng = mulberry32(seed);
  for (let d = 0; d < n; d++) {
    if (rng() < 0.5) {
      D.offsetX[d] = (rng() - 0.5) * 40;
      D.offsetY[d] = -rng() * 120;
    }
    if (rng() < 0.3) D.sortOffsetY[d] = (rng() - 0.6) * 200;
    if (rng() < 0.02) D.y[d] = -0;
    if (rng() < 0.02) D.sortOffsetY[d] = 0.5;
    // A spawned decoration's mask is the entities' bit (the setup's); some have none, some a bit no layer queues.
    if (rng() < 0.1) D.layerMask[d] = 0;
    else if (rng() < 0.02) D.layerMask[d] = Layer.entitiesMask() | 0x8000;
    if (masked && rng() < 0.05) D.layerMask[d] = rng() < 0.5 ? masked : masked | Layer.entitiesMask();
  }
  for (let p = 0; p < idleParents; p++) Transform.active[p] = 0;
}

function clear(pre, n) {
  pre._renderableY.fill(SENTINEL);
  pre._renderableType.fill(255);
  pre._renderableIndex.fill(-7);
  for (const a of [pre._collectPx, pre._collectPy, pre._collectRotC, pre._collectRotS]) a.fill(SENTINEL);
  D.depthFootDy.fill(SENTINEL, 0, n);
  pre._renderQueueOverflowWarned = false;
  if (pre._customLayerCollectors) {
    for (const c of Object.values(pre._customLayerCollectors)) {
      c.count = 0;
      c._overflowWarned = false;
    }
  }
}

function snapshot(pre, n) {
  const rows = pre._renderableCount;
  const bits = (a, len = rows) => Array.from(new Uint32Array(a.buffer, a.byteOffset, len));
  const custom = {};
  for (const [id, c] of Object.entries(pre._customLayerCollectors || {})) {
    custom[id] = {
      count: c.count,
      index: Array.from(c.index.subarray(0, c.count)),
      y: bits(c.y, c.count),
      x: bits(c.stashX, c.count),
      py: bits(c.stashY, c.count),
    };
  }
  return {
    rows,
    visible: pre.visibleDecorationsCount,
    warned: pre._renderQueueOverflowWarned,
    type: Array.from(pre._renderableType.subarray(0, rows)),
    index: Array.from(pre._renderableIndex.subarray(0, rows)),
    y: bits(pre._renderableY), x: bits(pre._collectPx), py: bits(pre._collectPy),
    rc: bits(pre._collectRotC), rs: bits(pre._collectRotS),
    foot: bits(D.depthFootDy, n),
    custom,
  };
}

const CASES = [
  { name: 'no layer y-sorts, half attached, the list in no order', opts: { n: 3000 } },
  { name: 'y-sort, half attached in runs', opts: { n: 3000, ySort: true } },
  { name: 'y-sort, world-owned faces with sort offsets', opts: { n: 3000, ySort: true, attachedShare: 0, sortOffset: true } },
  { name: 'y-sort, a full collector', opts: { n: 3000, ySort: true, maxItems: 1000 } },
  { name: 'no y-sort, a full collector', opts: { n: 3000, maxItems: 1200 } },
  { name: 'masked decorations to a custom layer, y-sort', opts: { n: 3000, ySort: true, customLayers: { fx: {} } }, masked: true },
  { name: 'masked decorations to a custom layer, no y-sort', opts: { n: 3000, customLayers: { fx: {} } }, masked: true },
  { name: 'parents that are not active (their decorations sort as world-owned)', opts: { n: 3000, ySort: true }, idleParents: 150 },
  { name: 'a 32-bit visible list (past 65 535 decorations)', opts: { n: 70000, ySort: true, attachedShare: 0.1, parents: 50 } },
  { name: '32-bit parent ids', opts: { n: 3000, ySort: true }, wideIds: true },
];

for (const c of CASES) {
  test(`the decoration collect kernel leaves the collectors as the JS loops do: ${c.name}`, async () => {
    if (c.wideIds) bindEntityIdWidth(32);
    try {
      const s = await setupDecorationCollect({ seed: 0xe520 + CASES.indexOf(c), ...c.opts });
      const { pre, n } = s;
      pre._noParent = entityIdNone;
      const fx = c.masked ? Layer.get('fx').id : -1;
      if (c.masked) pre._customLayerCollectors = { [fx]: customLayerCollector(n) };
      roughen(n, 77 + CASES.indexOf(c), { masked: c.masked ? 1 << fx : 0, idleParents: c.idleParents | 0 });
      const kernel = pre._collectWasm;
      assert.ok(kernel && kernel.decorations >= n, 'the setup bound the kernel with room for the list');
      let calls = 0;
      const collect = kernel.collectDecorations;
      kernel.collectDecorations = (...a) => {
        calls++;
        return collect(...a);
      };
      let handedBack = 0;
      const collectJs = pre._collectDecorationJs;
      pre._collectDecorationJs = function (...a) {
        handedBack++;
        return collectJs.apply(this, a);
      };

      const warn = console.warn;
      console.warn = () => {};
      try {
        clear(pre, n);
        pre._collectWasm = null;
        s.frame();
        const js = snapshot(pre, n);

        clear(pre, n);
        pre._collectWasm = kernel;
        s.frame();
        const wasm = snapshot(pre, n);

        assert.ok(calls > 0, 'the collect took the kernel');
        if (s.attached > 0 || c.masked) assert.ok(handedBack > 10, `attached or masked decorations went back to the JS (${handedBack})`);
        if (!c.masked && !(c.idleParents > 0)) assert.equal(handedBack, s.attached, 'the JS collected the attached ones, and no other');
        assert.ok(js.rows > 500, `the case collects decorations (${js.rows})`);
        if (c.opts.maxItems) assert.equal(js.warned, true, 'the collector filled');
        if (c.masked) assert.ok(js.custom[fx].count > 20, 'masked decorations reached the fx collector');
        assert.deepEqual(wasm, js);
      } finally {
        console.warn = warn;
      }
    } finally {
      if (c.wideIds) bindEntityIdWidth(16);
      Layer.reset();
    }
  });
}

test('without room for the list, or with a column outside the memory, the collect runs its JS loops', async () => {
  const s = await setupDecorationCollect({ n: 2000, ySort: true, seed: 5 });
  const { pre, n } = s;
  const kernel = pre._collectWasm;
  let calls = 0;
  const collect = kernel.collectDecorations;
  kernel.collectDecorations = (...a) => {
    calls++;
    return collect(...a);
  };
  try {
    clear(pre, n);
    s.frame();
    const withKernel = snapshot(pre, n);
    assert.ok(calls > 0);

    calls = 0;
    const room = kernel.decorations;
    kernel.decorations = n - 1;
    clear(pre, n);
    s.frame();
    kernel.decorations = room;
    assert.equal(calls, 0, 'a list longer than the region: the JS loops');
    assert.deepEqual(snapshot(pre, n), withKernel);

    const px = pre._collectPx;
    pre._collectPx = new Float32Array(px.length);
    clear(pre, n);
    s.frame();
    assert.equal(calls, 0, 'a collector column outside the memory: the JS loops');
    const outside = pre._collectPx;
    pre._collectPx = px;
    assert.equal(pre._renderableCount, withKernel.rows);
    assert.deepEqual(Array.from(new Uint32Array(outside.buffer, 0, withKernel.rows)), withKernel.x, 'the same poses');
  } finally {
    Layer.reset();
  }
});
