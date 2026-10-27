// The scene list's DOM in the editor page (VISUAL_EDITOR_PLAN.md ED-62, ED-63, ED-64): its filter field (typing keeps
// the matching rows, the count shows, Esc clears it, Ctrl+F in the list puts the focus there); its keys (↑ ↓ along the
// rows shown, Enter and a double click frame, F2 renames in a field over the row, Del and Ctrl+D) and its clicks; its
// context menu (the items per row, where it opens, what closes it, what each item does).
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
import {
  menuFor,
  placeMenu,
  ITEM_SEPARATOR,
  TARGET_GROUP,
  TARGET_PLACED,
  TARGET_RUNTIME,
  TARGET_NOT_LIVE,
} from '../../src/core/debug/editor/treeMenu.js';

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
    this._tabIndex = FOCUSABLE.has(this.tagName) ? 0 : -1;
    /** A browser focuses by script a field, or any element given a tabIndex (-1 included). */
    this._focusable = FOCUSABLE.has(this.tagName);
    this.rect = { left: 0, top: 0, width: 160, height: 100 };
    this.attributes = {};
  }
  get tabIndex() {
    return this._tabIndex;
  }
  set tabIndex(value) {
    this._tabIndex = value;
    this._focusable = true;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
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
    if (!this._focusable || !this.isConnected || this.style.display === 'none') return;
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
  if (doc && path.at(-1) === doc.body) path.push(doc, doc.defaultView);
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
  // As Selection.select and clear: the hosted list hears of each change.
  const select = (index) => {
    selection.index = index;
    selection.packed = index * 65536;
    selection.name = nameAt(scene, index);
    debugUI.hosted.onSelectionChanged();
  };
  const unselect = () => {
    selection.index = -1;
    selection.packed = -1;
    selection.name = null;
    debugUI.hosted.onSelectionChanged();
  };
  const indexOfName = (name) => Math.floor(scene._namedEntities.get(name) / 65536);
  // As MultiSelect: the others selected with the inspector's, by name.
  const multi = {
    names: new Set(),
    get count() {
      return this.names.size;
    },
    has(name) {
      return this.names.has(name);
    },
    selectedNames() {
      const out = selection.name !== null ? [selection.name] : [];
      for (const name of this.names) if (name !== selection.name) out.push(name);
      return out;
    },
    clear() {
      if (this.names.size === 0) return;
      this.names.clear();
      debugUI.hosted.onSelectionChanged();
    },
    selectNames(names) {
      log.push(['select names', names.slice()]);
      this.names.clear();
      if (names.length === 0) {
        unselect();
        return;
      }
      for (let k = 1; k < names.length; k++) this.names.add(names[k]);
      select(indexOfName(names[0]));
    },
  };
  const editMode = {
    active: editing,
    selection,
    layers: { locked: () => false },
    multi,
    _setStatus: (text, isError) => log.push(['status', text, isError]),
    enter() {
      log.push(['enter edit mode']);
      editMode.active = true;
    },
    selectFromList(index, center) {
      log.push(['select', index, center]);
      select(index);
    },
    // As EditMode's: a name the file has (or none) is refused; a change of the document, then the selection.
    renameSelected(to) {
      const from = selection.name;
      log.push(['rename', from, to]);
      if (to.trim() === '' || scene._namedEntities.has(to)) return false;
      scene.sceneFile.entities.find((r) => r.name === from).name = to;
      scene._namedEntities.set(to, scene._namedEntities.get(from));
      scene._namedEntities.delete(from);
      debugUI.hosted.onDocumentChanged();
      select(selection.index);
      return true;
    },
    deleteSelected() {
      log.push(['delete', selection.name]);
      if (!selection.authored) return false;
      const name = selection.name;
      scene.sceneFile.entities.splice(scene.sceneFile.entities.findIndex((r) => r.name === name), 1);
      scene._namedEntities.delete(name);
      Transform.active[selection.index] = 0; // logic0's despawn, at once
      debugUI.hosted.onDocumentChanged();
      unselect();
      return true;
    },
    duplicateSelected() {
      log.push(['duplicate', selection.name]);
      return -1;
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
  return { doc, tree, editMode, selection, scene, log, styles, unselect };
}

/** The rows drawn, as text. */
const shownRows = (tree) => tree._rows.filter((r) => r.style.display !== 'none').map((r) => r.textContent);

/** The row element drawing list row `r`. */
const rowEl = (tree, r) => tree._rows.find((el) => el.style.display !== 'none' && el.dataset.row === String(r));

/** A click on list row `r` (a double click: two clicks, then dblclick, as a browser sends them). */
function click(tree, r, init = {}) {
  dispatch(rowEl(tree, r), 'click', init);
}
function doubleClick(tree, r) {
  const el = rowEl(tree, r);
  dispatch(el, 'click', { detail: 1 });
  dispatch(el, 'click', { detail: 2 });
  dispatch(el, 'dblclick', { detail: 2 });
}

/** The keys the editor itself heard (a key the list takes must not be one). */
const editorKeys = (log) => log.filter(([what]) => what === 'editor key').map(([, key]) => key);

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
    assert.deepEqual(log, [['select', 18, false]], 'at the first match (ED-63)');
    log.length = 0;
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

// ---- keys and rename (ED-63) ----

test('↑ and ↓ move the selection along the rows shown, past a class’s row and an entity not live, into view; they stop at the list', () => {
  const { doc, tree, selection, log } = makeEditorPage();
  try {
    Transform.active[5] = 0; // Platform4 is not live
    tree.update();
    tree._list.clientHeight = 100; // five rows in view
    click(tree, 1); // Platform: open
    click(tree, 2); // Platform1
    tree._list.focus();
    assert.equal(selection.name, 'Platform1');
    const names = [];
    for (let k = 0; k < 4; k++) {
      press(doc, 'ArrowDown');
      names.push(selection.name);
    }
    assert.deepEqual(names, ['Platform2', 'Platform3', 'Platform5', 'Platform6'], 'Platform4, not live, passed over');
    assert.equal(tree._list.scrollTop, 7 * ROW_HEIGHT + ROW_HEIGHT - 100, 'scrolled by the bottom edge to Platform6’s row');
    press(doc, 'ArrowDown');
    assert.equal(selection.name, 'Platform6', 'Coin is closed: nothing after it');
    click(tree, 8); // Coin: open
    for (const index of [18, 19, 20, 20]) {
      press(doc, 'ArrowDown');
      assert.equal(selection.index, index);
    }
    for (let k = 0; k < 3; k++) press(doc, 'ArrowUp');
    assert.equal(selection.name, 'Platform6', 'up past Coin’s row');
    assert.deepEqual(editorKeys(log), [], 'no arrow reached the editor (its arrows move the selected entity)');
    assert.equal(rowEl(tree, 7).style.background, 'rgba(74,222,128,0.32)', 'the list has the focus: brighter');
    tree._list.blur();
    assert.equal(rowEl(tree, 7).style.background, 'rgba(74,222,128,0.18)');
  } finally {
    done();
  }
});

test('nothing selected, ↓ starts at the rows in view; after a delete it goes on from where the deleted entity was', () => {
  const { doc, tree, selection, scene, unselect } = makeEditorPage();
  try {
    click(tree, 1);
    tree._list.focus();
    press(doc, 'ArrowDown');
    assert.equal(selection.name, 'Platform1', 'the first entity in view');
    press(doc, 'ArrowDown');
    press(doc, 'Delete');
    assert.equal(selection.index, -1, 'deleted: nothing selected');
    assert.equal(scene.sceneFile.entities.some((r) => r.name === 'Platform2'), false);
    assert.equal(rowEl(tree, 3).textContent, 'Platform3  #4', 'the list shows the change at once');
    press(doc, 'ArrowDown');
    assert.equal(selection.name, 'Platform3', 'the next one, now on its row');
    unselect(); // the editor’s Esc
    press(doc, 'ArrowDown');
    assert.equal(selection.name, 'Platform4', 'let go of, still there: the one after it');
    unselect();
    press(doc, 'ArrowUp');
    assert.equal(selection.name, 'Platform3');
  } finally {
    done();
  }
});

test('Enter and a double click frame: EditMode.frameSelection when it is there, else the view centered on the entity', () => {
  const { doc, tree, editMode, selection, log } = makeEditorPage();
  try {
    click(tree, 1);
    click(tree, 2);
    tree._list.focus();
    log.length = 0;
    press(doc, 'Enter');
    assert.deepEqual(log, [['select', 2, true]], 'without frameSelection: centered, as a double click did');
    editMode.frameSelection = () => log.push(['frame', selection.name]);
    log.length = 0;
    press(doc, 'Enter');
    doubleClick(tree, 4);
    assert.deepEqual(log, [['frame', 'Platform1'], ['select', 4, false], ['frame', 'Platform3']], 'selected once, then framed');
    doubleClick(tree, 8);
    assert.equal(tree.model.groups[2].open, true, 'a double click on a class’s row: one fold');
    assert.deepEqual(editorKeys(log), []);
  } finally {
    done();
  }
});

test('F2 renames in place: Enter keeps a free name; a taken one leaves the field open, marked, the old name kept; Esc; leaving the field', () => {
  const { doc, tree, editMode, scene, log } = makeEditorPage();
  try {
    click(tree, 1);
    click(tree, 2);
    tree._list.focus();
    const f2 = press(doc, 'F2');
    const field = tree._rename;
    assert.equal(f2.stopped, true);
    assert.equal(tree.renaming, true);
    assert.equal(doc.activeElement, field);
    assert.equal(field.style.display, '');
    assert.equal(field.style.top, `${2 * ROW_HEIGHT}px`, 'over Platform1’s row');
    assert.equal(field.value, 'Platform1');
    assert.equal(field.selected, true, 'its name selected, to type over');

    field.value = 'Platform2';
    press(doc, 'Enter');
    assert.equal(doc.activeElement, field, 'a name the file has: the field stays');
    assert.equal(field.style.borderColor, '#f87171');
    assert.equal(scene.sceneFile.entities[0].name, 'Platform1', 'the old name stays');
    field.value = 'Start';
    dispatch(field, 'input');
    assert.equal(field.style.borderColor, '#4ade80', 'typing again unmarks it');
    press(doc, 'Enter');
    assert.equal(scene.sceneFile.entities[0].name, 'Start');
    assert.equal(field.style.display, 'none');
    assert.equal(doc.activeElement, tree._list, 'back to the list');
    assert.equal(rowEl(tree, 2).textContent, 'Start  #2');

    press(doc, 'F2');
    field.value = 'Begin';
    press(doc, 'Escape');
    assert.equal(scene.sceneFile.entities[0].name, 'Start', 'Esc: the old name');
    assert.equal(field.style.display, 'none');
    assert.equal(doc.activeElement, tree._list);

    press(doc, 'F2');
    field.value = 'Begin';
    tree._filter.focus(); // the field is left
    assert.equal(scene.sceneFile.entities[0].name, 'Begin', 'left: the name typed, when the file can take it');

    tree._list.focus();
    press(doc, 'F2');
    field.value = 'Other';
    editMode.selectFromList(3, false); // a pick in the view
    assert.equal(field.style.display, 'none', 'the selection moved away: the field goes');
    assert.equal(scene._namedEntities.has('Other'), false);

    editMode.selectFromList(19, false);
    tree._list.focus();
    press(doc, 'F2');
    assert.equal(tree.renaming, false);
    assert.deepEqual(log.at(-1), ['status', '#19 was spawned by code: the scene file has no name of it to change', true]);
    assert.deepEqual(log.filter(([what]) => what === 'rename'), [
      ['rename', 'Platform1', 'Platform2'],
      ['rename', 'Platform1', 'Start'],
      ['rename', 'Start', 'Begin'],
    ]);
    assert.deepEqual(editorKeys(log), [], 'F2, Enter and Esc stayed in the list');
  } finally {
    done();
  }
});

test('Del and Ctrl+D: the editor’s delete and duplicate, once each, not again by its own keys; a runtime entity says why not', () => {
  const { doc, tree, editMode, log } = makeEditorPage();
  try {
    click(tree, 1);
    click(tree, 2);
    tree._list.focus();
    const del = press(doc, 'Delete');
    assert.equal(del.defaultPrevented, true);
    assert.equal(del.stopped, true);
    press(doc, 'ArrowDown');
    const duplicate = press(doc, 'd', { ctrlKey: true });
    assert.equal(duplicate.defaultPrevented, true, 'not the browser’s bookmark');
    press(doc, 'Backspace');
    editMode.selectFromList(19, false);
    press(doc, 'Delete');
    press(doc, 'ArrowLeft');
    press(doc, 'z', { ctrlKey: true });
    assert.deepEqual(
      log.filter(([what]) => what === 'delete' || what === 'duplicate' || what === 'status' || what === 'editor key'),
      [
        ['delete', 'Platform1'],
        ['duplicate', 'Platform2'],
        ['delete', 'Platform2'],
        ['status', '#19 was spawned by code, not placed by the scene file: read-only', true],
        ['editor key', 'ArrowLeft'],
        ['editor key', 'z'],
      ],
      '← and Ctrl+Z are the editor’s',
    );
  } finally {
    done();
  }
});

test('while the game plays, ↑ ↓ and Enter select and frame; F2, Del and Ctrl+D enter edit mode first, as the Assets dock’s + does', () => {
  const { doc, tree, editMode, log } = makeEditorPage({ editing: false });
  try {
    click(tree, 1);
    click(tree, 2);
    tree._list.focus();
    press(doc, 'ArrowDown');
    press(doc, 'Enter');
    assert.equal(editMode.active, false, 'looking does not edit');
    press(doc, 'd', { ctrlKey: true });
    assert.equal(editMode.active, true);
    assert.deepEqual(
      log.filter(([what]) => what === 'enter edit mode' || what === 'duplicate'),
      [['enter edit mode'], ['duplicate', 'Platform2']],
      'edit mode, then the duplicate: one undo away',
    );
    assert.deepEqual(editorKeys(log), []);
  } finally {
    done();
  }
});

test('a click selects one and lets the others go; Shift or Ctrl+click adds a placed entity or takes it out, the list staying put', () => {
  const { tree, editMode, selection } = makeEditorPage();
  try {
    click(tree, 1);
    editMode.multi.selectNames(['Platform1', 'Platform2', 'Platform3']);
    const selected = () => tree._rows.filter((r) => r.style.display !== 'none' && Boolean(r.style.background)).map((r) => r.textContent);
    assert.deepEqual(selected(), ['Platform1  #2', 'Platform2  #3', 'Platform3  #4']);
    tree._list.scrollTop = 40;
    tree.render();
    click(tree, 6, { ctrlKey: true });
    assert.deepEqual(editMode.multi.selectedNames(), ['Platform1', 'Platform2', 'Platform3', 'Platform5']);
    click(tree, 3, { shiftKey: true });
    assert.deepEqual(editMode.multi.selectedNames(), ['Platform1', 'Platform3', 'Platform5']);
    assert.equal(tree._list.scrollTop, 40, 'the list stayed where it was');
    click(tree, 7);
    assert.equal(selection.name, 'Platform6');
    assert.equal(editMode.multi.count, 0, 'a plain click: that one alone');
    assert.deepEqual(selected(), ['Platform6  #7']);
  } finally {
    done();
  }
});

// ---- the context menu (ED-64) ----

const labelsOf = (menu) => menu.items.map((it) => (it.id === ITEM_SEPARATOR ? '—' : it.label));

/** A right click on list row `r`, at a point of the viewport. */
const rightClick = (tree, r, x = 120, y = 90) => dispatch(rowEl(tree, r), 'contextmenu', { button: 2, clientX: x, clientY: y });

/** Pick the menu's item labelled `label`, by a click. */
function pick(tree, label) {
  const el = [...tree._menu.el.all()].find((node) => node.dataset.item !== undefined && node.children[0].textContent === label);
  assert.ok(el, `an item "${label}" in ${JSON.stringify(tree._menu.labels)}`);
  dispatch(el, 'click');
}

test('the menu’s items per row: a placed entity’s, several selected, a runtime one’s (read-only), a class’s; Copy when the editor has it', () => {
  const placed = menuFor({ kind: TARGET_PLACED, className: 'Platform', name: 'Platform1', index: 2, selected: 1, placed: 6, matching: 6 });
  assert.equal(placed.caption, 'Platform1  ·  Platform');
  assert.deepEqual(labelsOf(placed), ['Frame', 'Rename…', 'Duplicate', 'Delete', '—', 'Select all Platform (6)']);
  assert.deepEqual(placed.items.filter((it) => it.hint !== '').map((it) => it.hint), ['Enter', 'F2', 'Ctrl+D', 'Del'], 'each with its key');
  assert.ok(placed.items.every((it) => it.id === ITEM_SEPARATOR || it.title.length > 20), 'each with a hover title');

  const several = menuFor({ kind: TARGET_PLACED, className: 'Platform', name: 'Platform1', selected: 3, placed: 6, matching: 6, canCopy: true });
  assert.equal(several.caption, 'Platform1 and 2 more selected');
  assert.deepEqual(labelsOf(several), ['Frame', 'Rename…', 'Duplicate 3', 'Copy 3', 'Delete 3', '—', 'Select all Platform (6)']);

  const runtime = menuFor({ kind: TARGET_RUNTIME, className: 'Coin', index: 19, placed: 1, matching: 1 });
  assert.equal(runtime.caption, 'Coin #19  ·  spawned by code, read-only');
  assert.deepEqual(labelsOf(runtime), ['Frame', '—', 'Select all Coin (1)'], 'read-only: Frame and Select all');
  const player = menuFor({ kind: TARGET_RUNTIME, className: 'Player', index: 0, placed: 0, matching: 0 });
  assert.equal(player.items.at(-1).disabled, true);
  assert.match(player.items.at(-1).title, /No Player is placed by the scene file/);

  const filtered = menuFor({ kind: TARGET_GROUP, className: 'Platform', placed: 6, matching: 2, runtime: 0, filtered: true });
  assert.deepEqual(labelsOf(filtered), ['Select the 2 matching Platform'], 'a class’s row; under a filter, what it keeps');
  assert.equal(menuFor({ kind: TARGET_GROUP, className: 'Coin', placed: 1, matching: 1, runtime: 2 }).caption, 'Coin  ·  1 placed, 2 runtime');
  const notLive = menuFor({ kind: TARGET_NOT_LIVE, className: 'Platform', name: 'Platform4', placed: 6, matching: 6 });
  assert.deepEqual(labelsOf(notLive), ['Frame', '—', 'Select all Platform (6)']);
  assert.equal(notLive.items[0].disabled, true, 'nothing live to frame');
});

test('the menu stays in the viewport: left of the point or above it when it does not fit, never past an edge', () => {
  assert.deepEqual(placeMenu(100, 100, 200, 150, 1000, 700), [100, 100]);
  assert.deepEqual(placeMenu(950, 100, 200, 150, 1000, 700), [796, 100]);
  assert.deepEqual(placeMenu(100, 650, 200, 150, 1000, 700), [100, 500]);
  assert.deepEqual(placeMenu(100, 100, 200, 800, 1000, 700), [100, 4], 'taller than the view: from its top');
  assert.deepEqual(placeMenu(-20, -20, 200, 150, 1000, 700), [4, 4]);
});

test('a right click opens the row’s menu in the list’s document, its entity selected first; Esc closes it, back to the list; its keys stop at it', () => {
  const { doc, tree, selection, log } = makeEditorPage();
  try {
    click(tree, 1);
    const e = rightClick(tree, 3);
    assert.equal(e.defaultPrevented, true, 'not the browser’s menu');
    const menu = tree._menu;
    const el = menu.el;
    assert.equal(el.parentNode, doc.body, 'in the list’s document, over everything');
    assert.equal(el.getAttribute('role'), 'menu');
    assert.equal(selection.name, 'Platform2', 'the row’s entity selected first');
    assert.deepEqual(menu.labels, ['Frame', 'Rename…', 'Duplicate', 'Delete', '—', 'Select all Platform (6)']);
    assert.deepEqual([el.style.left, el.style.top], ['120px', '90px'], 'at the pointer');
    assert.equal(doc.activeElement, el);
    const down = press(doc, 'ArrowDown');
    assert.equal(down.stopped, true);
    assert.equal(el.children[1].style.background, 'rgba(74,222,128,0.18)', 'Frame active');
    press(doc, 'Escape');
    assert.equal(menu.isOpen, false);
    assert.equal(doc.body.contains(el), false, 'taken out of the document');
    assert.equal(doc.activeElement, tree._list);
    assert.equal(doc.listening('pointerdown') + doc.defaultView.listening('blur'), 0, 'its listeners went with it');
    assert.deepEqual(editorKeys(log), [], '↓ and Esc did not reach the editor (its Esc lets go of the selection)');
  } finally {
    done();
  }
});

test('a click elsewhere, the window losing the focus, the list scrolling or the selection moving closes the menu; a click in it does not', () => {
  const { doc, tree, editMode } = makeEditorPage();
  try {
    click(tree, 1);
    rightClick(tree, 2);
    dispatch(tree._menu.el.children[0], 'pointerdown');
    assert.equal(tree._menu.isOpen, true, 'a press on its caption');
    dispatch(doc.body, 'pointerdown');
    assert.equal(tree._menu.isOpen, false, 'a press elsewhere');
    rightClick(tree, 2);
    dispatch(doc.defaultView, 'blur', {}, false);
    assert.equal(tree._menu.isOpen, false, 'a click in the game’s frame (the window loses the focus)');
    rightClick(tree, 2);
    tree._list.scrollTop = 40;
    dispatch(tree._list, 'scroll', {}, false);
    assert.equal(tree._menu.isOpen, false, 'the list scrolled');
    rightClick(tree, 2);
    editMode.selectFromList(19, false);
    assert.equal(tree._menu.isOpen, false, 'the selection moved');
  } finally {
    done();
  }
});

test('the items act on the selection: Select all (the row’s first), Rename on one of several, Copy and Delete on all of them', () => {
  const { doc, tree, editMode, selection, log } = makeEditorPage();
  try {
    click(tree, 1);
    rightClick(tree, 4);
    pick(tree, 'Select all Platform (6)');
    assert.deepEqual(log.findLast(([what]) => what === 'select names'), [
      'select names',
      ['Platform3', 'Platform1', 'Platform2', 'Platform4', 'Platform5', 'Platform6'],
    ]);
    assert.equal(selection.name, 'Platform3', 'the inspector shows the row’s');
    assert.equal(doc.activeElement, tree._list, 'a pick: back to the list');

    rightClick(tree, 6);
    assert.equal(editMode.multi.count, 5, 'one of several: they stay selected');
    assert.deepEqual(tree._menu.labels, ['Frame', 'Rename…', 'Duplicate 6', 'Delete 6', '—', 'Select all Platform (6)']);
    pick(tree, 'Rename…');
    assert.equal(selection.name, 'Platform5', 'the row’s entity for the field');
    assert.equal(editMode.multi.count, 5, 'the others still selected');
    assert.equal(tree.renaming, true);
    assert.equal(tree._rename.value, 'Platform5');
    press(doc, 'Escape');

    editMode.copySelected = () => log.push(['copy', editMode.multi.selectedNames().length]);
    rightClick(tree, 2);
    pick(tree, 'Copy 6');
    assert.deepEqual(log.at(-1), ['copy', 6]);
    rightClick(tree, 2);
    pick(tree, 'Delete 6');
    assert.equal(log.filter(([what]) => what === 'delete').length, 1, 'the editor’s delete, once (it takes all six)');
    assert.deepEqual(editorKeys(log), []);
  } finally {
    done();
  }
});

test('a runtime row’s menu: Frame and Select all; the keyboard’s (ContextMenu, Shift+F10) is the selection’s, its first item active', () => {
  const { doc, tree, editMode, log } = makeEditorPage();
  try {
    editMode.selectFromList(19, false);
    tree._list.focus();
    const e = dispatch(tree._list, 'contextmenu', { button: 0 });
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(tree._menu.labels, ['Frame', '—', 'Select all Coin (1)']);
    assert.equal(tree._menu.el.children[1].style.background, 'rgba(74,222,128,0.18)', 'Frame active');
    log.length = 0;
    press(doc, 'Enter');
    assert.deepEqual(log, [['select', 19, true]], 'Frame: the view centered on it (no frameSelection)');
    const empty = dispatch(tree._spacer, 'contextmenu', { button: 2 });
    assert.equal(tree._menu.isOpen, false, 'a right click on no row: no menu');
    assert.equal(empty.defaultPrevented, false, 'the browser’s own there');
  } finally {
    done();
  }
});

test('the menu is kept in the viewport; an edit from it while the game plays enters edit mode first', () => {
  const { tree, editMode, log } = makeEditorPage({ editing: false });
  try {
    click(tree, 1);
    rightClick(tree, 2, 990, 690); // the fake menu measures 160 × 100
    assert.deepEqual([tree._menu.el.style.left, tree._menu.el.style.top], [`${1000 - 4 - 160}px`, `${690 - 100}px`]);
    pick(tree, 'Duplicate');
    assert.equal(editMode.active, true);
    assert.deepEqual(log.filter(([what]) => what === 'enter edit mode' || what === 'duplicate'), [['enter edit mode'], ['duplicate', 'Platform1']]);
  } finally {
    done();
  }
});

test('the page going (destroy) with the menu open takes it out of the editor page’s document, with its listeners (D9)', () => {
  const { doc, tree } = makeEditorPage();
  try {
    click(tree, 1);
    rightClick(tree, 2);
    const el = tree._menu.el;
    tree.destroy();
    assert.equal(doc.body.contains(el), false);
    assert.equal(doc.listening('pointerdown') + doc.defaultView.listening('blur') + doc.defaultView.listening('resize'), 0);
    assert.equal(tree._list.listening('contextmenu') + tree.el.listening('keydown'), 0);
  } finally {
    done();
  }
});
