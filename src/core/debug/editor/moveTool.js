// moveTool.js — moving placed entities in edit mode (VISUAL_EDITOR_PLAN.md D6, ED-10).
//
// A press with the primary button selects (selection.js); on the selected entity it keeps it, so a drag from there
// moves it, and a click there without a drag takes the next entity under it. While dragging, nothing is spawned or
// written: the overlay draws a ghost of the entity's box where it would land, snapped to the grid. Letting go
// writes x and y into its record and respawns it, once (sceneDocument.js). The arrow keys nudge the selection by the
// grid step (Shift: ten steps), one respawn per press. Runtime entities are not in the file and do not move, nor do
// entities of a locked layer (editorLayers.js, ED-24).
//
// The ghost's corners live in a buffer made once: drawing it allocates nothing per frame.

import { entityBox, pointOnEntity } from './pick.js';
import { recordOf, writePosition } from './sceneDocument.js';

/** The grid steps the editor offers, in world pixels; 1 is no snap. */
export const SNAP_STEPS = Object.freeze([1, 8, 16, 32]);
/** Screen pixels a press must travel before it is a drag, not a click. */
const DRAG_THRESHOLD_PX = 3;

/** A position on the grid of `step` world pixels. */
export const snapTo = (value, step) => (step > 1 ? Math.round(value / step) * step : Math.round(value));

export class MoveTool {
  constructor(selection) {
    this.selection = selection;
    /** The grid step, one of SNAP_STEPS. */
    this.snap = 1;

    this._pressed = false;
    this._dragging = false;
    /** The press was on the entity already selected: a click without a drag goes to the next one under it. */
    this._pressedSelected = false;
    this._pressScreenX = NaN;
    this._pressScreenY = NaN;
    this._pressWorldX = NaN;
    this._pressWorldY = NaN;
    /** The record's x and y when the drag started, and where it would land now. */
    this._fromX = NaN;
    this._fromY = NaN;
    this._toX = NaN;
    this._toY = NaN;
    this._box = new Float64Array(6);
    this._corners = new Float64Array(8);
  }

  get dragging() {
    return this._dragging;
  }

  /** A primary press on the game canvas, at a world point and a screen point. */
  press(x, y, screenX, screenY) {
    const selection = this.selection;
    // An entity of a locked or hidden layer (selected in the scene list) is not kept by a press in the view (ED-24).
    this._pressedSelected =
      selection.index >= 0 && selection.editor?.layers?.unpickable(selection.index) !== true && pointOnEntity(selection.index, x, y);
    if (!this._pressedSelected) selection.pickAt(x, y);
    this._pressed = true;
    this._dragging = false;
    this._pressScreenX = screenX;
    this._pressScreenY = screenY;
    this._pressWorldX = x;
    this._pressWorldY = y;
  }

  move(x, y, screenX, screenY) {
    if (!this._pressed) return;
    if (!this._dragging) {
      const dx = screenX - this._pressScreenX;
      const dy = screenY - this._pressScreenY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      const found = this.selection.authored ? recordOf(this.selection.debugUI.scene, this.selection.name) : null;
      if (found === null) {
        this._pressed = false; // a runtime entity, or nothing: no drag
        return;
      }
      this._dragging = true;
      this._fromX = found.record.x;
      this._fromY = found.record.y;
    }
    this._toX = snapTo(this._fromX + (x - this._pressWorldX), this.snap);
    this._toY = snapTo(this._fromY + (y - this._pressWorldY), this.snap);
  }

  release() {
    if (!this._pressed) return;
    this._pressed = false;
    if (this._dragging) {
      this._dragging = false;
      if (this._toX !== this._fromX || this._toY !== this._fromY) this._moveTo(this._toX, this._toY);
    } else if (this._pressedSelected) {
      this.selection.pickAt(this._pressWorldX, this._pressWorldY); // the next one under it
    }
  }

  /** Let go of a drag without moving (edit mode left, a swap). */
  cancel() {
    this._pressed = false;
    this._dragging = false;
  }

  /**
   * An arrow key: move the selected authored entity by `steps` grid steps on each axis.
   * @returns {boolean} whether it moved
   */
  nudge(stepsX, stepsY) {
    const selection = this.selection;
    if (!selection.authored || this._dragging) return false;
    const layers = selection.editor?.layers;
    if (layers && layers.locked(selection.index)) {
      selection.editor._setStatus(`${selection.name} is on a locked layer (${layers.lockedLayerOf(selection.index)})`, true);
      return false;
    }
    const found = recordOf(selection.debugUI.scene, selection.name);
    if (found === null) return false;
    const step = this.snap;
    this._moveTo(snapTo(found.record.x + stepsX * step, step), snapTo(found.record.y + stepsY * step, step));
    return true;
  }

  /** Through the editor: kept for undo, and the selection follows the respawned entity (the others selected too). */
  _moveTo(x, y) {
    const editor = this.selection.editor;
    if (typeof editor.moveSelectedTo === 'function') editor.moveSelectedTo(x, y);
    else editor.editSelected(`move ${this.selection.name}`, (record) => writePosition(record, x, y));
  }

  /**
   * The ghost, in the overlay's screen space (camera.x and camera.y are the view's top-left in the world).
   * @param {CanvasRenderingContext2D} ctx
   */
  drawOverlay(ctx, camera, zoom) {
    if (!this._dragging || this.selection.index < 0) return;
    const box = this._box;
    if (!entityBox(this.selection.index, box)) return;
    const dx = this._toX - this._fromX;
    const dy = this._toY - this._fromY;
    const cx = (box[0] + dx - camera.x) * zoom;
    const cy = (box[1] + dy - camera.y) * zoom;
    const hw = box[2] * zoom;
    const hh = box[3] * zoom;
    const c = box[4];
    const s = box[5];
    const p = this._corners;
    p[0] = cx - c * hw + s * hh;
    p[1] = cy - s * hw - c * hh;
    p[2] = cx + c * hw + s * hh;
    p[3] = cy + s * hw - c * hh;
    p[4] = cx + c * hw - s * hh;
    p[5] = cy + s * hw + c * hh;
    p[6] = cx - c * hw - s * hh;
    p[7] = cy - s * hw + c * hh;
    ctx.save();
    ctx.setLineDash(GHOST_DASH);
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.lineTo(p[6], p[7]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

const GHOST_DASH = Object.freeze([6, 4]);
