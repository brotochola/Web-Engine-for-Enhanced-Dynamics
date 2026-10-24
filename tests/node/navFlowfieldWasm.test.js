// E-76 W14: the flowfield kernel (wasm/test/navFlowfield.c, tests/fixtures/wasm/navFlowfield.wasm) against
// the shipped ParticleWorker.computeFlowfield on a real particle worker, both on one shared memory as
// navFlowfieldWasmMicrobench.mjs lays it out. Grids of the sizes a scene can make: 1 × 1 up to 256 × 256,
// one row or one column, a 1 × 7000 line whose far end lies past the 65 535 a distance holds, a 4 700 × 2
// strip whose maxDistance clamps to 65 535. Open fields, random walls at three densities, rooms with sealed
// rooms, a serpentine whose path runs far past maxDistance (the catch-all bucket, popped in list order),
// lead-ins where a cell in that bucket is shortened and keeps its place, every cell a wall, scattered single
// cells, walkability values 1 .. 255. Targets on the corners, the edges, walls, sealed rooms and random
// cells. For each: the kernel's distances, directions, settled count and vectors, and the slot its wrapper
// fills, are the JS's bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { roomWalls, setupFlowfieldKernel, STRESS_NAVIGATION } from '../bench/navFlowfieldWasmMicrobench.mjs';
import { createNavigationMemory } from '../../src/util/navigationMemory.js';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';

// Few slots: the parity is per flowfield, and a 256 × 256 slot is 128 KB.
const NAVIGATION = { ...STRESS_NAVIGATION, maxFlowfields: 4, maxPaths: 2, maxPathLength: 16 };

/** Walls with probability p; walkable cells get any value 1 .. 255 (only 0 blocks). */
const randomWalls = (p, seed) => (walk) => {
  const r = mulberry32(seed);
  for (let i = 0; i < walk.length; i++) walk[i] = r() < p ? 0 : 1 + Math.floor(r() * 255);
};

/** One corridor: a wall on every odd row, open at the right end, then the left, then the right... */
const serpentine = (walk, gw, gh) => {
  for (let y = 1; y < gh; y += 2) {
    const gap = (y >> 1) % 2 === 0 ? gw - 1 : 0;
    for (let x = 0; x < gw; x++) if (x !== gap) walk[y * gw + x] = 0;
  }
};

/**
 * A one-cell serpentine over the first `rows` rows, then rubble at density p: the path leaves the
 * serpentine just under maxDistance, so the rubble's detours cross it. With these seeds a cell filed in
 * the last bucket is shortened to a distance that still clamps there (_bucketInsertCell's early return).
 */
const leadIn = (rows, p, seed) => (walk, gw) => {
  const r = mulberry32(seed);
  for (let i = 0; i < walk.length; i++) walk[i] = r() < p ? 0 : 1;
  for (let i = 0; i < rows * gw; i++) walk[i] = 1;
  for (let y = 1; y < rows; y += 2) {
    const gap = (y >> 1) % 2 === 0 ? gw - 1 : 0;
    for (let x = 0; x < gw; x++) if (x !== gap) walk[y * gw + x] = 0;
  }
};

const allWalls = (walk) => walk.fill(0);

/** Every cell a wall but one in twenty. */
const scattered = (seed) => (walk) => {
  const r = mulberry32(seed);
  for (let i = 0; i < walk.length; i++) walk[i] = r() < 0.05 ? 1 : 0;
};

const rooms = (seed) => (walk, gw, gh) => {
  randomWalls(0, seed)(walk);
  roomWalls(walk, gw, gh);
};

const CASES = [
  // [label, width, height, walls, random targets]
  ['the scene, 64 × 64 open', 64, 64, null, 4],
  ['1 × 1', 1, 1, null, 0],
  ['1 × 2', 1, 2, null, 0],
  ['2 × 1', 2, 1, null, 0],
  ['2 × 2', 2, 2, null, 0],
  ['3 × 5 open', 3, 5, null, 2],
  ['5 × 3 walls 0.3', 5, 3, randomWalls(0.3, 11), 4],
  ['1 × 9 walls 0.2', 1, 9, randomWalls(0.2, 12), 3],
  ['9 × 1 walls 0.2', 9, 1, randomWalls(0.2, 13), 3],
  ['37 × 23 walls 0.1', 37, 23, randomWalls(0.1, 14), 4],
  ['37 × 23 walls 0.3', 37, 23, randomWalls(0.3, 15), 4],
  ['37 × 23 walls 0.5', 37, 23, randomWalls(0.5, 16), 4],
  ['50 × 75 walls 0.3', 50, 75, randomWalls(0.3, 17), 3],
  ['16 × 16 all walls', 16, 16, allWalls, 2],
  ['33 × 33 scattered cells', 33, 33, scattered(18), 4],
  ['64 × 64 rooms', 64, 64, rooms(19), 4],
  ['61 × 47 rooms', 61, 47, rooms(20), 4],
  ['40 × 40 serpentine', 40, 40, serpentine, 2],
  ['64 × 64 serpentine', 64, 64, serpentine, 1],
  ['20 × 40 lead-in, rubble 0.3', 20, 40, leadIn(7, 0.3, 3), 1],
  ['20 × 40 lead-in, rubble 0.2', 20, 40, leadIn(8, 0.2, 285), 1],
  // Here the kept cell's place in the last bucket decides which search reaches a region first: a kernel
  // that moved it to the head would differ in 208 cells (seed 170) and 3 (seed 140).
  ['20 × 40 lead-in, seed 170', 20, 40, leadIn(7, 0.3, 170), 0],
  ['20 × 40 lead-in, seed 140', 20, 40, leadIn(7, 0.3, 140), 0],
  ['128 × 96 walls 0.2', 128, 96, randomWalls(0.2, 21), 1],
  ['256 × 256 walls 0.1', 256, 256, randomWalls(0.1, 22), 0],
  ['1 × 7000 line', 1, 7000, null, 0],
  ['4700 × 2 strip', 4700, 2, null, 0],
];

/** Corners, edge middles and the centre, a wall and a walkable cell if any, and `extra` random cells. */
function targetsFor(k, extra, r) {
  const { gridWidth: gw, gridHeight: gh, cells, walk } = k;
  const out = new Set([0, gw - 1, cells - gw, cells - 1, gw >> 1, (gh >> 1) * gw, (gh >> 1) * gw + gw - 1, cells >> 1]);
  const walls = [];
  const open = [];
  for (let i = 0; i < cells; i++) (walk[i] === 0 ? walls : open).push(i);
  if (walls.length) out.add(walls[Math.floor(r() * walls.length)]);
  if (open.length) out.add(open[Math.floor(r() * open.length)]);
  for (let i = 0; i < extra; i++) out.add(Math.floor(r() * cells));
  return [...out];
}

/** The first difference between two arrays, as cell (x, y), so a failure names where. */
function assertSame(actual, expected, gw, what) {
  assert.equal(actual.length, expected.length, `${what}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      const cell = what.includes('vectors') || what.includes('slot') ? i >> 1 : i;
      assert.fail(`${what}: index ${i} (cell ${cell % gw}, ${Math.floor(cell / gw)}) is ${actual[i]}, the JS has ${expected[i]}`);
    }
  }
}

/** The JS flowfield, then the kernel through its wrapper, for one target. */
function assertParity(k, target, label) {
  const s = k.worker.scratch;
  k.flowfieldJs(target);
  const dist = s.distance.slice();
  const dir = s.direction.slice();
  const vectors = s.smoothedVectors.slice();
  const slot = k.slotVectors(target).slice();
  let settled = 0;
  for (let i = 0; i < k.cells; i++) if (s.stamp[i] === s.currentStamp) settled++;

  const at = `${label}, target (${target % k.gridWidth}, ${Math.floor(target / k.gridWidth)})`;
  k.slotVectors(target).fill(0xa5);
  assert.equal(k.flowfieldWasm(target), settled, `${at}: settled cells`);
  assertSame(k.kernelDist, dist, k.gridWidth, `${at}: distance`);
  assertSame(k.kernelDir, dir, k.gridWidth, `${at}: direction`);
  assertSame(k.kernelVectors, vectors, k.gridWidth, `${at}: vectors`);
  assertSame(k.slotVectors(target), slot, k.gridWidth, `${at}: slot`);
  return settled;
}

test('the flowfield kernel writes what computeFlowfield writes, grid after grid', async (t) => {
  const r = mulberry32(0x0f10);
  for (const [label, gw, gh, walls, extra] of CASES) {
    await t.test(label, async () => {
      const k = await setupFlowfieldKernel({ gridWidth: gw, gridHeight: gh, navigation: NAVIGATION, walls });
      let settled = 0;
      for (const target of targetsFor(k, extra, r)) settled += assertParity(k, target, label);
      assert.ok(settled > 0);
    });
  }
});

/** The shipped _bucketInsertCell's two paths for a filed cell over one JS flowfield: moved, or kept in place. */
function bucketMoves(k, target) {
  const proto = Object.getPrototypeOf(k.worker);
  const shipped = proto._bucketInsertCell;
  const counts = { moved: 0, kept: 0 };
  proto._bucketInsertCell = function (scratch, cell, bucket) {
    const old = scratch.bucketNodeDist[cell];
    if (old >= 0) counts[old === Math.min(bucket, scratch.maxDistance) ? 'kept' : 'moved']++;
    return shipped.call(this, scratch, cell, bucket);
  };
  try {
    k.flowfieldJs(target);
  } finally {
    proto._bucketInsertCell = shipped;
  }
  return counts;
}

test('the reach the cases are meant to have', async () => {
  // Random walls move filed cells to a nearer bucket; the lead-ins keep one in the last bucket.
  const rubble = await setupFlowfieldKernel({ gridWidth: 37, gridHeight: 23, navigation: NAVIGATION, walls: randomWalls(0.3, 15) });
  assert.ok(bucketMoves(rubble, 0).moved > 0);
  for (const walls of [leadIn(7, 0.3, 3), leadIn(8, 0.2, 285)]) {
    const k = await setupFlowfieldKernel({ gridWidth: 20, gridHeight: 40, navigation: NAVIGATION, walls });
    assert.ok(bucketMoves(k, 0).kept > 0);
    assertParity(k, 0, 'lead-in');
  }
  // The line's far end is past 65 535: unreached, as the JS leaves it.
  const line = await setupFlowfieldKernel({ gridWidth: 1, gridHeight: 7000, navigation: NAVIGATION });
  assert.equal(assertParity(line, 0, 'line'), 6554);
  assert.equal(line.kernelDist[6999], 65535);
  // The strip's maxDistance is clamped.
  const strip = await setupFlowfieldKernel({ gridWidth: 4700, gridHeight: 2, navigation: NAVIGATION });
  assert.equal(strip.worker.scratch.maxDistance, 65535);
  // The serpentine's distances run past maxDistance, so most cells go through the catch-all bucket.
  const snake = await setupFlowfieldKernel({ gridWidth: 40, gridHeight: 40, navigation: NAVIGATION, walls: serpentine });
  assertParity(snake, 0, 'serpentine');
  const past = snake.kernelDist.filter((d) => d !== 65535 && d > snake.worker.scratch.maxDistance).length;
  assert.ok(past > 400, `${past} cells past maxDistance`);
  // roomWalls seals room (rx, ry) when (7 rx + 3 ry) % 11 === 5: (1, 3) is sealed, (2, 5) is not. A
  // target in the sealed one settles its 7 × 7 inside and nothing else.
  const walled = await setupFlowfieldKernel({ gridWidth: 64, gridHeight: 64, navigation: NAVIGATION, walls: rooms(19) });
  assert.equal(assertParity(walled, 28 * 64 + 12, 'rooms, sealed room'), 49);
  assert.ok(assertParity(walled, 44 * 64 + 20, 'rooms, open room') > 49);
});

test('a target off the grid writes nothing', async () => {
  const k = await setupFlowfieldKernel({ gridWidth: 8, gridHeight: 6, navigation: NAVIGATION });
  k.kernelVectors.fill(7);
  assert.equal(k.computeFlowfield(k.tableByte, 48), 0);
  assert.equal(k.computeFlowfield(k.tableByte, 0xffffffff), 0);
  assert.ok(k.kernelVectors.every((v) => v === 7));
});

test("the bench's warm-up leaves the grid as it found it", async () => {
  // The short calls read the grid's first cells as 4 × 4 and leave flowfields of it in the slots.
  const k = await setupFlowfieldKernel({ gridWidth: 64, gridHeight: 64, navigation: NAVIGATION, walls: rooms(23) });
  k.warmJs(20);
  await k.warmKernel(20);
  assert.equal(k.worker.gridWidth, 64);
  assert.equal(k.worker.gridHeight, 64);
  assert.equal(k.worker.totalCells, 4096);
  assert.equal(k.worker.cachedFlowfieldsCount, 0);
  for (let i = 0; i < NAVIGATION.maxFlowfields; i++) {
    const header = (NavGrid._flowfieldHeadersOffset + i * NavGrid._flowfieldSlotSize) >> 2;
    assert.equal(NavGrid._u32[header + 2], 0, `slot ${i} is not empty`);
  }
  assertParity(k, 33 * 64 + 21, 'after warm-up');
});

// W14 wired: a particle worker booted on the navigation memory as the scene makes it (the nav buffer at
// byte 0, the flowfield's scratch after it) binds the kernel at init; computeFlowfield with the kernel
// and without it must fill each target's slot with the same vectors and count the same cached flowfields.
// The targets stay under the slots, so no eviction (whose stamps are whole seconds) can tell the runs apart.
test('computeFlowfield through the kernel the worker binds fills the slots the JS fills', async (t) => {
  const navigation = { ...STRESS_NAVIGATION };
  for (const map of ['open', 'rooms']) {
    const gridWidth = 64;
    const gridHeight = 64;
    const cells = gridWidth * gridHeight;
    const m = createNavigationMemory(NavGrid.calculateSABSize(navigation, gridWidth, gridHeight), cells);
    assert.ok(m, 'the navigation memory is made');
    NavGrid.writeHeader(m.buffer, navigation, gridWidth, gridHeight);
    const walk = new Uint8Array(m.buffer, NavGrid._HEADER_SIZE, cells).fill(1);
    if (map === 'rooms') roomWalls(walk, gridWidth, gridHeight);
    const worker = await loadWorker('particleWorker.js', 'particleWorker');
    await initWorker(worker, {
      config: {
        worldWidth: gridWidth * navigation.cellSize,
        worldHeight: gridHeight * navigation.cellSize,
        navigation,
        particle: { maxParticles: 0, decals: false },
      },
      globalEntityCount: 0,
      buffers: { navigationData: m.buffer },
      extra: { navigationMemory: m.memory, navigationLayout: m.layout },
    });
    const bound = worker._flowWasm;
    assert.ok(bound, `${map}: the worker bound the kernel at init`);
    let calls = 0;
    const compute = bound.compute;
    bound.compute = (...args) => {
      calls++;
      return compute(...args);
    };
    const r = mulberry32(map === 'open' ? 0xf10 : 0xf11);
    const targets = [];
    while (targets.length < navigation.maxFlowfields - 4) {
      const cell = Math.floor(r() * cells);
      if (!targets.includes(cell)) targets.push(cell);
    }
    const slotBytes = (cell) => {
      const slot = worker._findExistingFlowfieldSlot(cell);
      assert.ok(slot >= 0, `${map}: a READY flowfield for cell ${cell}`);
      const byte = NavGrid._flowfieldHeadersOffset + slot * NavGrid._flowfieldSlotSize + NavGrid._FLOWFIELD_HEADER_SIZE;
      return Buffer.from(new Uint8Array(m.buffer, byte, cells * 2));
    };
    const run = (kernel) => {
      NavGrid.invalidate();
      worker.cachedFlowfieldsCount = 0;
      worker._flowWasm = kernel;
      for (const cell of targets) worker.computeFlowfield(cell);
      return { slots: targets.map(slotBytes), cached: worker.cachedFlowfieldsCount };
    };
    const js = run(null);
    const wasm = run(bound);
    assert.equal(calls, targets.length, `${map}: the kernel took every flowfield`);
    assert.equal(wasm.cached, js.cached, `${map}: cached flowfields`);
    targets.forEach((cell, k) => {
      const at = wasm.slots[k].findIndex((x, i) => x !== js.slots[k][i]);
      assert.equal(at, -1, `${map}: target ${cell}: the slot differs at byte ${at}`);
    });
    t.diagnostic(`${map}: ${targets.length} flowfields, ${walk.reduce((n, w) => n + (w === 0 ? 1 : 0), 0)} walls`);
  }
});
