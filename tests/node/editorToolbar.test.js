// The editor's toolbar (VISUAL_EDITOR_PLAN.md ED-69): while not editing, ⏸ pauses the running game (its last frame
// showing) and ⏭ steps it one frame; Undo and Redo name the change they would make; ? opens the sheet of every key,
// which ?, Esc or a click outside closes. Entering edit mode lets a paused game go on (the editor's respawns need it).
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditorToolbar } from '../../src/core/debug/editor/toolbar.js';
import { History } from '../../src/core/debug/editor/history.js';
import { toggleShortcutSheet, SHORTCUTS } from '../../src/core/debug/editor/shortcuts.js';

class El {
  constructor(tag, doc = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.title = '';
    this.disabled = false;
    this.value = '';
    this._text = '';
    this.parentNode = null;
    this.ownerDocument = doc;
    const classes = new Set();
    this.classList = { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  setAttribute() {}
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = String(text);
    this.children = [];
  }
}

function fakeDocument() {
  const listeners = new Map();
  const doc = {
    createElement: (tag) => new El(tag, doc),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type),
    listeners,
  };
  doc.body = new El('body', doc);
  return doc;
}

function toolbarFor({ active = false, paused = false } = {}) {
  const calls = [];
  const scene = { state: { pause: paused } };
  const editMode = {
    active,
    playing: false,
    dirty: false,
    status: '',
    statusIsError: false,
    sceneFileName: '1-1.scene.json',
    history: new History(() => {}),
    move: { snap: 1 },
    grid: { show: true },
    debugUI: { scene },
    togglePause: () => calls.push('pause'),
    stepFrame: () => calls.push('step'),
    toggleShortcuts: () => calls.push('help'),
    toggleLighting: () => calls.push('light'),
    layers: { lit: null },
  };
  globalThis.document = fakeDocument();
  try {
    return { toolbar: new EditorToolbar(editMode), editMode, scene, calls };
  } finally {
    delete globalThis.document;
  }
}

/** A button by its text: a glyph alone, or the label after its glyph (labelButton). */
const byText = (toolbar, text) => toolbar.el.children.find((b) => b.textContent === text || (b.children.length === 2 && b.children[1].textContent.trim() === text));

test('while the game runs: ⏸, and ⏭ only once paused; editing: neither', () => {
  const { toolbar, editMode, scene, calls } = toolbarFor();
  const pause = byText(toolbar, '⏸');
  const step = byText(toolbar, '⏭');
  assert.deepEqual([pause.style.display, step.style.display, step.disabled], ['', '', true]);
  pause.onclick();
  step.onclick();
  assert.deepEqual(calls, ['pause', 'step']);
  scene.state.pause = true;
  toolbar.refresh();
  assert.deepEqual([pause.textContent, pause.classList.contains('active'), step.disabled], ['▶', true, false]);
  editMode.active = true;
  toolbar.refresh();
  assert.deepEqual([pause.style.display, step.style.display], ['none', 'none'], 'edit mode holds the world its own way');
});

test('one button plays and stops, as Unity’s (ED-80): Play editing, Stop playing a level, Edit for a scene with no file', () => {
  const { toolbar, editMode, scene } = toolbarFor({ active: true });
  const toggles = [];
  editMode.toggle = () => toggles.push(editMode.active ? 'play' : 'back to editing');
  const mode = toolbar.el.children[0];
  const shown = () => [mode.children[0].textContent, mode.children[1].textContent.trim(), mode.classList.contains('active')];
  assert.deepEqual(shown(), ['▶', 'Play', false]);
  assert.match(mode.title, /^Play the level from its start/);
  editMode.active = false;
  toolbar.refresh();
  assert.deepEqual(shown(), ['❚❚', 'Edit', true], 'no scene file: no start to stop back to, edit mode holds it where it is');
  scene.sceneFileUrl = 'http://host/levels/1-1.scene.json';
  toolbar.refresh();
  assert.deepEqual(shown(), ['■', 'Stop', true]);
  assert.match(mode.title, /^Stop: back to the level’s start/);
  mode.onclick();
  assert.deepEqual(toggles, ['back to editing']);
  assert.equal(toolbar.el.children.filter((b) => /Stop/.test(b.textContent)).length, 1, 'no Stop beside it');
});

test('💡 only for a scene with lighting: lit as the game is, or unlit while editing (ED-78)', () => {
  const { toolbar, editMode, calls } = toolbarFor({ active: true });
  const light = byText(toolbar, '💡');
  assert.equal(light.style.display, 'none', 'no lighting: nothing to turn off');
  editMode.layers.lit = true;
  toolbar.refresh();
  assert.deepEqual([light.style.display, light.classList.contains('active')], ['', true]);
  assert.match(light.title, /^Lit as the game is/);
  editMode.layers.lit = false;
  toolbar.refresh();
  assert.equal(light.classList.contains('active'), false);
  assert.match(light.title, /^Unlit while editing/);
  light.onclick();
  assert.deepEqual(calls, ['light']);
});

test('Undo and Redo name what they would do', () => {
  const { toolbar, editMode } = toolbarFor({ active: true });
  editMode.history.push({ id: 0, label: 'move Platform1', kind: 'edit' });
  toolbar.refresh();
  assert.equal(byText(toolbar, 'Undo').title, 'Undo move Platform1 (Ctrl+Z)');
  editMode.history.undo();
  toolbar.refresh();
  assert.deepEqual([byText(toolbar, 'Undo').title, byText(toolbar, 'Redo').title], ['Undo (Ctrl+Z), while editing', 'Redo move Platform1 (Ctrl+Y)']);
});

test('the sheet: every key listed; ?, Esc or a click outside closes it; one per document', () => {
  const doc = fakeDocument();
  assert.equal(toggleShortcutSheet(doc), true);
  const backdrop = doc.body.children[0];
  const listed = SHORTCUTS.reduce((n, [, rows]) => n + rows.length, 0);
  assert.ok(listed > 20);
  assert.ok(backdrop.textContent.includes('frame the selection'));
  assert.equal(toggleShortcutSheet(doc), false, 'a second ? closes it');
  assert.equal(doc.body.children.length, 0);
  toggleShortcutSheet(doc);
  const prevented = [];
  doc.listeners.get('keydown')({ key: 'Escape', preventDefault: () => prevented.push(1), stopPropagation() {} });
  assert.deepEqual([doc.body.children.length, prevented.length], [0, 1]);
  toggleShortcutSheet(doc);
  doc.body.children[0].onclick({ target: doc.body.children[0] });
  assert.equal(doc.body.children.length, 0, 'a click outside the sheet');

  // The game page going (pagehide) closes it: the editor page keeps no handler of it. Node's global has no listeners.
  const page = new Map();
  globalThis.addEventListener = (type, fn) => page.set(type, fn);
  globalThis.removeEventListener = (type, fn) => {
    if (page.get(type) === fn) page.delete(type);
  };
  try {
    toggleShortcutSheet(doc);
    page.get('pagehide')();
    assert.deepEqual([doc.body.children.length, doc.listeners.has('keydown'), page.size], [0, false, 0]);
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});
