// E-335: the decoration screen test walks DecorationSpatial's grid where it can. On a real particle worker, frame after
// frame (pans, zooms, decorations moved out of and into the view, spawned and despawned, attached ones, ones in cell 0
// by truncation and ones off the world), the visible list (in snapshot order) and every snapshot decoration's flag are
// what the full test writes: the predicate on the worker's own bounds, applied to the snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { PoolSlotArray, poolSlotBytes } from '../../src/util/poolSlotWidth.js';
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';

const D = DecorationComponent;
const WORLD_W = 10000;
const WORLD_H = 5000;
const CELL = 128;
const VIEW_W = 1920;
const VIEW_H = 1080;

async function setup(n) {
  const { worker } = await setupSwayKernel({ n, listCounters: true });
  worker._decoSnapshotEpoch = -1;
  worker.refreshActiveDecorationSnapshot();
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const gridWidth = Math.ceil(WORLD_W / CELL);
  const gridHeight = Math.ceil(WORLD_H / CELL);
  const slotBytes = poolSlotBytes(n);
  DecorationSpatial.initialize(
    {
      head: new SharedArrayBuffer(gridWidth * gridHeight * slotBytes),
      next: new SharedArrayBuffer(n * slotBytes),
      prev: new SharedArrayBuffer(n * slotBytes),
      cellOf: new SharedArrayBuffer(n * 4),
      lock: new SharedArrayBuffer(4),
    },
    { cellSize: CELL, gridWidth, gridHeight, maxDecorations: n },
    true
  );
  for (let k = 0; k < worker._activeDecorationSnapshotCount; k++) DecorationSpatial.insert(worker._activeDecorationSnapshot[k]);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(8);
  }
  for (let p = 0; p < 8; p++) {
    Transform.active[p] = 1;
    Transform.rotC[p] = 1;
  }
  // Count the frames the grid walk ran (and not the full test).
  let walks = 0;
  const walk = worker._updateDecorationScreenGrid;
  if (typeof walk === 'function') {
    worker._updateDecorationScreenGrid = function grid() {
      const ran = walk.call(this);
      if (ran) walks++;
      return ran;
    };
  }
  const frame = (camX, camY, zoom = 1) => {
    calculateCameraScreenBounds(zoom, camX, camY, VIEW_W, VIEW_H, 0, worker._cameraBounds, 0);
    worker._frameCamValid = true;
    worker.refreshActiveDecorationSnapshot();
    worker.resolveAttachedDecorations(1000 / 60);
    worker._frameCamValid = true;
    worker.updateDecorationScreen();
  };
  return { worker, frame, walks: () => walks };
}

/** The full test's output on the worker's bounds: the visible list in snapshot order and each decoration's flag. */
function check(worker, label) {
  const b = worker._decorationCameraBounds();
  const snap = worker._activeDecorationSnapshot;
  const count = worker._activeDecorationSnapshotCount;
  const expected = [];
  for (let k = 0; k < count; k++) {
    const i = snap[k];
    if (!D.active[i]) continue;
    const sx = D.x[i] * b.zoom - b.cameraOffsetX;
    const sy = D.y[i] * b.zoom - b.cameraOffsetY;
    const on = sx > b.minX && sx < b.maxX && sy > b.minY && sy < b.maxY ? 1 : 0;
    assert.equal(D.isItOnScreen[i], on, `${label}: decoration ${i}'s flag`);
    if (on) expected.push(i);
  }
  const visible = worker.visibleDecorationsData;
  assert.deepEqual(Array.from(visible.subarray(1, 1 + visible[0])), expected, `${label}: the visible list`);
  return expected.length;
}

test('E-335: the grid walk writes the full test\'s visible list and flags through pans, moves, spawns and zooms', async () => {
  const n = 4000;
  const s = await setup(n);
  const { worker, frame } = s;
  let cx = (WORLD_W - VIEW_W) / 2;
  let cy = (WORLD_H - VIEW_H) / 2;

  frame(cx, cy);
  const first = check(worker, 'first frame (full test)');
  assert.ok(first > 50, `${first} on screen`);

  // A pan: decorations leave on one side, enter on the other.
  for (let f = 0; f < 30; f++) {
    cx += 61;
    cy -= 29;
    frame(cx, cy);
    check(worker, `pan ${f}`);
  }
  assert.ok(s.walks() >= 30, `the grid walk ran (${s.walks()} frames)`);

  // Moves: visible ones moved far away (they leave), far ones moved into the view (they come in).
  const visible = Array.from(worker.visibleDecorationsData.subarray(1, 1 + worker.visibleDecorationsData[0]));
  const leaving = visible.slice(0, 20);
  for (const i of leaving) DecorationSpatial.move(i, 50 + (i % 7), 4900);
  const coming = [];
  for (let k = 0; coming.length < 20; k++) {
    const i = worker._activeDecorationSnapshot[k];
    if (!D.isItOnScreen[i] && !leaving.includes(i)) coming.push(i);
  }
  coming.forEach((i, k) => DecorationSpatial.move(i, cx + 100 + k * 50, cy + 500));
  frame(cx, cy);
  check(worker, 'after moves');
  for (const i of leaving) assert.equal(D.isItOnScreen[i], 0, `moved away ${i}`);
  for (const i of coming) assert.equal(D.isItOnScreen[i], 1, `moved in ${i}`);

  // Despawns and spawns: world-owned in view, attached in view, one off the world, one in cell 0 by truncation.
  for (const i of visible.slice(20, 40)) DecorationPool.despawn(i);
  const spawned = [];
  for (let k = 0; k < 10; k++) spawned.push(DecorationPool.spawn({ x: cx + 300 + k * 90, y: cy + 300 }));
  Transform.x[2] = cx + 800;
  Transform.y[2] = cy + 400;
  for (let k = 0; k < 5; k++) spawned.push(DecorationPool.spawn({ parent: 2, localX: k * 20, localY: -k * 10 }));
  const offWorld = DecorationPool.spawn({ x: WORLD_W + 300, y: 200 });
  const cellZero = DecorationPool.spawn({ x: -40, y: -30 });
  assert.ok(spawned.every((i) => i >= 0) && offWorld >= 0 && cellZero >= 0);
  assert.equal(DecorationSpatial.cellOf[offWorld], -1, 'off the world: outside the grid');
  assert.equal(DecorationSpatial.cellOf[cellZero], 0, 'just left of the origin: cell 0');
  frame(cx, cy);
  check(worker, 'after spawns');
  for (const i of spawned) assert.equal(D.isItOnScreen[i], 1, `spawned in view ${i}`);

  // The world's corners, past its edges: the off-world one and the cell-0 one come into view.
  frame(WORLD_W - VIEW_W + 400, 100);
  check(worker, 'past the right edge');
  assert.equal(D.isItOnScreen[offWorld], 1, 'off the world, in view');
  frame(-500, -400);
  check(worker, 'past the origin');
  assert.equal(D.isItOnScreen[cellZero], 1, 'cell 0 by truncation, in view');
  assert.equal(D.isItOnScreen[offWorld], 0, 'off the world, out of view');

  // Zoomed out over most of the world (the full test runs), then back in (the walk).
  const before = s.walks();
  frame(0, 0, 0.18);
  check(worker, 'zoomed out');
  assert.equal(s.walks(), before, 'the full test ran zoomed out');
  frame(cx, cy);
  check(worker, 'zoomed back in');
  assert.equal(s.walks(), before + 1, 'the walk ran again');

  // The attached ones' parent moves out of the view: they leave with it.
  Transform.x[2] = 9000;
  frame(cx, cy);
  check(worker, 'parent moved away');
  for (const i of spawned.slice(10)) assert.equal(D.isItOnScreen[i], 0, `attached ${i} left with its parent`);
});
