// The editor's edit mode (VISUAL_EDITOR_PLAN.md D5, ED-6): the world holds still (Time.scale 0), the camera is held
// and free for the editor, and the game gets no button press and no key. Leaving puts it all back; a fast swap
// holds the new level again; a full load leaves and comes back. The zero step itself: editModeZeroStep.wasm.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { GameEngine } from '../../src/core/gameEngine.js';
import { Time } from '../../src/core/timeScale.js';
import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';

/** A document that keeps its listeners, so a test can fire them and see what is left. */
function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
}

function setup() {
  Time.bind(new SharedArrayBuffer(4));
  Time.scale = 0.5;
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data.set([1, 0, 0, 400, 300, 1]);
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Camera.setFree(false, { smoothing: 0.15 });
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  Mouse.reset();
  Mouse.isDebugToolActive = false;
  Mouse.isEditModeActive = false;
  globalThis.document = fakeDocument();
  const canvas = { tagName: 'CANVAS' };
  const calls = [];
  const tools = {
    deactivateAll: () => calls.push('tools off'),
    updateToolIndicator: () => calls.push('indicator'),
    _syncDebugToolFlag: () => {
      Mouse.isDebugToolActive = debugUI.editMode.active;
    },
  };
  const debugUI = {
    scene: {},
    gameEngine: { canvas },
    tools,
    panels: { scene: { updateEditButton: () => calls.push('button') } },
    _ensureTickLoop: () => calls.push('tick'),
  };
  debugUI.editMode = new EditMode(debugUI);
  // The palette is a DOM panel (editorPalette.test.js has it).
  debugUI.editMode.palette = { show: () => calls.push('palette'), hide() {}, refresh() {}, destroy() {} };
  return { editMode: debugUI.editMode, debugUI, canvas, calls };
}

function teardown() {
  delete globalThis.document;
  Mouse.isEditModeActive = false;
  Mouse.isDebugToolActive = false;
  Camera.held = false;
  Camera.setFree(false);
}

test('entering holds the world, the camera and the input; leaving puts them back', () => {
  const { editMode, calls } = setup();
  try {
    editMode.enter();
    assert.equal(editMode.active, true);
    assert.equal(Time.scale, 0);
    assert.equal(Camera.held, true);
    assert.equal(Camera._free, true);
    assert.equal(Mouse.isEditModeActive, true);
    assert.equal(Mouse.isDebugToolActive, true);
    assert.deepEqual(calls, ['tools off', 'palette', 'indicator', 'button', 'tick'], 'other tools off, the palette shown, the UI told');
    assert.deepEqual([...document.listeners.keys()].sort(), ['contextmenu', 'pointerdown', 'pointermove', 'pointerup']);

    editMode.exit();
    assert.equal(editMode.active, false);
    assert.equal(Time.scale, 0.5, 'the time scale entering found');
    assert.equal(Camera.held, false);
    assert.equal(Camera._free, false);
    assert.equal(Camera._freeSmoothing, 0.15);
    assert.equal(Mouse.isEditModeActive, false);
    assert.equal(Mouse.isDebugToolActive, false);
    assert.equal(document.listeners.size, 0, 'no listener left');
  } finally {
    teardown();
  }
});

test('a right or middle drag on the game canvas pans; elsewhere, or with the left button, it does not', () => {
  const { editMode, canvas } = setup();
  try {
    Camera.zoom = 2;
    editMode.enter();
    Camera.setFreeTarget(1000, 800);
    const fire = (type, e) => document.listeners.get(type)({ pointerId: 1, preventDefault() {}, ...e });
    fire('pointerdown', { buttons: 1, clientX: 100, clientY: 100, target: canvas });
    fire('pointermove', { buttons: 1, clientX: 300, clientY: 100, target: canvas });
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [1000, 800], 'the left button selects (ED-8)');
    fire('pointerdown', { buttons: 2, clientX: 100, clientY: 100, target: {} });
    fire('pointermove', { buttons: 2, clientX: 300, clientY: 100, target: {} });
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [1000, 800], 'a drag that starts on a panel');
    fire('pointerdown', { buttons: 2, clientX: 100, clientY: 100, target: canvas });
    fire('pointermove', { buttons: 2, clientX: 300, clientY: 40, target: canvas });
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [900, 830], 'the world follows the pointer, at zoom 2');
    fire('pointerup', { buttons: 0, clientX: 300, clientY: 40, target: canvas });
    fire('pointermove', { buttons: 0, clientX: 500, clientY: 40, target: canvas });
    assert.deepEqual([Camera._freeFollowX, Camera._freeFollowY], [900, 830], 'released: no more panning');
    let prevented = false;
    document.listeners.get('contextmenu')({ target: canvas, preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, 'no menu after a right drag');
  } finally {
    teardown();
  }
});

test('a left click on the game canvas selects at the mouse; Esc lets go of the selection, then of edit mode', () => {
  const { editMode, canvas } = setup();
  try {
    editMode.tools.length = 0; // the move tool's routing alone: box select has its tests (editorMulti.test.js)
    editMode.enter();
    const picks = [];
    let cleared = 0;
    editMode.selection.pickAt = (x, y) => picks.push([x, y]);
    editMode.selection.clear = () => {
      cleared++;
      editMode.selection.index = -1;
    };
    const fire = (e) => document.listeners.get('pointerdown')({ pointerId: 1, preventDefault() {}, ...e });
    fire({ buttons: 1, target: canvas });
    fire({ buttons: 1, target: {} });
    fire({ buttons: 3, target: canvas });
    assert.deepEqual(picks, [[Mouse.x, Mouse.y]], 'only a plain left press on the canvas');
    editMode.selection.index = 4;
    editMode.onKey({ key: 'Escape' });
    assert.deepEqual([cleared, editMode.active], [1, true]);
    editMode.onKey({ key: 'Escape' });
    assert.equal(editMode.active, false);
  } finally {
    teardown();
  }
});

test('the arrow keys nudge (Shift: ten steps) and G cycles the grid step', () => {
  const { editMode } = setup();
  try {
    editMode.enter();
    const nudges = [];
    editMode.move.nudge = (x, y) => (nudges.push([x, y]), true);
    const key = (k, extra = {}) => editMode.onKey({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
    assert.equal(key('ArrowRight'), true);
    key('ArrowUp', { shiftKey: true });
    key('ArrowLeft');
    key('ArrowDown', { shiftKey: true });
    assert.equal(key('ArrowLeft', { ctrlKey: true }), false, 'not with Ctrl');
    assert.deepEqual(nudges, [[1, 0], [0, -10], [-1, 0], [0, 10]]);
    const steps = [];
    for (let i = 0; i < 4; i++) {
      key('g');
      steps.push(editMode.move.snap);
    }
    assert.deepEqual(steps, [8, 16, 32, 1]);
    assert.equal(editMode.status, 'No grid');
    clearTimeout(editMode._statusTimer);
  } finally {
    teardown();
  }
});

test('in edit mode no button press reaches the game; a release still does', () => {
  setup();
  try {
    const ev = (button, buttons, pointerType = 'mouse') => ({
      pointerId: 1,
      pointerType,
      button,
      buttons,
      clientX: 10,
      clientY: 20,
      currentTarget: null,
    });
    Mouse.pointerDown(ev(2, 2));
    assert.equal(Mouse.isButton2Down, true, 'held before edit mode');
    Mouse.isEditModeActive = true;
    Mouse.pointerMove(ev(0, 3));
    Mouse.pointerMove(ev(1, 7));
    assert.equal(Mouse.isButton0Down, false);
    assert.equal(Mouse.isButton1Down, false);
    Mouse.pointerUp(ev(2, 0));
    assert.equal(Mouse.isButton2Down, false, 'the release applies');
    Mouse.pointerDown({ ...ev(0, undefined), buttons: undefined });
    assert.equal(Mouse.isButton0Down, false, 'a press without a buttons mask');
    Mouse.pointerDown(ev(0, 1, 'touch'));
    assert.equal(Mouse.isDown, false, 'a touch');
  } finally {
    teardown();
  }
});

test('a fast swap reset the time scale and the camera: edit mode holds the new level again', () => {
  const { editMode } = setup();
  try {
    editMode.enter();
    // What Scene._fastSwap's reset does (restoreBootCamera, Time.scale = 1).
    Time.scale = 1;
    Camera.setFree(false);
    Camera.held = false;
    editMode.onContentSwapped();
    assert.equal(Time.scale, 0);
    assert.equal(Camera.held, true);
    assert.equal(Camera._free, true);
    editMode.exit();
    assert.equal(Time.scale, 1, 'leaving plays the new level at its own start');
  } finally {
    teardown();
  }
});

test('a full load leaves edit mode, and the next scene comes back to it', () => {
  const { editMode } = setup();
  try {
    editMode.enter();
    editMode.onDetach();
    assert.equal(editMode.active, false);
    assert.equal(Time.scale, 0.5);
    editMode.onAttach();
    assert.equal(editMode.active, true);
    editMode.exit();
    editMode.onDetach();
    editMode.onAttach();
    assert.equal(editMode.active, false, 'not editing before: not after');
  } finally {
    teardown();
  }
});

test('GameEngine: Shift+E toggles edit mode; while it is on the game gets no key, a field keeps its keys', () => {
  const windowListeners = new Map();
  globalThis.window = { addEventListener: (type, fn) => windowListeners.set(type, fn) };
  globalThis.document = fakeDocument();
  try {
    const keys = [];
    const editorKeys = [];
    const debugUI = {
      editing: false,
      toggleEditMode() {
        this.editing = !this.editing;
      },
      onEditKey: (e) => (editorKeys.push(e.key), e.key === 'Escape' || e.key === 's'),
    };
    const engine = { debugEnabled: true, debugUI, currentScene: { onKeyDown: (key) => keys.push(key) } };
    GameEngine.prototype._setupWindowListeners.call(engine);
    const keydown = windowListeners.get('keydown');
    const press = (key, extra = {}) => {
      const e = { key, shiftKey: false, repeat: false, target: null, defaultPrevented: false, ...extra };
      e.preventDefault = () => (e.defaultPrevented = true);
      keydown(e);
      return e;
    };

    press('d');
    press('E', { shiftKey: true, target: { tagName: 'INPUT' } });
    assert.equal(debugUI.editing, false, 'typed into a field');
    press('E', { shiftKey: true });
    assert.equal(debugUI.editing, true);
    press('E', { shiftKey: true, repeat: true });
    assert.equal(debugUI.editing, true, 'a held key does not toggle again');
    press('w');
    press(' ');
    assert.equal(press('Escape').defaultPrevented, true, 'the editor took it');
    const field = { tagName: 'INPUT' };
    press('Delete', { target: field });
    assert.equal(press('s', { ctrlKey: true, target: field }).defaultPrevented, true, 'Ctrl+S saves from a field too');
    assert.deepEqual(
      editorKeys,
      ['E', 'w', ' ', 'Escape', 's'],
      'the held Shift+E (which the editor ignores), not a Delete typed into a field',
    );
    press('E', { shiftKey: true });
    assert.equal(debugUI.editing, false);
    press('a');
    assert.deepEqual(keys, ['d', 'e', 'a'], 'the game got none of the keys pressed while editing');

    engine.preventDefaultKeys = true;
    assert.equal(press(' ').defaultPrevented, true, 'a space for the game does not scroll the page');
    assert.equal(press(' ', { target: { tagName: 'INPUT' } }).defaultPrevented, false, 'a space typed in a field is the field’s');
    assert.equal(press('Tab', { target: { tagName: 'INPUT' } }).defaultPrevented, false, 'Tab moves to the next field');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});
