// The editor page's console (VISUAL_EDITOR_PLAN.md ED-18, ED-68), against a small DOM: the counts per level, the
// toggles and the search hiding and showing rows (writing only what changed), Clear, the cap on kept rows, the view
// following new rows unless scrolled up (then a "↓ new rows" button), and no DOM work while the Console tab is hidden:
// its rows are drawn in one batch when it shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';

import {
  ConsoleLog,
  ConsolePanel,
  MAX_ENTRIES,
  CHUNK_ROWS,
  GROUP_ERROR,
  GROUP_WARN,
  GROUP_LOG,
  shortCount,
} from '../../src/core/debug/editor/consolePanel.js';

// ---- a small DOM ----

/** Every write the panel makes to the DOM, by kind (`live`: insertions into the document, not into a fragment or a detached node). */
const writes = { create: 0, insert: 0, live: 0, remove: 0, text: 0, cls: 0, attr: 0, scroll: 0 };
const resetWrites = () => {
  for (const key of Object.keys(writes)) writes[key] = 0;
};
const totalWrites = () => Object.values(writes).reduce((a, b) => a + b, 0);

class FakeElement {
  constructor(tag, doc) {
    this.nodeType = tag === '#fragment' ? 11 : 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.children = [];
    this._text = '';
    this._classes = new Set();
    this._attrs = new Map();
    /** MutationObserver registrations on this node: { observer, filter }. */
    this._observers = [];
    this._listeners = new Map();
    this.dataset = new Proxy(
      {},
      {
        set(target, key, value) {
          writes.attr++;
          target[key] = String(value);
          return true;
        },
      },
    );
    this.style = {};
    this.value = '';
    this.type = '';
    this.placeholder = '';
    this.spellcheck = true;
    this.autocomplete = '';
    this.onclick = null;
    this.oninput = null;
    this.onkeydown = null;
    // A box: the height of its view (and how often it was read, a layout read), and a measure of its content.
    this.viewHeight = 0;
    this.heightReads = 0;
    this.measure = null;
    this._scrollTop = 0;
    const self = this;
    this.classList = {
      add(name) {
        self.classList.toggle(name, true);
      },
      remove(name) {
        self.classList.toggle(name, false);
      },
      toggle(name, force) {
        const on = force === undefined ? !self._classes.has(name) : Boolean(force);
        if (on !== self._classes.has(name)) {
          if (on) self._classes.add(name);
          else self._classes.delete(name);
          writes.cls++;
          self._changed('class');
        }
        return on;
      },
      contains: (name) => self._classes.has(name),
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
    writes.cls++;
    this._changed('class');
  }
  get hidden() {
    return this._attrs.has('hidden');
  }
  set hidden(value) {
    writes.attr++;
    if (value) this._attrs.set('hidden', '');
    else this._attrs.delete('hidden');
    this._changed('hidden');
  }
  get title() {
    return this._attrs.get('title') ?? '';
  }
  set title(value) {
    this.setAttribute('title', value);
  }
  setAttribute(name, value) {
    writes.attr++;
    this._attrs.set(name, String(value));
    this._changed(name);
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  get textContent() {
    return this.children.length > 0 ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(value) {
    writes.text++;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get parentElement() {
    return this.parentNode !== null && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }
  appendChild(node) {
    this._insert(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this._insert(node);
  }
  _insert(node) {
    writes.insert++;
    if (this.isConnected) writes.live++;
    const moved = node.nodeType === 11 ? node.children.splice(0) : [node];
    for (const child of moved) {
      if (child.parentNode !== null && child.parentNode !== node) child.parentNode._detach(child);
      child.parentNode = this;
      this.children.push(child);
    }
  }
  _detach(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }
  remove() {
    if (this.parentNode === null) return;
    writes.remove++;
    this.parentNode._detach(this);
  }
  closest(selector) {
    assert.equal(selector, '[data-entity]', 'the fake knows this selector only');
    for (let node = this; node !== null && node.nodeType === 1; node = node.parentNode) {
      if (node.dataset.entity !== undefined) return node;
    }
    return null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  /** An event, as the browser fires it on this element. */
  fire(type, event = {}) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    for (const fn of this._listeners.get(type) || []) fn(event);
    const handler = this[`on${type}`];
    if (typeof handler === 'function') handler(event);
  }
  checkVisibility() {
    if (!this.isConnected) return false;
    for (let node = this; node !== null; node = node.parentNode) if (node.hidden || node.style.display === 'none') return false;
    return true;
  }
  getClientRects() {
    return this.checkVisibility() ? [{}] : [];
  }
  get clientHeight() {
    this.heightReads++;
    return this.checkVisibility() ? this.viewHeight : 0;
  }
  get scrollHeight() {
    if (!this.checkVisibility()) return 0;
    return Math.max(this.viewHeight, this.measure === null ? 0 : this.measure());
  }
  get scrollTop() {
    return this._scrollTop;
  }
  set scrollTop(value) {
    writes.scroll++;
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this._scrollTop = Math.min(Math.max(0, value), max);
  }
  _changed(attribute) {
    for (const r of this._observers) if (r.filter.includes(attribute)) r.observer._queue();
  }
}

/** Attribute changes reach the callback after the task, as a microtask, the way the browser delivers them. */
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    this.queued = false;
    FakeMutationObserver.made++;
  }
  observe(node, options) {
    node._observers.push({ observer: this, filter: options.attributeFilter });
    this.targets.push(node);
  }
  disconnect() {
    for (const node of this.targets) node._observers = node._observers.filter((r) => r.observer !== this);
    this.targets = [];
  }
  _queue() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.targets.length > 0) this.callback([], this);
    });
  }
}
FakeMutationObserver.made = 0;

class FakeWindow {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
  }
}

const ROW_PX = 20;
const GROUP_LETTER = { e: 'e', w: 'w', l: 'l', i: 'l', d: 'l' };

/** Every row element, in order: the list holds blocks of rows. */
const allRows = (panel) => panel._rows.children.flatMap((chunk) => chunk.children);

/** The rows the panel's stylesheet lets show: not searched away, and their level's toggle on. */
function shownRows(panel) {
  const list = panel._rows;
  return allRows(panel).filter((row) => {
    if (row.classList.contains('weed-console-miss')) return false;
    const letter = /weed-console-([ewlid])(\s|$)/.exec(row.className)[1];
    return !list.classList.contains(`weed-console-hide-${GROUP_LETTER[letter]}`);
  });
}
const textOf = (row) => row.children[1].textContent;
const texts = (rows) => rows.map(textOf);
const microtask = () => new Promise((resolve) => queueMicrotask(resolve));

/**
 * The editor page around a console panel: html > body > footer > the Console slot (hidden, as the shell starts it),
 * the panel in the slot. `options.observer: false` for a browser without MutationObserver.
 */
function editorPage({ shown = false, observer = true, host = true } = {}) {
  const doc = {
    createElement: (tag) => {
      writes.create++;
      return new FakeElement(tag, doc);
    },
    createDocumentFragment: () => new FakeElement('#fragment', doc),
  };
  doc.documentElement = new FakeElement('html', doc);
  globalThis.document = doc;
  globalThis.window = new FakeWindow();
  if (observer) globalThis.MutationObserver = FakeMutationObserver;
  else delete globalThis.MutationObserver;
  const body = doc.createElement('body');
  const footer = doc.createElement('footer');
  const slot = doc.createElement('div');
  doc.documentElement.appendChild(body);
  body.appendChild(footer);
  footer.appendChild(slot);
  slot.hidden = !shown;
  const styles = [];
  const selected = [];
  const debugUI = {
    scene: {},
    editMode: { selectFromList: (index, frame) => selected.push([index, frame]) },
    hosted: host ? { host: { addStyles: (id, css) => styles.push([id, css.length]) } } : null,
  };
  const panel = new ConsolePanel(debugUI);
  slot.appendChild(panel.el);
  panel.el.viewHeight = 5 * ROW_PX + 26; // the list and the bar
  panel._scroller.viewHeight = 5 * ROW_PX;
  panel._scroller.measure = () => shownRows(panel).length * ROW_PX;
  panel.update(); // the first tick: watches the slot and its ancestors
  resetWrites();
  return { doc, body, footer, slot, panel, styles, selected };
}

function cleanUp() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.MutationObserver;
}

/** A test with the fake DOM in place. */
const domTest = (name, fn) =>
  test(name, async () => {
    try {
      await fn();
    } finally {
      cleanUp();
    }
  });

// ---- the log, without the DOM ----

test('the log counts calls per level over its rows: a repeated line on its row, an error by its key', () => {
  const log = new ConsoleLog();
  log.add('page', 'log', 'tick');
  log.add('page', 'log', 'tick');
  log.add('page', 'log', 'tick');
  assert.equal(log.size, 1, 'the same line again only counts');
  assert.equal(log.entryAt(0).count, 3);
  log.add('logic0', 'log', 'tick');
  assert.equal(log.size, 2, 'another source is a row of its own');
  log.add('page', 'info', 'ready');
  log.add('page', 'debug', 'dt 16');
  log.add('page', 'warn', 'low hp');
  log.add('page', 'warn', 'low hp');
  log.add('page', 'error', 'boom');
  assert.deepEqual([...log.counts], [1, 2, 6], 'errors, warnings, logs (info and debug are logs)');
  assert.deepEqual([...log.rows], [1, 1, 4]);

  const rec = { phase: 'tick', className: 'Enemy', entityIndex: 12, message: 'x is undefined', counts: new Map([['logic0', 4]]) };
  assert.equal(log.entityError('Enemy|tick|x', rec), true);
  const row = log.newest();
  assert.deepEqual([row.source, row.text, row.count, row.entityIndex], ['logic0', 'Enemy #12 · tick threw: x is undefined', 4, 12]);
  assert.deepEqual([...log.counts], [5, 2, 6], 'each throw counts');
  rec.counts.set('logic0', 10);
  rec.counts.set('logic1', 2);
  assert.equal(log.entityError('Enemy|tick|x', rec), false, 'the same error: its row');
  assert.deepEqual([row.count, row.source], [12, 'logic0, logic1'], 'every worker’s count, and every worker named');
  assert.deepEqual([...log.counts], [13, 2, 6]);
  log.add('page', 'error', 'boom');
  assert.equal(log.newest().key, null, 'a console line after it is a row of its own');
  log.newScene();
  assert.equal(log.entityError('Enemy|tick|x', rec), true, 'another scene’s error is a row of its own');
  assert.deepEqual([...log.rows], [4, 1, 4]);
  log.clear();
  assert.deepEqual([log.size, log.dropped, ...log.counts, ...log.rows], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(log.entityError('Enemy|tick|x', rec), true, 'after Clear an error is a new row');
});

test(`the log keeps ${MAX_ENTRIES} rows: the oldest go first, with their counts, and it says how many went`, () => {
  const log = new ConsoleLog();
  const rec = { phase: 'tick', className: 'Talker', entityIndex: 3, message: 'broke', counts: new Map([['logic0', 7]]) };
  log.entityError('Talker|tick|broke', rec);
  for (let i = 0; i < MAX_ENTRIES + 24; i++) log.add('page', i % 2 ? 'warn' : 'log', `line ${i}`);
  assert.equal(log.size, MAX_ENTRIES);
  assert.equal(log.dropped, 25);
  assert.equal(log.entryAt(0).text, 'line 24', 'the oldest kept');
  assert.equal(log.newest().text, `line ${MAX_ENTRIES + 23}`);
  assert.deepEqual([...log.counts], [0, MAX_ENTRIES / 2, MAX_ENTRIES / 2], 'the dropped rows’ calls are not counted');
  assert.equal(log.entityError('Talker|tick|broke', rec), true, 'a dropped error’s next report is a new row');
  const objects = new Set();
  for (let i = 0; i < log.size; i++) objects.add(log.entryAt(i));
  assert.equal(objects.size, MAX_ENTRIES, 'every kept row its own entry');
  assert.equal(log._ring.length, MAX_ENTRIES, 'no entry made past the cap: they are reused');
});

test('the search matches text or source, in any case; the toggles pick the groups', () => {
  const log = new ConsoleLog();
  log.add('logic1', 'log', 'Enemy spawned');
  log.add('page', 'warn', 'low HP');
  const [enemy, warning] = [log.entryAt(0), log.entryAt(1)];
  assert.equal(log.setQuery('  ENEMY '), true);
  assert.equal(log.query, 'enemy');
  assert.deepEqual([log.matches(enemy), log.matches(warning)], [true, false]);
  assert.equal(log.setQuery('enemy'), false, 'the same search');
  log.setQuery('LOGIC1');
  assert.deepEqual([log.matches(enemy), log.matches(warning)], [true, false], 'by its source');
  log.setQuery('hp');
  log.shown[GROUP_WARN] = false;
  assert.deepEqual([log.visible(enemy), log.visible(warning)], [false, false]);
  log.shown[GROUP_WARN] = true;
  assert.equal(log.visible(warning), true);
  assert.deepEqual([shortCount(9999), shortCount(12345), shortCount(2_345_678)], ['9999', '12k', '2.3M']);
});

// ---- the panel ----

domTest('the toggles show live counts, and hide and show their rows with one class on the list', () => {
  const { panel } = editorPage({ shown: true });
  panel.add('page', 'log', 'a');
  panel.add('page', 'log', 'a');
  panel.add('page', 'info', 'b');
  panel.add('logic0', 'warn', 'c');
  panel.add('page', 'error', 'd');
  panel.update();
  const counts = () => panel._countEls.map((el) => el.textContent);
  assert.deepEqual(counts(), ['1', '1', '3']);
  assert.match(panel._toggles[GROUP_LOG].title, /^Logs: 3 \(2 rows\)\. Click to hide them\.$/);
  panel.add('page', 'warn', 'e');
  panel.add('page', 'warn', 'e');
  panel.update();
  assert.deepEqual(counts(), ['1', '3', '3'], 'live');

  resetWrites();
  panel._toggles[GROUP_WARN].fire('click');
  assert.deepEqual(texts(shownRows(panel)), ['a', 'b', 'd']);
  assert.equal(panel._toggles[GROUP_WARN].getAttribute('aria-pressed'), 'false');
  assert.equal(writes.cls, 1, 'one class on the list, no row written');
  assert.equal(writes.text + writes.create + writes.insert + writes.remove, 0);
  assert.match(panel._toggles[GROUP_WARN].title, /Hidden: click to show them\.$/);
  panel.toggle(GROUP_LOG, false);
  assert.deepEqual(texts(shownRows(panel)), ['d']);
  panel.add('page', 'log', 'f');
  panel.update();
  assert.deepEqual(texts(shownRows(panel)), ['d'], 'a new row of a hidden group stays hidden');
  assert.deepEqual(counts(), ['1', '3', '4'], 'and still counts');
  panel.toggle(GROUP_WARN);
  panel.toggle(GROUP_LOG);
  assert.deepEqual(texts(shownRows(panel)), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(panel._toggles[GROUP_WARN].getAttribute('aria-pressed'), 'true');
});

domTest('the search: text or source in any case, rows written only when their state changes, Esc clears it', () => {
  const { panel } = editorPage({ shown: true });
  panel.add('page', 'log', 'Player spawned');
  panel.add('logic0', 'log', 'enemy spawned');
  panel.add('logic1', 'warn', 'Enemy died');
  panel.add('logic1', 'log', 'tick 3');
  panel.update();
  resetWrites();
  const input = panel._search;
  input.value = 'ENEMY';
  input.fire('input');
  assert.deepEqual(texts(shownRows(panel)), ['enemy spawned', 'Enemy died']);
  assert.equal(writes.cls, 2, 'the two rows that went');
  resetWrites();
  input.value = 'enemy d';
  input.fire('input');
  assert.deepEqual(texts(shownRows(panel)), ['Enemy died']);
  assert.equal(writes.cls, 1, 'only the row that changed');
  resetWrites();
  panel.search('Enemy D ');
  assert.equal(writes.cls, 0, 'the same search again writes nothing');
  panel.search('logic1');
  assert.deepEqual(texts(shownRows(panel)), ['Enemy died', 'tick 3'], 'by the source');
  panel.add('logic1', 'log', 'tick 4');
  panel.add('page', 'log', 'tick 5');
  panel.update();
  assert.deepEqual(texts(shownRows(panel)), ['Enemy died', 'tick 3', 'tick 4'], 'new rows: shown only when they match');
  input.fire('keydown', { key: 'Escape' });
  assert.equal(input.value, '');
  assert.equal(shownRows(panel).length, 6, 'Esc clears it');
});

domTest('Clear empties the list and resets every count', async () => {
  const { panel } = editorPage({ shown: true });
  for (let i = 0; i < 12; i++) panel.add('page', i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warn' : 'log', `line ${i}`);
  panel.entityError('E|tick|x', { phase: 'tick', className: 'E', entityIndex: 4, message: 'x', counts: new Map([['logic0', 9]]) });
  panel.update();
  assert.deepEqual(panel._countEls.map((el) => el.textContent), ['13', '4', '4']);
  panel._scroller.scrollTop = 0;
  panel._scroller.fire('scroll');
  panel.add('page', 'log', 'while scrolled up');
  panel.update();
  assert.equal(panel._newRows.hidden, false);

  const clear = panel.el.children[0].children.find((el) => el.textContent === 'Clear');
  clear.fire('click');
  assert.equal(allRows(panel).length, 0, 'at once, not at the next tick');
  assert.deepEqual(panel._countEls.map((el) => el.textContent), ['0', '0', '0']);
  assert.deepEqual([...panel.log.counts, ...panel.log.rows, panel.log.size], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(panel._newRows.hidden, true, 'the view follows new rows again');
  panel.add('page', 'log', 'after');
  panel.entityError('E|tick|x', { phase: 'tick', className: 'E', entityIndex: 4, message: 'x', counts: new Map([['logic0', 10]]) });
  panel.update();
  assert.deepEqual(texts(allRows(panel)), ['after', 'E #4 · tick threw: x']);
  assert.deepEqual(panel._countEls.map((el) => el.textContent), ['10', '0', '1']);
});

domTest(`at most ${MAX_ENTRIES} rows: the oldest go, and the console says so`, () => {
  const { panel, slot } = editorPage({ shown: true });
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    panel.add('page', 'log', `line ${i}`);
    if (i % 100 === 99) panel.update();
  }
  panel.update();
  assert.equal(allRows(panel).length, MAX_ENTRIES);
  assert.equal(textOf(allRows(panel)[0]), 'line 25');
  assert.equal(textOf(allRows(panel).at(-1)), `line ${MAX_ENTRIES + 24}`);
  assert.equal(panel._note.hidden, false);
  assert.equal(panel._note.textContent, '25 older rows dropped: the console keeps the newest 2,000.');
  assert.equal(panel._countEls[GROUP_LOG].textContent, String(MAX_ENTRIES));

  // Hidden, a flood: shown again, the newest MAX_ENTRIES in order, in one insertion.
  slot.hidden = true;
  for (let i = 0; i < 3000; i++) panel.add('logic0', 'log', `flood ${i}`);
  panel.update();
  slot.hidden = false;
  resetWrites();
  panel.update();
  const rows = allRows(panel);
  assert.equal(rows.length, MAX_ENTRIES);
  assert.deepEqual([textOf(rows[0]), textOf(rows.at(-1))], ['flood 1000', 'flood 2999']);
  assert.equal(writes.live, 1, 'the rows went into the document in one insertion');
  assert.equal(writes.remove, 0, 'the old rows went in one write');
  assert.equal(panel._note.textContent, '3,025 older rows dropped: the console keeps the newest 2,000.');
});

domTest(`rows go in blocks of ${CHUNK_ROWS}: rows coming and going touch the first and last blocks only`, () => {
  const { panel } = editorPage({ shown: true });
  for (let i = 0; i < MAX_ENTRIES; i++) panel.add('page', 'log', `line ${i}`);
  panel.update();
  const blocks = panel._rows.children;
  assert.equal(blocks.length, MAX_ENTRIES / CHUNK_ROWS);
  assert.ok(blocks.every((block) => block.children.length === CHUNK_ROWS && block.dataset.consoleRows === ''));
  const middle = blocks[1];

  resetWrites();
  for (let i = 0; i < 20; i++) panel.add('page', 'log', `more ${i}`);
  panel.update();
  assert.equal(writes.remove, 20, 'the 20 oldest rows, out of the first block');
  assert.equal(writes.live, 1, 'the new rows: one new block');
  assert.deepEqual([blocks[0].children.length, blocks.at(-1).children.length], [CHUNK_ROWS - 20, 20]);
  assert.equal(textOf(blocks[0].children[0]), 'line 20');

  resetWrites();
  for (let i = 20; i < 50; i++) panel.add('page', 'log', `more ${i}`);
  panel.update();
  assert.equal(writes.remove, 1, 'the first block, emptied: one removal');
  assert.equal(writes.live, 1, 'the new rows: into the last block');
  assert.equal(panel._rows.children[0], middle, 'the next block is first');
  assert.equal(blocks.at(-1).children.length, CHUNK_ROWS);
  assert.deepEqual(texts(allRows(panel)).slice(0, 2), ['line 50', 'line 51']);
  assert.equal(allRows(panel).length, MAX_ENTRIES);
});

domTest('the view follows new rows at the bottom; scrolled up, it stays, and "↓ new rows" takes it back down', () => {
  const { panel } = editorPage({ shown: true });
  const scroller = panel._scroller;
  const end = () => scroller.scrollHeight - scroller.clientHeight;
  for (let i = 0; i < 10; i++) panel.add('page', 'log', `row ${i}`);
  panel.update();
  assert.equal(scroller.scrollTop, end(), 'at the bottom');
  assert.equal(panel._newRows.hidden, true);

  scroller.scrollTop = 20; // the reader scrolls up
  scroller.fire('scroll');
  for (let i = 10; i < 13; i++) panel.add('page', 'log', `row ${i}`);
  panel.update();
  assert.equal(scroller.scrollTop, 20, 'the view stays where it was');
  assert.equal(panel._newRows.hidden, false);
  assert.equal(panel._newRows.textContent, '↓ 3 new rows');
  panel.toggle(GROUP_WARN, false);
  panel.add('page', 'warn', 'hidden by its toggle');
  panel.add('page', 'log', 'row 13');
  panel.update();
  assert.equal(panel._newRows.textContent, '↓ 4 new rows', 'a row the toggles hide is not counted');
  panel.toggle(GROUP_WARN, true);
  assert.equal(scroller.scrollTop, 20, 'a toggle does not move a view scrolled up');

  panel._newRows.fire('click');
  assert.equal(scroller.scrollTop, end());
  assert.equal(panel._newRows.hidden, true);
  panel.add('page', 'log', 'row 14');
  panel.update();
  assert.equal(scroller.scrollTop, end(), 'following again');

  // A wheel turned up lets go at once: a tick before its scroll event leaves the view alone.
  scroller.fire('wheel', { deltaY: -120 });
  const at = scroller.scrollTop;
  panel.add('page', 'log', 'row 15');
  panel.update();
  assert.equal(scroller.scrollTop, at);
  assert.equal(panel._newRows.textContent, '↓ 1 new row');
  // Scrolled back to the end by hand: following again, the button gone.
  scroller.scrollTop = end();
  scroller.fire('scroll');
  assert.equal(panel._newRows.hidden, true);
  panel.add('page', 'log', 'row 16');
  panel.update();
  assert.equal(scroller.scrollTop, end());

  // A list that does not fill the view never lets go.
  panel.clear();
  panel.add('page', 'log', 'one');
  panel.update();
  scroller.fire('wheel', { deltaY: -120 });
  scroller.fire('scroll');
  for (let i = 0; i < 9; i++) panel.add('page', 'log', `more ${i}`);
  panel.update();
  assert.equal(scroller.scrollTop, end(), 'it follows once it overflows');
});

domTest('a hidden console does no DOM work; shown, it draws everything at once, as the tab opens', async () => {
  const { panel, slot, footer } = editorPage({ shown: false });
  for (let i = 0; i < 300; i++) panel.add(i % 2 ? 'logic0' : 'page', i % 5 === 0 ? 'warn' : 'log', `line ${i}`);
  panel.add('logic0', 'log', 'line 299'); // the last line again
  panel.entityError('T|tick|x', { phase: 'tick', className: 'T', entityIndex: 1, message: 'x', counts: new Map([['logic0', 1]]) });
  panel.entityError('T|tick|x', { phase: 'tick', className: 'T', entityIndex: 1, message: 'x', counts: new Map([['logic0', 30]]) });
  for (let tick = 0; tick < 10; tick++) panel.update();
  panel.newScene();
  assert.equal(totalWrites(), 0, `no DOM write while hidden: ${JSON.stringify(writes)}`);
  assert.equal(allRows(panel).length, 0);

  slot.hidden = false; // the shell's Console tab: no tick in between
  await microtask();
  assert.equal(allRows(panel).length, 301, 'drawn before the next tick');
  assert.equal(allRows(panel).at(-2).children[2].textContent, '×2', 'with the repeat');
  assert.deepEqual(panel._countEls.map((el) => el.textContent), ['30', '60', '241']);
  assert.equal(panel._scroller.scrollTop, panel._scroller.scrollHeight - panel._scroller.clientHeight, 'at the bottom');

  // Hidden by an ancestor (a folded dock): nothing again; shown, the new rows come.
  footer.hidden = true;
  await microtask();
  resetWrites();
  for (let i = 0; i < 50; i++) panel.add('page', 'log', `later ${i}`);
  panel.update();
  assert.equal(totalWrites(), 0);
  footer.hidden = false;
  await microtask();
  assert.equal(allRows(panel).length, 351);
});

domTest('a dock folded by its size (no height) costs no DOM work either; unfolded, the rows come; a shown tick reads no height', async () => {
  const { panel, footer } = editorPage({ shown: true });
  panel.add('page', 'log', 'before');
  panel.update();
  const reads = panel.el.heightReads;
  for (let i = 0; i < 30; i++) {
    panel.add('page', 'log', `shown ${i}`);
    panel.update();
  }
  assert.equal(panel.el.heightReads, reads, 'a shown console’s ticks do not read its height');

  panel.el.viewHeight = 0; // the shell folds the dock by its size
  footer.setAttribute('style', 'height: 26px');
  await microtask();
  resetWrites();
  for (let i = 0; i < 20; i++) panel.add('page', 'log', `folded ${i}`);
  for (let tick = 0; tick < 5; tick++) panel.update();
  assert.equal(totalWrites(), 0, `no DOM write while folded: ${JSON.stringify(writes)}`);
  assert.equal(allRows(panel).length, 31);

  panel.el.viewHeight = 5 * ROW_PX + 26;
  footer.setAttribute('style', '');
  await microtask();
  assert.equal(allRows(panel).length, 51, 'unfolded: drawn at once');
});

domTest('without MutationObserver, the tick draws a console that shows', () => {
  const { panel, slot } = editorPage({ shown: false, observer: false });
  panel.add('page', 'log', 'hello');
  panel.update();
  assert.equal(allRows(panel).length, 0);
  slot.hidden = false;
  panel.update();
  assert.deepEqual(texts(allRows(panel)), ['hello']);
});

domTest('an idle tick writes nothing and allocates nothing', async () => {
  const { panel } = editorPage({ shown: true });
  for (let i = 0; i < 40; i++) panel.add('page', 'log', `line ${i}`);
  panel.update();
  resetWrites();
  const TICKS = 200_000;
  function idleTicks(n) {
    for (let i = 0; i < n; i++) panel.update();
  }
  idleTicks(50_000); // warm-up: the measured ticks run optimized code, not their first calls
  // Sampled allocation, the objects young and old GCs already took included (heapSampleNode.mjs), of everything
  // under the loop: the sampler names inlined code by the function it was inlined into, so update() may be the loop.
  // 8 bytes a tick would be 1.6 MB; a recompile of update() after the other tests' shapes is a few KB, once.
  const session = new inspector.Session();
  session.connect();
  let bytes = 0;
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 256,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    idleTicks(TICKS);
    const { profile } = await session.post('HeapProfiler.stopSampling');
    const walk = (node, inLoop) => {
      const here = inLoop || node.callFrame.functionName === 'idleTicks';
      if (here) bytes += node.selfSize;
      for (const child of node.children) walk(child, here);
    };
    walk(profile.head, false);
  } finally {
    session.disconnect();
  }
  assert.ok(bytes < TICKS / 4, `${bytes} sampled bytes over ${TICKS} idle ticks (${(bytes / TICKS).toFixed(3)} a tick)`);
  assert.equal(totalWrites(), 0);
});

domTest('the observer of the editor page’s nodes goes with the page (pagehide), and with the panel’s removal', async () => {
  const { panel, slot, footer, body, doc } = editorPage({ shown: true });
  const watched = () => [slot, footer, body, doc.documentElement].map((node) => node._observers.length);
  assert.deepEqual(watched(), [1, 1, 1, 1]);
  window.fire('pagehide');
  assert.deepEqual(watched(), [0, 0, 0, 0], 'pagehide: nothing of this page held by the editor page');
  panel.update();
  assert.deepEqual(watched(), [0, 0, 0, 0], 'not watched again');

  const second = editorPage({ shown: true });
  assert.deepEqual([second.slot._observers.length, second.footer._observers.length], [1, 1]);
  second.slot._detach(second.panel.el); // the host takes the panel out of its dock
  second.footer.hidden = true;
  await microtask();
  assert.deepEqual([second.slot._observers.length, second.footer._observers.length], [0, 0], 'it lets go once out');
});

domTest('the look goes to the editor page’s head through the host (text), else into the panel', () => {
  const hosted = editorPage({ shown: true });
  assert.deepEqual(hosted.styles.map(([id]) => id), ['weed-editor-console']);
  assert.equal(hosted.panel.el.children.some((el) => el.tagName === 'STYLE'), false);
  cleanUp();
  const alone = editorPage({ shown: true, host: false });
  assert.equal(alone.panel.el.children.some((el) => el.tagName === 'STYLE'), true);
});

domTest('ED-18: a repeated line counts on its row, one row per game code error, a click selects who threw', () => {
  const { panel, selected } = editorPage({ shown: true });
  panel.add('logic0', 'log', 'tick');
  panel.add('logic0', 'log', 'tick');
  assert.equal(allRows(panel).length, 0, 'nothing drawn before the tick');
  panel.update();
  assert.equal(allRows(panel).length, 1);
  panel.add('logic0', 'log', 'tick');
  panel.update();
  assert.equal(allRows(panel).length, 1, 'the same line again: its count');
  assert.equal(allRows(panel)[0].children[2].textContent, '×3');
  panel.add('logic1', 'log', 'tick');
  panel.update();
  assert.equal(allRows(panel).length, 2, 'another worker’s line is a row of its own');

  const rec = { phase: 'tick', className: 'Enemy', entityIndex: 12, message: 'x is undefined', counts: new Map([['logic0', 1]]) };
  panel.entityError('Enemy|tick|x is undefined', rec);
  panel.update();
  const row = allRows(panel)[2];
  assert.deepEqual(row.children.map((cell) => cell.textContent), ['logic0', 'Enemy #12 · tick threw: x is undefined', '']);
  assert.equal(row.dataset.entity, '12', 'a click selects it');
  assert.equal(row.title, 'Select the entity that threw');
  rec.counts.set('logic0', 40);
  rec.counts.set('logic1', 2);
  panel.entityError('Enemy|tick|x is undefined', rec);
  panel.update();
  assert.deepEqual([row.children[0].textContent, row.children[2].textContent], ['logic0, logic1', '×42'], 'every worker’s, on the same row');
  panel._scroller.fire('click', { target: row.children[1] });
  assert.deepEqual(selected, [[12, true]]);
  panel.newScene();
  panel.entityError('Enemy|tick|x is undefined', rec);
  panel.update();
  assert.equal(allRows(panel).length, 4, 'another scene’s error is a row of its own');
  assert.equal(panel._countEls[GROUP_ERROR].textContent, '84');
});
