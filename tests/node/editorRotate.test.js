// The rotate handle (VISUAL_EDITOR_PLAN.md ED-58, rotateTool.js): a round handle above the selection's box; a drag
// turns one entity about its origin, several about their common box's center (positions going round it), Shift by
// 15°; shown as it goes, written once on letting go (one undo); Esc puts it back. The real EditMode over the handles
// tests' world.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { Transform } from '../../src/components/transform.js';
import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

function setupCamera() {
  const data = new Float32Array(Camera.FLOAT_COUNT);
  data[0] = data[5] = 1;
  Camera.initialize(data, 800, 600);
}

const press = { button: 0, shiftKey: false };
const close = (a, b) => Math.abs(a - b) < 1e-5;

test('one entity: the handle 22 px above its box; a quarter turn about its origin, written on letting go', () => {
  setupCamera();
  const world = makeWorld();
  Transform.rotation = new Float32Array(Transform.x.length); // the world has rotC and rotS only
  try {
    const { editMode, calls } = world;
    const rotate = editMode.rotate;
    world.select('Block1'); // a 100 × 20 box at 300, 200: its top at 190, the handle at 168
    assert.equal(rotate.press(300, 150, press), false, 'not on the handle');
    assert.equal(rotate.press(300, 168, press), true);
    calls.length = 0;
    rotate.move(332, 200, press); // from straight up to the right: a quarter turn
    const i = world.indexOf('Block1');
    assert.ok(close(editMode.ghost._dr, Math.PI / 2), `its box drawn turned as it goes: ${editMode.ghost._dr}`);
    assert.equal(Transform.rotation[i], 0, 'the live entity is not turned (a body’s pose is the physics worker’s)');
    assert.deepEqual(calls, [], 'nothing written while turning');
    rotate.release();
    assert.ok(close(world.record('Block1').rotation, Math.PI / 2));
    assert.deepEqual(calls.map((c) => c[0]), ['despawn', 'spawn']);
    editMode.undo();
    assert.equal('rotation' in world.record('Block1'), false);
  } finally {
    world.done();
  }
});

test('Shift: to a multiple of 15°; Esc puts it back; a runtime entity has no handle', () => {
  setupCamera();
  const world = makeWorld();
  Transform.rotation = new Float32Array(Transform.x.length); // the world has rotC and rotS only
  try {
    const { editMode } = world;
    const rotate = editMode.rotate;
    world.select('Block1');
    rotate.press(300, 168, press);
    const a = (50 * Math.PI) / 180 - Math.PI / 2; // 50° from straight up
    rotate.move(300 + 100 * Math.cos(a), 200 + 100 * Math.sin(a), { shiftKey: true });
    assert.ok(close(editMode.ghost._dr, (45 * Math.PI) / 180), `45°: ${(editMode.ghost._dr * 180) / Math.PI}`);
    assert.equal(rotate.onKey({ key: 'Escape' }), true);
    assert.equal(editMode.ghost.active, false, 'dropped');
    rotate.release();
    assert.equal('rotation' in world.record('Block1'), false, 'nothing written');

    const door = world.classOf('Door').spawn({ x: 50, y: 50 });
    editMode.selection.select(door.index);
    assert.equal(rotate.wantsOverlay(), false, 'runtime: no handle');
  } finally {
    world.done();
  }
});

test('several: about their common box’s center, positions going round it, one undo', () => {
  setupCamera();
  const world = makeWorld();
  Transform.rotation = new Float32Array(Transform.x.length); // the world has rotC and rotS only
  try {
    const { editMode } = world;
    const rotate = editMode.rotate;
    editMode.multi.selectNames(['Block1', 'Ball1']); // boxes 250..350 × 190..210 and 484..516 × 84..116
    const cx = (250 + 516) / 2;
    const cy = (84 + 210) / 2;
    assert.equal(rotate.press(cx, 84 - 22, press), true, 'above their common box');
    rotate.move(cx, cy + 50, press); // half a turn
    rotate.release();
    const block = world.record('Block1');
    const ball = world.record('Ball1');
    assert.ok(close(block.x, 2 * cx - 300) && close(block.y, 2 * cy - 200), `Block1 went round: ${block.x}, ${block.y}`);
    assert.ok(close(ball.x, 2 * cx - 500) && close(ball.y, 2 * cy - 100), `Ball1 went round: ${ball.x}, ${ball.y}`);
    assert.ok(close(block.rotation, Math.PI) || close(block.rotation, -Math.PI));
    editMode.undo();
    assert.deepEqual([world.record('Block1').x, world.record('Ball1').x, 'rotation' in world.record('Block1')], [300, 500, false]);
  } finally {
    world.done();
  }
});

test('the ghost: each box turned about the pivot and moved, drawn dashed in screen space', async () => {
  const { TransformGhost } = await import('../../src/core/debug/editor/ghost.js');
  const world = makeWorld();
  try {
    const ghost = new TransformGhost();
    const i = world.indexOf('Block1'); // 100 × 20 at 300, 200
    const points = [];
    const ctx = { save() {}, restore() {}, setLineDash() {}, beginPath() {}, closePath() {}, stroke() {}, moveTo: (x, y) => points.push([x, y]), lineTo: (x, y) => points.push([x, y]) };
    ghost.show([i], 0, 0, Math.PI / 2, 300, 200); // a quarter turn about its own center
    ghost.drawOverlay(ctx, { x: 0, y: 0 }, 1);
    const xs = points.map((p) => Math.round(p[0]));
    const ys = points.map((p) => Math.round(p[1]));
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [290, 310, 150, 250], 'now 20 wide and 100 tall');
    points.length = 0;
    ghost.show([i], 40, -10, 0, 0, 0);
    ghost.drawOverlay(ctx, { x: 0, y: 0 }, 2);
    assert.deepEqual([Math.round(points[0][0]), Math.round(points[0][1])], [(250 + 40) * 2, (190 - 10) * 2], 'moved, at zoom 2');
    ghost.clear();
    points.length = 0;
    ghost.drawOverlay(ctx, { x: 0, y: 0 }, 1);
    assert.deepEqual(points, []);
  } finally {
    world.done();
  }
});
