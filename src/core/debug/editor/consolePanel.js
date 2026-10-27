// consolePanel.js — the editor page's console (VISUAL_EDITOR_PLAN.md ED-18, ED-68): what the game page and its workers
// log while the editor page shows it (consoleForward.js), and the game code errors the workers report (entityError: one
// row per distinct error, its count kept up to date; a click selects the entity that threw).
//
// The bar: Errors, Warnings and Logs are toggles with their counts (calls: a repeated line counts each time, an error
// each throw), a search over each row's text and source in any case, and Clear. The view follows new rows while it is
// at the bottom; scrolled up, it stays where it is, and a "↓ new rows" button takes it back down.
//
// Cost:
// - ConsoleLog keeps at most MAX_ENTRIES rows in a ring; past that the oldest go, and the console says how many went.
//   An entry is reused with its slot. The same line again (level, source and text) only counts on its row.
// - The DOM is written at the debug UI's tick, in one batch, and only while the console is shown. A hidden Console
//   tab (or a dock folded, by its display or by its size) costs no row, no style write and no layout per call: its
//   rows are made when it shows again, in one insertion. An observer of the console's ancestors (their hidden, class
//   and style) draws them as the tab opens, before the frame paints; the tick's own check covers any other way of
//   showing it. The observer holds this page from the editor page's nodes, so it goes on pagehide: without that, each
//   reload of the game page stayed alive (editorShellSmoke.mjs 'no leak': 3 → 8 documents over 5 reloads).
// - The rows go in blocks of CHUNK_ROWS: rows coming and going lay out the first and last blocks and the list of
//   blocks, not every row (one flat list of 2,000 rows cost 3 to 6 ms a tick in Chrome while rows streamed in).
// - A level toggle is one class on the list (the stylesheet hides the rows). The search tests the kept rows and writes
//   only the rows whose state changed. Nothing is allocated at a tick that has nothing new.

/** Rows kept; a new row past that drops the oldest (the console says how many went). */
export const MAX_ENTRIES = 2000;

/** The groups the toggles show or hide: errors, warnings, and the rest (log, info, debug). */
export const GROUP_ERROR = 0;
export const GROUP_WARN = 1;
export const GROUP_LOG = 2;
export const GROUP_NAMES = ['Errors', 'Warnings', 'Logs'];

/** @param {string} level - log, info, warn, error, debug */
export const groupOf = (level) => (level === 'error' ? GROUP_ERROR : level === 'warn' ? GROUP_WARN : GROUP_LOG);

/** One row: a console call (its repeats counted on it) or a game code error. Every field is declared here. */
class ConsoleEntry {
  constructor() {
    this.level = 'log';
    this.group = GROUP_LOG;
    this.source = '';
    this.text = '';
    /** Calls the row stands for (a game code error: its throws, every worker's). */
    this.count = 0;
    /** The entity that threw (a game code error), else -1. */
    this.entityIndex = -1;
    /** The game code error's key, else null. */
    this.key = null;
    /** Workers in the game code error's count when its source was written. */
    this.workers = 0;
    /** The text and source in lower case, made the first time a search reads them. */
    this.lowerText = null;
    this.lowerSource = null;
    // The view's (ConsolePanel): the row and its cells once drawn, what they show, and whether the search hides it.
    this.row = null;
    this.sourceEl = null;
    this.countEl = null;
    this.shownCount = 0;
    this.shownSource = '';
    this.miss = false;
  }
}

/** A game code error's source: the workers that reported it. */
const workersOf = (counts) => [...counts.keys()].join(', ');

/**
 * The console's rows without the DOM: a ring of at most `capacity` entries, the counts per group, and the filter (the
 * groups shown and the search).
 */
export class ConsoleLog {
  /**
   * @param {number} [capacity]
   * @param {((entry: ConsoleEntry) => void) | null} [onDrop] - an entry leaves (dropped for room, or cleared), before
   *   its object is reused
   */
  constructor(capacity = MAX_ENTRIES, onDrop = null) {
    this.capacity = capacity;
    this._onDrop = onDrop;
    /** The entries, a ring with the oldest at _head. It moves only once full, so it is 0 until then. */
    this._ring = [];
    this._head = 0;
    /** Rows kept. */
    this.size = 0;
    /** The newest rows the view has not drawn yet (it sets this to 0 once it has). */
    this.fresh = 0;
    /** Rows dropped for room since the last clear. */
    this.dropped = 0;
    /** Calls per group, over the kept rows. */
    this.counts = new Float64Array(3);
    /** Kept rows per group. */
    this.rows = new Int32Array(3);
    /** A kept row's count or source changed (the view clears it). */
    this.changed = false;
    /** Game code error key → its row, for this scene. */
    this._errors = new Map();
    /** The groups shown (the toggles), and the search in lower case ('' for none). */
    this.shown = [true, true, true];
    this.query = '';
  }

  /** The i-th kept entry, 0 the oldest. */
  entryAt(i) {
    let k = this._head + i;
    if (k >= this.capacity) k -= this.capacity;
    return this._ring[k];
  }

  /** The newest entry, or null. */
  newest() {
    return this.size === 0 ? null : this.entryAt(this.size - 1);
  }

  /**
   * A console call: a new row, or one more on the newest row when it is the same line.
   * @param {string} source - 'page', or the worker's name
   * @param {string} level - log, info, warn, error, debug
   * @param {string} text
   * @returns {boolean} whether it made a row
   */
  add(source, level, text) {
    const last = this.newest();
    if (last !== null && last.key === null && last.text === text && last.source === source && last.level === level) {
      last.count++;
      this.counts[last.group]++;
      this.changed = true;
      return false;
    }
    const entry = this._take();
    entry.level = level;
    entry.group = groupOf(level);
    entry.source = source;
    entry.text = text;
    entry.count = 1;
    entry.entityIndex = -1;
    entry.key = null;
    entry.workers = 0;
    this._added(entry);
    return true;
  }

  /**
   * A game code error a worker reported (Scene._onEntityError): one row per distinct error in this scene, its count
   * (every worker's) and its workers kept up to date.
   * @param {string} key
   * @param {{ phase: string, className: string, entityIndex: number, message: string, counts: Map<string, number> }} rec
   * @returns {boolean} whether it made a row
   */
  entityError(key, rec) {
    let count = 0;
    for (const n of rec.counts.values()) count += n;
    const known = this._errors.get(key);
    if (known !== undefined) {
      if (known.count !== count) {
        this.counts[GROUP_ERROR] += count - known.count;
        known.count = count;
        this.changed = true;
      }
      if (known.workers !== rec.counts.size) {
        known.source = workersOf(rec.counts);
        known.lowerSource = null;
        known.workers = rec.counts.size;
        this.changed = true;
      }
      return false;
    }
    const index = rec.entityIndex >= 0 ? rec.entityIndex : -1;
    const who = rec.className ? `${rec.className}${index >= 0 ? ` #${index}` : ''} · ` : '';
    const entry = this._take();
    entry.level = 'error';
    entry.group = GROUP_ERROR;
    entry.source = workersOf(rec.counts);
    entry.text = `${who}${rec.phase} threw: ${rec.message}`;
    entry.count = count;
    entry.entityIndex = index;
    entry.key = key;
    entry.workers = rec.counts.size;
    this._errors.set(key, entry);
    this._added(entry);
    return true;
  }

  /** Another scene: its errors are rows of their own; the old rows stay. */
  newScene() {
    this._errors.clear();
  }

  /** Every row goes, and every count. */
  clear() {
    const onDrop = this._onDrop;
    if (onDrop !== null) for (let i = 0; i < this.size; i++) onDrop(this.entryAt(i));
    this._head = 0;
    this.size = 0;
    this.fresh = 0;
    this.dropped = 0;
    this.counts.fill(0);
    this.rows.fill(0);
    this.changed = false;
    this._errors.clear();
  }

  /** Whether the search lets the entry through: its text or its source has the query, in any case. */
  matches(entry) {
    const query = this.query;
    if (query === '') return true;
    if (entry.lowerText === null) entry.lowerText = entry.text.toLowerCase();
    if (entry.lowerText.includes(query)) return true;
    if (entry.lowerSource === null) entry.lowerSource = entry.source.toLowerCase();
    return entry.lowerSource.includes(query);
  }

  /** Whether the entry's row shows: its group is on and the search lets it through. */
  visible(entry) {
    return this.shown[entry.group] && this.matches(entry);
  }

  /**
   * The search: text, any case, surrounding spaces ignored.
   * @returns {boolean} whether it changed
   */
  setQuery(text) {
    const query = String(text).trim().toLowerCase();
    if (query === this.query) return false;
    this.query = query;
    return true;
  }

  /** The entry for a new row: a slot of its own, or the oldest's once full (the oldest goes). */
  _take() {
    const capacity = this.capacity;
    if (this.size < capacity) {
      let entry = this._ring[this.size];
      if (entry === undefined) {
        entry = new ConsoleEntry();
        this._ring.push(entry);
      }
      this.size++;
      return entry;
    }
    const entry = this._ring[this._head];
    this.counts[entry.group] -= entry.count;
    this.rows[entry.group]--;
    this.dropped++;
    if (entry.key !== null && this._errors.get(entry.key) === entry) this._errors.delete(entry.key);
    if (this._onDrop !== null) this._onDrop(entry);
    this._head = this._head + 1 === capacity ? 0 : this._head + 1;
    return entry;
  }

  _added(entry) {
    entry.lowerText = null;
    entry.lowerSource = null;
    entry.miss = false;
    this.counts[entry.group] += entry.count;
    this.rows[entry.group]++;
    if (this.fresh < this.size) this.fresh++;
  }
}

// ---- the view ----

const STYLE_ID = 'weed-editor-console';
/**
 * Rows per block of the list. A flush then lays out the first block (rows leaving), the last (rows coming) and the
 * list of blocks, not every row: at the cap, with rows streaming in, that was 3 to 6 ms a tick in Chrome.
 */
export const CHUNK_ROWS = 50;
/** Scrolled to within this many pixels of the end is at the end. */
const END_SLACK = 4;
/** The console's ancestors' attributes that can show or hide it (the dock's tab, a fold). */
const WATCH = { attributes: true, attributeFilter: ['hidden', 'class', 'style'] };
const SCROLL_LISTENER = { passive: true };
const LEVEL_LETTER = { error: 'e', warn: 'w', info: 'i', log: 'l', debug: 'd' };
const ROW_CLASS = {};
const ROW_CLASS_MISS = {};
for (const [level, letter] of Object.entries(LEVEL_LETTER)) {
  ROW_CLASS[level] = `weed-console-row weed-console-${letter}`;
  ROW_CLASS_MISS[level] = `weed-console-row weed-console-${letter} weed-console-miss`;
}
const MISS = 'weed-console-miss';
/** The class on the list that hides a group's rows. */
const HIDE_CLASS = ['weed-console-hide-e', 'weed-console-hide-w', 'weed-console-hide-l'];
const TOGGLE_CLASS = ['weed-console-toggle weed-console-te', 'weed-console-toggle weed-console-tw', 'weed-console-toggle weed-console-tl'];
const ENTITY_TITLE = 'Select the entity that threw';

/** The console's look, in the editor page's dark theme (editorShell.css's colours). */
export const CONSOLE_CSS = `
.weed-console{display:flex;flex-direction:column;height:100%;min-height:0;color:#d6d9e2}
.weed-console [hidden]{display:none!important}
.weed-console-bar{display:flex;align-items:center;gap:4px;padding:3px 6px;flex:none;border-bottom:1px solid var(--weed-line,#262b38);font:11px/16px system-ui,-apple-system,'Segoe UI',sans-serif}
.weed-console-bar button{display:inline-flex;align-items:center;gap:5px;font:inherit;color:var(--weed-dim,#8a90a0);background:#1e2230;border:1px solid #343a4c;border-radius:4px;padding:1px 7px;cursor:pointer;white-space:nowrap}
.weed-console-bar button:hover{border-color:#59617a;color:var(--weed-text,#e3e6ee)}
.weed-console-toggle[aria-pressed=true]{color:var(--weed-text,#e3e6ee)}
.weed-console-toggle[aria-pressed=false]{background:none;opacity:.5}
.weed-console-n{min-width:8px;padding:0 5px;border-radius:7px;text-align:center;font-variant-numeric:tabular-nums;background:rgba(255,255,255,.08)}
.weed-console-te .weed-console-n{color:#f87171;background:rgba(248,113,113,.14)}
.weed-console-tw .weed-console-n{color:#fbbf24;background:rgba(251,191,36,.12)}
.weed-console-search{flex:0 1 260px;min-width:70px;height:20px;box-sizing:border-box;margin-left:4px;padding:0 6px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--weed-text,#e3e6ee);background:#0b0d12;border:1px solid #343a4c;border-radius:4px;outline:none}
.weed-console-search:focus{border-color:var(--weed-accent,#4ade80)}
.weed-console-clear{margin-left:auto}
.weed-console-body{position:relative;flex:1;min-height:0}
.weed-console-scroll{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain}
.weed-console-note{padding:2px 8px;color:#6b7080;font:italic 11px/1.45 system-ui,sans-serif;border-bottom:1px dashed rgba(255,255,255,.08)}
.weed-console-rows{font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.weed-console-rows:empty::before{content:'Nothing logged yet.';display:block;padding:4px 8px;color:#6b7080;font-style:italic}
.weed-console-row{display:flex;gap:8px;padding:1px 8px;border-bottom:1px solid rgba(255,255,255,.04)}
.weed-console-e{color:#f87171;background:rgba(248,113,113,.06)}
.weed-console-w{color:#fbbf24;background:rgba(251,191,36,.05)}
.weed-console-i{color:#93c5fd}
.weed-console-d{color:#8a90a0}
.weed-console-row:hover{background:rgba(255,255,255,.035)}
.weed-console-row[data-entity]{cursor:pointer}
.weed-console-row[data-entity]:hover .weed-console-text{text-decoration:underline}
.weed-console-src{flex:none;min-width:52px;color:#6b7080}
.weed-console-text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.weed-console-count{flex:none;color:#8a90a0}
.weed-console-hide-e .weed-console-e,.weed-console-hide-w .weed-console-w,.weed-console-hide-l .weed-console-l,.weed-console-hide-l .weed-console-i,.weed-console-hide-l .weed-console-d,.weed-console-row.weed-console-miss{display:none}
.weed-console-new{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);padding:2px 10px;font:600 11px/16px system-ui,-apple-system,'Segoe UI',sans-serif;color:#0e1016;background:var(--weed-accent,#4ade80);border:0;border-radius:10px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.55)}
.weed-console-new:hover{filter:brightness(1.12)}
`;

/** A count for a toggle: exact to 9,999, then short. */
export function shortCount(n) {
  if (n < 10000) return String(n);
  if (n < 1e6) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 1e5) / 10}M`;
}

const countText = (n) => (n > 1 ? `×${n}` : '');
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export class ConsolePanel {
  /** @param {object} debugUI */
  constructor(debugUI) {
    this.debugUI = debugUI;
    /** The rows, without the DOM. */
    this.log = new ConsoleLog(MAX_ENTRIES, (entry) => this._left(entry));
    /** Something to draw since the last flush (rows, counts, the dropped note). */
    this._dirty = false;
    /** Whether the view follows new rows (it is at the bottom), and the rows that came while it did not. */
    this._stick = true;
    this._unseen = 0;
    this._shownUnseen = 0;
    /** Row elements in the list, and how many of them, the first ones, are of entries that left. */
    this._rowCount = 0;
    this._staleRows = 0;
    /** The list's blocks of rows (CHUNK_ROWS each, the last filling), oldest first, and the rows in each. */
    this._chunks = [];
    this._chunkRows = [];
    /** What the bar and the note show. */
    this._shownCounts = new Float64Array(3);
    this._shownRows = new Int32Array(3);
    this._shownDropped = 0;
    /** The observer of the console's ancestors, and the parent it was set up from. */
    this._observer = null;
    this._watched = null;
    this._destroyed = false;
    /** Rendered with no height (a dock folded by its size), as last measured; and whether to measure again. */
    this._folded = false;
    this._measure = true;

    this._onAncestors = () => {
      if (!this.el.isConnected) {
        this._unwatch();
        return;
      }
      // Rows that left go first, so showing the console does not style them on the way out.
      if (this._staleRows > 0) this._removeStale();
      this._measure = true;
      if (!this._isShown()) return;
      if (this._dirty) this._flush();
      // Shown, or its box changed (a dock resized): the newest rows stay in view.
      if (this._stick) this._toEnd();
    };
    this._onScroll = () => {
      const scroller = this._scroller;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - END_SLACK;
      if (atEnd === this._stick) return;
      this._stick = atEnd;
      if (atEnd) {
        this._unseen = 0;
        this._writeNewRows();
      }
    };
    // Scrolling up lets go at once, before the scroll event: a tick in between would take the view back down.
    this._onWheel = (e) => {
      if (e.deltaY < 0 && this._scroller.scrollTop > 0) this._stick = false;
    };
    this._onPageHide = () => this.destroy();

    const el = document.createElement('div');
    el.className = 'weed-console';
    this.el = el;
    const bar = document.createElement('div');
    bar.className = 'weed-console-bar';
    /** The toggles and their counts. */
    this._toggles = [];
    this._countEls = [];
    for (let group = 0; group < 3; group++) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = TOGGLE_CLASS[group];
      toggle.setAttribute('aria-pressed', 'true');
      const label = document.createElement('span');
      label.textContent = GROUP_NAMES[group];
      const count = document.createElement('span');
      count.className = 'weed-console-n';
      count.textContent = '0';
      toggle.append(label, count);
      toggle.onclick = () => this.toggle(group);
      this._toggles.push(toggle);
      this._countEls.push(count);
      this._writeToggleTitle(group);
      bar.appendChild(toggle);
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'weed-console-search';
    search.placeholder = 'Filter';
    search.spellcheck = false;
    search.autocomplete = 'off';
    search.title = 'Show only the rows whose text or source (page, logic0, …) has this, in any case. Esc clears it.';
    search.oninput = () => this.search(search.value);
    search.onkeydown = (e) => {
      if (e.key === 'Escape' && search.value !== '') {
        e.preventDefault();
        this.search('');
      }
    };
    this._search = search;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'weed-console-clear';
    clear.textContent = 'Clear';
    clear.title = 'Clear the console: every row and count';
    clear.onclick = () => this.clear();
    bar.append(search, clear);

    const body = document.createElement('div');
    body.className = 'weed-console-body';
    const scroller = document.createElement('div');
    scroller.className = 'weed-console-scroll';
    scroller.addEventListener('scroll', this._onScroll, SCROLL_LISTENER);
    scroller.addEventListener('wheel', this._onWheel, SCROLL_LISTENER);
    scroller.onclick = (e) => this._clicked(e);
    this._scroller = scroller;
    const note = document.createElement('div');
    note.className = 'weed-console-note';
    note.hidden = true;
    note.title = `The console keeps the newest ${MAX_ENTRIES.toLocaleString('en-US')} rows; older ones go as new ones come.`;
    this._note = note;
    // The rows go in blocks of CHUNK_ROWS, each marked data-console-rows: `[data-console-rows] > div` is every row,
    // in order.
    const rows = document.createElement('div');
    rows.className = 'weed-console-rows';
    this._rows = rows;
    scroller.append(note, rows);
    const newRows = document.createElement('button');
    newRows.type = 'button';
    newRows.className = 'weed-console-new';
    newRows.hidden = true;
    newRows.title = 'New rows came while you read older ones: go down to the newest, and follow new rows again';
    newRows.onclick = () => this.scrollToEnd();
    this._newRows = newRows;
    body.append(scroller, newRows);
    el.append(bar, body);

    // The look: into the editor page's head, as the debug UI's own styles (text only: the host keeps nothing of this
    // page). With no host, in the panel itself.
    const host = debugUI?.hosted?.host;
    if (host && typeof host.addStyles === 'function') host.addStyles(STYLE_ID, CONSOLE_CSS);
    else {
      const style = document.createElement('style');
      style.textContent = CONSOLE_CSS;
      el.appendChild(style);
    }
    // The observer holds this page from the editor page's nodes: it goes with the page.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this._onPageHide);
    }
  }

  /**
   * A console call of the page or a worker.
   * @param {string} source - 'page', or the worker's name
   * @param {string} level - log, info, warn, error, debug
   * @param {string} text
   */
  add(source, level, text) {
    this.log.add(source, level, text);
    this._dirty = true;
  }

  /**
   * A game code error a worker reported (Scene._onEntityError): one row per distinct error, its count updated.
   * @param {string} key
   * @param {{ phase: string, className: string, entityIndex: number, message: string, counts: Map<string, number> }} rec
   */
  entityError(key, rec) {
    this.log.entityError(key, rec);
    this._dirty = true;
  }

  /** Another scene: its errors are new rows, the old rows stay. */
  newScene() {
    this.log.newScene();
  }

  /** Every row and count goes; the view follows new rows again. */
  clear() {
    this.log.clear();
    this._stick = true;
    this._unseen = 0;
    this._dirty = true;
    if (this._isShown()) this._flush();
  }

  /**
   * Show or hide a group's rows (Errors, Warnings, Logs): one class on the list.
   * @param {number} group - GROUP_ERROR, GROUP_WARN or GROUP_LOG
   * @param {boolean} [on]
   */
  toggle(group, on = !this.log.shown[group]) {
    if (this.log.shown[group] === on) return;
    this.log.shown[group] = on;
    this._rows.classList.toggle(HIDE_CLASS[group], !on);
    this._toggles[group].setAttribute('aria-pressed', on ? 'true' : 'false');
    this._writeToggleTitle(group);
    if (this._stick && this._isShown()) this._toEnd();
  }

  /**
   * Show only the rows whose text or source has `text`, in any case ('' shows every row). The kept rows are tested
   * again; only those whose state changed are written.
   * @param {string} text
   */
  search(text) {
    if (this._search.value !== text) this._search.value = text;
    const log = this.log;
    if (!log.setQuery(text)) return;
    for (let i = 0, drawn = log.size - log.fresh; i < drawn; i++) {
      const entry = log.entryAt(i);
      const miss = !log.matches(entry);
      if (miss !== entry.miss) {
        entry.miss = miss;
        entry.row.classList.toggle(MISS, miss);
      }
    }
    if (this._stick && this._isShown()) this._toEnd();
  }

  /** Go down to the newest row, and follow new rows again (the "↓ new rows" button). */
  scrollToEnd() {
    this._stick = true;
    this._unseen = 0;
    this._writeNewRows();
    this._toEnd();
  }

  /** The debug UI's tick: while the console is shown, draw what came since the last one, in one batch. */
  update() {
    if (this.el.parentElement !== this._watched) this._watch();
    if (!this._dirty || !this._isShown()) return;
    this._flush();
  }

  /** Let go of the editor page's nodes (the page goes: pagehide). */
  destroy() {
    this._destroyed = true;
    this._unwatch();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this._onPageHide);
    }
  }

  /**
   * Whether the console is on screen: in a document, rendered (not in a hidden tab, nor a dock hidden by its
   * display), and with some height (not a dock folded by its size). The height is a layout read, so it is measured
   * only after a change of the console's ancestors, or while folded: a shown console's tick does not read it.
   */
  _isShown() {
    const el = this.el;
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' ? !el.checkVisibility() : el.getClientRects().length === 0) return false;
    if (this._measure || this._folded) {
      this._measure = false;
      this._folded = el.clientHeight === 0;
    }
    return !this._folded;
  }

  /** Watch the attributes of the console's ancestors that can show it, so it draws as it shows. */
  _watch() {
    const parent = this.el.parentElement;
    this._unwatch();
    this._watched = parent;
    if (parent === null || this._destroyed || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(this._onAncestors);
    for (let node = parent; node !== null; node = node.parentElement) observer.observe(node, WATCH);
    this._observer = observer;
  }

  _unwatch() {
    if (this._observer !== null) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  /** An entry leaves the log (dropped for room, or cleared): its row, if drawn, is one of the first ones; it goes at the next flush. */
  _left(entry) {
    if (entry.row !== null) {
      this._staleRows++;
      entry.row = null;
      entry.sourceEl = null;
      entry.countEl = null;
    }
    this._dirty = true;
  }

  /** The rows of entries that left: the first ones, whole blocks at a time where they can. */
  _removeStale() {
    let stale = this._staleRows;
    this._staleRows = 0;
    const chunks = this._chunks;
    const chunkRows = this._chunkRows;
    if (stale >= this._rowCount) {
      this._rows.textContent = '';
      this._rowCount = 0;
      chunks.length = 0;
      chunkRows.length = 0;
      return;
    }
    this._rowCount -= stale;
    while (stale > 0) {
      const rows = chunkRows[0];
      if (stale >= rows) {
        chunks[0].remove();
        chunks.shift();
        chunkRows.shift();
        stale -= rows;
      } else {
        const chunk = chunks[0];
        chunkRows[0] = rows - stale;
        for (; stale > 0; stale--) chunk.firstChild.remove();
      }
    }
  }

  /**
   * Write what changed: rows that left, counts on drawn rows, new rows (into the last block, then new blocks: at most
   * two insertions), the bar, the view.
   */
  _flush() {
    this._dirty = false;
    const log = this.log;
    let rowsChanged = false;
    if (this._staleRows > 0) {
      this._removeStale();
      rowsChanged = true;
    }
    const drawn = log.size - log.fresh;
    if (log.changed) {
      log.changed = false;
      for (let i = 0; i < drawn; i++) {
        const entry = log.entryAt(i);
        if (entry.count !== entry.shownCount) {
          entry.shownCount = entry.count;
          entry.countEl.textContent = countText(entry.count);
          rowsChanged = true;
        }
        if (entry.source !== entry.shownSource) {
          entry.shownSource = entry.source;
          entry.sourceEl.textContent = entry.source;
          const miss = !log.matches(entry);
          if (miss !== entry.miss) {
            entry.miss = miss;
            entry.row.classList.toggle(MISS, miss);
          }
          rowsChanged = true;
        }
      }
    }
    if (log.fresh > 0) {
      const chunks = this._chunks;
      const chunkRows = this._chunkRows;
      const size = log.size;
      let i = drawn;
      let visible = 0;
      const last = chunks.length - 1;
      if (last >= 0 && chunkRows[last] < CHUNK_ROWS) {
        const end = Math.min(size, i + CHUNK_ROWS - chunkRows[last]);
        const fragment = document.createDocumentFragment();
        chunkRows[last] += end - i;
        for (; i < end; i++) {
          if (this._drawRow(fragment, log.entryAt(i))) visible++;
        }
        chunks[last].appendChild(fragment);
      }
      if (i < size) {
        const fragment = document.createDocumentFragment();
        while (i < size) {
          const chunk = document.createElement('div');
          chunk.dataset.consoleRows = '';
          const end = Math.min(size, i + CHUNK_ROWS);
          chunks.push(chunk);
          chunkRows.push(end - i);
          for (; i < end; i++) {
            if (this._drawRow(chunk, log.entryAt(i))) visible++;
          }
          fragment.appendChild(chunk);
        }
        this._rows.appendChild(fragment);
      }
      this._rowCount += log.fresh;
      log.fresh = 0;
      rowsChanged = true;
      if (!this._stick) this._unseen += visible;
    }
    for (let group = 0; group < 3; group++) {
      if (log.counts[group] !== this._shownCounts[group] || log.rows[group] !== this._shownRows[group]) this._writeCount(group);
    }
    if (log.dropped !== this._shownDropped) {
      const dropped = log.dropped;
      this._shownDropped = dropped;
      this._note.hidden = dropped === 0;
      if (dropped > 0) {
        this._note.textContent = `${plural(dropped, 'older row')} dropped: the console keeps the newest ${MAX_ENTRIES.toLocaleString('en-US')}.`;
      }
    }
    if (rowsChanged && this._stick) this._toEnd();
    this._writeNewRows();
  }

  /** Draw an entry's row into `parent`; whether it shows (its group on, the search letting it through). */
  _drawRow(parent, entry) {
    const log = this.log;
    entry.miss = !log.matches(entry);
    parent.appendChild(this._row(entry));
    return !entry.miss && log.shown[entry.group];
  }

  _row(entry) {
    const row = document.createElement('div');
    row.className = (entry.miss ? ROW_CLASS_MISS : ROW_CLASS)[entry.level] || (entry.miss ? ROW_CLASS_MISS.log : ROW_CLASS.log);
    if (entry.entityIndex >= 0) {
      row.dataset.entity = String(entry.entityIndex);
      row.title = ENTITY_TITLE;
    }
    const source = document.createElement('span');
    source.className = 'weed-console-src';
    source.textContent = entry.source;
    const text = document.createElement('span');
    text.className = 'weed-console-text';
    text.textContent = entry.text;
    const count = document.createElement('span');
    count.className = 'weed-console-count';
    count.textContent = countText(entry.count);
    row.append(source, text, count);
    entry.row = row;
    entry.sourceEl = source;
    entry.countEl = count;
    entry.shownCount = entry.count;
    entry.shownSource = entry.source;
    return row;
  }

  _writeCount(group) {
    const calls = this.log.counts[group];
    this._shownCounts[group] = calls;
    this._shownRows[group] = this.log.rows[group];
    this._countEls[group].textContent = shortCount(calls);
    this._writeToggleTitle(group);
  }

  _writeToggleTitle(group) {
    const log = this.log;
    const on = log.shown[group];
    const calls = log.counts[group];
    this._toggles[group].title =
      `${GROUP_NAMES[group]}: ${calls.toLocaleString('en-US')} (${plural(log.rows[group], 'row')}). ` +
      `${on ? 'Click to hide them.' : 'Hidden: click to show them.'}`;
  }

  /** The "↓ new rows" button: shown while the view is scrolled up and rows came since. */
  _writeNewRows() {
    const n = this._stick ? 0 : this._unseen;
    if (n === this._shownUnseen) return;
    this._shownUnseen = n;
    this._newRows.hidden = n === 0;
    if (n > 0) this._newRows.textContent = `↓ ${plural(n, 'new row')}`;
  }

  /** To the end of the list (one layout for the whole batch). */
  _toEnd() {
    const scroller = this._scroller;
    scroller.scrollTop = scroller.scrollHeight;
  }

  _clicked(e) {
    const row = e.target.closest ? e.target.closest('[data-entity]') : null;
    if (!row) return;
    const index = Number(row.dataset.entity);
    const editMode = this.debugUI.editMode;
    if (this.debugUI.scene && index >= 0) editMode.selectFromList(index, true);
  }
}
