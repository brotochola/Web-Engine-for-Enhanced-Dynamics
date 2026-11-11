// E-207: the particle worker's A* runs in navFlowfield.wasm (astar_path), on the navigation memory a scene makes
// (createNavigationMemory). It is navAstar.js's search ported cell for cell, the same heap moves and ties, so the
// slot it fills must hold the JS's path exactly: on astarStressScene's maze, on random rubble at two densities
// (unreachable targets included), with paths cut by maxPathLength, and across the generation counter's wrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NavGrid } from '../../src/core/navGrid.js';
import { NavScratch, searchAstar } from '../reference/navAstar.mjs';
import { createNavigationMemory } from '../../src/util/navigationMemory.js';
import { FLOWFIELD_SLOTS } from '../../src/workers/navFlowfieldClient.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { initWorker, loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildMaze, COLS, ROWS } from '../bench/stressScenes/astarStress/astarMaze.js';

async function setup(gridWidth, gridHeight, walls, maxPathLength = 1024) {
  const navigation = { enabled: true, cellSize: 32, maxFlowfields: 1, maxPaths: 4, maxPathLength, maxProcessingMsPerFrame: 8 };
  const cells = gridWidth * gridHeight;
  const nm = createNavigationMemory(NavGrid.calculateSABSize(navigation, gridWidth, gridHeight), cells);
  NavGrid.writeHeader(nm.buffer, navigation, gridWidth, gridHeight);
  const walk = new Uint8Array(nm.buffer, NavGrid._HEADER_SIZE, cells).fill(1);
  walls(walk);
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await quietly(() =>
    initWorker(worker, {
      config: {
        worldWidth: gridWidth * navigation.cellSize,
        worldHeight: gridHeight * navigation.cellSize,
        navigation,
        particle: { maxParticles: 0, decals: false },
      },
      globalEntityCount: 0,
      buffers: { navigationData: nm.buffer },
      extra: { navigationMemory: nm.memory, navigationLayout: nm.layout },
    }),
  );
  assert.ok(worker._flowWasm && worker._flowWasm.astar, 'the worker bound the A* kernel');
  return { worker, walk, gridWidth, gridHeight, maxPathLength };
}

/** The particle worker's path for the pair, read back from the slot it filled. */
function workerPath(ctx, from, to) {
  ctx.worker.computePath(from, to);
  const slot = NavGrid._findPathSlot(from, to);
  assert.ok(slot >= 0, `a slot for ${from} -> ${to}`);
  const u32 = NavGrid._u32;
  const base = (NavGrid._pathHeadersOffset + slot * NavGrid._pathSlotSize) >> 2;
  const n = u32[base + 3];
  return Array.from(u32.subarray(base + 5, base + 5 + n));
}

function jsPath(ctx, from, to) {
  const { gridWidth: w, gridHeight: h } = ctx;
  const s = new NavScratch(w * h, ctx.maxPathLength, w, h);
  const n = searchAstar(s, ctx.walk, w, h, from, to);
  return Array.from(s.pathResult.subarray(0, n));
}

function samePaths(ctx, pairs, label) {
  let reached = 0;
  for (const [from, to] of pairs) {
    const want = jsPath(ctx, from, to);
    assert.deepEqual(workerPath(ctx, from, to), want, `${label}: ${from} -> ${to}`);
    if (want.length > 0) reached++;
  }
  return reached;
}

function randomPairs(walk, count, seed, walkableOnly = true) {
  const r = mulberry32(seed);
  const out = [];
  while (out.length < count) {
    const a = Math.floor(r() * walk.length);
    const b = Math.floor(r() * walk.length);
    if (a === b) continue;
    if (walkableOnly && (!walk[a] || !walk[b])) continue;
    out.push([a, b]);
  }
  return out;
}

test("astarStressScene's maze: the kernel's paths are the JS's", { concurrency: false }, async () => {
  const maze = buildMaze(207);
  const ctx = await setup(COLS, ROWS, (walk) => walk.set(maze.walkable));
  const reached = samePaths(ctx, randomPairs(ctx.walk, 400, 7), 'maze');
  assert.ok(reached > 350, `${reached} of 400 reached`);
});

test('random rubble at two densities, unreachable targets and walls as targets included', { concurrency: false }, async () => {
  for (const [p, seed] of [[0.2, 11], [0.4, 12]]) {
    const r = mulberry32(seed);
    const ctx = await setup(40, 30, (walk) => {
      for (let i = 0; i < walk.length; i++) walk[i] = r() < p ? 0 : 1 + Math.floor(r() * 255);
    });
    samePaths(ctx, randomPairs(ctx.walk, 300, seed + 100, false), `rubble ${p}`);
  }
});

test('paths longer than maxPathLength keep the same last cells', { concurrency: false }, async () => {
  const maze = buildMaze(207);
  const ctx = await setup(COLS, ROWS, (walk) => walk.set(maze.walkable), 16);
  samePaths(ctx, randomPairs(ctx.walk, 100, 21), 'cut at 16');
});

test('the generation counter wraps without leaving a mark behind', { concurrency: false }, async () => {
  const maze = buildMaze(207);
  const ctx = await setup(COLS, ROWS, (walk) => walk.set(maze.walkable));
  const pairs = randomPairs(ctx.walk, 12, 31);
  const k = ctx.worker._flowWasm;
  const table = new Uint32Array(k.vectors.buffer, k.tableByte, FLOWFIELD_SLOTS.length);
  table[FLOWFIELD_SLOTS.indexOf('aSearch')] = 0x7ffffffc;
  samePaths(ctx, pairs, 'across the wrap');
  assert.ok(table[FLOWFIELD_SLOTS.indexOf('aSearch')] < 100, 'the counter wrapped');
});
