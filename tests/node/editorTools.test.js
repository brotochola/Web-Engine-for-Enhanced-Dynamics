// The editor's tools (VISUAL_EDITOR_PLAN.md Stage 4): what addTool() gives a tool. The first tool whose press takes a
// primary press on the view has the pointer until the button is let go, and the move tool gets nothing of it; a tool
// that declines leaves the press to the next, then to the move tool. Tools follow the pointer with no button down,
// draw on the overlay after the move ghost, take keys before the editor, and drop what they were doing when edit
// mode is left or the level swapped.
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { Time } from '../../src/core/timeScale.js';
import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';

function setup() {
  Time.bind(new SharedArrayBuffer(4));
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data.set([1, 0, 0, 400, 300, 1]);
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  const listeners = new Map();
  globalThis.document = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const canvas = { tagName: 'CANVAS' };
  const debugUI = {
    scene: {},
    gameEngine: { canvas },
    tools: { deactivateAll() {}, updateToolIndicator() {}, _syncDebugToolFlag() {} },
    panels: { scene: { updateEditButton() {} } },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  debugUI.editMode = editMode;
  editMode.palette = { show() {}, hide() {}, refresh() {}, destroy() {} };
  const moves = [];
  editMode.move = {
    press: () => moves.push('press'),
    move: () => moves.push('move'),
    release: () => moves.push('release'),
    cancel() {},
    drawOverlay: () => moves.push('ghost'),
    dragging: false,
  };
  const fire = (type, buttons) => listeners.get(type)({ target: canvas, buttons, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {} });
  return { editMode, moves, fire };
}

function teardown(editMode) {
  editMode.exit();
  clearTimeout(editMode._statusTimer);
  delete globalThis.document;
  Camera.held = false;
  Camera.setFree(false);
}

/** A tool that logs what it is given, and takes presses while `takes` is true. */
function loggingTool(name, log, { takes = true, key = null } = {}) {
  return {
    takes,
    press(x, y) {
      log.push(`${name} press ${x},${y}`);
      return this.takes;
    },
    move: () => log.push(`${name} move`),
    release: () => log.push(`${name} release`),
    hover: () => log.push(`${name} hover`),
    drawOverlay: () => log.push(`${name} draw`),
    onKey: (e) => {
      log.push(`${name} key ${e.key}`);
      return e.key === key;
    },
    cancel: () => log.push(`${name} cancel`),
  };
}

test('a tool that takes the press has the pointer until it is let go; the move tool gets none of it', () => {
  const { editMode, moves, fire } = setup();
  try {
    const log = [];
    const handles = editMode.addTool(loggingTool('handles', log));
    editMode.enter();
    Mouse.x = 12;
    Mouse.y = 34;
    fire('pointerdown', 1);
    fire('pointermove', 1);
    fire('pointerup', 0);
    assert.deepEqual(log, ['handles press 12,34', 'handles move', 'handles release']);
    assert.deepEqual(moves, []);
    handles.takes = false;
    log.length = 0;
    fire('pointerdown', 1);
    fire('pointermove', 1);
    fire('pointerup', 0);
    assert.deepEqual(log, ['handles press 12,34'], 'declined: asked, then left out');
    assert.deepEqual(moves, ['press', 'move', 'release'], 'the move tool had it');
  } finally {
    teardown(editMode);
  }
});

test('the first tool that takes it wins; hover, overlay, keys and cancel reach every tool', () => {
  const { editMode, moves, fire } = setup();
  try {
    const log = [];
    editMode.addTool(loggingTool('a', log, { takes: false }));
    editMode.addTool(loggingTool('b', log, { key: 'r' }));
    editMode.addTool(loggingTool('c', log));
    editMode.enter();
    fire('pointerdown', 1);
    assert.deepEqual(log.splice(0), ['a press 0,0', 'b press 0,0'], 'c is not asked');
    fire('pointerup', 0);
    log.length = 0;
    fire('pointermove', 0);
    assert.deepEqual(log.splice(0), ['a hover', 'b hover', 'c hover']);
    editMode.drawOverlay(null, null, 1);
    assert.deepEqual(moves.splice(0), ['ghost'], 'the ghost first');
    assert.deepEqual(log.splice(0), ['a draw', 'b draw', 'c draw']);
    assert.equal(editMode.onKey({ key: 'r' }), true, 'b took it');
    assert.deepEqual(log.splice(0), ['a key r', 'b key r']);
    editMode.onKey({ key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    assert.equal(editMode.active, false, 'a key no tool takes is the editor’s');
    assert.deepEqual(log.splice(0).filter((l) => l.endsWith('cancel')), ['a cancel', 'b cancel', 'c cancel'], 'leaving cancels');
    editMode.onContentSwapped();
    assert.deepEqual(log.splice(0).filter((l) => l.endsWith('cancel')), ['a cancel', 'b cancel', 'c cancel'], 'a swap too');
  } finally {
    teardown(editMode);
  }
});
