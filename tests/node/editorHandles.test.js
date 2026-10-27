// Handles on the selected placed entity in edit mode (VISUAL_EDITOR_PLAN.md Stage 4: ED-20 collider shapes, ED-22
// light reach, ED-27 points params): a drag draws a ghost and writes nothing until it is let go, then changes the
// spawn param named like the component's column (width, height, radius, lightIntensity, a points param) once, as one
// undo, and the entity respawns from it. A box keeps its opposite edge (Alt: its center); values snap to the grid. A
// polygon's vertices are the points param that holds them, in the entity's frame, and stay a convex polygon. A handle
// without a param is dimmed and says why. Runtime entities have none. Drawing is in whole screen pixels.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Mouse } from '../../src/core/mouse.js';
import { H_BOX, H_CIRCLE, H_VERTEX, H_LIGHT, H_POINT, convexPolygon } from '../../src/core/debug/editor/handles.js';
import { makeWorld, fakeContext } from '../helpers/editorHandlesWorld.mjs';

/** A drag of a handle through the tool: press, a first small move, then to `to` (screen = world at zoom 1). */
function drag(tool, from, to, { alt = false } = {}) {
  const at = (p) => ({ clientX: p[0], clientY: p[1], altKey: alt });
  assert.equal(tool.press(from[0], from[1], at(from)), true, `a handle at ${from}`);
  tool.move(to[0], to[1], at(to));
  tool.release();
}

const positions = (handles) => handles.map((h) => [Math.round(h.x * 1000) / 1000, Math.round(h.y * 1000) / 1000]);

test('a box: eight handles on its collider; an edge moves alone, snapped, and the record changes once on letting go', () => {
  const world = makeWorld();
  try {
    const { handles, editMode, calls } = world;
    world.select('Block1');
    const box = handles.handles();
    assert.deepEqual(box.map((h) => h.kind), Array(8).fill(H_BOX));
    assert.ok(box.every((h) => h.on), 'Block declares width and height');
    // 100 × 20 about (300, 200); its top and bottom handles 12 screen px from its middle, just outside it.
    assert.deepEqual(positions(box), [
      [250, 188], [250, 200], [250, 212], [300, 188], [300, 212], [350, 188], [350, 200], [350, 212],
    ]);
    assert.equal(handles.press(300, 203, { clientX: 300, clientY: 203 }), false, 'its body is the move tool’s');
    editMode.move.snap = 8;
    assert.equal(handles.press(350, 200, { clientX: 350, clientY: 200 }), true, 'the right edge');
    handles.move(351, 200, { clientX: 351, clientY: 200 });
    assert.equal(handles.dragging, false, 'under 3 screen pixels: not a drag yet');
    handles.move(397, 203, { clientX: 397, clientY: 203 });
    assert.equal(handles.dragging, true);
    assert.deepEqual(calls, [], 'nothing spawned while dragging');
    assert.deepEqual(world.record('Block1'), { name: 'Block1', class: 'Block', x: 300, y: 200, config: { width: 100, height: 20 } }, 'nor written');
    handles.release();
    // 147 wide to the pointer, 144 on the 8 grid; the left edge stays at 250, so the center moves 22.
    assert.deepEqual(world.record('Block1'), { name: 'Block1', class: 'Block', x: 322, y: 200, config: { width: 144, height: 20 } });
    assert.deepEqual(calls.map((c) => c[0]), ['despawn', 'spawn'], 'one respawn');
    assert.deepEqual(calls[1][2], { x: 322, y: 200, width: 144, height: 20 });
    assert.deepEqual(editMode.history._done.map((c) => c.label), ['resize Block1'], 'one undo');
    assert.equal(editMode.selection.name, 'Block1', 'the selection follows the respawned entity');
    assert.deepEqual(positions(handles.handles()).slice(6, 7), [[394, 200]], 'the handles follow it: its right edge where it was let go');
    editMode.undo();
    assert.deepEqual(world.record('Block1'), { name: 'Block1', class: 'Block', x: 300, y: 200, config: { width: 100, height: 20 } });
  } finally {
    world.done();
  }
});

test('a box with Alt held keeps its center; a corner sets both sides; a default value leaves the record', () => {
  const world = makeWorld();
  try {
    world.select('Block1');
    drag(world.handles, [250, 190], [240, 182], { alt: true });
    // 2 × 60 wide and 2 × 18 high about the center: 36 is height's default, so the record leaves it out.
    assert.deepEqual(world.record('Block1'), { name: 'Block1', class: 'Block', x: 300, y: 200, config: { width: 120 } });
  } finally {
    world.done();
  }
});

test('a turned box: its handles turn with it, and the edge moves along its own axis', () => {
  const world = makeWorld();
  try {
    world.select('Block1');
    const i = world.indexOf('Block1');
    Transform.rotC[i] = 0; // a quarter turn
    Transform.rotS[i] = 1;
    const right = world.handles.handles()[6];
    assert.deepEqual([right.sub, Math.round(right.x), Math.round(right.y)], [7, 300, 250], 'its right edge is below it now');
    drag(world.handles, [300, 250], [300, 280]);
    assert.deepEqual(world.record('Block1'), { name: 'Block1', class: 'Block', x: 300, y: 215, config: { width: 130, height: 20 } });
  } finally {
    world.done();
  }
});

test('a circle: four handles on its ring set its radius', () => {
  const world = makeWorld();
  try {
    world.select('Ball1');
    const ring = world.handles.handles();
    assert.deepEqual(ring.map((h) => h.kind), Array(4).fill(H_CIRCLE));
    assert.deepEqual(positions(ring), [[516, 100], [500, 116], [484, 100], [500, 84]]);
    drag(world.handles, [516, 100], [540, 103]);
    assert.deepEqual(world.record('Ball1').config, { radius: 40 }, '40.1 from the center, whole pixels');
    assert.equal(Collider.radius[world.indexOf('Ball1')], 40, 'respawned with it');
  } finally {
    world.done();
  }
});

test('a polygon: its vertices are its points param, in its frame; a change keeps it a convex polygon', () => {
  const world = makeWorld();
  try {
    const { handles, editMode, canvas } = world;
    world.select('Rock1');
    const hs = handles.handles();
    assert.deepEqual(hs.map((h) => h.kind), [H_POINT, H_POINT, H_POINT], 'the param holds the polygon: no vertex handles of its own');
    assert.deepEqual(positions(hs), [[700, 280], [720, 310], [680, 310]], 'the default points, about the rock');
    drag(handles, [700, 280], [703, 282]);
    assert.deepEqual(world.record('Rock1').config, { points: [3, -18, 20, 10, -20, 10] }, 'written in the rock’s frame');
    const i = world.indexOf('Rock1');
    assert.deepEqual([Collider.polyVertexX[i * 8], Collider.polyVertexY[i * 8]], [3, -18], 'its collider has it');

    handles.hover(720, 310, { target: canvas });
    assert.equal(editMode.onKey({ key: 'Delete', ctrlKey: false, metaKey: false }), true, 'Del over a point is the handles’');
    assert.equal(editMode.status, 'A polygon collider needs at least 3 points');
    assert.equal(world.record('Rock1').config.points.length, 6, 'kept');

    assert.equal(handles.press(700, 311, { clientX: 700, clientY: 311, altKey: true }), true, 'Alt on its bottom edge');
    assert.deepEqual(world.record('Rock1').config.points, [3, -18, 20, 10, 0, 11, -20, 10], 'a point there, between the two');

    const before = editMode.history._done.length;
    drag(handles, [700, 311], [700, 290]);
    assert.match(editMode.status, /Rock\.points: that is not a convex polygon/);
    assert.equal(editMode.history._done.length, before, 'refused: no change');
    assert.deepEqual(world.record('Rock1').config.points, [3, -18, 20, 10, 0, 11, -20, 10]);
  } finally {
    world.done();
  }
});

test('convexPolygon: 3 to 8 points, convex, wound like the polygon it replaces', () => {
  assert.equal(convexPolygon([0, -20, 20, 10, -20, 10], 1), true);
  assert.equal(convexPolygon([0, -20, -20, 10, 20, 10], 1), false, 'the other way round');
  assert.equal(convexPolygon([0, -20, -20, 10, 20, 10], -1), true);
  assert.equal(convexPolygon([0, -20, 20, 10, 0, 0, -20, 10], 1), false, 'a dent');
  assert.equal(convexPolygon([0, -20, 20, 10, 0, 10, -20, 10], 1), true, 'a point on an edge');
  assert.equal(convexPolygon([0, 0, 10, 0], 1), false, 'two points');
});

test('a light: its reach is a ring with four handles; a drag sets lightIntensity, (reach / 10)²', () => {
  const world = makeWorld();
  try {
    world.select('Lamp1');
    const ring = world.handles.handles();
    assert.deepEqual(ring.map((h) => h.kind), Array(4).fill(H_LIGHT));
    const d = 500 * Math.SQRT1_2;
    assert.deepEqual(positions(ring)[0], [Math.round((100 + d) * 1000) / 1000, Math.round((500 + d) * 1000) / 1000], 'reach 500: √2500 × 10');
    world.editMode.move.snap = 16;
    const to = 483 * Math.SQRT1_2;
    drag(world.handles, [ring[0].x, ring[0].y], [100 + to, 500 + to]);
    assert.deepEqual(world.record('Lamp1').config, { lightIntensity: 2304 }, 'reach 483 → 480 on the 16 grid → 2304');
    assert.equal(LightEmitter.lightIntensity[world.indexOf('Lamp1')], 2304);
  } finally {
    world.done();
  }
});

test('a handle whose param the class does not declare is dimmed, and a press on it says why and changes nothing', () => {
  const world = makeWorld();
  try {
    const { handles, editMode, calls } = world;
    const pressOn = (name, k) => {
      world.select(name);
      const h = handles.handles()[k];
      assert.equal(h.on, false, `${name}'s handle ${k} is dimmed`);
      assert.equal(handles.press(h.x, h.y, { clientX: h.x, clientY: h.y }), true, 'the press is the handle’s');
      handles.move(h.x + 40, h.y + 40, { clientX: h.x + 40, clientY: h.y + 40 });
      handles.release();
      assert.equal(editMode.statusIsError, true);
      return editMode.status;
    };
    assert.equal(pressOn('Door1', 0), 'Door has no width or height param: its collider is set in code');
    assert.equal(pressOn('Door1', 1), 'Door has no width param: its collider is set in code');
    assert.equal(pressOn('Pebble1', 0), 'Pebble has no radius param: its collider is set in code');
    assert.equal(pressOn('Torch1', 0), 'Torch has no lightIntensity param: its light is set in code');
    world.select('Shard1');
    assert.deepEqual(handles.handles().map((h) => h.kind), [H_VERTEX, H_VERTEX, H_VERTEX]);
    assert.equal(pressOn('Shard1', 0), 'Shard has no points param: its polygon is set in code');
    assert.deepEqual(calls, [], 'nothing respawned');
    assert.equal(editMode.history.canUndo, false);
  } finally {
    world.done();
  }
});

test('a route: its points are dragged, Alt+click on its line adds one, Del over one removes it, the + adds one', () => {
  const world = makeWorld();
  try {
    const { handles, editMode, canvas } = world;
    world.select('Guard1');
    assert.deepEqual(handles.handles().map((h) => [h.kind, h.slot, h.sub, h.x, h.y]), [
      [H_POINT, 0, 0, 900, 400],
      [H_POINT, 0, 1, 1000, 400],
    ], 'in world coordinates: the guard has no polygon');
    editMode.move.snap = 8;
    drag(handles, [1000, 400], [1013, 431]);
    assert.deepEqual(world.record('Guard1').config.route, [900, 400, 1016, 432]);
    assert.equal(handles.press(958, 416, { clientX: 958, clientY: 416, altKey: true }), true);
    assert.deepEqual(world.record('Guard1').config.route, [900, 400, 960, 416, 1016, 432], 'on the grid, between the two');
    assert.equal(handles.press(400, 900, { clientX: 400, clientY: 900, altKey: true }), false, 'Alt away from the line: not the handles’');
    handles.hover(961, 417, { target: canvas });
    assert.equal(editMode.onKey({ key: 'Delete', ctrlKey: false, metaKey: false }), true);
    assert.deepEqual(world.record('Guard1').config.route, [900, 400, 1016, 432]);
    assert.equal(editMode.onKey({ key: 'Delete', ctrlKey: false, metaKey: false }), true, 'still over nothing: the editor’s Del');
    assert.equal(world.record('Guard1'), null, 'which deletes the guard');
    editMode.undo();
    world.select('Guard1');
    world.editMode.selection._hooks.addPoint('route');
    assert.deepEqual(world.record('Guard1').config.route, [900, 400, 1016, 432, 1136, 464], 'the last segment once more, on the grid');
    assert.deepEqual(editMode.history._done.map((c) => c.label), [
      'move Guard1.route[1]',
      'Guard1.route: add a point',
      'Guard1.route: remove point 1',
      'Guard1.route: add a point',
    ]);
    const index = editMode.place('Guard', 300, 700);
    assert.deepEqual([editMode.selection.name, world.record('Guard2').x, world.record('Guard2').y], ['Guard2', 304, 704]);
    assert.ok(index >= 0);
    handles.addPoint('route');
    assert.deepEqual(world.record('Guard2').config, { route: [368, 704] }, 'the first: 64 px right of the guard, on the grid');
  } finally {
    world.done();
  }
});

test('runtime entities have no handles; Esc drops a drag; a drag is not written after its entity respawned', () => {
  const world = makeWorld();
  try {
    const { handles, editMode } = world;
    const door = world.classOf('Door').spawn({ x: 50, y: 50 });
    editMode.selection.select(door.index);
    assert.equal(editMode.selection.authored, false);
    assert.deepEqual(handles.handles(), []);
    assert.equal(handles.press(70, 90, { clientX: 70, clientY: 90 }), false, 'its corner: not a handle');

    world.select('Block1');
    handles.press(350, 200, { clientX: 350, clientY: 200 });
    handles.move(400, 200, { clientX: 400, clientY: 200 });
    assert.equal(editMode.onKey({ key: 'Escape' }), true, 'Esc is the drag’s');
    assert.equal(editMode.selection.name, 'Block1', 'and the selection stays');
    handles.release();
    assert.deepEqual(world.record('Block1').config, { width: 100, height: 20 });

    handles.press(350, 200, { clientX: 350, clientY: 200 });
    handles.move(400, 200, { clientX: 400, clientY: 200 });
    editMode.selection._hooks.onChange('height', 30); // a respawn under the drag
    handles.move(420, 200, { clientX: 420, clientY: 200 });
    handles.release();
    assert.deepEqual(world.record('Block1').config, { width: 100, height: 30 }, 'the drag ended with the entity it started on');
  } finally {
    world.done();
  }
});

test('through the editor: a press on a handle is the handles’, not the move tool’s', () => {
  const world = makeWorld();
  try {
    const { editMode, canvas } = world;
    Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
    world.select('Ball1');
    const moves = [];
    editMode.move.press = () => moves.push('press');
    const fire = (handler, buttons, x, y) => {
      Mouse.x = x;
      Mouse.y = y;
      handler({ target: canvas, buttons, clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
    };
    fire(editMode._onPointerDown, 1, 516, 100);
    fire(editMode._onPointerMove, 1, 530, 100);
    fire(editMode._onPointerUp, 0, 530, 100);
    assert.deepEqual(moves, [], 'the move tool had none of it');
    assert.deepEqual(world.record('Ball1').config, { radius: 30 });
    fire(editMode._onPointerDown, 1, 500, 100);
    assert.deepEqual(moves, ['press'], 'the middle of the ball is the move tool’s');
  } finally {
    world.done();
  }
});

test('drawn in whole screen pixels: the handles, a drag’s ghost and value, a route’s line, a line to a named entity', () => {
  const world = makeWorld();
  try {
    const { handles, editMode } = world;
    const camera = { x: 200, y: 100 };
    let ctx = fakeContext();
    editMode.drawOverlay(ctx, camera, 2);
    assert.deepEqual(ctx.log, [], 'nothing selected: nothing drawn');

    world.select('Block1');
    editMode.move.snap = 8;
    handles.press(350, 200, { clientX: 350, clientY: 200 });
    handles.move(397, 203, { clientX: 397, clientY: 203 });
    ctx = fakeContext();
    editMode.drawOverlay(ctx, camera, 2);
    const path = ctx.log.filter((e) => e[0] === 'M' || e[0] === 'L' || e[0] === 'Z');
    // The ghost: 144 × 20 about (322, 200); screen = (world − camera) × 2.
    assert.deepEqual(path, [['M', 100, 180], ['L', 388, 180], ['L', 388, 220], ['L', 100, 220], ['Z']]);
    const rects = ctx.log.filter((e) => e[0] === 'rect');
    assert.deepEqual(rects[6], ['rect', 296, 196, 8, 8], 'the right edge’s handle at (350, 200): 8 px whatever the zoom');
    assert.ok(ctx.log.some((e) => e[0] === 'text' && e[1] === '144 × 20' && e[2] === 408 && e[3] === 192), 'the value beside the pointer');
    handles.cancel();

    world.select('Guard1');
    ctx = fakeContext();
    editMode.drawOverlay(ctx, camera, 1);
    const lines = ctx.log.filter((e) => e[0] === 'M' || e[0] === 'L');
    assert.deepEqual(lines, [['M', 700, 300], ['L', 800, 300], ['M', 700, 300], ['L', 1000, 300]], 'the route, then the line to Door1');
    for (const e of ctx.log) if (e[0] !== 'stroke' && e[0] !== 'text') for (const v of e.slice(1)) assert.ok(Number.isInteger(v), `${e}: whole pixels`);
  } finally {
    world.done();
  }
});
