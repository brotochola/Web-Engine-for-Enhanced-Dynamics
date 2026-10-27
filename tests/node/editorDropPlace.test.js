// Drag to place (VISUAL_EDITOR_PLAN.md ED-66): a class dragged from the palette and dropped on the view is placed
// where it drops, as a click maps the point (Mouse: the canvas's box, then the drawn camera), on the grid, as one undo,
// and selected. A drop while the game plays goes back to editing first (a Stop, ED-80). A drag of anything else is left to the page; over
// the view in edit mode, the overlay draws where the drag would land.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Mouse } from '../../src/core/mouse.js';
import { Messages } from '../../src/core/messages.js';
import { Transform } from '../../src/components/transform.js';
import { Time } from '../../src/core/timeScale.js';
import { Camera } from '../../src/core/camera.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { recordOf } from '../../src/core/debug/editor/sceneDocument.js';
import { DropPlacer, viewPointToWorld, carriesClass, CLASS_DRAG_TYPE } from '../../src/core/debug/editor/dropPlace.js';
import { Palette, placeableClassOf, placeableClasses } from '../../src/core/debug/editor/palette.js';

/** A view's box on the page. */
const RECT = { left: 260, top: 36, right: 1070, bottom: 630, width: 810, height: 594 };

test('a drop’s point maps to the world as a click’s does: the same point Mouse holds, zoomed and rolled', () => {
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  const target = { getBoundingClientRect: () => RECT, setPointerCapture() {} };
  const cameras = [
    { x: 4587, y: 2199, zoom: 1, rotation: 0, canvasWidth: 810, canvasHeight: 594 },
    { x: -120.5, y: 1724.8, zoom: 1.25, rotation: 0, canvasWidth: 810, canvasHeight: 594 },
    { x: 300, y: 200, zoom: 0.5, rotation: 0.3, canvasWidth: 810, canvasHeight: 594 },
  ];
  for (const camera of cameras) {
    for (const [clientX, clientY] of [[300, 50], [701.5, 333.25], [1069, 629]]) {
      Mouse.pointerDown({ clientX, clientY, currentTarget: target, pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse' }, camera);
      const out = viewPointToWorld(clientX, clientY, RECT, camera, { x: 0, y: 0 });
      // Mouse keeps its world point in a Float32Array.
      assert.ok(Math.abs(out.x - Mouse.x) < 1e-3 * Math.max(1, Math.abs(out.x)), `x at ${clientX}, zoom ${camera.zoom}: ${out.x} vs ${Mouse.x}`);
      assert.ok(Math.abs(out.y - Mouse.y) < 1e-3 * Math.max(1, Math.abs(out.y)), `y at ${clientY}, zoom ${camera.zoom}: ${out.y} vs ${Mouse.y}`);
      Mouse.pointerUp({ clientX, clientY, currentTarget: target, pointerId: 1, button: 0, buttons: 0, pointerType: 'mouse' }, camera);
    }
  }
  const out = viewPointToWorld(RECT.left + 100, RECT.top + 50, RECT, cameras[1], { x: 0, y: 0 });
  assert.deepEqual(out, { x: -120.5 + 100 / 1.25, y: 1724.8 + 50 / 1.25 });
});

test('only a drag of a class from the palette counts: its type, not its data (unreadable until the drop)', () => {
  assert.equal(carriesClass({ types: ['Files'] }), false);
  assert.equal(carriesClass({ types: ['text/plain', CLASS_DRAG_TYPE] }), true);
  assert.equal(carriesClass(null), false);
  assert.equal(carriesClass({ types: null }), false);
});

// ---- the placer against a fake editor ----

function fakeEditor({ active = true, snap = 16 } = {}) {
  const calls = [];
  const canvas = { tagName: 'CANVAS', getBoundingClientRect: () => RECT };
  const scene = {
    camera: { x: 1000, y: 500, zoom: 2, rotation: 0, canvasWidth: 810, canvasHeight: 594 },
    registeredClasses: [{ class: { name: 'Platform' } }, { class: { name: 'Goal' } }, { class: { name: 'Flash' } }],
  };
  const editMode = {
    active,
    move: { snap },
    tools: [],
    addTool(tool) {
      this.tools.push(tool);
      return tool;
    },
    debugUI: {
      scene,
      gameEngine: { canvas },
      canvas: { startLoop: () => calls.push('overlay on'), syncLoop: () => calls.push('overlay sync') },
    },
    selection: {
      index: -1,
      select(i) {
        this.index = i;
        calls.push(`select ${i}`);
      },
    },
    enter() {
      calls.push('enter');
      this.active = true;
    },
    // EditMode.edit: back to editing from a game that plays (a Stop, ED-80).
    async edit() {
      calls.push('edit');
      this.active = true;
      return true;
    },
    place(className, x, y) {
      calls.push(`place ${className} ${x} ${y}`);
      return 42;
    },
    _setStatus: (text, error) => calls.push(`status ${error ? 'error' : 'ok'}: ${text}`),
  };
  const placer = new DropPlacer(editMode, (name) => placeableClassOf(scene, name));
  return { editMode, placer, canvas, scene, calls };
}

function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type),
  };
}

/** A drag event: of a class from the palette (or `types`), at a client point, on `target`. */
function dragEvent(target, clientX, clientY, { types = [CLASS_DRAG_TYPE], data = {} } = {}) {
  const e = {
    target,
    clientX,
    clientY,
    prevented: false,
    dataTransfer: { types, dropEffect: 'none', getData: (type) => data[type] ?? '' },
    preventDefault() {
      this.prevented = true;
    },
  };
  return e;
}

test('a class with a pool of 0 is not offered, and a drop of its name places nothing: nothing of it can spawn', () => {
  const scene = { registeredClasses: [{ class: { name: 'Car' }, count: 0 }, { class: { name: 'TrafficCar' }, count: 500 }] };
  assert.deepEqual(placeableClasses(scene).map((C) => C.name), ['TrafficCar']);
  assert.equal(placeableClassOf(scene, 'Car'), null);
  assert.equal(placeableClassOf(scene, 'TrafficCar').name, 'TrafficCar');
});

test('the placer listens on the page’s document once, and is the editor’s tool once', () => {
  const { editMode, placer } = fakeEditor();
  const doc = fakeDocument();
  placer.attach(doc);
  placer.attach(doc);
  assert.deepEqual([...doc.listeners.keys()].sort(), ['dragenter', 'dragleave', 'dragover', 'drop']);
  assert.deepEqual(editMode.tools, [placer], 'added once');
  placer.detach();
  assert.equal(doc.listeners.size, 0);
});

test('over the view: the drop is welcome, and where it would land is on the grid; elsewhere or another drag, nothing', () => {
  const { editMode, placer, canvas, calls } = fakeEditor({ snap: 16 });
  const doc = fakeDocument();
  placer.attach(doc);
  const over = doc.listeners.get('dragover');
  const file = dragEvent(canvas, 400, 300, { types: ['Files'] });
  over(file);
  assert.equal(file.prevented, false, 'a file dragged in is the page’s');
  const panel = dragEvent({ tagName: 'DIV' }, 400, 300);
  over(panel);
  assert.equal(panel.prevented, false, 'not over the view: no drop there');
  assert.equal(placer.wantsOverlay(), false);

  placer.begin('Platform');
  const e = dragEvent(canvas, RECT.left + 101, RECT.top + 33);
  doc.listeners.get('dragenter')(e);
  assert.equal(e.prevented, true);
  assert.equal(e.dataTransfer.dropEffect, 'copy');
  // 1000 + 101 / 2 = 1050.5 → 1056 on a 16 px grid; 500 + 33 / 2 = 516.5 → 512.
  assert.deepEqual([placer.x, placer.y], [1056, 512]);
  assert.equal(placer.wantsOverlay(), true);
  assert.deepEqual(calls, ['overlay on'], 'the overlay draws while the drag is over the view');
  over(dragEvent(canvas, RECT.left + 140, RECT.top + 33));
  assert.deepEqual([placer.x, placer.y], [1072, 512]);
  assert.deepEqual(calls, ['overlay on'], 'once');

  // The cross on the overlay: the view's top-left at (1000, 500), zoom 2.
  const drawn = [];
  const ctx = new Proxy({}, {
    get: (_, key) => (key in Object.prototype ? undefined : (...args) => drawn.push([key, ...args])),
    set: () => true,
  });
  placer.drawOverlay(ctx, { x: 1000, y: 500 }, 2);
  assert.deepEqual(drawn.find(([op]) => op === 'arc').slice(1, 3), [144, 24], 'centered on the landing point');
  assert.deepEqual(drawn.find(([op]) => op === 'fillText').slice(1, 2), ['Platform'], 'named');

  editMode.move.snap = 1;
  over(dragEvent(canvas, RECT.left + 101, RECT.top + 33));
  assert.deepEqual([placer.x, placer.y], [1051, 517], 'no grid: whole pixels');

  doc.listeners.get('dragleave')(dragEvent(canvas, 0, 0));
  assert.equal(placer.wantsOverlay(), false);
  assert.deepEqual(calls, ['overlay on', 'overlay sync'], 'the overlay stops when nothing else needs it');
});

test('a drop on the view places the class at the mapped point and selects it; elsewhere, nothing', () => {
  const { placer, canvas, calls } = fakeEditor();
  const doc = fakeDocument();
  placer.attach(doc);
  placer.begin('Goal');
  const drop = doc.listeners.get('drop');
  drop(dragEvent({ tagName: 'DIV' }, 400, 300, { data: { [CLASS_DRAG_TYPE]: 'Goal' } }));
  assert.deepEqual(calls, [], 'dropped on a panel: nothing placed');
  const e = dragEvent(canvas, RECT.left + 101, RECT.top + 33, { data: { [CLASS_DRAG_TYPE]: 'Goal' } });
  drop(e);
  assert.equal(e.prevented, true, 'the browser does not open it');
  assert.deepEqual(calls, ['place Goal 1050.5 516.5', 'select 42'], 'EditMode.place snaps it; then selected');
  assert.equal(placer.dragging, null);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a drop while the game plays goes back to editing first (a Stop), then lands at the point of its own view', async () => {
  const { editMode, placer, canvas, scene, calls } = fakeEditor({ active: false });
  const doc = fakeDocument();
  placer.attach(doc);
  editMode.edit = async () => {
    calls.push('edit');
    editMode.active = true;
    scene.camera.x = 0; // the swap put the camera back; a point mapped after it would be off
    return true;
  };
  doc.listeners.get('drop')(dragEvent(canvas, RECT.left + 10, RECT.top + 10, { data: { [CLASS_DRAG_TYPE]: 'Platform' } }));
  assert.deepEqual(calls, ['edit'], 'nothing placed in the game that plays');
  await tick();
  assert.deepEqual(calls, ['edit', 'place Platform 1005 505', 'select 42']);

  // Not back to editing (an unsaved level the author kept): nothing placed.
  calls.length = 0;
  editMode.active = false;
  editMode.edit = async () => (calls.push('edit'), false);
  doc.listeners.get('drop')(dragEvent(canvas, RECT.left + 10, RECT.top + 10, { data: { [CLASS_DRAG_TYPE]: 'Platform' } }));
  await tick();
  assert.deepEqual(calls, ['edit']);
});

test('a class the scene does not have, or the engine’s own, is not placed: the status line says so', () => {
  const { placer, canvas, calls } = fakeEditor({ active: false });
  const doc = fakeDocument();
  placer.attach(doc);
  doc.listeners.get('drop')(dragEvent(canvas, 300, 100, { data: { [CLASS_DRAG_TYPE]: 'Spaceship' } }));
  assert.deepEqual(placer.placeAt('Flash', 0, 0), -1);
  assert.deepEqual(calls, [
    'status error: Spaceship: this scene has no such class to place',
    'status error: Flash: this scene has no such class to place',
  ], 'and edit mode is not entered for it');
});

// ---- through the real editor: the document, the grid, undo ----

function makeEditor() {
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(256) }, []);
  Transform.entityType = new Uint8Array(256);
  Time.bind(new SharedArrayBuffer(4));
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data.set([1, 0, 0, 400, 300, 1]);
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  let next = 10;
  class Platform {
    static spawnParams = { width: { value: 220 } };
    static poolSize = 64;
    static live = 1;
    static spawn() {
      return { index: next++ };
    }
    static despawn() {}
  }
  const canvas = { tagName: 'CANVAS', getBoundingClientRect: () => RECT };
  const scene = {
    constructor: { name: 'PlatformerGameScene' },
    camera: { x: 100, y: 1500, zoom: 1.25, rotation: 0, canvasWidth: 810, canvasHeight: 594 },
    sceneFile: { format: 1, script: 's.js', entities: [{ name: 'Platform1', class: 'Platform', x: 0, y: 0 }] },
    registeredClasses: [{ class: Platform }],
    _namedEntities: new Map([['Platform1', 1 * 65536]]),
  };
  const debugUI = {
    scene,
    gameEngine: { canvas },
    tools: { deactivateAll() {}, updateToolIndicator() {}, _syncDebugToolFlag() {}, _classNameForType: () => 'Platform' },
    panels: { scene: { updateEditButton() {} } },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  debugUI.editMode = editMode;
  editMode.selection._show = () => {};
  return { editMode, scene, canvas };
}

test('through the editor: a drop is a record on the grid, selected, one undo; undo takes it out', async () => {
  const doc = fakeDocument();
  globalThis.document = doc;
  const { editMode, scene, canvas } = makeEditor();
  try {
    // The editor's own palette and its placer, attached as show() attaches it; its DOM is the palette tests'.
    const palette = editMode.palette;
    assert.ok(palette instanceof Palette);
    palette.show = () => palette.drops.attach(doc);
    palette.refresh = () => {};
    palette.hide = () => {};
    palette.show();
    assert.ok(editMode.tools.includes(palette.drops), 'the overlay’s cross is the editor’s tool');
    editMode.move.snap = 16;
    assert.equal(editMode.active, false);
    // At zoom 1.25, 251 px right of the view's left edge is 100 + 200.8 = 300.8; 125 px down is 1500 + 100 = 1600.
    doc.listeners.get('drop')(dragEvent(canvas, RECT.left + 251, RECT.top + 125, { data: { [CLASS_DRAG_TYPE]: 'Platform' } }));
    assert.equal(editMode.active, true, 'edit mode entered: a scene with no file holds the world where it is');
    await tick(); // the drop lands once EditMode.edit has resolved
    const found = recordOf(scene, 'Platform2');
    assert.deepEqual(found.record, { name: 'Platform2', class: 'Platform', x: 304, y: 1600 }, 'on the 16 px grid');
    assert.equal(editMode.selection.name, 'Platform2', 'selected');
    assert.equal(editMode.history._done.length, 1);
    assert.equal(editMode.history._done[0].label, 'place Platform2');
    editMode.undo();
    assert.equal(recordOf(scene, 'Platform2'), null, 'one undo takes it out');
    assert.deepEqual(scene.sceneFile.entities.map((e) => e.name), ['Platform1']);
  } finally {
    editMode.exit();
    clearTimeout(editMode._statusTimer);
    delete globalThis.document;
    Camera.held = false;
    Camera.setFree(false);
  }
});
