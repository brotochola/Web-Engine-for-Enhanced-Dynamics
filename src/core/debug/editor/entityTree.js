// entityTree.js — the editor page's scene list (VISUAL_EDITOR_PLAN.md D9, ED-15): the running scene's entities
// grouped by class, in the order the scene registers them. A group lists what the running scene file places (its
// records, by name, with the live entity each has, or none) and then what code spawned (live entities the file does
// not name, by index: read-only). Groups open and close; a click selects (it enters edit mode), a double click
// centers the view on the entity.
//
// Only the rows in view are drawn: a spacer as tall as every row, and a few row elements placed over it and reused.
// A scene of tens of thousands of entities costs the rows on screen.
//
// Refreshed at the debug UI's interval: one pass over the slots counts each group's runtime entities into an index
// list made once per class, and a signature per group (the live slots and their generations) tells whether to draw
// again. The document's lists are made again only when it changes (invalidate). Nothing is allocated per refresh.

import { Transform } from '../../../components/transform.js';
import { Messages } from '../../messages.js';

/** Height of a row, px: the view places rows by it. */
export const ROW_HEIGHT = 20;

/** Classes the editor does not list: the engine's own helpers. */
const UNLISTED = new Set(['Flash']);

export const ROW_GROUP = 0;
export const ROW_AUTHORED = 1;
export const ROW_RUNTIME = 2;

/**
 * The tree's rows, without the DOM: groups of authored records and runtime entities, as one list of rows.
 */
export class TreeModel {
  constructor() {
    /** @type {{ name: string, start: number, end: number, open: boolean, authored: string[],
     *   runtime: Int32Array, runtimeCount: number, signature: number }[]} */
    this.groups = [];
    /** Per slot, 1 when the running file names the live entity there. */
    this._named = new Uint8Array(0);
    /** Where locate() writes: the row's kind, its group, and its item in the group (a record or a runtime entity). */
    this.cursor = { kind: ROW_GROUP, group: null, item: 0 };
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
        start,
        end,
        open: wasOpen.has(name),
        authored: [],
        runtime: old ? old.runtime : new Int32Array(end - start),
        runtimeCount: 0,
        signature: 0,
      };
      groups.push(group);
      byName.set(name, group);
    }
    for (const record of scene?.sceneFile?.entities || []) byName.get(record.class)?.authored.push(record.name);
    this.groups = groups;
    let slots = 0;
    for (const group of groups) if (group.end > slots) slots = group.end;
    if (this._named.length < slots) this._named = new Uint8Array(slots);
  }

  clear() {
    this.groups = [];
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
    return changed;
  }

  /** How many rows: each group, and the records and runtime entities of the open ones. */
  get rowCount() {
    let rows = 0;
    for (const group of this.groups) rows += 1 + (group.open ? group.authored.length + group.runtimeCount : 0);
    return rows;
  }

  /**
   * What row `row` shows, into `this.cursor`; null past the last row.
   * @param {number} row
   */
  locate(row) {
    let r = row;
    for (const group of this.groups) {
      if (r === 0) return this._at(ROW_GROUP, group, 0);
      r--;
      if (!group.open) continue;
      if (r < group.authored.length) return this._at(ROW_AUTHORED, group, r);
      r -= group.authored.length;
      if (r < group.runtimeCount) return this._at(ROW_RUNTIME, group, r);
      r -= group.runtimeCount;
    }
    return null;
  }

  /**
   * The row of an entity (its record's row when the file names it), opening its group; -1 when it is not listed.
   * @param {number} index
   * @param {string|null} name - its name in the running file, or null
   */
  reveal(index, name) {
    let row = 0;
    for (const group of this.groups) {
      const inGroup = index >= group.start && index < group.end;
      if (inGroup) {
        group.open = true;
        row++;
        if (name !== null) {
          const k = group.authored.indexOf(name);
          if (k >= 0) return row + k;
        }
        row += group.authored.length;
        for (let k = 0; k < group.runtimeCount; k++) if (group.runtime[k] === index) return row + k;
        return -1;
      }
      row += 1 + (group.open ? group.authored.length + group.runtimeCount : 0);
    }
    return -1;
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

export class EntityTree {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.model = new TreeModel();
    this._scene = null;
    this._documentChanged = false;

    this.el = document.createElement('div');
    this.el.style.cssText = 'height:100%;overflow:auto;position:relative';
    this._spacer = document.createElement('div');
    this._spacer.style.cssText = 'position:relative;height:0';
    this.el.appendChild(this._spacer);
    /** Row elements, reused: as many as fit in view. */
    this._rows = [];

    this._onScroll = () => this.render();
    this._onClick = (e) => this._clicked(e, false);
    this._onDoubleClick = (e) => this._clicked(e, true);
    this.el.addEventListener('scroll', this._onScroll);
    this.el.addEventListener('click', this._onClick);
    this.el.addEventListener('dblclick', this._onDoubleClick);
  }

  attach(scene) {
    this._scene = scene;
    this.model.build(scene);
    this.model.refresh(scene);
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
      if (this._documentChanged) {
        this._documentChanged = false;
        this.model.build(this._scene);
        this.model.refresh(this._scene);
      }
      const row = this.model.reveal(selection.index, selection.name);
      if (row >= 0) {
        this._spacer.style.height = `${this.model.rowCount * ROW_HEIGHT}px`;
        const top = row * ROW_HEIGHT;
        const view = this.el.clientHeight;
        if (top < this.el.scrollTop || top + ROW_HEIGHT > this.el.scrollTop + view) {
          this.el.scrollTop = Math.max(0, top - (view >> 1));
        }
      }
    }
    this.render();
  }

  /** Draw the rows in view. */
  render() {
    const model = this.model;
    const total = model.rowCount;
    this._spacer.style.height = `${total * ROW_HEIGHT}px`;
    const first = Math.floor(this.el.scrollTop / ROW_HEIGHT);
    const fit = Math.ceil((this.el.clientHeight || 400) / ROW_HEIGHT) + 1;
    while (this._rows.length < fit) {
      const row = document.createElement('div');
      row.style.cssText = ROW_STYLE;
      this._spacer.appendChild(row);
      this._rows.push(row);
    }
    const selection = this.debugUI.editMode.selection;
    for (let k = 0; k < this._rows.length; k++) {
      const el = this._rows[k];
      const r = first + k;
      const at = r < total ? model.locate(r) : null;
      if (at === null) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.top = `${r * ROW_HEIGHT}px`;
      el.dataset.row = String(r);
      this._fill(el, at, selection);
    }
  }

  _fill(el, at, selection) {
    const group = at.group;
    // A locked layer's entity is marked (editorLayers.js, ED-24).
    const layers = this.debugUI.editMode.layers;
    let text;
    let color = '#d6d9e2';
    let selected = false;
    let indent = 8;
    if (at.kind === ROW_GROUP) {
      const placed = group.authored.length;
      text = `${group.open ? '▾' : '▸'} ${group.name}  ·  ${placed} placed, ${group.runtimeCount} runtime`;
      color = '#9aa2b4';
    } else if (at.kind === ROW_AUTHORED) {
      const name = group.authored[at.item];
      const index = liveIndexOf(this._scene, name);
      text = index >= 0 ? `${name}  #${index}` : `${name}  (not live)`;
      if (index < 0) color = '#6b7080';
      else if (layers?.locked(index)) text += LOCKED_MARK;
      selected = (selection.name === name && selection.index >= 0) || this.debugUI.editMode.multi?.has(name) === true;
      indent = 22;
    } else {
      const index = group.runtime[at.item];
      text = `#${index}  runtime`;
      if (layers?.locked(index)) text += LOCKED_MARK;
      color = '#8a90a0';
      selected = selection.index === index && selection.name === null;
      indent = 22;
    }
    if (el.textContent !== text) el.textContent = text;
    el.style.color = color;
    el.style.paddingLeft = `${indent}px`;
    el.style.background = selected ? 'rgba(74,222,128,0.18)' : '';
  }

  _clicked(e, double) {
    const el = e.target.closest ? e.target.closest('[data-row]') : null;
    if (!el || this._scene === null) return;
    const at = this.model.locate(Number(el.dataset.row));
    if (at === null) return;
    if (at.kind === ROW_GROUP) {
      if (double) return;
      at.group.open = !at.group.open;
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

  destroy() {
    this.el.removeEventListener('scroll', this._onScroll);
    this.el.removeEventListener('click', this._onClick);
    this.el.removeEventListener('dblclick', this._onDoubleClick);
  }
}
