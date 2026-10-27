// entityTree.js — the editor page's scene list (VISUAL_EDITOR_PLAN.md D9, ED-15): the running scene's entities
// grouped by class, in the order the scene registers them. A group lists what the running scene file places (its
// records, by name, with the live entity each has, or none) and then what code spawned (live entities the file does
// not name, by index: read-only). Groups open and close; a click selects (while playing too: ED-17), a double click
// centers the view on the entity.
//
// A filter over the list (ED-62; Ctrl+F while the list has the focus) keeps the rows whose name or class holds what
// is typed, case aside: they show under their classes, unfolded, each class with its count. Esc clears it, and the
// groups are as they were.
//
// Only the rows in view are drawn: a spacer as tall as every row, and a few row elements placed over it and reused.
// Each remembers what it shows, and is written only when that changes. A scene of tens of thousands of entities costs
// the rows on screen.
//
// Refreshed at the debug UI's interval: one pass over the slots counts each group's runtime entities into an index
// list made once per class, and a signature per group (the live slots and their generations) tells whether to draw
// again. The document's lists are made again only when it changes (invalidate). Nothing is allocated per refresh.
// The filter runs over the names, lowercased once per document, into an index list per class kept from one query to
// the next: a keystroke allocates the query's own string, nothing else.

import { Transform } from '../../../components/transform.js';
import { Messages } from '../../messages.js';

/** Height of a row, px: the view places rows by it. */
export const ROW_HEIGHT = 20;

/** Classes the editor does not list: the engine's own helpers. */
const UNLISTED = new Set(['Flash']);

export const ROW_GROUP = 0;
export const ROW_AUTHORED = 1;
export const ROW_RUNTIME = 2;

/** A group's lowercased names and filter matches, until the filter first needs them. */
const NO_NAMES = Object.freeze([]);
const NO_INDEXES = new Int32Array(0);

const lowerOf = (name) => name.toLowerCase();

/** Where `value` is in the ascending `list[0..count)`, or -1. */
function search(list, count, value) {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = list[mid];
    if (at === value) return mid;
    if (at < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The tree's rows, without the DOM: groups of authored records and runtime entities, as one list of rows; with a
 * filter, only the rows that match it.
 */
export class TreeModel {
  constructor() {
    /** @type {{ name: string, lowerName: string, start: number, end: number, open: boolean, authored: string[],
     *   authoredLower: string[], runtime: Int32Array, runtimeCount: number, signature: number, matchAll: boolean,
     *   matched: Int32Array, matchedCount: number, folded: boolean }[]} */
    this.groups = [];
    /** Per slot, 1 when the running file names the live entity there. */
    this._named = new Uint8Array(0);
    /** Where locate() writes: the row's kind, its group, and its item in the group (a record or a runtime entity). */
    this.cursor = { kind: ROW_GROUP, group: null, item: 0 };
    /** The filter (ED-62), trimmed and lowercased; '' lists everything. */
    this.query = '';
    /** How many entity rows match the filter, every class together (0 without one). */
    this.matchCount = 0;
  }

  /** The groups from the scene's classes, and their records from its file. Open groups stay open. */
  build(scene) {
    const wasOpen = new Set();
    for (const group of this.groups) if (group.open) wasOpen.add(group.name);
    const byName = new Map();
    const groups = [];
    for (const { class: EntityClass } of scene?.registeredClasses || []) {
      const name = EntityClass.name;
      if (UNLISTED.has(name)) continue;
      const start = EntityClass.startIndex | 0;
      const end = EntityClass.endIndex ?? start + (EntityClass.poolSize | 0);
      const old = this.groups.find((g) => g.name === name && g.end - g.start === end - start);
      const group = {
        name,
        lowerName: name.toLowerCase(),
        start,
        end,
        open: wasOpen.has(name),
        authored: [],
        // The filter's: the names lowercased (made when it first runs over this document), and the positions in
        // `authored` that match, a list kept from one document to the next.
        authoredLower: NO_NAMES,
        runtime: old ? old.runtime : new Int32Array(end - start),
        runtimeCount: 0,
        signature: 0,
        matchAll: false,
        matched: old ? old.matched : NO_INDEXES,
        matchedCount: 0,
        folded: old ? old.folded : false,
      };
      groups.push(group);
      byName.set(name, group);
    }
    for (const record of scene?.sceneFile?.entities || []) byName.get(record.class)?.authored.push(record.name);
    this.groups = groups;
    let slots = 0;
    for (const group of groups) if (group.end > slots) slots = group.end;
    if (this._named.length < slots) this._named = new Uint8Array(slots);
    if (this.query !== '') this._applyFilter();
  }

  clear() {
    this.groups = [];
    this.matchCount = 0;
  }

  /**
   * Count the runtime entities of every group again (live, and not named by the running file).
   * @returns {boolean} whether any group differs from the last refresh
   */
  refresh(scene) {
    const named = this._named;
    named.fill(0);
    const names = scene?._namedEntities;
    const active = Transform.active;
    const gens = Messages.spawnGen;
    if (names) {
      for (const packed of names.values()) {
        const i = Math.floor(packed / 65536);
        if (i < named.length && gens[i] === packed - i * 65536) named[i] = 1;
      }
    }
    let changed = false;
    for (const group of this.groups) {
      let count = 0;
      let signature = 0;
      const list = group.runtime;
      for (let i = group.start; i < group.end; i++) {
        if (!active || !active[i] || named[i]) continue;
        list[count++] = i;
        signature = (Math.imul(signature, 31) + i * 65536 + (gens[i] | 0)) | 0;
      }
      // The file's entities live or not (despawned, a full pool).
      for (const name of group.authored) {
        const packed = names?.get(name);
        const i = packed === undefined ? -1 : Math.floor(packed / 65536);
        const live = i >= 0 && gens[i] === packed - i * 65536 && active && active[i] ? 1 : 0;
        signature = (Math.imul(signature, 31) + live) | 0;
      }
      if (count !== group.runtimeCount || signature !== group.signature) changed = true;
      group.runtimeCount = count;
      group.signature = signature;
    }
    if (this.query !== '') this._countMatches(); // a class that matches shows its runtime entities, as many as live
    return changed;
  }

  /**
   * Filter the rows (ED-62): those whose name or class holds `text`, case aside. A class that matches shows all of
   * its rows; another, its records whose name matches (a runtime entity has no name). Groups with no match are not
   * listed; the others show unfolded. '' lists everything again, each group open or closed as it was.
   * @param {string} text
   * @returns {boolean} whether the filter changed
   */
  setFilter(text) {
    const query = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (query === this.query) return false;
    this.query = query;
    for (const group of this.groups) group.folded = false;
    this._applyFilter();
    return true;
  }

  /** Each group's matches, into its index list: allocates only the first time a list is too short. */
  _applyFilter() {
    const query = this.query;
    for (const group of this.groups) {
      group.matchedCount = 0;
      group.matchAll = query !== '' && group.lowerName.includes(query);
      if (query === '' || group.matchAll) continue;
      const names = group.authored;
      if (group.authoredLower.length !== names.length) group.authoredLower = names.map(lowerOf);
      if (group.matched.length < names.length) group.matched = new Int32Array(names.length);
      const lower = group.authoredLower;
      const matched = group.matched;
      let n = 0;
      for (let k = 0; k < lower.length; k++) if (lower[k].includes(query)) matched[n++] = k;
      group.matchedCount = n;
    }
    this._countMatches();
  }

  _countMatches() {
    let total = 0;
    if (this.query !== '') for (const group of this.groups) total += this.matchesOf(group);
    this.matchCount = total;
  }

  /** How many entity rows of a group the filter keeps (all of them without one). */
  matchesOf(group) {
    return this.query === '' || group.matchAll ? group.authored.length + group.runtimeCount : group.matchedCount;
  }

  /** Whether a group shows its rows: open, or under a filter, not folded. */
  isOpen(group) {
    return this.query === '' ? group.open : !group.folded;
  }

  /** Open or close a group; under a filter, fold or unfold it until the filter changes. */
  toggle(group) {
    if (this.query === '') group.open = !group.open;
    else group.folded = !group.folded;
  }

  /** The rows a group takes: its own and, open, its entities'; none under a filter that keeps none of them. */
  _rowsOf(group) {
    if (this.query === '') return 1 + (group.open ? group.authored.length + group.runtimeCount : 0);
    const items = this.matchesOf(group);
    return items === 0 ? 0 : 1 + (group.folded ? 0 : items);
  }

  /** How many rows: each group, and the records and runtime entities of the open ones (with a filter, its). */
  get rowCount() {
    let rows = 0;
    for (const group of this.groups) rows += this._rowsOf(group);
    return rows;
  }

  /**
   * What row `row` shows, into `this.cursor`; null past the last row. A record's item is its place in the group's
   * `authored`, a runtime entity's in its `runtime`, with a filter as without.
   * @param {number} row
   */
  locate(row) {
    let r = row;
    for (const group of this.groups) {
      const rows = this._rowsOf(group);
      if (rows === 0) continue;
      if (r === 0) return this._at(ROW_GROUP, group, 0);
      if (r < rows) {
        const k = r - 1;
        if (this.query !== '' && !group.matchAll) return this._at(ROW_AUTHORED, group, group.matched[k]);
        if (k < group.authored.length) return this._at(ROW_AUTHORED, group, k);
        return this._at(ROW_RUNTIME, group, k - group.authored.length);
      }
      r -= rows;
    }
    return null;
  }

  /**
   * The row an entity shows on in the list as it is (its record's row when the file names it), or -1: its group
   * closed, the filter leaves it out, or it is not listed. Opens nothing.
   * @param {number} index
   * @param {string|null} name - its name in the running file, or null
   */
  rowOf(index, name) {
    let row = 0;
    for (const group of this.groups) {
      const rows = this._rowsOf(group);
      if (index >= group.start && index < group.end) {
        if (rows <= 1) return -1;
        const k = this._itemOf(group, index, name);
        return k < 0 ? -1 : row + 1 + k;
      }
      row += rows;
    }
    return -1;
  }

  /** Where an entity is among the rows its open group shows, or -1. */
  _itemOf(group, index, name) {
    const filtered = this.query !== '' && !group.matchAll;
    if (name !== null) {
      const k = group.authored.indexOf(name);
      if (k >= 0) return filtered ? search(group.matched, group.matchedCount, k) : k;
    }
    if (filtered) return -1; // a runtime entity has no name to match
    const at = search(group.runtime, group.runtimeCount, index);
    return at < 0 ? -1 : group.authored.length + at;
  }

  /**
   * The row of an entity (its record's row when the file names it), opening its group (under a filter, unfolding
   * it); -1 when it is not listed, or the filter leaves it out.
   * @param {number} index
   * @param {string|null} name - its name in the running file, or null
   */
  reveal(index, name) {
    for (const group of this.groups) {
      if (index < group.start || index >= group.end) continue;
      if (this.query === '') group.open = true;
      else group.folded = false;
      break;
    }
    return this.rowOf(index, name);
  }

  _at(kind, group, item) {
    const cursor = this.cursor;
    cursor.kind = kind;
    cursor.group = group;
    cursor.item = item;
    return cursor;
  }
}

/** The live index of the entity the running file names `name`, or -1. */
function liveIndexOf(scene, name) {
  const packed = scene?._namedEntities?.get(name);
  if (packed === undefined) return -1;
  const i = Math.floor(packed / 65536);
  return Messages.spawnGen[i] === packed - i * 65536 && Transform.active?.[i] ? i : -1;
}

/** After the row of an entity on a locked layer: the view does not pick it, the move tool leaves it (ED-24). */
const LOCKED_MARK = '  🔒 locked';

const ROW_STYLE =
  'position:absolute;left:0;right:0;height:20px;line-height:20px;padding:0 8px;box-sizing:border-box;' +
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;font-size:12px';

/** The editor page's colors (shell/editorShell.css). */
const TEXT = '#d6d9e2';
const DIM = '#8a90a0';
const LINE = '#262b38';
const SELECTED = 'rgba(74,222,128,0.18)';

/** The list's rules that inline styles cannot say, in the list's document: a row under the pointer, a field's focus. */
const STYLE_ID = 'weed-editor-tree';
const STYLES =
  `.weed-tree-row:hover{background-color:rgba(255,255,255,0.05)}` +
  `.weed-tree-filter:focus{border-color:#4ade80;outline:none}` +
  `.weed-tree-filter::placeholder{color:#6b7080}` +
  `.weed-tree-clear:hover{color:${TEXT}}` +
  `.weed-tree-list:focus-visible{box-shadow:inset 0 0 0 1px rgba(74,222,128,0.4)}`;

const SEARCH_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round"/></svg>';

// What a row is (RowShown.flags).
const F_OPEN = 1;
const F_FILTERED = 2;
const F_LIVE = 4;
const F_SELECTED = 8;
const F_LOCKED = 16;

/** What a row element shows, so that a render writes only what changed. */
class RowShown {
  constructor() {
    /** The list's row it shows, or -1: hidden. */
    this.row = -1;
    this.kind = -1;
    /** Its group's name, or its record's. */
    this.name = '';
    /** The live entity, or -1. */
    this.index = -1;
    this.flags = 0;
    // A group row's counts: placed, runtime, and what the filter keeps.
    this.placed = -1;
    this.runtime = -1;
    this.matches = -1;
    // What is written.
    this.text = '';
    this.color = '';
    this.background = '';
    this.indent = -1;
    this.title = '';
  }
}

export class EntityTree {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.model = new TreeModel();
    this._scene = null;
    this._documentChanged = false;

    this.el = document.createElement('div');
    this.el.className = 'weed-tree';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0';

    // The filter (ED-62): a field, the count it keeps, a button that clears it.
    this._bar = document.createElement('div');
    this._bar.style.cssText = `flex:none;display:flex;align-items:center;gap:5px;padding:4px 6px 4px 8px;border-bottom:1px solid ${LINE}`;
    const icon = document.createElement('span');
    icon.style.cssText = `flex:none;display:flex;color:${DIM}`;
    icon.innerHTML = SEARCH_ICON;
    icon.title = 'Filter the list: Ctrl+F while it has the focus';
    this._filter = document.createElement('input');
    this._filter.type = 'text';
    this._filter.className = 'weed-tree-filter';
    this._filter.placeholder = 'Filter by name or class';
    this._filter.spellcheck = false;
    this._filter.autocomplete = 'off';
    this._filter.title =
      'Show the entities whose name or class holds this, case aside (Ctrl+F in the list). ↓ or Enter: to the list; Esc clears it';
    this._filter.style.cssText =
      `flex:1;min-width:0;font:12px system-ui,-apple-system,'Segoe UI',sans-serif;color:#e3e6ee;background:#0b0d12;` +
      'border:1px solid #343a4c;border-radius:4px;padding:2px 6px';
    this._count = document.createElement('span');
    this._count.style.cssText = `flex:none;color:${DIM};font-size:11px;white-space:nowrap`;
    this._clear = document.createElement('button');
    this._clear.type = 'button';
    this._clear.className = 'weed-tree-clear';
    this._clear.textContent = '×';
    this._clear.title = 'Clear the filter (Esc)';
    this._clear.style.cssText =
      `flex:none;display:none;font:15px/1 system-ui,sans-serif;color:${DIM};background:none;border:0;padding:0 2px;cursor:pointer`;
    this._bar.append(icon, this._filter, this._count, this._clear);

    // The rows: the list scrolls, the spacer is as tall as all of them.
    this._list = document.createElement('div');
    this._list.className = 'weed-tree-list';
    this._list.tabIndex = 0;
    this._list.style.cssText = 'flex:1;min-height:0;overflow:auto;position:relative;outline:none';
    this._spacer = document.createElement('div');
    this._spacer.style.cssText = 'position:relative;height:0';
    this._list.appendChild(this._spacer);
    this.el.append(this._bar, this._list);
    /** Row elements, reused: as many as fit in view; and what each shows. */
    this._rows = [];
    /** @type {RowShown[]} */
    this._shown = [];
    /** What is written: the spacer's height, the count, whether the clear button shows. */
    this._spacerHeight = -1;
    this._countText = '';
    this._clearShown = false;
    /** The list's rules are in its document. */
    this._styled = false;

    this._onScroll = () => this.render();
    this._onClick = (e) => this._clicked(e, false);
    this._onDoubleClick = (e) => this._clicked(e, true);
    this._onKeyDown = (e) => this._keyDown(e);
    this._onFilterInput = () => this._filterChanged();
    this._onClearClick = () => {
      this.clearFilter();
      this._filter.focus();
    };
    this._list.addEventListener('scroll', this._onScroll);
    this._list.addEventListener('click', this._onClick);
    this._list.addEventListener('dblclick', this._onDoubleClick);
    this.el.addEventListener('keydown', this._onKeyDown);
    this._filter.addEventListener('input', this._onFilterInput);
    this._clear.addEventListener('click', this._onClearClick);
    this._style();
  }

  attach(scene) {
    this._scene = scene;
    this.model.build(scene);
    this.model.refresh(scene);
    this._style();
    this.render();
  }

  detach() {
    this._scene = null;
    this.model.clear();
    this.render();
  }

  /** The document changed: its records are listed again at the next update. */
  invalidate() {
    this._documentChanged = true;
  }

  /** The debug UI's tick: draw again when the document or a group changed. */
  update() {
    const scene = this._scene;
    if (scene === null) return;
    let changed = false;
    if (this._documentChanged) {
      this._documentChanged = false;
      this.model.build(scene);
      changed = true;
    }
    if (this.model.refresh(scene) || changed) this.render();
  }

  /** The selection changed: open its group, scroll it into view, mark it. */
  onSelectionChanged() {
    const selection = this.debugUI.editMode.selection;
    if (this._scene !== null && selection.index >= 0) {
      this._fresh();
      const row = this.model.reveal(selection.index, selection.name);
      if (row >= 0) this._scrollToRow(row);
    }
    this.render();
  }

  // ---- the filter (ED-62) ----

  /** Put the focus in the filter, its text selected (Ctrl+F). */
  focusFilter() {
    this._filter.focus();
    this._filter.select();
  }

  /** Show every row again: the groups as they were, the selection in its place. */
  clearFilter() {
    if (this._filter.value !== '') this._filter.value = '';
    if (this.model.setFilter('')) this._filterShown(true);
    else this._showFilter(); // only spaces were typed: the same rows, no clear button
  }

  /** A keystroke in the filter: the rows it keeps, from the top. */
  _filterChanged() {
    if (this.model.setFilter(this._filter.value)) this._filterShown(this.model.query === '');
    else this._showFilter(); // spaces around it: the same rows
  }

  /** The filter changed: from the top of what it keeps; cleared, back to the selection. */
  _filterShown(cleared) {
    let top = 0;
    const selection = this.debugUI.editMode.selection;
    if (cleared && selection.index >= 0) {
      const row = this.model.reveal(selection.index, selection.name);
      if (row >= 0) top = Math.max(0, row * ROW_HEIGHT - (this._list.clientHeight >> 1));
    }
    this._sizeSpacer(this.model.rowCount);
    if (this._list.scrollTop !== top) this._list.scrollTop = top;
    this.render();
  }

  /** The count of what the filter keeps, and the clear button; written only on change. */
  _showFilter() {
    const query = this.model.query;
    const text = query === '' ? '' : String(this.model.matchCount);
    if (text !== this._countText) {
      this._countText = text;
      this._count.textContent = text;
      this._count.title = query === '' ? '' : `${text} ${text === '1' ? 'entity matches' : 'entities match'} “${query}”`;
    }
    const clear = query !== '' || this._filter.value !== '';
    if (clear !== this._clearShown) {
      this._clearShown = clear;
      this._clear.style.display = clear ? '' : 'none';
    }
  }

  // ---- keys ----

  /**
   * A key typed in the list or its filter. The keys it takes stop here: none reaches the editor's own keys (the
   * editor page passes keys on from its window, HostedEditor.onHostKey), so each has one action.
   */
  _keyDown(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = false;
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      this.focusFilter();
      handled = true;
    } else if (e.target === this._filter) {
      handled = this._filterKey(e);
    } else if (e.target === this._list) {
      handled = this._listKey(e);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** In the filter: Esc clears it (empty, back to the list); ↓ and Enter go to the list. */
  _filterKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Escape') {
      if (this._filter.value !== '' || this.model.query !== '') this.clearFilter();
      else this._list.focus();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      this._list.focus();
      return true;
    }
    return false;
  }

  /** In the list: Esc clears a filter (without one, it is the editor's: it lets go of the selection). */
  _listKey(e) {
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && this.model.query !== '') {
      this.clearFilter();
      return true;
    }
    return false;
  }

  // ---- drawing ----

  /** Draw the rows in view. */
  render() {
    this._style();
    const model = this.model;
    const total = model.rowCount;
    this._sizeSpacer(total);
    const list = this._list;
    const first = Math.floor(list.scrollTop / ROW_HEIGHT);
    const fit = Math.ceil((list.clientHeight || 400) / ROW_HEIGHT) + 1;
    while (this._rows.length < fit) this._addRow();
    for (let k = 0; k < this._rows.length; k++) {
      const r = first + k;
      this._fill(k, r, r < total ? model.locate(r) : null);
    }
    this._showFilter();
  }

  _sizeSpacer(total) {
    const height = total * ROW_HEIGHT;
    if (height === this._spacerHeight) return;
    this._spacerHeight = height;
    this._spacer.style.height = `${height}px`;
  }

  /** Scroll so that a row shows. */
  _scrollToRow(row) {
    this._sizeSpacer(this.model.rowCount);
    const list = this._list;
    const top = row * ROW_HEIGHT;
    const view = list.clientHeight;
    if (top < list.scrollTop || top + ROW_HEIGHT > list.scrollTop + view) list.scrollTop = Math.max(0, top - (view >> 1));
  }

  _addRow() {
    const row = document.createElement('div');
    row.className = 'weed-tree-row';
    row.style.cssText = ROW_STYLE;
    row.style.display = 'none';
    this._spacer.appendChild(row);
    this._rows.push(row);
    this._shown.push(new RowShown());
  }

  /** Row element `k` shows list row `r` (`at`: what it is, null for none). */
  _fill(k, r, at) {
    const el = this._rows[k];
    const shown = this._shown[k];
    if (at === null) {
      if (shown.row !== -1) {
        shown.row = -1;
        el.style.display = 'none';
      }
      return;
    }
    if (shown.row === -1) el.style.display = '';
    if (shown.row !== r) {
      shown.row = r;
      el.style.top = `${r * ROW_HEIGHT}px`;
      el.dataset.row = String(r);
    }
    const model = this.model;
    const editMode = this.debugUI.editMode;
    const group = at.group;
    const kind = at.kind;
    let name = group.name;
    let index = -1;
    let flags = 0;
    let placed = 0;
    let runtime = 0;
    let matches = 0;
    if (kind === ROW_GROUP) {
      if (model.isOpen(group)) flags |= F_OPEN;
      if (model.query !== '') flags |= F_FILTERED;
      placed = group.authored.length;
      runtime = group.runtimeCount;
      matches = model.matchesOf(group);
    } else {
      const selection = editMode.selection;
      if (kind === ROW_AUTHORED) {
        name = group.authored[at.item];
        index = liveIndexOf(this._scene, name);
        if ((selection.name === name && selection.index >= 0) || editMode.multi?.has(name) === true) flags |= F_SELECTED;
      } else {
        index = group.runtime[at.item];
        if (selection.index === index && selection.name === null) flags |= F_SELECTED;
      }
      if (index >= 0) {
        flags |= F_LIVE;
        // A locked layer's entity is marked (editorLayers.js, ED-24).
        if (editMode.layers?.locked(index)) flags |= F_LOCKED;
      }
    }
    if (
      shown.kind === kind &&
      shown.name === name &&
      shown.index === index &&
      shown.flags === flags &&
      shown.placed === placed &&
      shown.runtime === runtime &&
      shown.matches === matches
    ) {
      return;
    }
    shown.kind = kind;
    shown.name = name;
    shown.index = index;
    shown.flags = flags;
    shown.placed = placed;
    shown.runtime = runtime;
    shown.matches = matches;
    this._write(el, shown);
  }

  /** Write a row's text and look from what it shows, each only when it changed. */
  _write(el, shown) {
    const { kind, name, index, flags } = shown;
    let text;
    let color = TEXT;
    let indent = 22;
    let title;
    if (kind === ROW_GROUP) {
      const arrow = (flags & F_OPEN) !== 0 ? '▾' : '▸';
      text =
        (flags & F_FILTERED) !== 0
          ? `${arrow} ${name}  ·  ${shown.matches} of ${shown.placed + shown.runtime} match`
          : `${arrow} ${name}  ·  ${shown.placed} placed, ${shown.runtime} runtime`;
      color = '#9aa2b4';
      indent = 8;
      title = `${name}: ${shown.placed} placed by the scene file, ${shown.runtime} spawned by code. A click folds or unfolds it`;
    } else if (kind === ROW_AUTHORED) {
      text = index >= 0 ? `${name}  #${index}` : `${name}  (not live)`;
      if (index < 0) color = '#6b7080';
      title =
        index >= 0
          ? 'Placed by the scene file. A click selects it, a double click centers the view on it'
          : 'Placed by the scene file, but not live: its pool may be full';
    } else {
      text = `#${index}  runtime`;
      color = DIM;
      title = 'Spawned by code, not by the scene file: read-only. A click selects it, a double click centers the view on it';
    }
    if ((flags & F_LOCKED) !== 0) text += LOCKED_MARK;
    const background = (flags & F_SELECTED) !== 0 ? SELECTED : '';
    if (shown.text !== text) el.textContent = shown.text = text;
    if (shown.color !== color) el.style.color = shown.color = color;
    if (shown.background !== background) el.style.background = shown.background = background;
    if (shown.indent !== indent) {
      shown.indent = indent;
      el.style.paddingLeft = `${indent}px`;
    }
    if (shown.title !== title) el.title = shown.title = title;
  }

  // ---- pointer ----

  _clicked(e, double) {
    const el = e.target?.closest ? e.target.closest('[data-row]') : null;
    if (!el || this._scene === null) return;
    const at = this.model.locate(Number(el.dataset.row));
    if (at === null) return;
    if (at.kind === ROW_GROUP) {
      if (double) return;
      this.model.toggle(at.group);
      this.render();
      return;
    }
    const index =
      at.kind === ROW_AUTHORED ? liveIndexOf(this._scene, at.group.authored[at.item]) : at.group.runtime[at.item];
    const editMode = this.debugUI.editMode;
    if (index < 0) {
      editMode._setStatus(`${at.group.authored[at.item]} is not live: its pool may be full`, true);
      return;
    }
    editMode.selectFromList(index, double);
  }

  // ---- upkeep ----

  /** The document changed since the lists were made: make them again now (a key or a selection needs its rows). */
  _fresh() {
    if (!this._documentChanged || this._scene === null) return;
    this._documentChanged = false;
    this.model.build(this._scene);
    this.model.refresh(this._scene);
  }

  /**
   * The list's rules, once, in the document the list is in: in the editor page, through its host (the page keeps the
   * text in a style element of its own, D9); else into this page's head.
   */
  _style() {
    if (this._styled) return;
    const host = this.debugUI.hosted?.host;
    if (host && typeof host.addStyles === 'function') {
      host.addStyles(STYLE_ID, STYLES);
      this._styled = true;
      return;
    }
    const doc = this.el.ownerDocument;
    if (!doc?.head || typeof doc.createElement !== 'function' || typeof doc.getElementById !== 'function') return;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLES;
      doc.head.appendChild(style);
    }
    this._styled = true;
  }

  destroy() {
    this._list.removeEventListener('scroll', this._onScroll);
    this._list.removeEventListener('click', this._onClick);
    this._list.removeEventListener('dblclick', this._onDoubleClick);
    this.el.removeEventListener('keydown', this._onKeyDown);
    this._filter.removeEventListener('input', this._onFilterInput);
    this._clear.removeEventListener('click', this._onClearClick);
  }
}
