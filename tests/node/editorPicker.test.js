// An entity param filled by clicking the entity in the view (VISUAL_EDITOR_PLAN.md D4, ED-27, ED-45): the param row's
// pick button, then the next click on the view sets the param to the name of the placed entity there, of the class it
// declares, as one change. Anything else under the click says why and keeps picking; Esc, the button again, a swap or
// leaving edit mode stop. While picking, the entity under the pointer is boxed green (a click takes it) or red.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Mouse } from '../../src/core/mouse.js';
import { buildParamFields } from '../../src/core/debug/editor/paramWidgets.js';
import { describeSpawnParams } from '../../src/core/spawnParams.js';
import { makeWorld, fakeContext } from '../helpers/editorHandlesWorld.mjs';

/** A button as the param row makes it: its classes are what shows it pressed. */
function buttonFor() {
  const classes = new Set();
  return { classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
}

test('the pick button, then a click on a placed Door: the param names it, as one change', () => {
  const world = makeWorld();
  try {
    const { picker, editMode, calls } = world;
    world.select('Guard1');
    const button = buttonFor();
    assert.equal(picker.start('door', 'Door', button), true);
    assert.equal(picker.picking, true);
    assert.equal(button.classes.has('active'), true, 'the button shows it');
    assert.equal(editMode.status, 'Click a Door in the view: Guard1.door names it. Esc cancels');
    assert.equal(editMode._statusTimer, 0, 'the hint stays while picking');

    assert.equal(picker.press(500, 100), true, 'Ball1');
    assert.equal(editMode.status, 'Ball1 is a Ball: Guard1.door takes a Door. Esc cancels');
    assert.equal(editMode.statusIsError, true);
    assert.equal(picker.press(50, 900), true, 'nothing');
    assert.equal(editMode.status, 'Nothing there: click a Door, or Esc');
    const runtime = world.classOf('Door').spawn({ x: 60, y: 60 });
    assert.equal(picker.press(60, 60), true, 'a Door spawned by code');
    assert.equal(editMode.status, `Door #${runtime.index} was spawned by code: Guard1.door names an entity the scene file places. Esc cancels`);
    assert.equal(picker.picking, true, 'still picking');
    assert.equal(world.record('Guard1').config.door, 'Door1', 'nothing written');

    calls.length = 0;
    assert.equal(picker.press(1400, 400), true, 'Door2');
    assert.equal(picker.picking, false);
    assert.equal(button.classes.has('active'), false);
    assert.equal(world.record('Guard1').config.door, 'Door2');
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['despawn', 'Guard'], ['spawn', 'Guard']]);
    assert.equal(calls[1][2].door, world.indexOf('Door2'), 'respawned with Door2’s index');
    assert.deepEqual(editMode.history._done.map((c) => c.label), ['Guard1.door']);
    assert.equal(editMode.status, 'Guard1.door: Door2');
    assert.equal(editMode.selection.name, 'Guard1', 'the guard stays selected');
    editMode.undo();
    assert.equal(world.record('Guard1').config.door, 'Door1');
  } finally {
    world.done();
  }
});

test('Esc, the button again, the tools’ cancel and another selection stop picking; Esc keeps the selection', () => {
  const world = makeWorld();
  try {
    const { picker, editMode } = world;
    world.select('Guard1');
    picker.start('door', 'Door');
    assert.equal(editMode.onKey({ key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), true);
    assert.equal(picker.picking, false);
    assert.equal(editMode.selection.name, 'Guard1', 'Esc stopped the pick, not the selection');
    assert.equal(editMode.status, '', 'the hint is gone');

    picker.start('door', 'Door');
    assert.equal(picker.start('door', 'Door'), false, 'the button again');
    assert.equal(picker.picking, false);

    picker.start('door', 'Door');
    editMode._cancelTools(); // leaving edit mode, a swap
    assert.equal(picker.picking, false);

    picker.start('door', 'Door');
    world.select('Block1');
    assert.equal(picker.press(1400, 400), false, 'another entity is selected: not its params');
    assert.equal(picker.picking, false);
    world.editMode.selection.select(world.classOf('Door').spawn({ x: 60, y: 60 }).index);
    assert.equal(picker.start('door', 'Door'), false, 'a runtime entity has no record to fill');
  } finally {
    world.done();
  }
});

test('while picking, the entity under the pointer is boxed: green when a click takes it, red when not', () => {
  const world = makeWorld();
  try {
    const { picker, canvas } = world;
    world.select('Guard1');
    picker.start('door', 'Door');
    const strokes = () => {
      const ctx = fakeContext();
      picker.drawOverlay(ctx, { x: 0, y: 0 }, 1);
      return ctx.log.filter((e) => e[0] === 'stroke').map((e) => e[1]);
    };
    picker.hover(1400, 400, { target: canvas });
    assert.deepEqual(strokes(), ['rgba(52, 211, 153, 0.95)', 'rgba(52, 211, 153, 0.95)'], 'Door2: its box, and a line from the guard');
    picker.hover(500, 100, { target: canvas });
    assert.deepEqual(strokes(), ['rgba(248, 113, 113, 0.95)'], 'Ball1: red');
    picker.hover(50, 900, { target: canvas });
    assert.deepEqual(strokes(), [], 'nothing under it');
    picker.hover(1400, 400, { target: {} });
    assert.deepEqual(strokes(), [], 'the pointer over a panel');
  } finally {
    world.done();
  }
});

test('through the editor: while picking, a press is the picker’s, before the handles and the move tool', () => {
  const world = makeWorld();
  try {
    const { editMode, canvas } = world;
    Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
    world.select('Guard1');
    const moves = [];
    editMode.move.press = () => moves.push('press');
    editMode.selection._hooks.pickEntity('door', 'Door', null);
    Mouse.x = 1400;
    Mouse.y = 400;
    editMode._onPointerDown({ target: canvas, buttons: 1, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {} });
    editMode._onPointerUp({ target: canvas, buttons: 0, clientX: 0, clientY: 0, pointerId: 1 });
    assert.deepEqual(moves, []);
    assert.equal(world.record('Guard1').config.door, 'Door2');
    assert.equal(editMode.selection.name, 'Guard1');
  } finally {
    world.done();
  }
});

// ---- the param rows, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.title = '';
    this.type = '';
    this.className = '';
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = text;
    this.children = [];
  }
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
  find(fn) {
    for (const el of this.all()) if (fn(el)) return el;
    return null;
  }
}

test('an entity param’s row has a pick button, a points param’s a +; without the hooks, neither', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    class Guard {
      static spawnParams = {
        route: { value: null, type: 'points' },
        door: { value: null, type: 'entity', class: 'Door' },
      };
    }
    const description = describeSpawnParams(Guard);
    const asked = [];
    const hooks = {
      onChange() {},
      onConfig() {},
      entityNames: () => ['Door1', 'Door2'],
      pickEntity: (key, className, button) => asked.push(['pick', key, className, button.dataset.pick]),
      addPoint: (key) => asked.push(['add', key]),
    };
    const container = new El('div');
    buildParamFields(container, description, { route: [1, 2, 3, 4], door: 'Door1' }, hooks);
    const row = (key) => container.children.find((r) => r.dataset.key === key);
    const pick = row('door').find((el) => el.dataset.pick === 'door');
    assert.ok(pick, 'a pick button');
    assert.match(pick.title, /Pick the Door in the view/);
    assert.ok(row('door').find((el) => el.tagName === 'SELECT'), 'beside the dropdown');
    pick.onclick();
    const add = row('route').find((el) => el.dataset.addPoint === 'route');
    assert.ok(add, 'a +');
    assert.match(row('route').textContent, /2 points/);
    add.onclick();
    assert.deepEqual(asked, [['pick', 'door', 'Door', 'door'], ['add', 'route']]);

    const plain = new El('div');
    buildParamFields(plain, description, {}, { onChange() {}, onConfig() {}, entityNames: () => [] });
    assert.equal(plain.find((el) => el.dataset.pick !== undefined || el.dataset.addPoint !== undefined), null);
  } finally {
    delete globalThis.document;
  }
});
