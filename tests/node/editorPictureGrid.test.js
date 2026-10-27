// The picture grid of a sprite or animation param (VISUAL_EDITOR_PLAN.md ED-76, pictureGrid.js), as Unity's object
// picker: the field's thumbnail opens the scene's pictures with a search field, on the family of the name shown (the
// seed's pick when the param is empty), the value outlined. A click or Enter picks (not the value it has), Esc, a press
// outside, the focus leaving the page's part of it, the game page going (pagehide) close it. Only the rows in view are
// built, and their cells are reused as it scrolls (littleCity's atlas has 1,158 names).
import test from 'node:test';
import assert from 'node:assert/strict';

import { KIND_SPRITE, KIND_ANIMATION } from '../../src/core/spawnParams.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { AssetCatalog, assetPickerWidget } from '../../src/core/debug/editor/assetPicker.js';
import {
  familyOf,
  filterNames,
  moveCursor,
  cellsInView,
  togglePictureGrid,
  closePictureGrid,
  GRID_WIDTH,
  GRID_HEIGHT,
  MIN_GRID_HEIGHT,
} from '../../src/core/debug/editor/pictureGrid.js';

test('a name’s family: the name without the number it ends with', () => {
  assert.deepEqual(
    ['house_12', 'blue_car_7.5', 'civil1', 'barrel', '', '12', 'tree_04'].map(familyOf),
    ['house_', 'blue_car_', 'civil', '', '', '', 'tree_'],
  );
});

test('the search: every word, any case; an empty one keeps every name', () => {
  const names = ['house_01', 'House_Big', 'tree_01', 'blue_car_7.5'];
  assert.equal(filterNames(names, '  '), names);
  assert.deepEqual(filterNames(names, 'HOUSE'), ['house_01', 'House_Big']);
  assert.deepEqual(filterNames(names, 'car blue'), ['blue_car_7.5']);
  assert.deepEqual(filterNames(names, 'nope'), []);
});

test('the cursor: along and across the rows, by pages, to the last row; no cell, no cursor', () => {
  // 10 cells, 4 columns: rows 0-3, 4-7, 8-9.
  const m = (cursor, key, page) => moveCursor(cursor, key, 10, 4, page);
  assert.deepEqual([m(3, 'ArrowRight'), m(9, 'ArrowRight'), m(0, 'ArrowLeft'), m(5, 'ArrowLeft')], [4, 9, 0, 4]);
  assert.deepEqual([m(5, 'ArrowDown'), m(6, 'ArrowDown'), m(8, 'ArrowDown'), m(2, 'ArrowUp'), m(6, 'ArrowUp')], [9, 9, 8, 2, 2]);
  assert.deepEqual([m(1, 'PageDown', 2), m(9, 'PageUp', 2), m(5, 'PageUp', 2)], [9, 1, 1]);
  assert.deepEqual([m(-1, 'ArrowDown'), m(4, 'a'), moveCursor(3, 'ArrowRight', 0, 4)], [0, 4, -1]);
});

test('the cells built: the rows in view and one past each edge', () => {
  assert.deepEqual(cellsInView(0, 400, 5, 1158), [0, 30]);
  assert.deepEqual(cellsInView(900, 400, 5, 1158), [45, 80]);
  assert.deepEqual(cellsInView(0, 400, 5, 7), [0, 7]);
  assert.deepEqual(cellsInView(0, 400, 5, 0), [0, 0]);
});

// ---- the grid, over a fake DOM ----

/** A 2D context that records what is drawn. */
function recorder() {
  const calls = [];
  const ctx = { calls };
  for (const name of ['clearRect', 'drawImage', 'beginPath', 'arc', 'moveTo', 'lineTo', 'stroke']) {
    ctx[name] = (...args) => calls.push([name, ...args]);
  }
  return ctx;
}

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: '' };
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.title = '';
    this.type = '';
    this.id = '';
    this.textContent = '';
    this.width = 0;
    this.height = 0;
    this.scrollTop = 0;
    this.tabIndex = 0;
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this._ctx = null;
  }
  appendChild(node) {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  closest(selector) {
    assert.equal(selector, '[data-cell]');
    for (let n = this; n; n = n.parentNode) if (n.dataset && 'cell' in n.dataset) return n;
    return null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  /** Fire `type` here, bubbling up the parents; the event, to read what the handlers did with it. */
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...init,
    };
    for (let n = this; n && !event.stopped; n = n.parentNode) for (const fn of [...(n.listeners[type] || [])]) fn(event);
    if (type === 'click' && typeof this.onclick === 'function') this.onclick(event);
    return event;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  select() {}
  getContext() {
    return (this._ctx ||= recorder());
  }
  getBoundingClientRect() {
    return this.rect;
  }
  /** The grid's scroller is 400 × 380 inside its padding; the rest has no size. */
  get clientWidth() {
    return this.style.cssText.includes('overflow-y:auto') ? 400 : 0;
  }
  get clientHeight() {
    return this.style.cssText.includes('overflow-y:auto') ? 380 : 0;
  }
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
}

function makeDoc() {
  const doc = { activeElement: null, listeners: {}, focused: true };
  doc.createElement = (tag) => new El(doc, tag);
  doc.body = new El(doc, 'body');
  const winListeners = {};
  doc.defaultView = {
    innerWidth: 1366,
    innerHeight: 768,
    devicePixelRatio: 1,
    listeners: winListeners,
    addEventListener: (type, fn) => (winListeners[type] ||= []).push(fn),
    removeEventListener: (type, fn) => {
      winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn);
    },
  };
  doc.addEventListener = (type, fn) => (doc.listeners[type] ||= []).push(fn);
  doc.removeEventListener = (type, fn) => {
    doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn);
  };
  doc.hasFocus = () => doc.focused;
  return doc;
}

/** The game window's own listeners (pagehide): Node's global has none. */
function withPageListeners(fn) {
  const listeners = {};
  const had = [globalThis.addEventListener, globalThis.removeEventListener];
  globalThis.addEventListener = (type, f) => (listeners[type] ||= []).push(f);
  globalThis.removeEventListener = (type, f) => {
    listeners[type] = (listeners[type] || []).filter((g) => g !== f);
  };
  try {
    return fn(listeners);
  } finally {
    [globalThis.addEventListener, globalThis.removeEventListener] = had;
    if (had[0] === undefined) delete globalThis.addEventListener;
    if (had[1] === undefined) delete globalThis.removeEventListener;
  }
}

const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
/** A scene's sprites: two of the engine's, 63 houses, 18 trees, two cars. */
const NAMES = [
  'smoke',
  'blood',
  ...Array.from({ length: 63 }, (_, i) => `house_${pad(i + 1)}`),
  ...Array.from({ length: 18 }, (_, i) => `tree_${pad(i + 1)}`),
  'blue_car_7.5',
  'blue_car_22.5',
  '_empty',
];

function catalogOf(names, label = '') {
  const draws = [];
  return {
    draws,
    options: () => names.map((name) => [name, label]),
    drawThumbnail: (canvas, kind, name) => {
      draws.push(name);
      return true;
    },
  };
}

/** A grid by a thumbnail at the inspector's place (1150, 250), its document's body holding both. */
function opened(options = {}) {
  const doc = options.doc ?? makeDoc();
  const anchor = options.anchor ?? doc.createElement('button');
  if (!anchor.parentNode) doc.body.appendChild(anchor);
  anchor.rect = { left: 1150, top: 250, right: 1180, bottom: 280, width: 30, height: 30 };
  const commits = [];
  const catalog = options.catalog ?? catalogOf(NAMES);
  const grid = togglePictureGrid({
    anchor,
    kind: options.kind ?? KIND_SPRITE,
    catalog,
    value: options.value ?? '',
    shown: options.shown ?? '',
    none: options.none ?? false,
    commit: (name) => commits.push(name),
  });
  return { doc, anchor, catalog, commits, grid, cells: () => [...grid._cells.values()] };
}

test('opening on an empty house: its family, the seed’s pick under the cursor in view, only the rows in view built', () =>
  withPageListeners(() => {
    const { doc, grid, catalog, cells } = opened({ value: '', shown: 'house_37', none: true });
    try {
      assert.equal(grid._search.value, 'house_', 'the family of what is shown');
      assert.equal(doc.activeElement, grid._search, 'typing searches');
      assert.equal(grid._count.textContent, `63 of ${NAMES.length}`);
      assert.equal(grid._names[0], '', 'None first: the class picks');
      assert.equal(grid._names[grid._cursor], 'house_37');
      assert.equal(grid._columns, 5, '400 px less the padding: five cells of 76');
      const [first, end] = cellsInView(grid._scrollTop, 380, 5, 64);
      assert.ok(first > 0 && grid._scrollTop > 0, 'scrolled to the pick');
      assert.equal(cells().length, end - first, 'the rows in view, one past each edge');
      assert.deepEqual(catalog.draws.slice().sort(), cells().map((c) => c.name).sort(), 'each cell drew its picture once');
      const pick = cells().find((c) => c.name === 'house_37');
      assert.equal(pick.el.style.borderColor, '#60a5fa', 'the cursor’s outline');
      assert.equal(pick.el.style.borderStyle, 'solid');
      assert.match(grid._foot.textContent, /^house_37 · shown now/);
      assert.equal(grid.el.style.left, `${1366 - GRID_WIDTH - 8}px`, 'its left edge kept inside the window');
      assert.equal(grid.el.style.top, '284px', 'under the thumbnail');
    } finally {
      grid.close();
    }
  }));

test('placed under its thumbnail, shorter to stay there; above it when the room is above; never off the window', () =>
  withPageListeners(() => {
    const at = (top, bottom, innerHeight = 768) => {
      const doc = makeDoc();
      doc.defaultView.innerHeight = innerHeight;
      const anchor = doc.createElement('button');
      doc.body.appendChild(anchor);
      const { grid } = opened({ doc, anchor });
      anchor.rect = { left: 1150, top, right: 1180, bottom, width: 30, height: bottom - top };
      grid._place();
      const placed = [grid.el.style.top, grid.el.style.height];
      grid.close();
      return placed;
    };
    assert.deepEqual(at(250, 280), ['284px', `${GRID_HEIGHT}px`], 'room below');
    assert.deepEqual(at(275, 305), ['309px', '451px'], 'shorter, still under it (it covered its thumbnail)');
    assert.deepEqual(at(670, 700), [`${670 - 4 - GRID_HEIGHT}px`, `${GRID_HEIGHT}px`], 'low on the screen: above it');
    assert.deepEqual(at(100, 130, 300), ['32px', `${MIN_GRID_HEIGHT}px`], 'a small window: as short as it goes, inside it');
  }));

test('typing filters, the cursor on the first match past None; Enter picks it and closes, listeners gone', () =>
  withPageListeners((page) => {
    const { doc, grid, commits } = opened({ value: '', shown: 'house_37', none: true });
    grid._search.value = 'tree';
    grid._search.dispatch('input');
    assert.equal(grid._count.textContent, `18 of ${NAMES.length}`);
    assert.equal(grid._names[grid._cursor], 'tree_01');
    assert.equal(grid._scrollTop, 0);
    const enter = grid._search.dispatch('keydown', { key: 'Enter' });
    assert.ok(enter.defaultPrevented);
    assert.deepEqual(commits, ['tree_01']);
    assert.equal(grid.open, false);
    assert.equal(doc.body.children.some((c) => 'pictureGrid' in c.dataset), false, 'out of the page');
    assert.deepEqual([doc.listeners.pointerdown, doc.defaultView.listeners.resize, page.pagehide], [[], [], []]);

    const none = opened({ value: '', none: true });
    none.grid._search.value = 'nothing like it';
    none.grid._search.dispatch('input');
    assert.deepEqual([none.grid._names, none.grid._cursor], [[''], 0], 'no match: None alone');
    assert.match(none.grid._foot.textContent, /^None: the class picks the sprite/);
    none.grid.close();
  }));

test('the arrows move the cursor (the field keeps the focus); Esc closes with no pick', () =>
  withPageListeners(() => {
    const { grid, commits, cells } = opened({ value: 'house_07' });
    assert.equal(grid._names[grid._cursor], 'house_07', 'on the value');
    assert.equal(cells().find((c) => c.name === 'house_07').el.style.borderColor, '#60a5fa');
    const right = grid._search.dispatch('keydown', { key: 'ArrowRight' });
    assert.ok(right.defaultPrevented && right.stopped, 'not the caret’s, not the editor’s');
    assert.equal(grid._names[grid._cursor], 'house_08');
    grid._search.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(grid._names[grid._cursor], 'house_13');
    assert.equal(cells().find((c) => c.name === 'house_07').el.style.borderColor, '#34d399', 'the value keeps its outline');
    assert.equal(grid._search.dispatch('keydown', { key: 'a' }).defaultPrevented, false, 'a letter is the search’s');
    const esc = grid._search.dispatch('keydown', { key: 'Escape' });
    assert.ok(esc.defaultPrevented && esc.stopped);
    assert.deepEqual([commits, grid.open], [[], false]);
  }));

test('a click picks a picture, or None; the value it has already is no change', () =>
  withPageListeners(() => {
    const a = opened({ value: 'house_07' });
    a.cells().find((c) => c.name === 'house_09').canvas.dispatch('click');
    assert.deepEqual([a.commits, a.grid.open], [['house_09'], false]);

    const b = opened({ value: 'house_07', none: true });
    b.grid._search.value = '';
    b.grid._search.dispatch('input');
    const none = b.cells().find((c) => c.name === '');
    assert.equal(none.label.textContent, 'None');
    assert.ok(none.canvas._ctx.calls.some((call) => call[0] === 'arc'), 'a crossed circle');
    none.el.dispatch('click');
    assert.deepEqual(b.commits, [''], 'empty: the class picks');

    const c = opened({ value: '', none: true });
    assert.equal(c.grid._cursor, 0, 'no value and nothing shown: on None');
    c.cells().find((cell) => cell.name === '').el.dispatch('click');
    assert.deepEqual([c.commits, c.grid.open], [[], false]);
  }));

test('a press outside closes it, not one on its thumbnail or in it; the thumbnail toggles it; one grid at a time', () =>
  withPageListeners(() => {
    const { doc, anchor, grid } = opened({ value: 'house_07' });
    const press = (target) => doc.listeners.pointerdown.forEach((fn) => fn({ target }));
    press(anchor);
    press(grid._foot);
    assert.equal(grid.open, true);
    press(doc.body);
    assert.equal(grid.open, false);

    const again = opened({ doc, anchor, value: 'house_07' });
    assert.equal(opened({ doc, anchor }).grid, null, 'its thumbnail again: closed');
    assert.equal(again.grid.open, false);

    const first = opened({ doc, anchor, value: 'house_07' });
    const second = opened({ doc, value: 'tree_02' });
    assert.deepEqual([first.grid.open, second.grid.open], [false, true], 'another field’s grid replaces it');
    closePictureGrid();
    assert.equal(second.grid.open, false);
  }));

test('scrolling builds the rows coming into view from the cells leaving it', () =>
  withPageListeners(() => {
    const { grid, catalog, cells } = opened({ value: '' });
    assert.equal(grid._names.length, NAMES.length, 'nothing to open on: every name');
    const built = grid._spacer.children.length;
    for (let top = 0; top <= 18 * 90; top += 45) {
      grid._scroller.scrollTop = top;
      grid._scroller.dispatch('scroll');
    }
    assert.ok(grid._spacer.children.length <= built + 5, `${grid._spacer.children.length} cells for ${NAMES.length} names`);
    assert.ok(cells().some((c) => c.index === NAMES.length - 1), 'down to the last');
    const shown = cells();
    for (const cell of shown) {
      const x = 12 + (cell.index % 5) * 76;
      const y = ((cell.index / 5) | 0) * 90;
      assert.equal(cell.el.style.transform, `translate(${x}px,${y}px)`);
      assert.equal(cell.el.style.display, '');
    }
    assert.ok(catalog.draws.length < NAMES.length * 2, 'a cell draws when it takes another name only');
    grid.close();
  }));

test('the focus leaving for this page (or the game’s frame) closes it; another window taking it does not', async () => {
  const listeners = {};
  const had = [globalThis.addEventListener, globalThis.removeEventListener];
  globalThis.addEventListener = (type, f) => (listeners[type] ||= []).push(f);
  globalThis.removeEventListener = (type, f) => {
    listeners[type] = (listeners[type] || []).filter((g) => g !== f);
  };
  try {
    const { doc, grid } = opened({ value: 'house_07' });
    doc.focused = false;
    doc.activeElement = doc.body;
    grid.el.dispatch('focusout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(grid.open, true, 'the window lost the focus: kept');
    doc.focused = true;
    grid.el.dispatch('focusout');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(grid.open, false, 'the focus went elsewhere in the page');

    const game = opened({ doc, value: 'house_07' });
    listeners.pagehide.forEach((fn) => fn());
    assert.equal(game.grid.open, false, 'the game page went: nothing of it stays in this page');
    assert.deepEqual(listeners.pagehide, []);
  } finally {
    [globalThis.addEventListener, globalThis.removeEventListener] = had;
    if (had[0] === undefined) delete globalThis.addEventListener;
    if (had[1] === undefined) delete globalThis.removeEventListener;
  }
});

test('an animation: its sheets under the grid', () =>
  withPageListeners(() => {
    const { grid } = opened({ kind: KIND_ANIMATION, value: 'walk_down', catalog: catalogOf(['walk_down', 'walk_left'], 'civil1, civil2') });
    assert.equal(grid._search.value, '', 'walk_down has no number: every animation');
    assert.match(grid._foot.textContent, /^walk_down · civil1, civil2 · the value/);
    grid.close();
  }));

test('the field: its thumbnail opens the grid on its value, or on what the entity shows; again, closes it', () =>
  withPageListeners(() => {
    const doc = makeDoc();
    globalThis.document = doc;
    SpriteSheetRegistry.clearForSceneUnload();
    SpriteSheetRegistry.register('bigAtlas', {
      frames: {},
      animations: Object.fromEntries(NAMES.map((name) => [name, [name]])),
      meta: {},
    });
    try {
      const catalog = new AssetCatalog(() => null);
      const commits = [];
      const field = assetPickerWidget(KIND_SPRITE, '', (v) => commits.push(v), catalog, { none: true, shown: () => 'house_02' });
      doc.body.appendChild(field);
      const pick = [...field.all()].find((el) => 'pictures' in el.dataset);
      pick.dispatch('click');
      const grid = [...doc.body.children].find((el) => 'pictureGrid' in el.dataset);
      assert.ok(grid, 'open');
      const input = [...grid.all()].find((el) => el.tagName === 'INPUT');
      assert.equal(input.value, 'house_', 'on what the entity shows');
      pick.dispatch('click');
      assert.equal(doc.body.children.some((el) => 'pictureGrid' in el.dataset), false, 'its thumbnail again: closed');

      // One datalist for every sprite field, its options made once, in the field that has the focus.
      const other = assetPickerWidget(KIND_SPRITE, 'tree_01', () => {}, catalog);
      doc.body.appendChild(other);
      const listIn = (box) => [...box.all()].find((el) => el.tagName === 'DATALIST');
      assert.deepEqual([listIn(field), listIn(other)], [undefined, undefined], 'built: no list in the page');
      [...field.all()].find((el) => el.tagName === 'INPUT').onfocus();
      const list = listIn(field);
      [...other.all()].find((el) => el.tagName === 'INPUT').onfocus();
      assert.deepEqual([listIn(field), listIn(other)], [undefined, list], 'the focus takes it along');
      assert.equal(list.children.length, NAMES.length, 'every sprite the scene loaded, the engine’s last');
      assert.equal([...other.all()].find((el) => el.tagName === 'INPUT').getAttribute('list'), list.id);
      assert.equal([...field.all()].find((el) => el.tagName === 'INPUT').getAttribute('list'), list.id, 'both name it');
    } finally {
      closePictureGrid();
      SpriteSheetRegistry.clearForSceneUnload();
      delete globalThis.document;
    }
  }));
