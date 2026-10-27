// dropPlace.js — a class dragged from the palette onto the view is placed where it drops (VISUAL_EDITOR_PLAN.md
// ED-66), as Unity and Godot place what is dragged into their scene view: snapped to the grid, one undo, selected.
//
// HTML5 drag and drop, with a type of the editor's own (CLASS_DRAG_TYPE): the palette's rows are the drag's source,
// the game page's document listens for the drop on the game's canvas. In the editor page the palette is in the editor
// page's document and the view in the game page's frame; a drag crosses frames of one origin, and the drop arrives in
// the game page with its own client point. A drag that does not carry the type (a file, the game's own) is left alone.
//
// The drop's point maps to the world as a click's does (Mouse: the canvas's box, then the drawn camera, scene.camera),
// so a drop and a click at one spot land at one point. The point is mapped through the view the drop was made in: a
// drop while the game plays (the editor page's palette shows then) goes back to editing after it, at the level's start
// (EditMode.edit, ED-80), and that leaves the view where it is.
//
// While a drag is over the view in edit mode, the overlay shows where it would land: a cross at the snapped point, and
// the class's name.
//
// Cost: four listeners on the game page's document that return at once for any other drag. Nothing per frame, except
// while a drag is over the view: then the cross, a few lines.

import { snapTo } from './moveTool.js';
import { viewScreenToWorld } from '../../../util/viewBounds.js';

/** The drag data type that carries a class's name from the palette. */
export const CLASS_DRAG_TYPE = 'application/x-weed-class';

const GHOST_COLOR = 'rgba(52, 211, 153, 0.95)'; // the move tool's ghost
const LABEL_FONT = '11px system-ui, sans-serif';
const GHOST_DASH = Object.freeze([4, 3]);
const NO_DASH = Object.freeze([]);
/** The cross's arm, screen px. */
const ARM = 7;
const TWO_PI = Math.PI * 2;

/**
 * A client point (an event's clientX and clientY) as a world point, as Mouse maps a click (Mouse._place, _writeWorld):
 * the point in the view's box, then through the drawn camera, turned about the canvas's center when the camera is
 * (util/viewBounds.js viewScreenToWorld, Mouse's own arithmetic).
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number }} rect - the view's (canvas's) box
 * @param {{ x: number, y: number, zoom: number, rotation: number, canvasWidth: number, canvasHeight: number }} camera -
 *   the scene's main-thread camera (scene.camera), the one Mouse inverts
 * @param {{ x: number, y: number }} out
 * @returns {{ x: number, y: number }} out
 */
export function viewPointToWorld(clientX, clientY, rect, camera, out) {
  return viewScreenToWorld(
    camera.x,
    camera.y,
    camera.zoom || 1,
    camera.rotation || 0,
    camera.canvasWidth || 0,
    camera.canvasHeight || 0,
    clientX - rect.left,
    clientY - rect.top,
    out,
  );
}

/** Whether a drag carries a class from the palette (its types can be read while it is under way; its data cannot). */
export function carriesClass(dataTransfer) {
  const types = dataTransfer ? dataTransfer.types : null;
  if (!types) return false;
  for (let k = 0; k < types.length; k++) if (types[k] === CLASS_DRAG_TYPE) return true;
  return false;
}

export class DropPlacer {
  /**
   * @param {object} editMode - the EditMode that places (place), and whose overlay draws the cross (addTool)
   * @param {(name: string) => Function|null} classOf - the running scene's placeable class of that name, or null
   */
  constructor(editMode, classOf) {
    this.editMode = editMode;
    this._classOf = classOf;
    /** The class a drag from this page's palette carries (begin), or null: none, or a drag from elsewhere. */
    this.dragging = null;
    /** The document listened to, or null. */
    this._doc = null;
    /** Added to the editor's tools (the overlay's cross), once. */
    this._isTool = false;
    /** A drag over the view: where it would land, on the grid. */
    this._over = false;
    this.x = NaN;
    this.y = NaN;
    /** viewPointToWorld's output, reused. */
    this._point = { x: NaN, y: NaN };
    this._onDragOver = (e) => this._dragOver(e);
    this._onDragLeave = (e) => this._dragLeave(e);
    this._onDrop = (e) => this._drop(e);
  }

  /**
   * Listen for drops in `doc` (the game page's document; again for another, a no-op for the same), and draw the cross
   * on the editor's overlay.
   * @param {Document} doc
   */
  attach(doc) {
    if (!this._isTool && typeof this.editMode.addTool === 'function') {
      this.editMode.addTool(this);
      this._isTool = true;
    }
    if (!doc || doc === this._doc) return;
    this.detach();
    doc.addEventListener('dragenter', this._onDragOver);
    doc.addEventListener('dragover', this._onDragOver);
    doc.addEventListener('dragleave', this._onDragLeave);
    doc.addEventListener('drop', this._onDrop);
    this._doc = doc;
  }

  detach() {
    const doc = this._doc;
    if (doc === null) return;
    doc.removeEventListener('dragenter', this._onDragOver);
    doc.removeEventListener('dragover', this._onDragOver);
    doc.removeEventListener('dragleave', this._onDragLeave);
    doc.removeEventListener('drop', this._onDrop);
    this._doc = null;
    this._leave();
  }

  /** A drag of `className` starts in this page's palette (its row's dragstart). */
  begin(className) {
    this.dragging = className;
  }

  /** The drag is over (dropped or given up: its row's dragend). */
  end() {
    this.dragging = null;
    this._leave();
  }

  /**
   * Place `className` at a world point, as a drop does: through EditMode.place (on the grid, under a free name, one
   * undo), the new entity selected. While the game plays it goes back to editing first, and places it then.
   * @returns {number} its index, or -1 (no such class, no scene file, a full pool: the status line says which; or the
   *   game plays, and it is placed once the editor is editing again)
   */
  placeAt(className, x, y) {
    const editMode = this.editMode;
    if (this._classOf(className) === null) {
      editMode._setStatus(`${className}: this scene has no such class to place`, true);
      return -1;
    }
    if (!editMode.active) {
      editMode.edit().then((editing) => {
        if (editing) this.placeAt(className, x, y);
      });
      return -1;
    }
    const index = editMode.place(className, x, y);
    if (index >= 0 && editMode.selection.index !== index) editMode.selection.select(index);
    return index;
  }

  // ---- the drag over the game page ----

  _canvas() {
    return this.editMode.debugUI.gameEngine?.canvas ?? null;
  }

  _dragOver(e) {
    if (!carriesClass(e.dataTransfer)) return;
    const canvas = this._canvas();
    if (canvas === null || e.target !== canvas) {
      this._leave(); // over something else of the page: no drop there
      return;
    }
    e.preventDefault(); // a drop is welcome here
    e.dataTransfer.dropEffect = 'copy';
    const scene = this.editMode.debugUI.scene;
    if (!scene || !scene.camera) return;
    const point = viewPointToWorld(e.clientX, e.clientY, canvas.getBoundingClientRect(), scene.camera, this._point);
    const step = this.editMode.move.snap;
    this.x = snapTo(point.x, step);
    this.y = snapTo(point.y, step);
    if (this._over) return;
    this._over = true;
    if (this.editMode.active) this.editMode.debugUI.canvas?.startLoop?.(); // the overlay draws the cross
  }

  _dragLeave(e) {
    if (e.target === this._canvas() && carriesClass(e.dataTransfer)) this._leave();
  }

  _drop(e) {
    if (!carriesClass(e.dataTransfer)) return;
    const canvas = this._canvas();
    if (canvas === null || e.target !== canvas) return;
    e.preventDefault(); // the browser does not open it
    const className = e.dataTransfer.getData(CLASS_DRAG_TYPE) || this.dragging;
    this._leave();
    this.dragging = null;
    const scene = this.editMode.debugUI.scene;
    if (!className || !scene || !scene.camera) return;
    // Mapped through the view the drop was made in, before edit mode (if it was off) holds it.
    const point = viewPointToWorld(e.clientX, e.clientY, canvas.getBoundingClientRect(), scene.camera, this._point);
    this.placeAt(className, point.x, point.y);
  }

  _leave() {
    if (!this._over) return;
    this._over = false;
    this.editMode.debugUI.canvas?.syncLoop?.();
  }

  // ---- the editor's tool (EditMode.addTool): the cross on the overlay ----

  wantsOverlay() {
    return this._over;
  }

  /** The cross where the drag would land, and the class's name (camera.x, camera.y: the view's top-left in the world). */
  drawOverlay(ctx, camera, zoom) {
    if (!this._over || this.x !== this.x) return;
    const cx = (this.x - camera.x) * zoom;
    const cy = (this.y - camera.y) * zoom;
    ctx.save();
    ctx.strokeStyle = GHOST_COLOR;
    ctx.fillStyle = GHOST_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(NO_DASH);
    ctx.beginPath();
    ctx.moveTo(cx - ARM, cy);
    ctx.lineTo(cx + ARM, cy);
    ctx.moveTo(cx, cy - ARM);
    ctx.lineTo(cx, cy + ARM);
    ctx.stroke();
    ctx.setLineDash(GHOST_DASH);
    ctx.beginPath();
    ctx.arc(cx, cy, ARM + 5, 0, TWO_PI);
    ctx.stroke();
    if (this.dragging !== null) {
      ctx.font = LABEL_FONT;
      ctx.fillText(this.dragging, cx + ARM + 8, cy - ARM - 2);
    }
    ctx.restore();
  }

  /** Edit mode left, or the level swapped: no cross. */
  cancel() {
    this._leave();
  }
}
