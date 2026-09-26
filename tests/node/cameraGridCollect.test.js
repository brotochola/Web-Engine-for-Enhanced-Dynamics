import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aabbCellRange,
  cameraWorldAabb,
  splitRowRange,
  fillCameraCellIndices,
  spriteOnScreen,
  viewYBand,
  inViewYBand,
} from '../../src/util/cameraGridCollect.js';
import {
  spriteYSortKey,
  zSortBand,
  orderSortKey,
  createPainterState,
  orderPainterSlots,
} from '../../src/util/sortIndexByKey.js';

const Y_SORT_K = 128;
const CELL = 100;
const GRID_W = 20;
const GRID_H = 20;

function keysU32Of(sortKey) {
  return new Uint32Array(sortKey.buffer, sortKey.byteOffset, sortKey.length);
}

function cellIndex(x, y) {
  const col = (x / CELL) | 0;
  const row = (y / CELL) | 0;
  return row * GRID_W + col;
}

test('aabbCellRange is inclusive and clamps to the grid', () => {
  const r = aabbCellRange(50, 50, 250, 150, CELL, GRID_W, GRID_H);
  assert.deepEqual(r, { col0: 0, col1: 2, row0: 0, row1: 1 });
  const empty = aabbCellRange(10, 10, 1, 1, CELL, GRID_W, GRID_H);
  assert.equal(empty.col1 < empty.col0 || empty.row1 < empty.row0, true);
});

test('splitRowRange: worker 0 gets the low rows', () => {
  const a = splitRowRange(4, 11, 0, 2);
  const b = splitRowRange(4, 11, 1, 2);
  assert.deepEqual(a, { row0: 4, row1: 7 });
  assert.deepEqual(b, { row0: 8, row1: 11 });
  const all = splitRowRange(4, 11, 0, 1);
  assert.deepEqual(all, { row0: 4, row1: 11 });
});

test('camera cells + onScreen pad match a full query cull', () => {
  // Origins on a 2000×2000 world. Camera at (400,400), view 400×300.
  const camX = 400;
  const camY = 400;
  const viewW = 400;
  const viewH = 300;
  const zoom = 1;
  const screenMinX = 0;
  const screenMaxX = viewW;
  const screenMinY = 0;
  const screenMaxY = viewH;
  const cameraOffsetX = camX * zoom;
  const cameraOffsetY = camY * zoom;
  const half = [40, 40, 80, 10, 200, 20, 30];
  const xs = [420, 790, 380, 10, 500, 600, 1800];
  const ys = [410, 420, 390, 50, 650, 500, 1800];
  const n = xs.length;
  const pad = Math.max(...half);
  const aabb = cameraWorldAabb(camX, camY, viewW, viewH, pad);
  const range = aabbCellRange(aabb.minX, aabb.minY, aabb.maxX, aabb.maxY, CELL, GRID_W, GRID_H);

  const queryHit = [];
  const cellHit = [];
  const cells = new Set();
  const buf = new Uint32Array(GRID_W * GRID_H);
  const count = fillCameraCellIndices(
    buf, range.col0, range.col1, range.row0, range.row1, GRID_W, 0, 1
  );
  for (let i = 0; i < count; i++) cells.add(buf[i]);

  for (let i = 0; i < n; i++) {
    const sx = xs[i] * zoom - cameraOffsetX;
    const sy = ys[i] * zoom - cameraOffsetY;
    const on = spriteOnScreen(sx, sy, half[i], zoom, screenMinX, screenMaxX, screenMinY, screenMaxY);
    if (on) queryHit.push(i);
    if (cells.has(cellIndex(xs[i], ys[i])) && on) cellHit.push(i);
  }
  assert.deepEqual(cellHit, queryHit);
  assert.ok(queryHit.length >= 2);
  assert.equal(queryHit.includes(6), false);
});

test('concat of per-camera-row painters equals global painter when zIndex is 0', () => {
  const worldHeight = 800;
  const camY = 200;
  const viewH = 400;
  const pad = 0;
  const aabb = cameraWorldAabb(0, camY, 800, viewH, pad);
  const range = aabbCellRange(aabb.minX, aabb.minY, aabb.maxX, aabb.maxY, CELL, GRID_W, GRID_H);
  const n = 12;
  const ys = new Float32Array(n);
  const sortKey = new Float32Array(n);
  const band = zSortBand(worldHeight);
  const inView = [];
  for (let i = 0; i < n; i++) {
    ys[i] = camY + 20 + i * 28;
    sortKey[i] = orderSortKey(spriteYSortKey(ys[i], Y_SORT_K), 0, true, band);
    const row = (ys[i] / CELL) | 0;
    if (row >= range.row0 && row <= range.row1) inView.push(i);
  }
  const keysU32 = keysU32Of(sortKey);
  const idxAll = new Uint32Array(inView);
  const global = createPainterState(n);
  const globalOrder = Array.from(orderPainterSlots(global, idxAll, inView.length, keysU32).subarray(0, inView.length));

  const lists = [[], []];
  for (let k = 0; k < inView.length; k++) {
    const i = inView[k];
    const row = (ys[i] / CELL) | 0;
    const mine0 = splitRowRange(range.row0, range.row1, 0, 2);
    const bandIdx = row >= mine0.row0 && row <= mine0.row1 ? 0 : 1;
    lists[bandIdx].push(i);
  }
  const concat = [];
  for (let b = 0; b < 2; b++) {
    const local = new Uint32Array(lists[b]);
    const st = createPainterState(n);
    const ordered = orderPainterSlots(st, local, local.length, keysU32);
    for (let k = 0; k < local.length; k++) concat.push(ordered[k]);
  }
  assert.deepEqual(concat, globalOrder);
  assert.ok(lists[0].length > 0 && lists[1].length > 0);
});

test('viewYBand splits the camera view; last worker eats the remainder', () => {
  const a = viewYBand(100, 400, 0, 2);
  const b = viewYBand(100, 400, 1, 2);
  assert.equal(a.y0, 100);
  assert.equal(a.y1, 300);
  assert.equal(b.y0, 300);
  assert.equal(b.y1, 500);
  assert.equal(inViewYBand(100, 100, 400, 0, 2), true);
  assert.equal(inViewYBand(299, 100, 400, 0, 2), true);
  assert.equal(inViewYBand(300, 100, 400, 0, 2), false);
  assert.equal(inViewYBand(300, 100, 400, 1, 2), true);
  assert.equal(inViewYBand(200, 100, 400, 0, 1), true);
});
