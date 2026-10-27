// entityTree.js — the editor page's scene list (VISUAL_EDITOR_PLAN.md D9, ED-15): the running scene's entities
// grouped by class, in the order the scene registers them. A group lists what the running scene file places (its
// records, by name, with the live entity each has, or none) and then what code spawned (live entities the file does
// not name, by index: read-only). Groups open and close; a click selects one entity (while playing too: ED-17), and
// Shift or Ctrl+click adds a placed one to the selection or takes it out; a double click frames it.
//
// A filter over the list (ED-62; Ctrl+F while the list has the focus) keeps the rows whose name or class holds what
// is typed, case aside: they show under their classes, unfolded, each class with its count. Esc clears it, and the
// groups are as they were.
//
// Keys while the list has the focus (ED-63): ↑ and ↓ move the selection along the rows shown, Enter frames it, F2
// renames it in a field over its row, Del deletes and Ctrl+D duplicates what is selected (the editor's own commands:
// several selected, all of them, one undo). An edit while the game plays enters edit mode first, as the Assets dock's
// + does. The keys the list takes stop at it, so the editor's own keys (which the editor page passes on from its
// window) do not act on them a second time; ← → and the rest go on to the editor.
//
// A right click on a row (ED-64; the ContextMenu key or Shift+F10 for the selection's) opens its menu (treeMenu.js):
// Frame, Rename, Duplicate, Copy, Delete and Select all of its class; on a runtime entity, Frame and Select all.
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
import {
  TreeMenu,
  menuFor,
  ITEM_FRAME,
  ITEM_RENAME,
  ITEM_DUPLICATE,
  ITEM_COPY,
  ITEM_DELETE,
  ITEM_SELECT_ALL,
  TARGET_GROUP,
  TARGET_PLACED,
  TARGET_RUNTIME,
  TARGET_NOT_LIVE,
} from './treeMenu.js';

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
const ACCENT = '#4ade80';
const ERROR = '#f87171';
/** A selected row; brighter while the list has the focus, where the keys go. */
const SELECTED = 'rgba(74,222,128,0.18)';
const SELECTED_FOCUS = 'rgba(74,222,128,0.32)';
const FONT = "12px system-ui,-apple-system,'Segoe UI',sans-serif";

/** The list's rules that inline styles cannot say, in the list's document: a row under the pointer, a field's focus. */
const STYLE_ID = 'weed-editor-tree';
const STYLES =
  `.weed-tree-row:hover{background-color:rgba(255,255,255,0.05)}` +
  `.weed-tree-filter:focus{border-color:${ACCENT};outline:none}` +
  `.weed-tree-filter::placeholder{color:#6b7080}` +
  `.weed-tree-clear:hover{color:${TEXT}}` +
  `.weed-tree-list:focus-visible{box-shadow:inset 0 0 0 1px rgba(74,222,128,0.4)}`;

const SEARCH_ICON =
  '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round"/></svg>';

const PLACED_TITLE =
  'Placed by the scene file. Click: select it (Shift or Ctrl: add it to the selection, or take it out); double click: ' +
  'frame it; right click: more. With the list focused: ↑ ↓ select, Enter frames, F2 renames, Del deletes, Ctrl+D duplicates';
const RUNTIME_TITLE =
  'Spawned by code, not by the scene file: read-only. Click: select it; double click: frame it; right click: more. ' +
  '↑ ↓ select, Enter frames';
const NOT_LIVE_TITLE = 'Placed by the scene file, but not live: its pool may be full';

// What a row is (RowShown.flags).
const F_OPEN = 1;
const F_FILTERED = 2;
const F_LIVE = 4;
const F_SELECTED = 8;
const F_LOCKED = 16;
const F_FOCUS = 32;

/** A row up to this many rows past an edge of the view is scrolled to by that edge (a key's step); farther, to the middle. */
const NEAR_ROWS = 3;

// The list's edits of what is selected (Del, Ctrl+D).
const EDIT_DELETE = 0;
const EDIT_DUPLICATE = 1;

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

    /**
     * Its rows are made to fit its height when it draws: a taller dock (a fold, a drag, a window resize) draws again.
     * The observer is the window's the list is shown in (the editor page's, D9), made when it is first drawn there,
     * and let go in destroy, so nothing of this page stays in the editor page.
     */
    this._sizeObserver = null;
    this._observedView = null;
    this._shownHeight = -1;
    this._onResize = () => {
      const height = this._list.clientHeight;
      if (height === this._shownHeight) return;
      this._shownHeight = height;
      this.render();
    };

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
      `flex:1;min-width:0;font:${FONT};color:#e3e6ee;background:#0b0d12;border:1px solid #343a4c;border-radius:4px;` +
      'padding:2px 6px';
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

    // The rows: the list scrolls, the spacer is as tall as all of them. The list takes the focus, for its keys.
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
    /** The list has the focus: the keys are its (its selected row is brighter). */
    this._focused = false;
    /**
     * The row the selection was last shown on, and the entity there: once nothing is selected (a delete, Esc), ↓ and
     * ↑ go on from that row. After a delete it holds the next entity. -1: none.
     */
    this._cursorRow = -1;
    this._cursorIndex = -1;
    /**
     * A held ↑ or ↓ (repeated keydowns): the row it is on and its entity, shown as selected at once; the selection
     * itself follows once a frame (_pendingFrame), as a selection rebuilds the inspector. -1: none.
     */
    this._pendingRow = -1;
    this._pendingIndex = -1;
    this._pendingFrame = 0;
    this._pendingWindow = null;
    /** A change of the selection the list makes itself that must not move the list (a Ctrl+click). */
    this._quiet = false;
    // Rename in place (ED-63): the field over the row, made on the first F2; the name it renames (null: closed); its
    // row's top as written; whether the name typed was refused.
    this._rename = null;
    this._renameName = null;
    this._renameTop = -1;
    this._renameRefused = false;
    // The context menu (ED-64), and what it was opened on: the row's class, its entity's name (null: runtime, or a
    // class's row) and index; the list's scroll then (the list scrolling closes it).
    this._menu = new TreeMenu((id) => this._menuPicked(id));
    this._menuGroup = null;
    this._menuName = null;
    this._menuIndex = -1;
    this._menuScrollTop = 0;

    this._onScroll = () => {
      if (this._menu.isOpen && this._list.scrollTop !== this._menuScrollTop) this._menu.close(false);
      this.render();
    };
    this._onClick = (e) => this._clicked(e, false);
    this._onDoubleClick = (e) => this._clicked(e, true);
    this._onKeyDown = (e) => this._keyDown(e);
    this._onFilterInput = () => this._filterChanged();
    this._onClearClick = () => {
      this.clearFilter();
      this._filter.focus();
    };
    this._onFocus = () => this._setFocused(true);
    this._onBlur = () => this._setFocused(false);
    this._onRenameBlur = () => this._commitRename(false);
    this._onRenameInput = () => this._markRename(false);
    this._onContextMenu = (e) => this._contextMenu(e);
    this._onPendingFrame = () => {
      this._pendingFrame = 0;
      this._pendingWindow = null;
      this._applyPending();
    };
    this._list.addEventListener('scroll', this._onScroll);
    this._list.addEventListener('click', this._onClick);
    this._list.addEventListener('dblclick', this._onDoubleClick);
    this._list.addEventListener('contextmenu', this._onContextMenu);
    this._list.addEventListener('focus', this._onFocus);
    this._list.addEventListener('blur', this._onBlur);
    this.el.addEventListener('keydown', this._onKeyDown);
    this._filter.addEventListener('input', this._onFilterInput);
    this._clear.addEventListener('click', this._onClearClick);
    this._style();
  }

  attach(scene) {
    this._scene = scene;
    this.model.build(scene);
    this.model.refresh(scene);
    this._cursorRow = -1;
    this._style();
    this.render();
  }

  detach() {
    this._menu.close(false);
    this._closeRename(false);
    this._cancelPending();
    this._scene = null;
    this.model.clear();
    this.render();
  }

  /** The document changed: its records are listed again at the next update. A menu open on its rows goes. */
  invalidate() {
    this._documentChanged = true;
    this._menu.close(false);
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

  /**
   * The selection changed: open its group, scroll it into view, mark it. A rename in place of another entity is
   * left (the old name stays): the selection moved away from it; so is a menu open on what was selected.
   */
  onSelectionChanged() {
    const selection = this.debugUI.editMode.selection;
    if (this._renameName !== null && selection.name !== this._renameName) this._closeRename(false);
    this._menu.close(false);
    this._cancelPending(); // a pick in the view while ↓ is held: the pick wins
    this._fresh(); // a delete clears the selection: its row goes now, not at the next tick
    if (!this._quiet && this._scene !== null && selection.index >= 0) {
      const row = this.model.reveal(selection.index, selection.name);
      if (row >= 0) {
        this._cursorRow = row;
        this._cursorIndex = selection.index;
        this._scrollToRow(row);
      }
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
    this._cursorRow = -1;
    this._cancelPending();
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

  // ---- keys (ED-63) ----

  /**
   * A key typed in the list, its filter or a rename's field. The keys it takes stop here: none reaches the editor's
   * own keys (the editor page passes keys on from its window, HostedEditor.onHostKey), so each has one action. The
   * others (Ctrl+Z, ← →, Shift+E, …) go on to the editor.
   */
  _keyDown(e) {
    if (e.isComposing) return; // an input method's Enter or Esc is its own
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = false;
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      this.focusFilter();
      handled = true;
    } else if (e.target === this._list) {
      handled = this._listKey(e);
    } else if (e.target === this._filter) {
      handled = this._filterKey(e);
    } else if (this._rename !== null && e.target === this._rename) {
      handled = this._renameKey(e);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /**
   * In the list: ↑ ↓ move the selection, Enter frames it, F2 renames it, Del (or Backspace) deletes and Ctrl+D
   * duplicates what is selected; Esc clears a filter (without one, Esc is the editor's: it lets go of the selection).
   */
  _listKey(e) {
    if (e.altKey) return false;
    const key = e.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') this._settle(); // Del after a held ↓ deletes the row it shows
    if (e.ctrlKey || e.metaKey) {
      if (key !== 'd' && key !== 'D') return false;
      this._edit(EDIT_DUPLICATE);
      return true;
    }
    switch (key) {
      case 'ArrowDown':
        this._step(1, e.repeat === true);
        return true;
      case 'ArrowUp':
        this._step(-1, e.repeat === true);
        return true;
      case 'Enter':
        this._frame();
        return true;
      case 'F2':
        this.startRename();
        return true;
      case 'Delete':
      case 'Backspace':
        this._edit(EDIT_DELETE);
        return true;
      case 'Escape':
        if (this.model.query === '') return false;
        this.clearFilter();
        return true;
      default:
        return false;
    }
  }

  /** In the filter: Esc clears it (empty, back to the list); ↓ and Enter go to the list, at the first match. */
  _filterKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Escape') {
      if (this._filter.value !== '' || this.model.query !== '') this.clearFilter();
      else this._list.focus();
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      this._list.focus();
      const selection = this.debugUI.editMode.selection;
      if (selection.index < 0 || this.model.rowOf(selection.index, selection.name) < 0) this._step(1);
      return true;
    }
    return false;
  }

  /**
   * ↓ (1) and ↑ (-1): select the entity on the next row the list shows; a class's row and an entity that is not live
   * are passed over. Nothing selected (or not shown): from the row the selection was last on, else from the rows in
   * view. Scrolled into view by the selection's change (onSelectionChanged).
   *
   * A held key (`held`: its repeated keydowns) moves the row at once, shown as selected and scrolled to, and the
   * selection follows once a frame, the last row winning. A selection rebuilds the inspector, which in littleCity takes
   * longer than a key's repeat (60 to 110 ms): the steps would queue, and run on after the key is let go.
   */
  _step(step, held = false) {
    if (this._scene === null) return;
    this._fresh();
    const model = this.model;
    const total = model.rowCount;
    const selection = this.debugUI.editMode.selection;
    let row = this._pendingRow;
    if (row < 0 && selection.index >= 0) row = model.rowOf(selection.index, selection.name);
    let start;
    if (row >= 0) {
      start = row + step;
    } else if (this._cursorRow >= 0 && this._cursorRow <= total) {
      // The entity it was on is still there (Esc let go of it): the next one. Another one is (a delete): that one.
      const at = model.locate(this._cursorRow);
      const same = at !== null && this._indexAt(at) === this._cursorIndex;
      start = step > 0 ? (same ? this._cursorRow + 1 : this._cursorRow) : this._cursorRow - 1;
    } else {
      const first = Math.floor(this._list.scrollTop / ROW_HEIGHT);
      const view = Math.max(1, Math.floor(this._list.clientHeight / ROW_HEIGHT));
      start = step > 0 ? first : Math.min(total - 1, first + view - 1);
    }
    for (let r = start; r >= 0 && r < total; r += step) {
      const at = model.locate(r);
      if (at === null) break;
      const index = this._indexAt(at);
      if (index < 0) continue;
      if (held) {
        this._holdAt(r, index);
      } else {
        this._cancelPending();
        this._choose(index);
      }
      return;
    }
    if (!held) this._settle(); // at an end: the row a held key showed is where the selection stays
  }

  /** A held key's row: shown as selected now; the selection follows at the next frame of the list's window. */
  _holdAt(row, index) {
    this._pendingRow = row;
    this._pendingIndex = index;
    this._scrollToRow(row);
    this.render();
    if (this._pendingFrame !== 0) return;
    const win = this.el.ownerDocument?.defaultView;
    if (!win || typeof win.requestAnimationFrame !== 'function') {
      this._applyPending(); // a document without frames: at once
      return;
    }
    this._pendingWindow = win;
    this._pendingFrame = win.requestAnimationFrame(this._onPendingFrame);
  }

  /** The held key's row becomes the selection. */
  _applyPending() {
    const index = this._pendingIndex;
    this._pendingRow = -1;
    this._pendingIndex = -1;
    if (index >= 0) this._choose(index);
  }

  /** Another key, a menu or a click acts on the selection as the list shows it: the held key's row, now. */
  _settle() {
    if (this._pendingIndex < 0) return;
    this._cancelFrame();
    this._applyPending();
  }

  /** The held key's row is dropped (another selection, another filter, the list going). */
  _cancelPending() {
    this._cancelFrame();
    this._pendingRow = -1;
    this._pendingIndex = -1;
  }

  _cancelFrame() {
    if (this._pendingFrame === 0) return;
    this._pendingWindow?.cancelAnimationFrame?.(this._pendingFrame);
    this._pendingFrame = 0;
    this._pendingWindow = null;
  }

  /** Select one entity from the list (a click, ↑ ↓): the others selected with it are let go. */
  _choose(index) {
    const editMode = this.debugUI.editMode;
    const multi = editMode.multi;
    if (multi && multi.count > 0) {
      this._quiet = true;
      try {
        multi.clear();
      } finally {
        this._quiet = false;
      }
    }
    editMode.selectFromList(index, false);
  }

  /** Shift or Ctrl+click on a placed entity: add it to the selection, or take it out (as Shift+click in the view). */
  _toggleSelected(name) {
    const multi = this.debugUI.editMode.multi;
    const names = multi.selectedNames();
    const at = names.indexOf(name);
    if (at >= 0) names.splice(at, 1);
    else names.push(name);
    this._quiet = true; // the list stays where it is: the inspector's entity may be far from this row
    try {
      multi.selectNames(names);
    } finally {
      this._quiet = false;
    }
  }

  /** Enter and a double click: frame the selection (EditMode.frameSelection, ED-57), else center the view on it. */
  _frame() {
    const editMode = this.debugUI.editMode;
    const index = editMode.selection.index;
    if (index < 0) return;
    if (typeof editMode.frameSelection === 'function') editMode.frameSelection();
    else editMode.selectFromList(index, true);
  }

  /** Del and Ctrl+D: the editor's delete and duplicate of what is selected (several: all of them, one undo). */
  _edit(kind) {
    const editMode = this.debugUI.editMode;
    const selection = editMode.selection;
    if (selection.index < 0) return;
    if (!selection.authored) {
      editMode._setStatus(`#${selection.index} was spawned by code, not placed by the scene file: read-only`, true);
      return;
    }
    if (!this._editing()) return;
    if (kind === EDIT_DELETE) editMode.deleteSelected();
    else editMode.duplicateSelected();
  }

  /**
   * An edit from the list while the game plays enters edit mode first, as the Assets dock's + does: the world holds
   * still, and the edit can be undone at once (the editor's undo is edit mode's).
   * @returns {boolean} whether the editor is editing
   */
  _editing() {
    const editMode = this.debugUI.editMode;
    if (!editMode.active) editMode.enter();
    return editMode.active === true;
  }

  // ---- rename in place (ED-63) ----

  /**
   * F2: a field over the selected placed entity's row, its name selected. Enter keeps the name typed
   * (EditMode.renameSelected); a name the file has, or none, is refused: the field stays, marked, and the status line
   * says why. Esc leaves the old name, as does a selection that moves away; leaving the field keeps a name it can.
   * @returns {boolean} whether the field opened
   */
  startRename() {
    const editMode = this.debugUI.editMode;
    const selection = editMode.selection;
    if (selection.index < 0 || this._scene === null) return false;
    if (!selection.authored) {
      editMode._setStatus(`#${selection.index} was spawned by code: the scene file has no name of it to change`, true);
      return false;
    }
    this._fresh();
    const row = this.model.reveal(selection.index, selection.name);
    if (row < 0) {
      editMode._setStatus(`${selection.name} is not in the list: the filter leaves it out`, true);
      return false;
    }
    if (!this._editing()) return false;
    this._scrollToRow(row);
    const field = this._renameField();
    this._renameName = selection.name;
    field.value = selection.name;
    this._markRename(false);
    this.render(); // places the field over the row
    field.style.display = '';
    field.focus();
    field.select();
    return true;
  }

  /** Whether a rename's field is open. */
  get renaming() {
    return this._renameName !== null;
  }

  _renameField() {
    if (this._rename !== null) return this._rename;
    const field = document.createElement('input');
    field.type = 'text';
    field.spellcheck = false;
    field.autocomplete = 'off';
    field.title = 'Its new name in the scene file: Enter keeps it, Esc leaves the old one';
    field.style.cssText =
      `position:absolute;left:16px;right:4px;height:20px;box-sizing:border-box;z-index:1;display:none;font:${FONT};` +
      `color:#e3e6ee;background:#0b0d12;border:1px solid ${ACCENT};border-radius:3px;padding:0 5px;outline:none`;
    field.addEventListener('blur', this._onRenameBlur);
    field.addEventListener('input', this._onRenameInput);
    this._spacer.appendChild(field);
    this._rename = field;
    return field;
  }

  /** In a rename's field: Enter keeps the name, Esc leaves the old one. Other keys are the field's (Ctrl+S saves). */
  _renameKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Enter') {
      this._commitRename(true);
      return true;
    }
    if (e.key === 'Escape') {
      this._closeRename(true);
      return true;
    }
    return false;
  }

  /**
   * Keep the name typed. `byKey` (Enter): refused, the field stays; else (the field was left) the old name stays.
   */
  _commitRename(byKey) {
    const from = this._renameName;
    if (from === null) return;
    const editMode = this.debugUI.editMode;
    const to = this._rename.value.trim();
    if (to === from || editMode.selection.name !== from || (to === '' && !byKey)) {
      this._closeRename(byKey);
      return;
    }
    this._renameName = null; // the selection the rename shows is not one that moved away
    if (editMode.renameSelected(to)) {
      this._closeRename(byKey);
      return;
    }
    if (byKey) {
      this._renameName = from;
      this._markRename(true);
      this._rename.select();
      return;
    }
    this._closeRename(false);
  }

  /** Close a rename's field (the focus back to the list when `refocus`: Enter, Esc). */
  _closeRename(refocus) {
    const field = this._rename;
    const open = field !== null && field.style.display !== 'none';
    this._renameName = null; // before the focus moves: the field's blur then keeps nothing
    this._renameTop = -1;
    if (open) {
      this._markRename(false);
      if (refocus) this._list.focus();
      field.style.display = 'none';
    }
  }

  /** The field's border: refused (red) or not. */
  _markRename(refused) {
    if (refused === this._renameRefused || this._rename === null) return;
    this._renameRefused = refused;
    this._rename.style.borderColor = refused ? ERROR : ACCENT;
  }

  /** The field follows its row (rows above it may come and go); a row that went closes it. */
  _placeRename() {
    const selection = this.debugUI.editMode.selection;
    const row = this.model.rowOf(selection.index, this._renameName);
    if (row < 0) {
      this._closeRename(false);
      return;
    }
    const top = row * ROW_HEIGHT;
    if (top === this._renameTop) return;
    this._renameTop = top;
    this._rename.style.top = `${top}px`;
  }

  // ---- the context menu (ED-64) ----

  /**
   * A right click on a row opens its menu, in place of the browser's. The ContextMenu key and Shift+F10 send one with
   * no button to the list itself: the selection's menu, under its row.
   */
  _contextMenu(e) {
    if (this._scene === null) return;
    this._settle();
    const el = e.target?.closest ? e.target.closest('[data-row]') : null;
    if (el !== null) {
      e.preventDefault();
      const at = this.model.locate(Number(el.dataset.row));
      if (at !== null) this._openMenu(at.kind, at.group, at.item, e.clientX, e.clientY, false);
      return;
    }
    if (e.button !== 2) {
      e.preventDefault();
      this._openMenuAtSelection();
    }
  }

  /** The selection's menu, under its row (the keyboard's), its first item active. */
  _openMenuAtSelection() {
    const selection = this.debugUI.editMode.selection;
    if (selection.index < 0) return;
    this._fresh();
    const row = this.model.reveal(selection.index, selection.name);
    if (row < 0) return;
    this._scrollToRow(row);
    this.render();
    const at = this.model.locate(row);
    const box = this._list.getBoundingClientRect();
    this._openMenu(at.kind, at.group, at.item, box.left + 24, box.top + (row + 1) * ROW_HEIGHT - this._list.scrollTop, true);
  }

  /**
   * The menu of a row (its kind, class and item, as locate gives them), at a point of the viewport. Its edits act on
   * the selection: an entity outside it is selected first (alone); one of several selected keeps them.
   */
  _openMenu(rowKind, group, item, x, y, keyboard) {
    const editMode = this.debugUI.editMode;
    const model = this.model;
    let kind = TARGET_GROUP;
    let name = null;
    let index = -1;
    if (rowKind === ROW_AUTHORED) {
      name = group.authored[item];
      index = liveIndexOf(this._scene, name);
      kind = index >= 0 ? TARGET_PLACED : TARGET_NOT_LIVE;
    } else if (rowKind === ROW_RUNTIME) {
      index = group.runtime[item];
      kind = TARGET_RUNTIME;
    }
    if (index >= 0 && !this._isSelected(index, name)) this._choose(index);
    const selection = editMode.selection;
    this._menuGroup = group;
    this._menuName = name;
    this._menuIndex = index;
    this._menuScrollTop = this._list.scrollTop;
    const menu = menuFor({
      kind,
      className: group.name,
      name,
      index,
      selected: (selection.authored ? 1 : 0) + (editMode.multi ? editMode.multi.count : 0),
      placed: group.authored.length,
      matching: model.query === '' || group.matchAll ? group.authored.length : group.matchedCount,
      runtime: group.runtimeCount,
      filtered: model.query !== '',
      canCopy: typeof editMode.copySelected === 'function',
    });
    this._menu.open(this.el.ownerDocument, x, y, menu, { keyboard, returnFocus: this._list });
  }

  /** Whether the entity of a row is selected: the inspector's, or one of the others. */
  _isSelected(index, name) {
    const editMode = this.debugUI.editMode;
    const selection = editMode.selection;
    if (name === null) return selection.index === index && selection.name === null;
    return (selection.name === name && selection.index >= 0) || editMode.multi?.has(name) === true;
  }

  /** A pick in the menu (it has closed). The edits are the list's keys' (an edit while playing enters edit mode). */
  _menuPicked(id) {
    const editMode = this.debugUI.editMode;
    const name = this._menuName;
    const group = this._menuGroup;
    this._menuGroup = null;
    switch (id) {
      case ITEM_FRAME:
        this._frame();
        break;
      case ITEM_RENAME:
        if (editMode.selection.name !== name) this._makeFirst(name);
        this.startRename();
        break;
      case ITEM_DUPLICATE:
        this._edit(EDIT_DUPLICATE);
        break;
      case ITEM_COPY:
        editMode.copySelected?.();
        break;
      case ITEM_DELETE:
        this._edit(EDIT_DELETE);
        break;
      case ITEM_SELECT_ALL:
        if (group !== null) this._selectAll(group, name);
        break;
      default:
        break;
    }
  }

  /** The row's entity becomes the inspector's, the others selected with it staying so (Rename on one of several). */
  _makeFirst(name) {
    const multi = this.debugUI.editMode.multi;
    if (!multi) return;
    const names = multi.selectedNames();
    const at = names.indexOf(name);
    if (at <= 0) return;
    names.splice(at, 1);
    names.unshift(name);
    this._quiet = true;
    try {
      multi.selectNames(names);
    } finally {
      this._quiet = false;
    }
  }

  /**
   * "Select all <Class>": its placed entities (under a filter, the ones it keeps) through the editor's multi-select,
   * the row's own first (the inspector shows it).
   */
  _selectAll(group, first) {
    const names = [];
    if (this.model.query === '' || group.matchAll) {
      for (const name of group.authored) names.push(name);
    } else {
      for (let k = 0; k < group.matchedCount; k++) names.push(group.authored[group.matched[k]]);
    }
    const at = first === null ? -1 : names.indexOf(first);
    if (at > 0) {
      names.splice(at, 1);
      names.unshift(first);
    }
    this.debugUI.editMode.multi.selectNames(names);
  }

  // ---- drawing ----

  /** Draw the rows in view. */
  render() {
    this._style();
    this._watchSize();
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
    if (this._renameName !== null) this._placeRename();
    this._showFilter();
  }

  /** Watch the list's height in the window it is shown in now (see the constructor). */
  _watchSize() {
    const view = this._list.ownerDocument?.defaultView ?? null;
    if (view === this._observedView) return;
    this._sizeObserver?.disconnect();
    this._observedView = view;
    this._sizeObserver = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(this._onResize) : null;
    this._sizeObserver?.observe(this._list);
  }

  _sizeSpacer(total) {
    const height = total * ROW_HEIGHT;
    if (height === this._spacerHeight) return;
    this._spacerHeight = height;
    this._spacer.style.height = `${height}px`;
  }

  /** Scroll so that a row shows: a row near an edge (a key's step) by that edge, a farther one to the middle. */
  _scrollToRow(row) {
    this._sizeSpacer(this.model.rowCount);
    const list = this._list;
    const top = row * ROW_HEIGHT;
    const view = list.clientHeight;
    const scroll = list.scrollTop;
    if (top >= scroll && top + ROW_HEIGHT <= scroll + view) return;
    const near = NEAR_ROWS * ROW_HEIGHT;
    let to;
    if (top < scroll && top >= scroll - near) to = top;
    else if (top >= scroll && top < scroll + view + near) to = top + ROW_HEIGHT - view;
    else to = top - (view >> 1);
    list.scrollTop = Math.max(0, to);
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
      // A held ↑ ↓ shows its row as the selection until the selection follows (_holdAt).
      const pending = this._pendingIndex;
      if (kind === ROW_AUTHORED) {
        name = group.authored[at.item];
        index = liveIndexOf(this._scene, name);
        if (pending >= 0 ? index === pending : (selection.name === name && selection.index >= 0) || editMode.multi?.has(name) === true) {
          flags |= F_SELECTED;
        }
      } else {
        index = group.runtime[at.item];
        if (pending >= 0 ? index === pending : selection.index === index && selection.name === null) flags |= F_SELECTED;
      }
      if (index >= 0) {
        flags |= F_LIVE;
        // A locked layer's entity is marked (editorLayers.js, ED-24).
        if (editMode.layers?.locked(index)) flags |= F_LOCKED;
      }
      if ((flags & F_SELECTED) !== 0 && this._focused) flags |= F_FOCUS;
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
      title =
        `${name}: ${shown.placed} placed by the scene file, ${shown.runtime} spawned by code. A click folds or unfolds ` +
        'it; right click: select all of it';
    } else if (kind === ROW_AUTHORED) {
      text = index >= 0 ? `${name}  #${index}` : `${name}  (not live)`;
      if (index < 0) color = '#6b7080';
      title = index >= 0 ? PLACED_TITLE : NOT_LIVE_TITLE;
    } else {
      text = `#${index}  runtime`;
      color = DIM;
      title = RUNTIME_TITLE;
    }
    if ((flags & F_LOCKED) !== 0) text += LOCKED_MARK;
    const background = (flags & F_SELECTED) === 0 ? '' : (flags & F_FOCUS) !== 0 ? SELECTED_FOCUS : SELECTED;
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

  /**
   * A click on a row: a class's row folds or unfolds; an entity's selects it alone (Shift or Ctrl on a placed one:
   * adds it to the selection or takes it out). A double click frames the entity; on a class's row it is one fold.
   */
  _clicked(e, double) {
    const el = e.target?.closest ? e.target.closest('[data-row]') : null;
    if (!el || this._scene === null) return;
    const at = this.model.locate(Number(el.dataset.row));
    if (at === null) return;
    if (at.kind === ROW_GROUP) {
      if (double || e.detail > 1) return;
      this.model.toggle(at.group);
      this._cursorRow = -1;
      this.render();
      return;
    }
    const editMode = this.debugUI.editMode;
    const index = this._indexAt(at);
    if (index < 0) {
      editMode._setStatus(`${at.group.authored[at.item]} is not live: its pool may be full`, true);
      return;
    }
    if (double) {
      if (editMode.selection.index !== index) this._choose(index);
      this._frame();
      return;
    }
    if (at.kind === ROW_AUTHORED && (e.shiftKey || e.ctrlKey || e.metaKey) && editMode.multi) {
      this._toggleSelected(at.group.authored[at.item]);
      return;
    }
    // The second click of a double click: already selected.
    if (e.detail > 1 && editMode.selection.index === index) return;
    this._choose(index);
  }

  /** The live entity a row shows, or -1 (a class's row, or a record that is not live). */
  _indexAt(at) {
    if (at.kind === ROW_AUTHORED) return liveIndexOf(this._scene, at.group.authored[at.item]);
    return at.kind === ROW_RUNTIME ? at.group.runtime[at.item] : -1;
  }

  // ---- upkeep ----

  _setFocused(focused) {
    if (focused === this._focused) return;
    this._focused = focused;
    this.render();
  }

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

  /**
   * The page goes (or the editor): nothing of this page may stay in the editor page's document (D9), so an open
   * menu goes with its listeners there.
   */
  destroy() {
    this._sizeObserver?.disconnect();
    this._sizeObserver = null;
    this._observedView = null;
    this._menu.close(false);
    this._closeRename(false);
    this._cancelPending();
    this._list.removeEventListener('scroll', this._onScroll);
    this._list.removeEventListener('click', this._onClick);
    this._list.removeEventListener('dblclick', this._onDoubleClick);
    this._list.removeEventListener('contextmenu', this._onContextMenu);
    this._list.removeEventListener('focus', this._onFocus);
    this._list.removeEventListener('blur', this._onBlur);
    this.el.removeEventListener('keydown', this._onKeyDown);
    this._filter.removeEventListener('input', this._onFilterInput);
    this._clear.removeEventListener('click', this._onClearClick);
    if (this._rename !== null) {
      this._rename.removeEventListener('blur', this._onRenameBlur);
      this._rename.removeEventListener('input', this._onRenameInput);
    }
  }
}
