// N-303 CR-35: public API nothing in the repo calls. Each item keeps a behavioural test so it cannot break unseen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Grid } from '../../src/core/grid.js';
import { DebugFlags, DEBUG_FLAGS } from '../../src/core/debug/debugFlags.js';
import { LiquidFun } from '../../src/core/liquidFun.js';
import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
} from '../../src/box2d/box2dCommandRing.js';

class Lamp extends GameObject {}

function quietScene() {
  const saved = console.warn;
  console.warn = () => {};
  try {
    return new (class Cave extends Scene {
      static entities = [[Lamp, 4]];
      static config = { worldWidth: 2000, worldHeight: 2000 };
    })({});
  } finally {
    console.warn = saved;
  }
}

// ---- Scene ----

test('Scene.needsParticleWorker is always true (the particle worker also does lighting and visibility)', () => {
  const scene = quietScene();
  assert.equal(scene.needsParticleWorker, true);
});

test('Scene.numberOfPreRenderWorkers is always 1', () => {
  const scene = quietScene();
  assert.equal(scene.numberOfPreRenderWorkers, 1);
});

test('Scene.getMemoryUsageSummary totals the scene buffers, counting an aliased buffer once', () => {
  const scene = quietScene();
  const shared = new SharedArrayBuffer(256);
  scene.buffers = {
    inputData: new SharedArrayBuffer(64),
    spatial: { gridBuffer: shared, neighborBuffer: shared },
    nothing: null,
  };
  const summary = scene.getMemoryUsageSummary();
  assert.equal(summary.totalBytes, 64 + 256);
  assert.equal(summary.bufferCount, 2);
  assert.equal(summary.categories.inputData.totalBytes, 64);
  assert.equal(summary.categories.spatial.totalBytes, 256);
  assert.equal(typeof summary.totalFormatted, 'string');
});

// ---- Grid cell sleeping ----

function withSleepingGrid(totalCells, fn) {
  Grid.reset();
  const sab = new SharedArrayBuffer(totalCells);
  Grid.initialize({ cellSleepingBuffer: sab }, { cellSize: 128, gridWidth: totalCells / 2, gridHeight: 2 });
  try {
    fn(sab);
  } finally {
    Grid.reset();
  }
}

test('Grid.setCellSleeping and getCellSleeping write and read the shared per-cell byte', () => {
  withSleepingGrid(8, (sab) => {
    assert.equal(Grid.totalCells, 8);
    assert.equal(Grid.getCellSleeping(3), 0);
    Grid.setCellSleeping(3, true);
    assert.equal(Grid.getCellSleeping(3), 1);
    assert.equal(new Uint8Array(sab)[3], 1);
    Grid.setCellSleeping(3, 0);
    assert.equal(Grid.getCellSleeping(3), 0);
    Grid.setCellSleeping(5, 7); // any truthy value stores 1
    assert.equal(new Uint8Array(sab)[5], 1);
  });
});

test('Grid cell sleeping ignores indices outside the grid', () => {
  withSleepingGrid(8, (sab) => {
    Grid.setCellSleeping(-1, true);
    Grid.setCellSleeping(8, true);
    assert.equal(Grid.getCellSleeping(-1), 0);
    assert.equal(Grid.getCellSleeping(8), 0);
    assert.equal(new Uint8Array(sab).some((v) => v !== 0), false);
  });
});

test('Grid.getSleepingCellCount and getCellSleepingStats count sleeping cells', () => {
  withSleepingGrid(8, () => {
    assert.equal(Grid.getSleepingCellCount(), 0);
    Grid.setCellSleeping(0, true);
    Grid.setCellSleeping(1, true);
    Grid.setCellSleeping(7, true);
    assert.equal(Grid.getSleepingCellCount(), 3);
    assert.equal(Grid.cellSleepingData.length, 8);
    assert.deepEqual(Grid.getCellSleepingStats(), {
      totalCells: 8,
      sleepingCells: 3,
      awakeCells: 5,
      sleepingPercentage: '37.50',
      awakePercentage: '62.50',
    });
  });
});

test('Grid cell sleeping reads as awake and empty when the buffer was never bound', () => {
  Grid.reset();
  assert.equal(Grid.getCellSleeping(0), 0);
  Grid.setCellSleeping(0, true);
  assert.equal(Grid.getSleepingCellCount(), 0);
  assert.equal(Grid.getCellSleepingStats().totalCells, 0);
});

// ---- DebugFlags ----

test('DebugFlags.showProfiler and showCollisionCandidates set SHOW_PROFILER and SHOW_COLLISION_CANDIDATES', () => {
  const flags = new DebugFlags(new SharedArrayBuffer(32));
  assert.equal(flags.showProfiler(), flags);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_PROFILER), true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES), false);
  flags.showCollisionCandidates(true);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES), true);
  assert.equal(flags.flags[DEBUG_FLAGS.SHOW_PROFILER], 1);
  assert.equal(flags.flags[DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES], 1);
  flags.showProfiler(false).showCollisionCandidates(false);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_PROFILER), false);
  assert.equal(flags.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES), false);
});

test('DebugFlags.enablePerformanceDebug turns on the fps graph and the spatial grid only', () => {
  const flags = new DebugFlags(new SharedArrayBuffer(32));
  assert.equal(flags.enablePerformanceDebug(), flags);
  const on = Object.entries(flags.getState())
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(on, ['fpsGraph', 'spatialGrid']);
});

test('DebugFlags.colors is the renderer palette: packed 0xRRGGBB numbers', () => {
  const { colors } = new DebugFlags(new SharedArrayBuffer(32));
  assert.deepEqual(Object.keys(colors).sort(), [
    'acceleration',
    'collider',
    'grid',
    'neighbor',
    'text',
    'trigger',
    'velocity',
  ]);
  for (const value of Object.values(colors)) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffff);
  }
  assert.equal(colors.collider, 0x00ff00);
});

// ---- LiquidFun range wrappers ----

function drainLiquidFunRing(enqueue) {
  const ring = createCommandRingSab(32);
  bindCommandRing(ring);
  enqueue();
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  drainCommandRing(new Int32Array(ring), new Float32Array(ring), {
    setParticleUserDataRange: record('userData'),
    setParticleColorRange: record('color'),
    setParticleViscousScaleRange: record('viscous'),
    particleApplyForceRange: record('force'),
    particleApplyImpulseRange: record('impulse'),
  });
  return calls;
}

test('LiquidFun.setUserDataRange enqueues [first, last) with the bits', () => {
  assert.deepEqual(
    drainLiquidFunRing(() => LiquidFun.setUserDataRange(4, 12, 0xdeadbeef)),
    [['userData', 4, 12, 0xdeadbeef]],
  );
});

test('LiquidFun.setColorRange enqueues [first, last) with the packed RGBA', () => {
  assert.deepEqual(
    drainLiquidFunRing(() => LiquidFun.setColorRange(0, 100, 0xff8040ff)),
    [['color', 0, 100, 0xff8040ff]],
  );
});

test('LiquidFun.setViscousScaleRange enqueues the scale, and a scale of 0 or less means 1', () => {
  const scaleOf = (scale) => drainLiquidFunRing(() => LiquidFun.setViscousScaleRange(2, 9, scale));
  assert.deepEqual(scaleOf(3.5), [['viscous', 2, 9, 3.5]]);
  assert.deepEqual(scaleOf(0), [['viscous', 2, 9, 1]]);
  assert.deepEqual(scaleOf(-4), [['viscous', 2, 9, 1]]);
});

test('LiquidFun.applyForceRange enqueues the total force over [first, last)', () => {
  assert.deepEqual(
    drainLiquidFunRing(() => LiquidFun.applyForceRange(10, 20, 1.5, -2.5)),
    [['force', 10, 20, 1.5, -2.5]],
  );
});

test('LiquidFun.applyLinearImpulseRange enqueues the impulse over [first, last)', () => {
  assert.deepEqual(
    drainLiquidFunRing(() => LiquidFun.applyLinearImpulseRange(10, 20, 0.25, 4)),
    [['impulse', 10, 20, 0.25, 4]],
  );
});
