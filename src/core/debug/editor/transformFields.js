// transformFields.js — the inspector's Transform rows (VISUAL_EDITOR_PLAN.md ED-53), first as in Unity: a placed
// entity's position (its record's x, y), its rotation in degrees and its sprite's scale (the record's rotation in
// radians, scaleX, scaleY: sceneFile.js; 0 and 1 are left out of the record). A value is typed (Enter or leaving the
// field writes it), or dragged by its label: 1 px is a world unit, a degree or 0.01 of scale, ×10 with Shift, ×0.1
// with Ctrl; a position snaps to the grid as a drag in the view does, unless Alt is held. As a drag goes, the moved or
// turned box is drawn over the view (ghost.js: a body's pose is the physics worker's) and the sprite's scale shows on
// the entity; the record is written once, on letting go: one undo, one respawn (EditMode.editSelected). Esc during a
// drag drops it.
//
// Cost: built once, filled when the selection changes; a drag writes one field's text and a few component values per
// pointer move, and allocates nothing.

import { Transform } from '../../../components/transform.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { writePosition } from './sceneDocument.js';
import { snapTo } from './moveTool.js';

const DEG = 180 / Math.PI;
const LABEL_STYLE = 'font-size:11px;color:#ccc;width:84px;flex:none';
const AXIS_STYLE = 'font-size:11px;color:#8a90a0;cursor:ew-resize;user-select:none;padding:0 3px 0 6px;touch-action:none';
const INPUT_STYLE =
  'flex:1;min-width:0;width:0;font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;font-variant-numeric:tabular-nums';

/** Each value: its key, the row it is on, its axis label, what 1 px of a drag adds, and its number of decimals. */
const VALUES = [
  { key: 'x', row: 'Position', axis: 'X', perPixel: 1, decimals: 2 },
  { key: 'y', row: 'Position', axis: 'Y', perPixel: 1, decimals: 2 },
  { key: 'rotation', row: 'Rotation', axis: '°', perPixel: 1, decimals: 2 },
  { key: 'scaleX', row: 'Scale', axis: 'X', perPixel: 0.01, decimals: 3 },
  { key: 'scaleY', row: 'Scale', axis: 'Y', perPixel: 0.01, decimals: 3 },
];

/** A number as the field shows it: at most `decimals` decimals, no trailing zeros. */
export function formatValue(value, decimals) {
  const p = 10 ** decimals;
  return String(Math.round(value * p) / p);
}

/** The record's value for a row: degrees for the rotation, 1 for a scale it leaves out. */
export function recordValue(record, key) {
  switch (key) {
    case 'rotation':
      return (record.rotation || 0) * DEG;
    case 'scaleX':
    case 'scaleY':
      return record[key] ?? 1;
    default:
      return record[key];
  }
}

/** Write a row's value into a record: radians for the rotation (in (-180°, 180°]), and 0 and 1 left out. */
export function writeValue(record, key, value) {
  switch (key) {
    case 'x':
      writePosition(record, value, record.y);
      break;
    case 'y':
      writePosition(record, record.x, value);
      break;
    case 'rotation': {
      let deg = value % 360;
      if (deg > 180) deg -= 360;
      else if (deg <= -180) deg += 360;
      const rad = Math.round((deg / DEG) * 1e6) / 1e6;
      if (rad === 0) delete record.rotation;
      else record.rotation = rad;
      break;
    }
    default: {
      const scale = Math.round(value * 1e4) / 1e4;
      if (scale === 1) delete record[key];
      else record[key] = scale;
    }
  }
}

export class TransformFields {
  /** @param {object} selection - the editor's Selection: its editor writes, its index is the live entity */
  constructor(selection) {
    this.selection = selection;
    this.el = document.createElement('div');
    this.el.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px';
    /** The record shown, or null. */
    this._record = null;
    /** Per value (VALUES' order): its input and axis label. */
    this._inputs = [];
    this._axes = [];
    /** The scale row: hidden for an entity without a sprite. */
    this._scaleRow = null;
    // A drag on a label: which value (-1: none), where it started, and the value then.
    this._drag = -1;
    this._dragStartX = 0;
    this._dragStartValue = 0;
    this._dragValue = 0;
    this._build();
  }

  /** Show a placed entity's record (null: hide the rows, for a runtime entity or none). */
  show(record, index) {
    this.cancelDrag();
    this._record = record;
    this.el.style.display = record === null ? 'none' : 'flex';
    if (record === null) return;
    for (let v = 0; v < VALUES.length; v++) this._inputs[v].value = formatValue(recordValue(record, VALUES[v].key), VALUES[v].decimals);
    const sprite = index >= 0 && SpriteRenderer.active && SpriteRenderer.active[index] === 1;
    this._scaleRow.style.display = sprite || record.scaleX !== undefined || record.scaleY !== undefined ? 'flex' : 'none';
  }

  /** Esc, or the selection changing, during a drag: the live entity as the record has it. */
  cancelDrag() {
    if (this._drag < 0) return;
    const v = this._drag;
    this._drag = -1;
    this.selection.editor?.ghost?.clear();
    if (this._record !== null) {
      const key = VALUES[v].key;
      if (key === 'scaleX' || key === 'scaleY') this._preview(key, recordValue(this._record, key));
      this._inputs[v].value = formatValue(recordValue(this._record, key), VALUES[v].decimals);
    }
  }

  _build() {
    let row = null;
    for (let v = 0; v < VALUES.length; v++) {
      const value = VALUES[v];
      if (row === null || row.dataset.row !== value.row) {
        row = document.createElement('div');
        row.dataset.row = value.row;
        row.style.cssText = 'display:flex;align-items:center;min-width:0';
        const label = document.createElement('span');
        label.textContent = value.row;
        label.style.cssText = LABEL_STYLE;
        row.appendChild(label);
        this.el.appendChild(row);
        if (value.row === 'Scale') this._scaleRow = row;
      }
      const axis = document.createElement('span');
      axis.textContent = value.axis;
      axis.style.cssText = AXIS_STYLE;
      axis.title =
        value.key === 'rotation'
          ? 'Drag to turn: 1 px is a degree; Shift ×10, Ctrl ×0.1'
          : value.row === 'Scale'
            ? 'Drag to scale the sprite: 1 px is 0.01; Shift ×10, Ctrl ×0.1 (a collider keeps the size its params give)'
            : `Drag to move along ${value.axis}: 1 px is a world unit, on the grid unless Alt is held; Shift ×10, Ctrl ×0.1`;
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.spellcheck = false;
      input.style.cssText = INPUT_STYLE;
      input.title = value.key === 'rotation' ? 'Rotation in degrees' : `${value.row} ${value.axis}`;
      input.onchange = () => this._typed(v);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape' && this._record !== null) {
          input.value = formatValue(recordValue(this._record, value.key), value.decimals);
          input.blur();
        }
      };
      if (value.key === 'rotation') {
        // The degree sign after the field, as the label for a drag.
        row.append(input, axis);
      } else {
        row.append(axis, input);
      }
      axis.onpointerdown = (e) => this._dragStart(v, e);
      axis.onpointermove = (e) => this._dragMove(v, e);
      axis.onpointerup = () => this._dragEnd(v);
      axis.onpointercancel = () => this.cancelDrag();
      axis.onkeydown = (e) => e.key === 'Escape' && this.cancelDrag();
      this._inputs.push(input);
      this._axes.push(axis);
    }
  }

  _typed(v) {
    const record = this._record;
    if (record === null) return;
    const value = Number(this._inputs[v].value.trim());
    if (!Number.isFinite(value)) {
      this._inputs[v].value = formatValue(recordValue(record, VALUES[v].key), VALUES[v].decimals);
      return;
    }
    this._write(v, value);
  }

  _dragStart(v, e) {
    if (this._record === null || e.button !== 0) return;
    this._drag = v;
    this._dragStartX = e.clientX;
    this._dragStartValue = this._dragValue = recordValue(this._record, VALUES[v].key);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  _dragMove(v, e) {
    if (this._drag !== v) return;
    const value = VALUES[v];
    const speed = e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1;
    let next = this._dragStartValue + (e.clientX - this._dragStartX) * value.perPixel * speed;
    if (value.row === 'Position' && !e.altKey) next = snapTo(next, this.selection.editor?.move?.snap ?? 1);
    if (next === this._dragValue) return;
    this._dragValue = next;
    this._inputs[v].value = formatValue(next, value.decimals);
    this._preview(value.key, next);
  }

  _dragEnd(v) {
    if (this._drag !== v) return;
    this._drag = -1;
    this.selection.editor?.ghost?.clear();
    if (this._dragValue !== this._dragStartValue) this._write(v, this._dragValue);
  }

  _write(v, value) {
    const key = VALUES[v].key;
    const editor = this.selection.editor;
    const name = this.selection.name;
    if (!editor || name === null) return;
    const label = key === 'x' || key === 'y' ? `move ${name}` : key === 'rotation' ? `turn ${name}` : `scale ${name}`;
    if (editor.editSelected(label, (record) => writeValue(record, key, value)) < 0 && this._record !== null) {
      // Nothing changed (the same value): the field shows the record's again.
      this._inputs[v].value = formatValue(recordValue(this._record, key), VALUES[v].decimals);
    }
  }

  /**
   * A drag's value shown before it is written: a moved or turned box drawn over the view (the editor's ghost: the
   * physics worker owns a body's pose), or the sprite's scale on the entity (no worker writes that).
   */
  _preview(key, value) {
    const i = this.selection.index;
    if (i < 0) return;
    const ghost = this.selection.editor?.ghost;
    const from = this._dragStartValue;
    switch (key) {
      case 'x':
        ghost?.showOne(i, value - from, 0, 0, Transform.x[i], Transform.y[i]);
        break;
      case 'y':
        ghost?.showOne(i, 0, value - from, 0, Transform.x[i], Transform.y[i]);
        break;
      case 'rotation':
        ghost?.showOne(i, 0, 0, (value - from) / DEG, Transform.x[i], Transform.y[i]);
        break;
      default: {
        if (!SpriteRenderer.active || SpriteRenderer.active[i] !== 1) return;
        // A flip is the stored scale's sign (GameObject.setScale).
        const flip = SpriteRenderer.flip ? SpriteRenderer.flip[i] : 0;
        SpriteRenderer[key][i] = flip & (key === 'scaleX' ? 1 : 2) ? -value : value;
        SpriteRenderer.updateBounds?.(i);
        if (SpriteRenderer.renderDirty) SpriteRenderer.renderDirty[i] = 1;
      }
    }
    this.selection.debugUI?.canvas?.startLoop?.();
  }
}
