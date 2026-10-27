// The editor's grid and snap (VISUAL_EDITOR_PLAN.md ED-60, grid.js) and Space+drag panning (ED-61): the step and the
// lines are remembered per viewer (guarded storage; a step the editor does not offer is dropped); the lines are every
// step, thinned out where they would come closer than 8 screen pixels, every fourth one brighter; Alt during a drag
// leaves the grid; Space held over the game page makes a primary drag pan.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GridOverlay, loadGrid, saveGrid } from '../../src/core/debug/editor/grid.js';
import { SNAP_STEPS } from '../../src/core/debug/editor/moveTool.js';
import { Camera } from '../../src/core/camera.js';
import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

function withStorage(storage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

/** A context that counts the lines of each stroke, and its style. */
function lineContext(width, height) {
  const strokes = [];
  let lines = 0;
  return {
    canvas: { width, height },
    strokes,
    save() {},
    restore() {},
    translate() {},
    beginPath() {
      lines = 0;
    },
    moveTo() {
      lines++;
    },
    lineTo() {},
    stroke() {
      strokes.push([this.strokeStyle, lines]);
    },
  };
}

test('remembered: the step and the lines; a step not offered and storage that throws give the defaults', () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.deepEqual(loadGrid(SNAP_STEPS), { snap: 1, show: true });
    saveGrid(16, false);
    assert.deepEqual(loadGrid(SNAP_STEPS), { snap: 16, show: false });
    storage.map.set('weed.editor.grid', JSON.stringify({ snap: 12, show: true }));
    assert.deepEqual(loadGrid(SNAP_STEPS), { snap: 1, show: true }, '12 is not offered');
  });
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  withStorage(blocked, () => {
    saveGrid(32, true);
    assert.deepEqual(loadGrid(SNAP_STEPS), { snap: 1, show: true });
  });
});

test('the lines: every step at 1:1, every fourth brighter; thinned out when zoomed out; none without a step', () => {
  const editMode = { move: { snap: 16 } };
  const grid = new GridOverlay(editMode);
  const ctx = lineContext(320, 160);
  grid.drawOverlay(ctx, { x: 0, y: 0 }, 1);
  const [[minorStyle, minor], [majorStyle, major]] = ctx.strokes;
  // 0..320 by 16: 21 columns (6 of them every fourth: 0, 64, …, 320), 0..160: 11 rows (3 every fourth).
  assert.deepEqual([minor, major], [21 - 6 + (11 - 3), 6 + 3]);
  assert.notEqual(minorStyle, majorStyle);

  const far = lineContext(320, 160);
  grid.drawOverlay(far, { x: 0, y: 0 }, 0.25); // 16 px at 0.25 is 4 px on screen: every 32 px (8 on screen)
  assert.equal(far.strokes[0][1] + far.strokes[1][1], Math.ceil(1280 / 32) + 1 + Math.ceil(640 / 32) + 1);

  editMode.move.snap = 1;
  const none = lineContext(320, 160);
  grid.drawOverlay(none, { x: 0, y: 0 }, 1);
  assert.deepEqual([none.strokes, grid.wantsOverlay()], [[], false]);
});

test('Alt during a drag leaves the grid; setSnap remembers; Space held pans with the primary button', () => {
  withStorage(memoryStorage(), () => {
    const world = makeWorld();
    try {
      const { editMode } = world;
      editMode.debugUI.canvas.startLoop = () => {};
      editMode.setSnap(16);
      assert.deepEqual(loadGrid(SNAP_STEPS), { snap: 16, show: true });
      world.select('Block1'); // at 300, 200
      const move = editMode.move;
      move.press(300, 200, 0, 0);
      move.move(307, 205, 10, 10);
      assert.deepEqual([move._toX, move._toY], [304, 208], 'on the 16 px grid');
      move.free = true;
      move.move(307, 205, 10, 10);
      assert.deepEqual([move._toX, move._toY], [307, 205], 'Alt: off the grid');
      move.cancel();

      const data = new Float32Array(Camera.FLOAT_COUNT);
      data[0] = data[5] = 1;
      Camera.initialize(data, 800, 600);
      Camera.setFreeTarget(500, 500);
      const canvas = world.canvas;
      canvas.style = {};
      const doc = globalThis.document;
      globalThis.document = { marker: true };
      try {
        editMode.onKey({ key: ' ', target: { ownerDocument: globalThis.document } });
        assert.equal(canvas.style.cursor, 'grab');
        const down = { target: canvas, buttons: 1, pointerId: 7, clientX: 100, clientY: 100, preventDefault() {} };
        editMode._onPointerDown(down);
        editMode._onPointerMove({ ...down, clientX: 140, clientY: 90 });
        assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [460, 510], 'the view follows the drag');
        assert.equal(editMode.move.dragging, false, 'nothing selected or moved');
        editMode._onKeyUp({ key: ' ' });
        assert.equal(canvas.style.cursor, '');
      } finally {
        globalThis.document = doc;
      }
    } finally {
      world.done();
    }
  });
});
