// rotateTool.js — the rotate handle (VISUAL_EDITOR_PLAN.md ED-58), as in Figma and Godot: a round handle above the
// selection's box. A drag turns the selected placed entity about its origin, or several selected about their common
// box's center (their positions go round it); Shift turns by 15° steps (one entity: to a multiple of 15°). As the
// drag goes, their turned boxes are drawn (ghost.js: a body's pose is the physics worker's, so the live entity is
// not turned to show it), and their records are written once, on letting go: one undo, one respawn each
// (EditMode.editSelected, editMany). Esc during the drag drops it. Runtime entities, and entities of a locked layer,
// have no handle.
//
// Cost: a frame computes the handle from the selection's box, with no allocation; a press allocates the turned
// entities' start values.

import { Camera } from '../../camera.js';
import { Transform } from '../../../components/transform.js';
import { entityBox } from './pick.js';
import { resetBounds, addEntityBounds } from './frame.js';
import { indexOfName, recordOf } from './sceneDocument.js';
import { writeValue } from './transformFields.js';

/** Screen pixels between the box's top and the handle, the handle's radius, and how near a press must be. */
const GAP_PX = 22;
const RADIUS_PX = 5;
const HIT_PX = 9;
const SNAP = Math.PI / 12; // 15°
const DEG = 180 / Math.PI;
const HANDLE_COLOR = 'rgba(52, 211, 153, 1)';
const HANDLE_FILL = 'rgba(255, 255, 255, 0.95)';
const LABEL_FONT = '11px monospace';
const LABEL_BACK = 'rgba(0, 0, 0, 0.7)';

export class RotateTool {
  /** @param {object} editMode */
  constructor(editMode) {
    this.editMode = editMode;
    // The handle this frame, in the world: where it is, the point on the box it hangs from, and the pivot.
    this._hx = NaN;
    this._hy = NaN;
    this._tx = NaN;
    this._ty = NaN;
    this._px = NaN;
    this._py = NaN;
    this._box = new Float64Array(6);
    this._bounds = new Float64Array(4);
    // A drag: what is turned, from where, by how much.
    this._dragging = false;
    this._names = [];
    this._indices = new Int32Array(0);
    this._x0 = new Float64Array(0);
    this._y0 = new Float64Array(0);
    this._r0 = new Float64Array(0);
    this._startAngle = 0;
    this._delta = 0;
  }

  get dragging() {
    return this._dragging;
  }

  /** A placed entity is selected, not being moved, and not on a locked layer: it has a handle (no allocation). */
  _canTurn() {
    const editMode = this.editMode;
    const selection = editMode.selection;
    // Another tool with the pointer (a collider handle being dragged): no handle, as in Figma.
    const other = editMode._toolWithPointer;
    if (other !== null && other !== undefined && other !== this) return false;
    return selection.authored && !editMode.move.dragging && editMode.layers?.locked?.(selection.index) !== true;
  }

  /** Where the handle is now (world), from the selection's box; false when there is none. */
  _place(zoom) {
    if (!this._canTurn()) return false;
    const editMode = this.editMode;
    const selection = editMode.selection;
    const gap = GAP_PX / zoom;
    if (editMode.multi.count > 0) {
      // Several: their common box, the pivot its center.
      const bounds = resetBounds(this._bounds);
      addEntityBounds(selection.index, bounds);
      const scene = editMode.debugUI.scene;
      for (const name of editMode.multi.names) {
        const i = indexOfName(scene, name);
        if (i >= 0) addEntityBounds(i, bounds);
      }
      this._px = (bounds[0] + bounds[2]) * 0.5;
      this._py = (bounds[1] + bounds[3]) * 0.5;
      this._tx = this._px;
      this._ty = bounds[1];
      this._hx = this._tx;
      this._hy = this._ty - gap;
      return true;
    }
    const i = selection.index;
    const box = this._box;
    this._px = Transform.x[i];
    this._py = Transform.y[i];
    if (entityBox(i, box)) {
      // The box's top middle, along its own up (the turned box's (0, -1): (sin, -cos)).
      const ux = box[5];
      const uy = -box[4];
      this._tx = box[0] + ux * box[3];
      this._ty = box[1] + uy * box[3];
      this._hx = this._tx + ux * gap;
      this._hy = this._ty + uy * gap;
    } else {
      this._tx = this._px;
      this._ty = this._py;
      this._hx = this._px;
      this._hy = this._py - gap;
    }
    return true;
  }

  wantsOverlay() {
    return this._dragging || this._canTurn();
  }

  press(x, y, e) {
    if (e?.button !== undefined && e.button !== 0) return false;
    const zoom = Camera.zoom || 1;
    if (!this._place(zoom)) return false;
    const dx = x - this._hx;
    const dy = y - this._hy;
    const reach = HIT_PX / zoom;
    if (dx * dx + dy * dy > reach * reach) return false;
    const editMode = this.editMode;
    const names = editMode.multi.count > 0 ? editMode.multi.selectedNames() : [editMode.selection.name];
    const scene = editMode.debugUI.scene;
    const n = names.length;
    this._names = names;
    this._indices = new Int32Array(n);
    this._x0 = new Float64Array(n);
    this._y0 = new Float64Array(n);
    this._r0 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = indexOfName(scene, names[k]);
      const record = recordOf(scene, names[k])?.record;
      this._indices[k] = i;
      this._x0[k] = record ? record.x : Transform.x[i];
      this._y0[k] = record ? record.y : Transform.y[i];
      // What shows: a class may turn its entity in onSpawned without the file.
      this._r0[k] = i >= 0 && Transform.rotation ? Transform.rotation[i] : 0;
    }
    this._startAngle = Math.atan2(y - this._py, x - this._px);
    this._delta = 0;
    this._dragging = true;
    return true;
  }

  move(x, y, e) {
    if (!this._dragging) return;
    let delta = Math.atan2(y - this._py, x - this._px) - this._startAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    else if (delta < -Math.PI) delta += 2 * Math.PI;
    if (e?.shiftKey) {
      // One entity: to a multiple of 15°; several: by 15° steps.
      if (this._names.length === 1) delta = Math.round((this._r0[0] + delta) / SNAP) * SNAP - this._r0[0];
      else delta = Math.round(delta / SNAP) * SNAP;
    }
    if (delta === this._delta) return;
    this._delta = delta;
    this._preview(delta);
  }

  release() {
    if (!this._dragging) return;
    this._dragging = false;
    this.editMode.ghost.clear();
    const delta = this._delta;
    if (delta === 0) return;
    const editor = this.editMode;
    const names = this._names;
    if (names.length === 1) {
      const r = this._r0[0] + delta;
      editor.editSelected(`turn ${names[0]}`, (record) => writeValue(record, 'rotation', r * DEG));
      return;
    }
    const at = new Map();
    for (let k = 0; k < names.length; k++) at.set(names[k], k);
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    const px = this._px;
    const py = this._py;
    editor.editMany(`turn ${names.length} entities`, names, (record) => {
      const k = at.get(record.name);
      if (k === undefined) return;
      const dx = this._x0[k] - px;
      const dy = this._y0[k] - py;
      record.x = Math.round((px + dx * c - dy * s) * 100) / 100;
      record.y = Math.round((py + dx * s + dy * c) * 100) / 100;
      writeValue(record, 'rotation', (this._r0[k] + delta) * DEG);
    });
  }

  cancel() {
    if (!this._dragging) return;
    this._dragging = false;
    this._delta = 0;
    this.editMode.ghost.clear();
  }

  onKey(e) {
    if (e.key !== 'Escape' || !this._dragging) return false;
    this.cancel();
    return true;
  }

  /** The turned entities as they would be: their boxes turned about the pivot (ghost.js). */
  _preview(delta) {
    this.editMode.ghost.show(this._indices, 0, 0, delta, this._px, this._py);
    this.editMode.debugUI.canvas?.startLoop?.();
  }

  /** The handle, its stem from the box, and while turning the angle; in the overlay's screen space. */
  drawOverlay(ctx, camera, zoom) {
    if (!this._dragging && !this._place(zoom)) return;
    // While turning, the handle and its stem go round the pivot with the ghost.
    const c = this._dragging ? Math.cos(this._delta) : 1;
    const s = this._dragging ? Math.sin(this._delta) : 0;
    const hx = (this._px + (this._hx - this._px) * c - (this._hy - this._py) * s - camera.x) * zoom;
    const hy = (this._py + (this._hx - this._px) * s + (this._hy - this._py) * c - camera.y) * zoom;
    const tx = (this._px + (this._tx - this._px) * c - (this._ty - this._py) * s - camera.x) * zoom;
    const ty = (this._py + (this._tx - this._px) * s + (this._ty - this._py) * c - camera.y) * zoom;
    ctx.save();
    ctx.strokeStyle = HANDLE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(tx) + 0.5, Math.round(ty) + 0.5);
    ctx.lineTo(Math.round(hx) + 0.5, Math.round(hy) + 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(Math.round(hx) + 0.5, Math.round(hy) + 0.5, RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = HANDLE_FILL;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (this._dragging) {
      const px = Math.round((this._px - camera.x) * zoom) + 0.5;
      const py = Math.round((this._py - camera.y) * zoom) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px - 5, py);
      ctx.lineTo(px + 5, py);
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px, py + 5);
      ctx.stroke();
      const degrees = this._names.length === 1 ? (this._r0[0] + this._delta) * DEG : this._delta * DEG;
      const text = `${Math.round(degrees * 10) / 10}°`;
      ctx.font = LABEL_FONT;
      const w = ctx.measureText ? ctx.measureText(text).width : text.length * 7;
      ctx.fillStyle = LABEL_BACK;
      ctx.fillRect(Math.round(hx) + 10, Math.round(hy) - 9, w + 8, 16);
      ctx.fillStyle = HANDLE_FILL;
      ctx.fillText(text, Math.round(hx) + 14, Math.round(hy) + 3);
    }
    ctx.restore();
  }
}
