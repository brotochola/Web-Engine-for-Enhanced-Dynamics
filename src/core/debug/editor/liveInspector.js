// liveInspector.js — the inspector's live values (VISUAL_EDITOR_PLAN.md D8, ED-17): the selected entity's components,
// each column of their ARRAY_SCHEMA with its value now, refreshed at the debug UI's interval while the game plays or
// edit mode holds it. A field changes the live entity through its page instance (the component's own setter where
// it has one; the position through setPosition), never the scene file: Stop throws it away with the rest of the play.
// A column a worker writes every frame shows the worker's value again at the next refresh.
//
// "Copy to scene" writes what the live entity has into its record in the scene file, as one change (undo takes it
// back): its position, and each spawn param whose name is a column of its components (a number, a color, a bool or
// an enum: a Platform's width from its Collider, its tint from its SpriteRenderer).
//
// Cost: the rows are made on selection. A refresh reads each column of the open sections and writes a field only when
// its value changed, and never the one being typed in.

import { Transform } from '../../../components/transform.js';
import { getComponentColor, getInspectorPropertyNames, formatComponentValue } from '../../../util/utils.js';
import { describeSpawnParams, KIND_NUMBER, KIND_COLOR, KIND_BOOL, KIND_ENUM } from '../../spawnParams.js';
import { GameObject } from '../../gameObject.js';
import { classNamed, recordOf, writeParam, writePosition } from './sceneDocument.js';

/** Columns shown but not written from here: worker-owned pose and velocities (getInspectorPropertyNames' extras). */
const READ_ONLY = new Set(['rotC', 'rotS', 'vx', 'vy', 'angularVelocity', 'sleeping']);
/** Param kinds a column's number can stand for. */
const COPYABLE = new Set([KIND_NUMBER, KIND_COLOR, KIND_BOOL, KIND_ENUM]);

const FIELD_STYLE =
  'width:96px;font:11px monospace;padding:1px 4px;background:rgba(0,0,0,0.45);color:#fff;' +
  'border:1px solid rgba(255,255,255,0.18);border-radius:3px;text-align:right';

/** A float32 column's value as the decimal it was set from (7 significant digits round-trip a float32). */
export const tidyNumber = (value) => (Number.isInteger(value) ? value : +value.toPrecision(7));

/**
 * What "copy to scene" writes for an entity of a class: its position, and each spawn param whose name is a column of
 * one of its components (the first component that has it), for the kinds a number stands for.
 * @param {Function} EntityClass
 * @param {Function[]} components - the class's component classes, in order
 * @returns {{ key: string, Comp: Function, kind: number }[]} the params, beside x and y
 */
export function copyablePairs(EntityClass, components) {
  const description = describeSpawnParams(EntityClass);
  const pairs = [];
  if (description === null) return pairs;
  for (let k = 0; k < description.keys.length; k++) {
    const key = description.keys[k];
    if (!COPYABLE.has(description.kinds[k])) continue;
    const Comp = components.find((C) => C.ARRAY_SCHEMA && Object.hasOwn(C.ARRAY_SCHEMA, key) && C[key]);
    if (Comp !== undefined) pairs.push({ key, Comp, kind: description.kinds[k] });
  }
  return pairs;
}

export class LiveInspector {
  /** @param {object} selection - the Selection it shows the live values of */
  constructor(selection) {
    this.selection = selection;
    this.el = document.createElement('div');
    this.el.style.cssText = '';
    this._index = -1;
    /** Per section: its component, its rows, whether it is open. */
    this._sections = [];
    /** Sections closed by the author, by component name, across selections. */
    this._closed = new Set();
    this._copy = null;
    this._pairs = [];
  }

  /** Rows for the entity at `index`: one section per component of its class. */
  show(index) {
    this._index = index;
    this.el.textContent = '';
    this._sections = [];
    const scene = this.selection.debugUI.scene;
    const entityType = Transform.entityType[index];
    let components = null;
    let EntityClass = null;
    for (const registered of scene?.registeredClasses || []) {
      if (registered.entityType === entityType) {
        components = registered.components;
        EntityClass = registered.class;
        break;
      }
    }
    // Transform first: where it is, what most edits are about.
    components = components === null ? [Transform] : [Transform, ...components.filter((C) => C !== Transform)];

    // Its title is the inspector section's (selection.js, ED-54).
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 6px';
    const note = document.createElement('span');
    note.textContent = 'the entity now; Stop throws changes away';
    note.style.cssText = 'font-size:10px;color:#777;flex:1';
    head.append(note);
    this._copy = null;
    this._pairs = [];
    if (this.selection.authored && EntityClass !== null) {
      this._pairs = copyablePairs(EntityClass, components);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'debug-ui-btn';
      copy.textContent = 'Copy to scene';
      const fields = ['x', 'y', ...this._pairs.map((p) => `${p.key} (${p.Comp.name}.${p.key})`)];
      copy.title = `Write the live ${fields.join(', ')} into ${this.selection.name}'s record in the scene file (Ctrl+Z undoes)`;
      copy.onclick = () => this.copyToScene();
      head.appendChild(copy);
      this._copy = copy;
    }
    this.el.appendChild(head);

    const box = document.createElement('div');
    box.className = 'debug-ui-inspector-sections';
    box.style.padding = '0';
    for (const Comp of components) box.appendChild(this._section(Comp));
    this.el.appendChild(box);
    this.update();
  }

  clear() {
    this._index = -1;
    this._sections = [];
    this.el.textContent = '';
  }

  /** The debug UI's tick: the open sections' fields that changed, but the one being typed in. */
  update() {
    const index = this._index;
    if (index < 0) return;
    for (const section of this._sections) {
      if (!section.open) continue;
      const Comp = section.Comp;
      for (const row of section.rows) {
        const column = Comp[row.name];
        if (!column) continue;
        const value = column[index];
        if (value === row.shown || (value !== value && row.shown !== row.shown)) continue;
        if (row.input.ownerDocument.activeElement === row.input) continue;
        row.shown = value;
        row.input.value = formatComponentValue(row.name, value);
      }
    }
  }

  /**
   * Write the live position and the copyable params into the selected entity's record: one change, through the
   * editor (respawn, undo).
   * @returns {number} the respawned entity's index, or -1
   */
  copyToScene() {
    const index = this._index;
    const selection = this.selection;
    if (index < 0 || !selection.authored) return -1;
    const x = tidyNumber(Transform.x[index]);
    const y = tidyNumber(Transform.y[index]);
    const values = this._pairs.map(({ key, Comp, kind }) => {
      const value = Comp[key][index];
      return [key, kind === KIND_BOOL ? value !== 0 : tidyNumber(value)];
    });
    const scene = selection.debugUI.scene;
    const found = recordOf(scene, selection.name);
    if (found === null || classNamed(scene, found.record.class) === undefined) return -1;
    return selection.editor.editSelected(`copy live ${selection.name} to the scene`, (record, description) => {
      writePosition(record, x, y);
      for (const [key, value] of values) writeParam(record, description, key, value);
    });
  }

  _section(Comp) {
    const name = Comp.name;
    const color = getComponentColor(name).css;
    const section = document.createElement('div');
    section.className = 'debug-ui-inspector-section';
    section.style.borderColor = color;
    section.style.borderLeftColor = color;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'debug-ui-inspector-section-head';
    header.style.color = color;
    header.style.background = `linear-gradient(90deg,${color}22,transparent)`;
    const chevron = document.createElement('span');
    chevron.className = 'debug-ui-inspector-chevron';
    const label = document.createElement('span');
    label.textContent = name;
    header.append(chevron, label);
    const props = document.createElement('div');
    props.className = 'debug-ui-inspector-props';
    const record = { Comp, rows: [], open: !this._closed.has(name) };
    for (const prop of getInspectorPropertyNames(Comp)) record.rows.push(this._row(props, Comp, prop));
    const shut = () => {
      chevron.textContent = record.open ? '▾' : '▸';
      props.style.display = record.open ? '' : 'none';
    };
    header.onclick = () => {
      record.open = !record.open;
      if (record.open) this._closed.delete(name);
      else this._closed.add(name);
      shut();
      if (record.open) this.update();
    };
    shut();
    section.append(header, props);
    this._sections.push(record);
    return section;
  }

  _row(props, Comp, prop) {
    const row = document.createElement('div');
    row.className = 'debug-ui-inspector-prop';
    row.style.alignItems = 'center';
    const label = document.createElement('span');
    label.className = 'debug-ui-inspector-prop-label';
    label.textContent = prop;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.style.cssText = FIELD_STYLE;
    input.readOnly = READ_ONLY.has(prop);
    if (input.readOnly) input.style.opacity = '0.6';
    const entry = { name: prop, input, shown: NaN };
    input.onchange = () => {
      if (!this._write(Comp, prop, input.value)) entry.shown = NaN; // shows the value it has again
      this.update();
    };
    row.append(label, input);
    props.appendChild(row);
    return entry;
  }

  /** Write a typed value into the live entity: its position through setPosition, a column through its setter. */
  _write(Comp, prop, text) {
    const index = this._index;
    const raw = text.trim();
    const value = /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : Number(raw);
    if (index < 0 || raw === '' || !Number.isFinite(value)) return false;
    const entity = GameObject.get(index);
    if (Comp === Transform && (prop === 'x' || prop === 'y')) {
      if (!entity) return false;
      entity.setPosition(prop === 'x' ? value : Transform.x[index], prop === 'y' ? value : Transform.y[index]);
      return true;
    }
    if (Comp === Transform && prop === 'rotation') {
      if (!entity) return false;
      entity.rotation = value;
      return true;
    }
    const camel = Comp.name.charAt(0).toLowerCase() + Comp.name.slice(1);
    const component = entity ? entity[camel] : null;
    if (component && prop in component) component[prop] = value;
    else if (Comp[prop]) Comp[prop][index] = value;
    else return false;
    return true;
  }
}
