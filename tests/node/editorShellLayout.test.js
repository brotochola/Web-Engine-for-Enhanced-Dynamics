// The editor page's docks (VISUAL_EDITOR_PLAN.md ED-50, ED-51): sizes a handle's drag changes, folds, Ctrl+1, 2, 3,
// the bottom dock's Console pane, this viewer's layout kept in localStorage (a storage that throws keeps the defaults),
// and the narrow layouts (below 1280 px the side docks narrow, below 1100 px they open over the view). The layout runs
// here on stand-in elements; tests/bench/editorLayoutSmoke.mjs runs the real page in Chromium.
//
// And the status bar under the view (ED-52): what it says, that it writes nothing while nothing changes, the debug
// tools' hint it shows, and the indicator and the overlay's lines it takes the place of.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DockLayout,
  LAYOUT_DEFAULTS,
  LAYOUT_KEY,
  FLAG_KEYS,
  SIZE_KEYS,
  SIZE_LIMITS,
  dockKeyOf,
  narrowFactor,
  numberText,
  paneHeight,
  paneSizeFor,
  readLayout,
  shareText,
  sideSizeFor,
  sideWidth,
  splitFor,
  writeLayout,
} from '../../src/core/debug/editor/shell/editorLayout.js';
import { StatusBar } from '../../src/core/debug/editor/statusBar.js';
import { ToolManager } from '../../src/core/debug/tools/toolManager.js';
import { DebugCanvas } from '../../src/core/debug/rendering/debugCanvas.js';

// ---- stand-ins for the page's elements ----

class ClassList {
  constructor() {
    this.names = new Set();
  }
  add(name) {
    this.names.add(name);
  }
  remove(name) {
    this.names.delete(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : !!force;
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name) {
    return this.names.has(name);
  }
}

class Style {
  constructor() {
    this.props = new Map();
    this.writes = [];
  }
  setProperty(name, value) {
    this.props.set(name, value);
    this.writes.push([name, value]);
  }
}

class Element {
  constructor({ dataset = {}, rect = { width: 0, height: 0 }, queries = {} } = {}) {
    this.dataset = dataset;
    this.classList = new ClassList();
    this.style = new Style();
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.rect = rect;
    this.rectReads = 0;
    this.clicks = 0;
    this.captured = new Set();
    this.queries = queries;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, init = {}) {
    const e = {
      type,
      currentTarget: this,
      target: this,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {},
      ...init,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(e);
    return e;
  }
  getBoundingClientRect() {
    this.rectReads++;
    return { ...this.rect };
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  click() {
    this.clicks++;
    this.dispatch('click');
  }
  querySelector(selector) {
    return this.queries[selector] ?? null;
  }
}

function memoryStorage(initial = null) {
  const data = new Map(initial === null ? [] : [[LAYOUT_KEY, initial]]);
  return {
    data,
    sets: 0,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      this.sets++;
      data.set(key, String(value));
    },
  };
}

const throwingStorage = () => ({
  getItem() {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem() {
    throw new DOMException('full', 'QuotaExceededError');
  },
});

function makeLayout({ width = 1366, height = 768, storage = memoryStorage(), debugQueries = {} } = {}) {
  const named = (key, names) => names.map((name) => new Element({ dataset: { [key]: name } }));
  const el = {
    body: new Element(),
    left: new Element({ rect: { width: 250, height: 700 } }),
    right: new Element({ rect: { width: 320, height: 700 } }),
    bottom: new Element({ rect: { width: width, height: 240 } }),
    column: new Element({ rect: { width: 315, height: 700 } }),
    assets: new Element({ rect: { width: 315, height: 280 } }),
    handles: named('handle', ['left', 'right', 'bottom', 'split']),
    folds: named('fold', ['left', 'right', 'bottom', 'inspector', 'assets']),
    toggles: named('toggle', ['left', 'right', 'bottom']),
    consoleTab: new Element(),
    consolePane: new Element(),
    debugSlot: new Element({ queries: debugQueries }),
  };
  const win = { innerWidth: width, innerHeight: height };
  const layout = new DockLayout(el, { win, storage }).start();
  const by = (list, key) => Object.fromEntries(list.map((e) => [e.dataset[key], e]));
  return { layout, el, win, storage, handle: by(el.handles, 'handle'), fold: by(el.folds, 'fold'), toggle: by(el.toggles, 'toggle') };
}

/** A drag on a handle: press, moves by (dx, dy) each, release. */
function drag(handle, moves, { pointerId = 1, x = 500, y = 400 } = {}) {
  handle.dispatch('pointerdown', { button: 0, pointerId, clientX: x, clientY: y });
  for (const [dx, dy] of moves) handle.dispatch('pointermove', { pointerId, clientX: x + dx, clientY: y + dy });
  handle.dispatch('pointerup', { pointerId, clientX: x, clientY: y });
}

const key = (k, extra = {}) => ({ key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...extra });
const ctrl = (digit, extra = {}) => {
  const e = key(String(digit), { code: `Digit${digit}`, ctrlKey: true, ...extra });
  e.prevented = false;
  e.preventDefault = () => {
    e.prevented = true;
  };
  return e;
};

// ---- sizes ----

test('a side dock shows its size from 1280 px up, within its bounds and a share of the window', () => {
  assert.equal(sideWidth('left', 250, 1920), 250);
  assert.equal(sideWidth('right', 320, 1366), 320);
  assert.equal(sideWidth('left', 50, 1920), SIZE_LIMITS.left[0], 'the minimum');
  assert.equal(sideWidth('left', 640, 1366), 0.32 * 1366, 'a third of the window at most');
  assert.equal(sideWidth('right', 760, 1366), 0.4 * 1366);
  assert.equal(sideWidth('right', 320, 300), 0.85 * 300, 'over the view: 85 % of the window at most');
  assert.equal(sideWidth('right', 320, 200), SIZE_LIMITS.right[0], 'a window too small: the minimum wins, as CSS clamp');
});

test('below 1280 px the side docks give up what the window loses, down to 70 % at 1100 px', () => {
  assert.equal(narrowFactor(1280), 1);
  assert.equal(narrowFactor(1920), 1);
  assert.ok(Math.abs(narrowFactor(1100) - 0.7) < 1e-12);
  assert.ok(Math.abs(narrowFactor(1190) - 0.85) < 1e-12);
  assert.ok(Math.abs(sideWidth('left', 250, 1100) - 175) < 1e-9);
  assert.ok(Math.abs(sideWidth('right', 320, 1100) - 224) < 1e-9);
  // The view keeps about the width it had at 1280 px.
  const view = (w) => w - sideWidth('left', 250, w) - sideWidth('right', 320, w);
  assert.ok(Math.abs(view(1100) - view(1280)) < 15, `${view(1100)} vs ${view(1280)}`);
  // Below 1100 px they are over the view, at their size again (up to 85 % of the window).
  assert.equal(narrowFactor(1099), 1);
  assert.equal(sideWidth('left', 250, 800), 250);
  assert.equal(sideWidth('right', 640, 600), 0.85 * 600);
});

test('a drag keeps the size that shows the width it reached, whatever the window', () => {
  for (const viewport of [1920, 1366, 1279, 1190, 1100, 1099, 800]) {
    for (const side of ['left', 'right']) {
      for (const width of [100, 180, 260, 333, 420, 900]) {
        const size = sideSizeFor(side, width, viewport);
        assert.equal(size, Math.round(size), 'whole px');
        assert.ok(size >= SIZE_LIMITS[side][0] && size <= SIZE_LIMITS[side][1]);
        const [min, sizeMax] = SIZE_LIMITS[side];
        const max = Math.min((viewport < 1100 ? 0.85 : side === 'left' ? 0.32 : 0.4) * viewport, sizeMax * narrowFactor(viewport));
        const wanted = Math.max(min, Math.min(width, max));
        assert.ok(Math.abs(sideWidth(side, size, viewport) - wanted) < 1, `${side} ${width} px at ${viewport}: ${sideWidth(side, size, viewport)}`);
      }
    }
  }
});

test('the bottom pane: at least 96 px, and it leaves 200 px of the window', () => {
  assert.equal(paneHeight(240, 768), 240);
  assert.equal(paneHeight(900, 768), 568);
  assert.equal(paneHeight(20, 768), 96);
  assert.equal(paneHeight(240, 250), 96, 'a short window: the minimum');
  assert.equal(paneSizeFor(340.4, 768), 340);
  assert.equal(paneSizeFor(5000, 1080), 880);
});

test('the split is the Inspector’s share of the column, from the Assets’ height', () => {
  assert.equal(splitFor(280, 700), 0.6);
  assert.equal(splitFor(0, 700), 0.85, 'the Assets keep some room');
  assert.equal(splitFor(700, 700), 0.15);
  assert.equal(splitFor(100, 0), LAYOUT_DEFAULTS.split, 'no column measured');
});

// ---- this viewer's layout ----

test('the layout kept in storage: the defaults, with what it holds over them where valid and in bounds', () => {
  const defaults = readLayout(null);
  assert.deepEqual(defaults, { ...LAYOUT_DEFAULTS });
  assert.notEqual(defaults, LAYOUT_DEFAULTS, 'a layout of its own, not the frozen defaults');
  for (const text of ['not json', '[1,2]', '42', 'null', '"left"']) assert.deepEqual(readLayout(memoryStorage(text)), { ...LAYOUT_DEFAULTS }, text);
  const kept = readLayout(
    memoryStorage(JSON.stringify({ left: '300', right: 99999, bottom: 333.6, split: 2, leftFolded: 'yes', consoleOpen: true, extra: 1 })),
  );
  assert.equal(kept.left, LAYOUT_DEFAULTS.left, 'a string is not a size');
  assert.equal(kept.right, SIZE_LIMITS.right[1]);
  assert.equal(kept.bottom, 334);
  assert.equal(kept.split, SIZE_LIMITS.split[1]);
  assert.equal(kept.leftFolded, false, 'not a boolean');
  assert.equal(kept.consoleOpen, true);
  assert.equal('extra' in kept, false);
});

test('a storage that throws (blocked, full) leaves the defaults and keeps nothing, without throwing', () => {
  assert.deepEqual(readLayout(throwingStorage()), { ...LAYOUT_DEFAULTS });
  assert.equal(writeLayout(throwingStorage(), { ...LAYOUT_DEFAULTS }), false);
  assert.equal(writeLayout(null, { ...LAYOUT_DEFAULTS }), false);
});

test('what is kept is the sizes and folds only, and reads back the same', () => {
  const storage = memoryStorage();
  const layout = { ...LAYOUT_DEFAULTS, left: 301, split: 0.7, rightFolded: true, consoleOpen: true, notMine: 'x' };
  assert.equal(writeLayout(storage, layout), true);
  const saved = JSON.parse(storage.getItem(LAYOUT_KEY));
  assert.deepEqual(Object.keys(saved).sort(), [...SIZE_KEYS, ...FLAG_KEYS].sort());
  const { notMine, ...expected } = layout;
  assert.deepEqual(readLayout(storage), expected);
});

test('a size is written from a table of strings: the same value, the same string', () => {
  assert.equal(numberText(250), '250');
  assert.equal(numberText(250), numberText(250));
  assert.equal(numberText(-3), '-3');
  assert.equal(numberText(1.5), '1.5');
  assert.equal(shareText(400), '0.400');
  assert.equal(shareText(400), shareText(400));
  assert.equal(shareText(1000), '1.000');
});

test('Ctrl+1, Ctrl+2, Ctrl+3 (Cmd on a Mac) by the key or the physical key; nothing with Shift or Alt', () => {
  assert.equal(dockKeyOf(key('1', { ctrlKey: true })), 1);
  assert.equal(dockKeyOf(key('2', { metaKey: true })), 2);
  assert.equal(dockKeyOf(key('"', { code: 'Digit3', ctrlKey: true })), 3, 'a layout whose 3 key types another character');
  assert.equal(dockKeyOf(key('2', { code: 'Numpad2', ctrlKey: true })), 2);
  assert.equal(dockKeyOf(key('1')), 0);
  assert.equal(dockKeyOf(key('!', { code: 'Digit1', ctrlKey: true, shiftKey: true })), 0);
  assert.equal(dockKeyOf(key('3', { code: 'Digit3', ctrlKey: true, altKey: true })), 0);
  assert.equal(dockKeyOf(key('4', { code: 'Digit4', ctrlKey: true })), 0);
});

// ---- the layout on the page ----

test('the kept layout is shown at start: each size on the element that reads it, the folds as body classes', () => {
  const storage = memoryStorage(JSON.stringify({ left: 300, right: 400, bottom: 333, split: 0.7, rightFolded: true, assetsFolded: true }));
  const { el, toggle, fold } = makeLayout({ storage });
  assert.equal(el.body.style.props.get('--weed-left'), '300');
  assert.equal(el.left.style.props.get('--weed-left'), '300', 'over the view the dock reads it itself');
  assert.equal(el.body.style.props.get('--weed-right'), '400');
  assert.equal(el.bottom.style.props.get('--weed-bottom'), '333');
  assert.equal(el.assets.style.props.get('--weed-assets'), '0.300');
  assert.equal(el.body.classList.contains('weed-fold-right'), true);
  assert.equal(el.body.classList.contains('weed-fold-left'), false);
  assert.equal(el.body.classList.contains('weed-fold-assets'), true);
  assert.deepEqual(['left', 'right', 'bottom'].map((t) => toggle[t].getAttribute('aria-pressed')), ['true', 'false', 'true']);
  assert.equal(fold.assets.getAttribute('aria-expanded'), 'false');
  assert.equal(fold.inspector.getAttribute('aria-expanded'), 'true');
  assert.equal(el.consolePane.hidden, true);
  assert.equal(storage.sets, 0, 'showing writes nothing back');
});

test('a drag writes one property per move that changes the size, reads the layout only at the press, and keeps it at the release', () => {
  const { el, handle, storage } = makeLayout();
  const reads = () => el.left.rectReads + el.right.rectReads + el.bottom.rectReads + el.assets.rectReads + el.column.rectReads;
  drag(handle.left, [[10, 0], [10.2, 3], [35, 0], [60, 0]]);
  // 260, 260 (unchanged: no write), 285, 310; the release writes both places once.
  assert.deepEqual(el.body.style.writes.slice(-4), [['--weed-left', '260'], ['--weed-left', '285'], ['--weed-left', '310'], ['--weed-left', '310']]);
  assert.deepEqual(el.left.style.writes.at(-1), ['--weed-left', '310']);
  assert.equal(reads(), 1, 'one layout read, at the press');
  assert.equal(storage.sets, 1, 'kept once, at the release');
  assert.equal(JSON.parse(storage.getItem(LAYOUT_KEY)).left, 310);
  assert.equal(el.body.classList.contains('weed-resizing'), false, 'the drag is over');
  assert.equal(handle.left.captured.size, 0, 'the pointer is let go');
});

test('each handle sizes its own: the right dock leftward, the bottom pane upward, the split downward', () => {
  const { layout, el, handle } = makeLayout();
  drag(handle.right, [[-50, 0]]);
  assert.equal(layout.layout.right, 370);
  assert.equal(el.body.style.props.get('--weed-right'), '370');
  drag(handle.bottom, [[0, -100]]);
  assert.equal(layout.layout.bottom, 340);
  assert.equal(el.bottom.style.props.get('--weed-bottom'), '340');
  drag(handle.split, [[0, 70]]);
  assert.equal(layout.layout.split, 0.7, 'the Assets 280 → 210 px of 700');
  assert.equal(el.assets.style.props.get('--weed-assets'), '0.300');
});

test('a drag stops at the bounds, ignores another pointer, and a double click puts the default back', () => {
  const { layout, el, handle } = makeLayout();
  drag(handle.left, [[5000, 0]]);
  assert.equal(layout.layout.left, Math.round(0.32 * 1366), 'a third of the window');
  handle.right.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 900, clientY: 300 });
  handle.right.dispatch('pointermove', { pointerId: 8, clientX: 700, clientY: 300 });
  handle.right.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 900, clientY: 300 });
  handle.right.dispatch('pointerup', { pointerId: 9 });
  assert.equal(layout.layout.right, LAYOUT_DEFAULTS.right, 'other pointers do nothing');
  handle.right.dispatch('pointerup', { pointerId: 7 });
  handle.left.dispatch('dblclick');
  assert.equal(layout.layout.left, LAYOUT_DEFAULTS.left);
  assert.equal(el.body.style.props.get('--weed-left'), String(LAYOUT_DEFAULTS.left));
  // A secondary button does not start a drag.
  handle.left.dispatch('pointerdown', { button: 2, pointerId: 3, clientX: 0, clientY: 0 });
  handle.left.dispatch('pointermove', { pointerId: 3, clientX: 100, clientY: 0 });
  assert.equal(layout.layout.left, LAYOUT_DEFAULTS.left);
});

test('with a storage that throws, the layout starts with the defaults and its drags and folds still work', () => {
  const { layout, el, handle, fold } = makeLayout({ storage: throwingStorage() });
  assert.deepEqual(layout.layout, { ...LAYOUT_DEFAULTS });
  drag(handle.left, [[40, 0]]);
  assert.equal(el.body.style.props.get('--weed-left'), '290');
  fold.left.click();
  assert.equal(el.body.classList.contains('weed-fold-left'), true);
});

test('fold buttons and Ctrl+1, 2, 3 fold and unfold the docks; the bar’s buttons show it; a held key folds once', () => {
  const { layout, el, toggle, fold, storage } = makeLayout();
  fold.left.click();
  assert.equal(el.body.classList.contains('weed-fold-left'), true);
  assert.equal(toggle.left.getAttribute('aria-pressed'), 'false');
  toggle.left.click();
  assert.equal(el.body.classList.contains('weed-fold-left'), false);
  const e2 = ctrl(2);
  assert.equal(layout.onKey(e2), true);
  assert.equal(e2.prevented, true, 'the browser does not switch tabs');
  assert.equal(el.body.classList.contains('weed-fold-right'), true);
  layout.onKey(ctrl(3));
  assert.equal(el.body.classList.contains('weed-fold-bottom'), true);
  const held = ctrl(3, { repeat: true });
  assert.equal(layout.onKey(held), true);
  assert.equal(held.prevented, true);
  assert.equal(el.body.classList.contains('weed-fold-bottom'), true, 'a repeat folds nothing');
  assert.equal(layout.onKey(ctrl(4)), false);
  assert.equal(layout.onKey(key('2')), false);
  assert.deepEqual(JSON.parse(storage.getItem(LAYOUT_KEY)).rightFolded, true, 'kept');
  // A section's title: folded, the other section takes the column.
  fold.assets.click();
  assert.equal(el.body.classList.contains('weed-fold-assets'), true);
  assert.equal(fold.assets.getAttribute('aria-expanded'), 'false');
  // The game page passes its keys on by digit (EditorHost.dockKey).
  assert.equal(layout.toggleDock(1), true);
  assert.equal(el.body.classList.contains('weed-fold-left'), true);
  assert.equal(layout.toggleDock(7), false);
});

test('the Console opens a pane over the strip; it closes a debug panel that is open, and a debug panel closes it', () => {
  const activeTab = new Element();
  const queries = { '.debug-ui-tab.active': activeTab };
  const { layout, el, storage } = makeLayout({ debugQueries: queries });
  el.consoleTab.click();
  assert.equal(layout.layout.consoleOpen, true);
  assert.equal(el.consolePane.hidden, false);
  assert.equal(el.body.classList.contains('weed-console-open'), true);
  assert.equal(el.consoleTab.getAttribute('aria-pressed'), 'true');
  assert.equal(activeTab.clicks, 1, 'the open debug panel’s tab, clicked: the debug bar closes it');
  assert.equal(JSON.parse(storage.getItem(LAYOUT_KEY)).consoleOpen, true);
  // A debug tab clicked while the Console is open: once its panel is open, the Console closes.
  queries['.debug-ui-panel.open'] = new Element();
  el.debugSlot.dispatch('click');
  assert.equal(layout.layout.consoleOpen, false);
  assert.equal(el.consolePane.hidden, true);
  // Opening the Console unfolds a folded bottom dock.
  layout.setFolded('bottom', true);
  delete queries['.debug-ui-tab.active'];
  el.consoleTab.click();
  assert.equal(layout.layout.bottomFolded, false);
});

test('below 1100 px the side docks open over the view from the bar and Ctrl+1, 2; their fold button closes them', () => {
  const { layout, el, win, toggle, fold, handle } = makeLayout({ width: 900, height: 600 });
  assert.equal(layout.overlay, true);
  assert.deepEqual(['left', 'right', 'bottom'].map((t) => toggle[t].getAttribute('aria-pressed')), ['false', 'false', 'true']);
  toggle.right.click();
  assert.equal(el.body.classList.contains('weed-open-right'), true);
  assert.equal(el.body.classList.contains('weed-fold-right'), false, 'not a fold');
  assert.equal(toggle.right.getAttribute('aria-pressed'), 'true');
  layout.onKey(ctrl(1));
  assert.equal(el.body.classList.contains('weed-open-left'), true);
  fold.left.click();
  assert.equal(el.body.classList.contains('weed-open-left'), false);
  assert.equal(layout.layout.leftFolded, false, 'closing is not folding');
  // A drag over the view writes the dock's own width; the release, both places.
  const bodyWrites = el.body.style.writes.length;
  el.right.rect = { width: 320, height: 500 };
  handle.right.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 580, clientY: 200 });
  handle.right.dispatch('pointermove', { pointerId: 1, clientX: 530, clientY: 200 });
  assert.deepEqual(el.right.style.writes.at(-1), ['--weed-right', '370']);
  assert.equal(el.body.style.writes.length, bodyWrites);
  handle.right.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(el.body.style.writes.at(-1), ['--weed-right', '370']);
  // Wide again: the bar's buttons show the folds.
  win.innerWidth = 1400;
  layout.apply();
  assert.equal(toggle.left.getAttribute('aria-pressed'), 'true');
});

test('in the narrow band a drag keeps the size that shows the reached width at this window', () => {
  const { layout, el, handle } = makeLayout({ width: 1100 });
  el.left.rect = { width: 175, height: 700 };
  drag(handle.left, [[35, 0]]);
  assert.equal(layout.layout.left, 300, '210 px shown at 70 %');
  assert.ok(Math.abs(sideWidth('left', layout.layout.left, 1100) - 210) < 1e-9);
});

// ---- the status bar (ED-52) ----

/** A node of the status bar: what is written into it, counted. */
class Node {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.classList = new ClassList();
    this.className = '';
    this._text = '';
    this._title = '';
    this.writes = 0;
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = value;
    this.writes++;
  }
  get title() {
    return this._title;
  }
  set title(value) {
    this._title = value;
    this.writes++;
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

const fakeDoc = { createElement: () => new Node() };

function statusFor() {
  const selection = { index: -1, name: null, className: '' };
  const handles = { dragging: false };
  const joints = { dragging: false };
  const editMode = {
    active: true,
    playing: false,
    status: '',
    statusIsError: false,
    placing: null,
    brush: { className: null },
    selection,
    multi: { count: 0 },
    move: { snap: 1, dragging: false },
    handles,
    tools: [handles, {}, joints],
  };
  const tools = {
    kind: 0,
    bulkSpawnEnabled: false,
    activeToolKind() {
      return this.kind;
    },
    toolHintArg() {
      return this.kind === 0 ? null : 'Ball';
    },
    toolHint() {
      return 'Painting: Ball (click & drag to spawn)';
    },
  };
  const debugUI = { scene: {}, editMode, tools };
  const mouse = { isPresent: false, x: 0, y: 0 };
  const camera = { zoom: 1.25 };
  const bar = new StatusBar(debugUI, { doc: fakeDoc, mouse, camera });
  const parts = Object.fromEntries(bar.el.children.map((span) => [span.dataset.status, span]));
  const writes = () => bar.el.children.reduce((sum, span) => sum + span.writes, 0);
  return { bar, debugUI, editMode, selection, handles, joints, tools, mouse, camera, parts, writes };
}

test('the status bar writes each part when it changes, and nothing at all while nothing does', () => {
  const s = statusFor();
  assert.deepEqual(Object.keys(s.parts), ['mode', 'hint', 'pointer', 'zoom', 'selection', 'grid']);
  s.bar.update();
  assert.equal(s.parts.mode.textContent, 'EDIT');
  assert.equal(s.parts.mode.dataset.mode, 'edit');
  assert.match(s.parts.hint.textContent, /^Click selects/);
  assert.equal(s.parts.pointer.textContent, 'x –\u2002y –');
  assert.equal(s.parts.zoom.textContent, '125%');
  assert.equal(s.parts.selection.textContent, 'Nothing selected');
  assert.equal(s.parts.grid.textContent, 'No grid');
  const after = s.writes();
  for (let k = 0; k < 5; k++) s.bar.update();
  assert.equal(s.writes(), after, 'no write while nothing changed');
  s.mouse.isPresent = true;
  s.mouse.x = 12.4;
  s.mouse.y = -5.6;
  s.bar.update();
  assert.equal(s.parts.pointer.textContent, 'x 12\u2002y −6');
  const moved = s.writes();
  s.mouse.x = 12.3; // the same whole pixel
  s.bar.update();
  assert.equal(s.writes(), moved);
  s.camera.zoom = 0.5;
  s.editMode.move.snap = 16;
  s.selection.index = 4;
  s.selection.name = 'Platform1';
  s.editMode.multi.count = 2;
  s.bar.update();
  assert.equal(s.parts.zoom.textContent, '50%');
  assert.equal(s.parts.grid.textContent, 'Grid 16 px');
  assert.equal(s.parts.selection.textContent, '3 selected');
});

test('the hint says what the editor is doing: placing, painting, moving, a handle, the selection', () => {
  const s = statusFor();
  const hint = () => {
    s.bar.update();
    return s.parts.hint.textContent;
  };
  assert.match(hint(), /^Click selects/);
  s.selection.index = 7;
  s.selection.name = 'Platform1';
  s.selection.className = 'Platform';
  assert.match(hint(), /^Platform1: drag or the arrows move it/);
  s.editMode.move.dragging = true;
  assert.equal(hint(), 'Moving Platform1: release to drop it');
  s.editMode.multi.count = 2;
  assert.equal(hint(), 'Moving 3 entities: release to drop them');
  s.editMode.move.dragging = false;
  assert.match(hint(), /^3 selected: drag or the arrows move them/);
  s.editMode.multi.count = 0;
  s.handles.dragging = true;
  assert.match(hint(), /^Dragging a handle of Platform1: release to apply it/);
  s.handles.dragging = false;
  s.joints.dragging = true;
  assert.equal(hint(), 'Dragging: release to apply it');
  s.joints.dragging = false;
  s.selection.name = null; // a runtime entity
  assert.equal(hint(), 'Platform #7: spawned by code, not by the scene file, so read-only');
  s.editMode.brush.className = 'Grass';
  assert.match(hint(), /^Painting Grass: drag to scatter/);
  s.editMode.placing = 'Goal';
  assert.match(hint(), /^Placing Goal: each click on the view puts one there · Esc stops/);
  s.editMode.status = 'Saved 1-1.scene.json';
  assert.equal(hint(), 'Saved 1-1.scene.json', 'what was just done, for a moment');
  assert.equal(s.parts.hint.classList.contains('error'), false);
  s.editMode.status = 'Could not save';
  s.editMode.statusIsError = true;
  assert.equal(hint(), 'Could not save');
  assert.equal(s.parts.hint.classList.contains('error'), true, 'in red');
  s.tools.kind = 1;
  assert.equal(hint(), 'Painting: Ball (click & drag to spawn)', 'a debug tool’s hint first');
  assert.equal(s.parts.hint.classList.contains('error'), false);
});

test('playing, the bar says so; without a scene it is empty', () => {
  const s = statusFor();
  s.editMode.active = false;
  s.bar.update();
  assert.equal(s.parts.mode.textContent, 'PLAY');
  assert.equal(s.parts.hint.textContent, 'Playing · Shift+E pauses into edit mode');
  s.editMode.playing = true;
  s.bar.update();
  assert.match(s.parts.hint.textContent, /^Playing from edit mode · Stop goes back/);
  s.debugUI.scene = null;
  s.mouse.isPresent = true;
  s.bar.update();
  assert.equal(s.parts.mode.textContent, '');
  assert.equal(s.parts.hint.textContent, '');
  assert.equal(s.parts.zoom.textContent, '');
  assert.equal(s.parts.pointer.textContent, 'x –\u2002y –');
});

test('the debug tools say what they do once: in the indicator over the view, or (hosted) in the status bar', () => {
  const editMode = { status: '', statusIsError: false, placing: null, dirty: false };
  const debugUI = { editing: false, editMode, panels: {} };
  const tools = new ToolManager(debugUI);
  const indicator = { textContent: '', className: '' };
  tools._toolIndicator = indicator;
  tools.updateToolIndicator();
  assert.equal(indicator.className, 'debug-ui-tool-indicator', 'nothing on: hidden');
  assert.equal(tools.activeToolKind(), 0);
  assert.equal(tools.toolHint(), '');
  assert.equal(tools.toolHintArg(), null);
  tools.activeSpawnerType = 'Ball';
  tools.bulkSpawnEnabled = true;
  tools.updateToolIndicator();
  assert.equal(indicator.textContent, 'Painting: Ball ×50 (click & drag to spawn)');
  assert.equal(indicator.className, 'debug-ui-tool-indicator visible spawner');
  assert.equal(tools.toolHintArg(), 'Ball');
  tools.activeSpawnerType = null;
  tools.poolEraserKind = 'decoration';
  tools.updateToolIndicator();
  assert.equal(indicator.textContent, 'Eraser: decoration (click & drag)');
  assert.equal(indicator.className, 'debug-ui-tool-indicator visible eraser');
  tools.poolEraserKind = null;
  tools.inspectorActive = true;
  tools.inspectKind = 'particle';
  tools.updateToolIndicator();
  assert.equal(indicator.textContent, 'Inspector: click a particle');
  tools.inspectorActive = false;
  debugUI.editing = true;
  editMode.placing = 'Goal';
  tools.updateToolIndicator();
  assert.equal(indicator.textContent, 'Placing Goal: each click puts one there. Esc stops');
  assert.equal(indicator.className, 'debug-ui-tool-indicator visible editor');
  // In the editor page: hidden, whatever is on; the hint is still there for the status bar.
  tools.showIndicator = false;
  tools.eraserActive = true;
  tools.updateToolIndicator();
  assert.equal(indicator.className, 'debug-ui-tool-indicator');
  assert.equal(tools.toolHint(), 'Eraser Active (click & drag to despawn entities)');
});

test('the overlay draws its pointer and camera lines unless the editor page’s status bar shows them', () => {
  const debugUI = { editMode: { active: true, wantsOverlay: () => true, drawOverlay() {} }, debugFlags: null, scene: null, tools: null };
  const canvas = new DebugCanvas(debugUI);
  assert.equal(canvas.showHud, true);
  const texts = [];
  const ctx = {
    setTransform() {},
    clearRect() {},
    fillRect() {},
    fillText: (text) => texts.push(text),
  };
  canvas._canvas = { width: 800, height: 600 };
  canvas._ctx = ctx;
  canvas.render();
  assert.deepEqual(texts, ['mouse --', 'cam 0.0, 0.0  z1.00']);
  canvas.showHud = false;
  texts.length = 0;
  canvas.render();
  assert.deepEqual(texts, []);
});
