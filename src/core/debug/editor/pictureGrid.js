// pictureGrid.js — the picture grid of a sprite or animation param (VISUAL_EDITOR_PLAN.md ED-76), as Unity's object
// picker: the thumbnail beside the field opens the scene's pictures in a grid with a search field, so a house is
// picked by how it looks and not by its number. The grid opens on the family of the name shown (house_12, or the house
// the seed picked when the param is empty: every house_), with the value outlined; a click picks (one undo), Enter
// picks the outlined one, Esc closes, and the arrows move the outline while the search field keeps the focus.
//
// Cost: only the rows in view are built, a few dozen cells reused as the grid scrolls (littleCity's atlas has 1,158
// names), and a cell's thumbnail is drawn when it takes another name, never per frame. One grid at a time; it lives in
// the field's document (the editor page's, in the editor page) and closes when the game page goes (pagehide), so the
// editor page keeps no handler of a page that reloaded.

import { KIND_ANIMATION } from '../../spawnParams.js';

/** A cell's box and its thumbnail, CSS px. */
export const CELL_WIDTH = 76;
export const CELL_HEIGHT = 90;
export const CELL_THUMB = 64;
/** The grid's size when the window has room for it; it is not made shorter than MIN_GRID_HEIGHT (about two rows). */
export const GRID_WIDTH = 412;
export const GRID_HEIGHT = 470;
export const MIN_GRID_HEIGHT = 260;
/** Rows built past each edge of the view, so a scroll shows drawn cells. */
const OVERSCAN = 1;
/** Padding around the cells, px. */
const PAD = 6;

const GRID_STYLE =
  'position:fixed;z-index:100000;display:flex;flex-direction:column;box-sizing:border-box;background:#161a24;' +
  'color:#dfe3ee;border:1px solid rgba(255,255,255,0.14);border-radius:6px;box-shadow:0 12px 36px rgba(0,0,0,0.55);' +
  'font:11px/1.35 system-ui,sans-serif;overflow:hidden';
const FIELD_STYLE =
  'font-size:12px;padding:4px 6px;background:rgba(0,0,0,0.45);color:white;border:1px solid rgba(255,255,255,0.3);' +
  'border-radius:3px;min-width:0;box-sizing:border-box;outline:none';
const CELL_STYLE =
  `position:absolute;left:0;top:0;width:${CELL_WIDTH - 4}px;height:${CELL_HEIGHT - 4}px;box-sizing:border-box;` +
  'display:flex;flex-direction:column;align-items:center;gap:3px;padding:3px 2px;margin:0;background:none;' +
  'border:1px solid transparent;border-radius:4px;color:#c8cddb;cursor:pointer;font:10px/1.2 system-ui,sans-serif';
const THUMB_STYLE =
  `width:${CELL_THUMB}px;height:${CELL_THUMB}px;flex:none;border-radius:3px;` +
  'background:repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 8px 8px';
const LABEL_STYLE = 'display:block;width:100%;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
/** Hover is the only state CSS gives (a style element of the grid's own). */
const HOVER_CSS = '[data-picture-grid] [data-cell]:hover{background:rgba(255,255,255,0.07)}';

/** The cursor's outline, the value's, and the outline of what the entity shows now (the seed's pick). */
const CURSOR_COLOR = '#60a5fa';
const VALUE_COLOR = '#34d399';
const SHOWN_COLOR = 'rgba(52,211,153,0.55)';

/**
 * A name's family: the name without the number it ends with (house_12 → house_, blue_car_7.5 → blue_car_,
 * civil1 → civil); '' when it ends with no number.
 * @param {string} name
 * @returns {string}
 */
export function familyOf(name) {
  const m = typeof name === 'string' ? /^(.*[^\d.])\d+(?:\.\d+)?$/.exec(name) : null;
  return m === null ? '' : m[1];
}

/**
 * The names that hold every word of the query, ignoring case; every name for an empty query.
 * @param {string[]} names
 * @param {string} query
 * @returns {string[]}
 */
export function filterNames(names, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return names;
  const out = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    let all = true;
    for (let w = 0; w < words.length && all; w++) all = lower.includes(words[w]);
    if (all) out.push(name);
  }
  return out;
}

/**
 * The cursor after an arrow, Page Up or Page Down, in a grid of `count` cells `columns` wide (`page` rows to a page).
 * Left and right go along the cells, up and down by a row and stay when there is none that way. Another key, or no
 * cell: the same cursor. With no cursor, any of them goes to the first cell.
 * @returns {number}
 */
export function moveCursor(cursor, key, count, columns, page = 1) {
  if (count === 0) return -1;
  if (!key.startsWith('Arrow') && key !== 'PageDown' && key !== 'PageUp') return cursor;
  if (cursor < 0 || cursor >= count) return 0;
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, cursor + 1);
    case 'ArrowLeft':
      return Math.max(0, cursor - 1);
    case 'ArrowDown':
    case 'PageDown': {
      const by = key === 'ArrowDown' ? columns : columns * Math.max(1, page);
      if (cursor + by < count) return cursor + by;
      // The last row, when the cursor is above it.
      return (((count - 1) / columns) | 0) > ((cursor / columns) | 0) ? count - 1 : cursor;
    }
    case 'ArrowUp':
    case 'PageUp': {
      const by = key === 'ArrowUp' ? columns : columns * Math.max(1, page);
      if (cursor - by >= 0) return cursor - by;
      return key === 'PageUp' ? cursor % columns : cursor;
    }
    default:
      return cursor;
  }
}

/**
 * The cells of the rows a view shows, with a row past each edge: [first, end) of the cell indices.
 * @returns {[number, number]}
 */
export function cellsInView(scrollTop, viewHeight, columns, count) {
  const rows = Math.ceil(count / columns);
  const firstRow = Math.max(0, Math.floor(scrollTop / CELL_HEIGHT) - OVERSCAN);
  const endRow = Math.min(rows, Math.ceil((scrollTop + viewHeight) / CELL_HEIGHT) + OVERSCAN);
  return [Math.min(count, firstRow * columns), Math.min(count, endRow * columns)];
}

/** The grid open now, if any. */
let current = null;

/** Close the grid if one is open (the selection changed, edit mode was left). */
export function closePictureGrid() {
  if (current !== null) current.close();
}

/**
 * Open the grid for a field, closing another first; a second click on the same thumbnail closes it.
 * @param {object} options
 * @param {HTMLElement} options.anchor - the field's thumbnail button: the grid opens by it, in its document
 * @param {number} options.kind - KIND_SPRITE or KIND_ANIMATION
 * @param {import('./assetPicker.js').AssetCatalog} options.catalog - the names and their thumbnails
 * @param {string} options.value - the field's value ('' for none)
 * @param {string} [options.shown] - what the entity shows now: with no value, the grid opens on it (the seed's pick)
 * @param {boolean} [options.none] - a None cell first: the param's default is empty, and empty means the class picks
 * @param {(name: string) => void} options.commit - a pick (not called for the value it already has)
 * @returns {PictureGrid|null} null when it was open for this thumbnail and is closed now
 */
export function togglePictureGrid(options) {
  if (current !== null) {
    const same = current.anchor === options.anchor;
    current.close();
    if (same) return null;
  }
  current = new PictureGrid(options);
  return current;
}

/** The grid: a search field, the cells in view, a line saying what the cursor is on. */
export class PictureGrid {
  constructor({ anchor, kind, catalog, value, shown = '', none = false, commit }) {
    this.anchor = anchor;
    this.kind = kind;
    this.catalog = catalog;
    this.value = typeof value === 'string' ? value : '';
    /** What the entity shows, when the value is empty (the grid opens on it). */
    this.shown = this.value === '' && typeof shown === 'string' ? shown : '';
    this.none = none;
    this.commit = commit;
    this.doc = anchor.ownerDocument;
    this.what = kind === KIND_ANIMATION ? 'animation' : 'sprite';
    /** The grid's element (null once closed) and its parts. */
    this.el = null;
    this._search = null;
    this._count = null;
    this._scroller = null;
    this._spacer = null;
    this._foot = null;
    /** Every name the scene has for the kind; the ones the search holds (the None cell's '' first). */
    this._all = catalog.options(kind).map(([name]) => name);
    /** Animation name → the sheets that have it (the line under the grid). */
    this._sheets = kind === KIND_ANIMATION ? new Map(catalog.options(kind)) : null;
    this._names = [];
    this._columns = 1;
    this._offset = 0;
    this._cursor = -1;
    this._scrollTop = 0;
    this._viewHeight = 0;
    /** Cells by the index they show, and cells out of view to reuse. */
    this._cells = new Map();
    this._free = [];

    this._onOutside = (e) => {
      if (this.el === null || this.el.contains(e.target) || this.anchor.contains(e.target)) return;
      this.close();
    };
    this._onFocusOut = () => {
      // After the focus has moved: away inside this page (or into the game page's frame) closes; another window
      // taking the focus does not.
      setTimeout(() => {
        if (this.el !== null && this.doc.hasFocus() && !this.el.contains(this.doc.activeElement)) this.close();
      }, 0);
    };
    this._onResize = () => this.close();
    this._onPageHide = () => this.close();

    this._build();
    this._search.value = familyOf(this.value || this.shown);
    this._filter(true);
    this._search.focus();
    this._search.select();
  }

  /** Whether the grid is still open. */
  get open() {
    return this.el !== null;
  }

  _build() {
    const doc = this.doc;
    const el = doc.createElement('div');
    el.dataset.pictureGrid = '';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Pick a ${this.what}`);
    el.style.cssText = GRID_STYLE;
    const hover = doc.createElement('style');
    hover.textContent = HOVER_CSS;

    const head = doc.createElement('div');
    head.style.cssText = `display:flex;gap:6px;align-items:center;padding:${PAD}px`;
    const search = doc.createElement('input');
    search.type = 'search';
    search.spellcheck = false;
    search.placeholder = `Search the scene's ${this.what}s`;
    search.setAttribute('aria-label', `Search the scene's ${this.what}s`);
    search.style.cssText = `${FIELD_STYLE};flex:1`;
    const count = doc.createElement('span');
    count.style.cssText = 'font-size:10px;color:#8b92a5;white-space:nowrap';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'debug-ui-btn';
    close.textContent = '×';
    close.title = 'Close (Esc)';
    close.style.cssText = 'flex:none;padding:1px 7px';
    close.onclick = () => this.close();
    head.append(search, count, close);

    const scroller = doc.createElement('div');
    scroller.style.cssText = 'flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative';
    const spacer = doc.createElement('div');
    spacer.style.cssText = 'position:relative;width:100%';
    scroller.appendChild(spacer);

    const foot = doc.createElement('div');
    foot.style.cssText =
      'padding:5px 8px;font-size:10px;color:#9aa1b2;border-top:1px solid rgba(255,255,255,0.08);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    el.append(hover, head, scroller, foot);
    this.el = el;
    this._search = search;
    this._count = count;
    this._scroller = scroller;
    this._spacer = spacer;
    this._foot = foot;

    search.addEventListener('input', () => this._filter(false));
    el.addEventListener('keydown', (e) => this._onKey(e));
    // The search field keeps the focus: a press on a cell, the scroll bar or the frame does not take it.
    el.addEventListener('mousedown', (e) => {
      if (e.target !== search) e.preventDefault();
    });
    el.addEventListener('focusout', this._onFocusOut);
    scroller.addEventListener('scroll', () => {
      this._scrollTop = scroller.scrollTop;
      this._render();
    }, { passive: true });
    spacer.addEventListener('click', (e) => {
      const index = this._indexAt(e.target);
      if (index >= 0) this._pick(this._names[index]);
    });
    spacer.addEventListener('pointerover', (e) => {
      const index = this._indexAt(e.target);
      if (index >= 0) this._describe(index);
    });

    this._place();
    doc.body.appendChild(el);
    // Its size, once: the columns and the rows in view.
    const inner = scroller.clientWidth - 2 * PAD;
    this._columns = Math.max(1, Math.floor(inner / CELL_WIDTH));
    this._offset = PAD + Math.max(0, Math.floor((inner - this._columns * CELL_WIDTH) / 2)) + 2;
    this._viewHeight = scroller.clientHeight;

    doc.addEventListener('pointerdown', this._onOutside, true);
    doc.defaultView?.addEventListener('resize', this._onResize);
    globalThis.addEventListener?.('pagehide', this._onPageHide);
  }

  /**
   * By the thumbnail: under it, as tall as the room there allows down to MIN_GRID_HEIGHT (above it when there is more
   * room above); its left edge kept inside the window. It covers its thumbnail only in a window too small for it.
   */
  _place() {
    const win = this.doc.defaultView;
    const vw = win ? win.innerWidth : GRID_WIDTH + 16;
    const vh = win ? win.innerHeight : GRID_HEIGHT + 16;
    const width = Math.min(GRID_WIDTH, vw - 16);
    const a = this.anchor.getBoundingClientRect();
    const below = vh - 8 - (a.bottom + 4);
    const above = a.top - 4 - 8;
    const down = below >= MIN_GRID_HEIGHT || below >= above;
    const height = Math.max(Math.min(GRID_HEIGHT, down ? below : above), Math.min(MIN_GRID_HEIGHT, vh - 16));
    const top = Math.max(8, Math.min(down ? a.bottom + 4 : a.top - 4 - height, vh - 8 - height));
    const left = Math.max(8, Math.min(a.left, vw - width - 8));
    const style = this.el.style;
    style.left = `${Math.round(left)}px`;
    style.top = `${Math.round(top)}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
  }

  /** The search changed (or the grid opened): the names it holds, the cursor, and the cells again. */
  _filter(opening) {
    const names = filterNames(this._all, this._search.value);
    this._names = this.none ? [''].concat(names) : names;
    this._count.textContent = `${names.length} of ${this._all.length}`;
    for (const cell of this._cells.values()) this._release(cell);
    this._cells.clear();
    const rows = Math.ceil(this._names.length / this._columns);
    this._spacer.style.height = `${rows * CELL_HEIGHT}px`;
    // Opening: on the value, else on what the entity shows, else on None. Typing: the first match past None.
    let cursor = -1;
    if (opening) {
      const at = this.value !== '' ? this.value : this.shown;
      if (at !== '') cursor = this._names.indexOf(at);
      else if (this.none) cursor = 0;
    }
    const firstMatch = this.none ? 1 : 0;
    if (cursor < 0) cursor = this._names.length > firstMatch ? firstMatch : this._names.length - 1;
    this._cursor = cursor;
    this._scrollTop = 0;
    this._scroller.scrollTop = 0;
    if (cursor >= 0) this._reveal(cursor, opening);
    this._render();
    if (cursor >= 0) this._describe(cursor);
    else this._foot.textContent = this._all.length === 0 ? `This scene loaded no ${this.what}s` : `No ${this.what} holds “${this._search.value.trim()}”`;
  }

  /** Build the cells of the rows in view; let go of the others. */
  _render() {
    const [first, end] = cellsInView(this._scrollTop, this._viewHeight, this._columns, this._names.length);
    for (const [index, cell] of this._cells) {
      if (index < first || index >= end) {
        this._cells.delete(index);
        this._release(cell);
      }
    }
    for (let i = first; i < end; i++) {
      if (this._cells.has(i)) continue;
      const cell = this._free.length > 0 ? this._free.pop() : this._newCell();
      cell.el.style.display = '';
      this._assign(cell, i);
      this._cells.set(i, cell);
    }
  }

  _newCell() {
    const doc = this.doc;
    const el = doc.createElement('button');
    el.type = 'button';
    el.tabIndex = -1;
    el.dataset.cell = '';
    el.style.cssText = CELL_STYLE;
    const canvas = doc.createElement('canvas');
    const ratio = Math.min(2, Math.max(1, doc.defaultView?.devicePixelRatio || 1));
    canvas.width = Math.round(CELL_THUMB * ratio);
    canvas.height = canvas.width;
    canvas.style.cssText = THUMB_STYLE;
    const label = doc.createElement('span');
    label.style.cssText = LABEL_STYLE;
    el.append(canvas, label);
    this._spacer.appendChild(el);
    return { el, canvas, label, name: null, index: -1 };
  }

  _release(cell) {
    cell.el.style.display = 'none';
    cell.index = -1;
    this._free.push(cell);
  }

  /** A cell shows the name at `index`: placed, its thumbnail drawn when the name is another, outlined as it is. */
  _assign(cell, index) {
    const name = this._names[index];
    cell.index = index;
    cell.el.dataset.index = String(index);
    const x = this._offset + (index % this._columns) * CELL_WIDTH;
    const y = ((index / this._columns) | 0) * CELL_HEIGHT;
    cell.el.style.transform = `translate(${x}px,${y}px)`;
    if (cell.name !== name) {
      cell.name = name;
      if (name === '') {
        drawNone(cell.canvas);
        cell.label.textContent = 'None';
        cell.el.title = `None: the class picks the ${this.what}`;
      } else {
        this.catalog.drawThumbnail(cell.canvas, this.kind, name);
        cell.label.textContent = name;
        cell.el.title = name;
      }
    }
    this._outline(cell);
  }

  _outline(cell) {
    const name = cell.name;
    const cursor = cell.index === this._cursor;
    const value = name === this.value && (name !== '' || this.none);
    const shown = !value && name !== '' && name === this.shown;
    const style = cell.el.style;
    style.borderColor = cursor ? CURSOR_COLOR : value ? VALUE_COLOR : shown ? SHOWN_COLOR : 'transparent';
    style.borderStyle = shown && !cursor ? 'dashed' : 'solid';
    style.background = cursor ? 'rgba(96,165,250,0.16)' : '';
    cell.el.setAttribute('aria-selected', cursor ? 'true' : 'false');
  }

  /** The cell index of a cell or anything in it; -1 elsewhere. */
  _indexAt(target) {
    const cell = target && typeof target.closest === 'function' ? target.closest('[data-cell]') : null;
    if (!cell) return -1;
    const index = Number(cell.dataset.index);
    return Number.isInteger(index) && index >= 0 && index < this._names.length ? index : -1;
  }

  /** The line under the grid: what a cell is (the value, what is shown now), and the keys. */
  _describe(index) {
    const name = this._names[index];
    let text = name === '' ? `None: the class picks the ${this.what}` : name;
    if (this._sheets !== null && name !== '') text += ` · ${this._sheets.get(name)}`;
    if (name === this.value && (name !== '' || this.none)) text += ' · the value';
    else if (name !== '' && name === this.shown) text += ' · shown now';
    this._foot.textContent = `${text}   ·   click or Enter picks, Esc closes`;
  }

  /** Move the cursor, keep it in view. */
  _moveTo(index) {
    const before = this._cells.get(this._cursor);
    this._cursor = index;
    if (before) this._outline(before);
    this._reveal(index, false);
    this._render();
    const now = this._cells.get(index);
    if (now) this._outline(now);
    this._describe(index);
  }

  /** Scroll so the cell's row shows (opening: in the middle of the view). */
  _reveal(index, center) {
    const top = ((index / this._columns) | 0) * CELL_HEIGHT;
    let scroll = this._scrollTop;
    if (center) scroll = Math.max(0, top - Math.max(0, (this._viewHeight - CELL_HEIGHT) / 2));
    else if (top < scroll) scroll = top;
    else if (top + CELL_HEIGHT > scroll + this._viewHeight) scroll = top + CELL_HEIGHT - this._viewHeight;
    scroll = Math.round(scroll);
    if (scroll !== this._scrollTop) {
      this._scrollTop = scroll;
      this._scroller.scrollTop = scroll;
    }
  }

  _onKey(e) {
    const key = e.key;
    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.anchor.focus?.();
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (this._cursor >= 0) this._pick(this._names[this._cursor]);
      return;
    }
    if (!key.startsWith('Arrow') && key !== 'PageDown' && key !== 'PageUp') return;
    e.preventDefault();
    e.stopPropagation();
    const page = Math.max(1, Math.floor(this._viewHeight / CELL_HEIGHT));
    const next = moveCursor(this._cursor, key, this._names.length, this._columns, page);
    if (next !== this._cursor && next >= 0) this._moveTo(next);
  }

  _pick(name) {
    const commit = this.commit;
    const changed = name !== this.value;
    this.close();
    if (changed) commit(name);
  }

  close() {
    if (current === this) current = null;
    if (this.el === null) return;
    this.doc.removeEventListener('pointerdown', this._onOutside, true);
    this.doc.defaultView?.removeEventListener('resize', this._onResize);
    globalThis.removeEventListener?.('pagehide', this._onPageHide);
    this.el.remove();
    this.el = null;
    this._cells.clear();
    this._free.length = 0;
  }
}

/** The None cell's picture: a crossed circle. */
function drawNone(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const r = Math.round(Math.min(w, h) * 0.28);
  const cx = w >> 1;
  const cy = h >> 1;
  ctx.strokeStyle = '#8b92a5';
  ctx.lineWidth = Math.max(2, Math.round(w / 32));
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.moveTo(cx - r, cy + r);
  ctx.lineTo(cx + r, cy - r);
  ctx.stroke();
}
