// The scene list's DOM in the editor page (VISUAL_EDITOR_PLAN.md ED-62): its filter field (typing keeps the matching
// rows, the count shows, Esc clears it, Ctrl+F in the list puts the focus there).
//
// The list sits in a fake document whose events go the way a browser's do (capture, target, bubble, stopPropagation),
// with the editor page's own key handling on its window, as editorShell.js has it: a keydown the list does not take
// reaches the real HostedEditor.onHostKey, and from there the editor's keys. So a key the list takes is seen to stop
// at the list: one action per key.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Messages } from '../../src/core/messages.js';
import { EntityTree, ROW_HEIGHT } from '../../src/core/debug/editor/entityTree.js';
import { HostedEditor } from '../../src/core/debug/editor/editorHost.js';

// ---- a fake document: what the list uses, with a browser's event order ----

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = '';
    this.ctrlKey = false;
    this.metaKey = false;
    this.shiftKey = false;
    this.altKey = false;
    this.repeat = false;
    this.detail = 1;
    this.button = 0;
    this.clientX = 0;
    this.clientY = 0;
    this.relatedTarget = null;
    Object.assign(this, init);
    this.target = null;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

class FakeTarget {
  constructor() {
    this._listeners = [];
  }
  addEventListener(type, fn, options) {
    this._listeners.push({ type, fn, capture: options === true || options?.capture === true });
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || options?.capture === true;
    const at = this._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (at >= 0) this._listeners.splice(at, 1);
  }
  _fire(e, capture) {
    for (const l of this._listeners.slice()) if (l.type === e.type && (capture === null || l.capture === capture)) l.fn.call(this, e);
  }
  listening(type) {
    return this._listeners.filter((l) => l.type === type).length;
  }
}

const FOCUSABLE = new Set(['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);

class FakeElement extends FakeTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.title = '';
    this.type = '';
    this.className = '';
    this.value = '';
    this.placeholder = '';
    this.innerHTML = '';
    this.id = '';
    this.textContent = '';
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.tabIndex = FOCUSABLE.has(this.tagName) ? 0 : -1;
    this.rect = { left: 0, top: 0, width: 160, height: 100 };
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at >= 0) this.children.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  closest(selector) {
    const key = /^\[data-([a-z]+)\]$/.exec(selector)[1];
    for (let at = this; at instanceof FakeElement; at = at.parentNode) if (key in at.dataset) return at;
    return null;
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  get isConnected() {
    return this.ownerDocument.body.contains(this);
  }
  focus() {
    if (this.tabIndex < 0 || !this.isConnected || this.style.display === 'none') return;
    this.ownerDocument._moveFocus(this);
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument._moveFocus(this.ownerDocument.body);
  }
  select() {
    this.selected = true;
  }
  /** Every element under this one, depth first. */
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
}

class FakeDocument extends FakeTarget {
  constructor() {
    super();
    this.defaultView = new FakeTarget();
    this.defaultView.innerWidth = 1000;
    this.defaultView.innerHeight = 700;
    this.documentElement = { clientWidth: 1000, clientHeight: 700 };
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  getElementById(id) {
    for (const root of [this.head, this.body]) for (const el of root.all()) if (el.id === id) return el;
    return null;
  }
  _moveFocus(to) {
    const from = this.activeElement;
    if (from === to) return;
    this.activeElement = to;
    if (from !== this.body) {
      dispatch(from, 'blur', { relatedTarget: to }, false);
      dispatch(from, 'focusout', { relatedTarget: to });
    }
    if (to !== this.body) {
      dispatch(to, 'focus', { relatedTarget: from }, false);
      dispatch(to, 'focusin', { relatedTarget: from });
    }
  }
}

/** Dispatch an event as a browser does: capture from the window down, the target, then bubbling up. */
function dispatch(target, type, init = {}, bubbles = true) {
  const e = new FakeEvent(type, init);
  e.target = target;
  const path = [];
  for (let at = target; at instanceof FakeElement; at = at.parentNode) path.push(at);
  const doc = target.ownerDocument;
  if (path.at(-1) === doc.body) path.push(doc, doc.defaultView);
  for (let k = path.length - 1; k > 0 && !e.stopped; k--) path[k]._fire(e, true);
  if (!e.stopped) target._fire(e, null);
  if (bubbles) for (let k = 1; k < path.length && !e.stopped; k++) path[k]._fire(e, false);
  return e;
}

/** A key typed where the focus is. */
const press = (doc, key, extra = {}) => dispatch(doc.activeElement, 'keydown', { key, ...extra });

/** Type text into the focused field, a keystroke at a time. */
function type(doc, text) {
  const field = doc.activeElement;
  for (const ch of text) {
    const e = dispatch(field, 'keydown', { key: ch });
    if (!e.defaultPrevented) {
      field.value += ch;
      dispatch(field, 'input');
    }
  }
}

// ---- the scene, the editor and the editor page around the list ----

const N = 64;

/** Players 0..2 (runtime 0), Platforms 2..18 (placed Platform1..Platform6 at 2..7), Coins 18..34 (Coin1 at 18, runtime 19, 20). */
function makeScene() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
  const cls = (name, startIndex, poolSize) => ({ class: { name, startIndex, poolSize, endIndex: startIndex + poolSize } });
  const entities = [];
  const named = new Map();
  for (let k = 1; k <= 6; k++) {
    entities.push({ name: `Platform${k}`, class: 'Platform' });
    named.set(`Platform${k}`, (1 + k) * 65536);
  }
  entities.push({ name: 'Coin1', class: 'Coin' });
  named.set('Coin1', 18 * 65536);
  for (const i of [0, 2, 3, 4, 5, 6, 7, 18, 19, 20]) Transform.active[i] = 1;
  return {
    registeredClasses: [cls('Player', 0, 2), cls('Platform', 2, 16), cls('Coin', 18, 16)],
    sceneFile: { entities },
    _namedEntities: named,
  };
}

/** The running file's name for the live entity at `index`, or null (selection.js's nameOf). */
function nameAt(scene, index) {
  for (const [name, packed] of scene._namedEntities) if (Math.floor(packed / 65536) === index) return name;
  return null;
}

/**
 * The list in an editor page: a fake EditMode that records what the list asks of it, a real HostedEditor whose
 * onHostKey the page's window calls (editorShell.js), and the editor's own keys behind it (EditMode.onKey: a spy).
 */
function makeEditorPage({ editing = true } = {}) {
  const doc = new FakeDocument();
  globalThis.document = doc;
  const scene = makeScene();
  const log = [];
  const selection = {
    index: -1,
    packed: -1,
    name: null,
    get authored() {
      return this.name !== null;
    },
  };
  const editMode = {
    active: editing,
    selection,
    layers: { locked: () => false },
    multi: { count: 0, has: () => false },
    _setStatus: (text, isError) => log.push(['status', text, isError]),
    selectFromList(index, center) {
      log.push(['select', index, center]);
      selection.index = index;
      selection.packed = index * 65536;
      selection.name = nameAt(scene, index);
      debugUI.hosted.onSelectionChanged();
    },
    onKey(e) {
      log.push(['editor key', e.key]);
      return true;
    },
  };
  const debugUI = {
    scene,
    editMode,
    get editing() {
      return editMode.active;
    },
    onEditKey: (e) => editMode.onKey(e),
    toggleEditMode: () => log.push(['toggle edit mode']),
  };
  const styles = [];
  const hosted = new HostedEditor(debugUI, { addStyles: (id, css) => styles.push([id, css]) });
  debugUI.hosted = hosted;
  const tree = new EntityTree(debugUI);
  hosted.tree = tree;
  // The editor page: its dock, and its window passing keys on to the connected game page (editorShell.js).
  const dock = doc.createElement('div');
  doc.body.appendChild(dock);
  dock.appendChild(tree.el);
  doc.defaultView.addEventListener('keydown', (e) => hosted.onHostKey(e));
  tree.attach(scene);
  return { doc, tree, editMode, selection, scene, log, styles };
}

/** The rows drawn, as text. */
const shownRows = (tree) => tree._rows.filter((r) => r.style.display !== 'none').map((r) => r.textContent);

function done() {
  delete globalThis.document;
}

// ---- the filter (ED-62) ----

test('the filter field: the rows that match, their class unfolded with its count, the total; Esc clears it', () => {
  const { doc, tree, styles } = makeEditorPage();
  try {
    assert.deepEqual(styles.map(([id]) => id), ['weed-editor-tree'], 'the list’s rules, through the editor page’s host');
    assert.deepEqual(shownRows(tree), ['▸ Player  ·  0 placed, 1 runtime', '▸ Platform  ·  6 placed, 0 runtime', '▸ Coin  ·  1 placed, 2 runtime']);
    tree._filter.focus();
    type(doc, 'form1');
    assert.equal(tree.model.query, 'form1');
    assert.deepEqual(shownRows(tree), ['▾ Platform  ·  1 of 6 match', 'Platform1  #2']);
    assert.equal(tree._count.textContent, '1');
    assert.equal(tree._clear.style.display, '', 'the clear button shows');

    tree._filter.value = 'COIN';
    dispatch(tree._filter, 'input');
    assert.deepEqual(shownRows(tree), ['▾ Coin  ·  3 of 3 match', 'Coin1  #18', '#19  runtime', '#20  runtime'], 'the class: all its rows');
    assert.equal(tree._count.textContent, '3');

    const esc = press(doc, 'Escape');
    assert.equal(esc.stopped, true, 'the filter’s Esc stops there');
    assert.equal(tree._filter.value, '');
    assert.equal(tree.model.query, '');
    assert.deepEqual(shownRows(tree), ['▸ Player  ·  0 placed, 1 runtime', '▸ Platform  ·  6 placed, 0 runtime', '▸ Coin  ·  1 placed, 2 runtime']);
    assert.equal(tree._count.textContent, '');
    assert.equal(tree._clear.style.display, 'none');
    press(doc, 'Escape');
    assert.equal(doc.activeElement, tree._list, 'Esc in an empty filter: back to the list');
  } finally {
    done();
  }
});

test('Ctrl+F in the list puts the focus in the filter; the list’s keys stop at it, the others reach the editor', () => {
  const { doc, tree, log } = makeEditorPage();
  try {
    tree._list.focus();
    const find = press(doc, 'f', { ctrlKey: true });
    assert.equal(doc.activeElement, tree._filter);
    assert.equal(tree._filter.selected, true, 'its text selected, to type over');
    assert.equal(find.defaultPrevented, true, 'not the browser’s find bar');
    assert.equal(find.stopped, true);
    assert.deepEqual(log, [], 'the editor heard nothing');

    type(doc, 'coin');
    assert.deepEqual(log, [], 'typing in the field is the field’s');
    press(doc, 'ArrowDown');
    assert.equal(doc.activeElement, tree._list, '↓ in the filter: to the list');
    const esc = press(doc, 'Escape');
    assert.equal(esc.stopped, true);
    assert.equal(tree.model.query, '', 'Esc in the list clears a filter first');
    assert.deepEqual(log, []);
    press(doc, 'Escape');
    press(doc, 'z', { ctrlKey: true });
    assert.deepEqual(log, [['editor key', 'Escape'], ['editor key', 'z']], 'without a filter, Esc is the editor’s, as Ctrl+Z is');
  } finally {
    done();
  }
});

test('a click on a class folds it under the filter; the rows in view are drawn, and a row is written only when it changes', () => {
  const { doc, tree } = makeEditorPage();
  try {
    tree._filter.focus();
    type(doc, 'platform');
    assert.equal(shownRows(tree).length, 7);
    dispatch(tree._rows[0], 'click');
    assert.deepEqual(shownRows(tree), ['▸ Platform  ·  6 of 6 match'], 'folded');
    dispatch(tree._rows[0], 'click');
    assert.equal(shownRows(tree).length, 7, 'unfolded');
    assert.equal(tree._spacer.style.height, `${7 * ROW_HEIGHT}px`);
    // Written once: a render that changes nothing writes nothing.
    const row = tree._rows[1];
    let writes = 0;
    let text = row.textContent;
    Object.defineProperty(row, 'textContent', {
      get: () => text,
      set: (value) => {
        writes++;
        text = value;
      },
    });
    tree.render();
    tree.update();
    assert.equal(writes, 0);
  } finally {
    done();
  }
});
