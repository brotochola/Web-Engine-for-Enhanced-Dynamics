// The editor's framing (VISUAL_EDITOR_PLAN.md ED-57, frame.js): F puts the selection in the middle of the view, as
// large as fits with a margin; several selected, their common box; Shift+F every placed entity. A point keeps the
// zoom, and the zoom stays within the scene's limits. The real EditMode over the handles tests' world.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { frameFor, FRAME_FILL, resetBounds, addEntityBounds } from '../../src/core/debug/editor/frame.js';
import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

function setupCamera({ zoom = 1, canvasW = 800, canvasH = 600 } = {}) {
  const data = new Float32Array(Camera.FLOAT_COUNT);
  data[0] = zoom;
  data[5] = zoom;
  Camera.initialize(data, canvasW, canvasH);
  Camera.worldWidth = 4000;
  Camera.worldHeight = 3000;
  Camera.maxZoom = 8;
  Camera.setFree(true, { smoothing: 1 });
  return data;
}

const key = (k, extra = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test('frameFor: the box’s center; out far enough that it takes FRAME_FILL of the view, never in past 1:1 or the zoom', () => {
  const out = frameFor(0, 0, 2000, 400, 800, 600, 1, 0.1, 8, new Float64Array(3));
  assert.deepEqual([out[0], out[1]], [1000, 200]);
  assert.equal(out[2], (800 * FRAME_FILL) / 2000, 'a wide level: out until it fits');
  assert.equal(frameFor(100, 100, 300, 200, 800, 600, 0.3, 0.1, 8, new Float64Array(3))[2], 1, 'a house from far out: 1:1, not blown up');
  assert.equal(frameFor(100, 100, 300, 200, 800, 600, 2.5, 0.1, 8, new Float64Array(3))[2], 2.5, 'already closer: the zoom stays');
  assert.equal(frameFor(0, 0, 1, 1, 800, 600, 1.5, 0.1, 8, new Float64Array(3))[2], 1.5, 'a point keeps the zoom');
  assert.equal(frameFor(0, 0, 1e6, 10, 800, 600, 1, 0.25, 8, new Float64Array(3))[2], 0.25, 'no farther than minZoom');
});

test('an entity’s bounds: its collider box turned, or its position', () => {
  const world = makeWorld();
  try {
    const block = world.indexOf('Block1'); // 100 × 20 at (300, 200)
    const bounds = addEntityBounds(block, resetBounds(new Float64Array(4)));
    assert.deepEqual([...bounds], [250, 190, 350, 210]);
    const guard = world.indexOf('Guard1'); // no collider, no sprite: its position
    assert.deepEqual([...addEntityBounds(guard, resetBounds(new Float64Array(4)))], [900, 400, 900, 400]);
  } finally {
    world.done();
  }
});

test('F frames the selection, Shift+F the level, a double click in the list its row; nothing while playing', () => {
  const world = makeWorld();
  setupCamera();
  try {
    const { editMode } = world;
    world.select('Block1');
    assert.equal(editMode.onKey(key('f')), true);
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [300, 200]);
    assert.equal(Camera.targetZoom, 1, 'a 100 px block from 1:1: the zoom stays');

    editMode.multi.selectNames(['Block1', 'Ball1']); // Ball1: radius 16 at (500, 100)
    editMode.onKey(key('F'));
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [(250 + 516) / 2, (84 + 210) / 2], 'their common box');

    editMode.onKey(key('F', { shiftKey: true }));
    const all = [Camera._freeFollowX, Camera._freeFollowY];
    assert.ok(all[0] > 300 && all[0] < 1400 && all[1] > 100 && all[1] < 600, `the level's middle: ${all}`);

    editMode.selection.clear();
    editMode.multi.clear();
    Camera.setFreeTarget(0, 0);
    editMode.onKey(key('f'));
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], all, 'nothing selected: the whole level');

    Camera.setFreeTarget(0, 0);
    editMode.selectFromList(world.indexOf('Door2'), true);
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [1400, 400], 'a double click in the scene list');

    editMode.active = false;
    Camera.setFreeTarget(0, 0);
    assert.equal(editMode.frameSelection(), false);
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [0, 0], 'playing, the camera is the game’s');
  } finally {
    Camera.setFree(false);
    world.done();
  }
});
