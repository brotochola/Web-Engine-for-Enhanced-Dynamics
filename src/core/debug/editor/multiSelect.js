// multiSelect.js — selecting several placed entities (VISUAL_EDITOR_PLAN.md ED-28): a drag on empty ground draws a
// box and selects what it touches, Shift+click adds or takes out one, Ctrl+A selects every placed entity. The
// selection (selection.js) stays the one the inspector shows; the others are kept here by name, and a move, a nudge,
// Del and Ctrl+D act on all of them as one change (EditMode.editMany and the history's batch). Ctrl+G groups them:
// a click on one of a group selects the group. Groups are the editor's, kept in the scene file under `editor.groups`
// (a key the game never reads); Ctrl+Shift+G ungroups.
//
// Cost: a press tests what is under the pointer (pick.js, one pass); a box tests every placed entity once, on
// release. The overlay draws from buffers made once.

import { Transform } from '../../../components/transform.js';
import { pickEntityAt, entityBox } from './pick.js';
import { recordOf, indexOfName } from './sceneDocument.js';

const BOX_DASH = Object.freeze([4, 4]);
/** Screen pixels a press on empty ground must travel to draw a box rather than clear the selection. */
const BOX_THRESHOLD_PX = 3;

/** The groups of a scene file's document (`editor.groups`: lists of names), or an empty list. */
export function groupsOf(doc) {
  const groups = doc?.editor?.groups;
  return Array.isArray(groups) ? groups : [];
}

/** Write a document's groups: none removes the key, and an `editor` left empty with it. */
export function writeGroups(doc, groups) {
  if (groups.length > 0) {
    doc.editor = { ...(doc.editor || {}), groups };
  } else if (doc.editor) {
    delete doc.editor.groups;
    if (Object.keys(doc.editor).length === 0) delete doc.editor;
  }
}

export class MultiSelect {
  /** @param {object} editMode */
  constructor(editMode) {
    this.editMode = editMode;
    /** The other selected placed entities, by name (the selection holds the one the inspector shows). */
    this.names = new Set();
    this._boxing = false;
    this._pressed = false;
    this._x0 = NaN;
    this._y0 = NaN;
    this._x1 = NaN;
    this._y1 = NaN;
    this._screenX = NaN;
    this._screenY = NaN;
    this._box = new Float64Array(6);
    this._corners = new Float64Array(8);
  }

  get count() {
    return this.names.size;
  }

  has(name) {
    return this.names.has(name);
  }

  /** The selected placed entities' names: the inspector's first, then the others. */
  selectedNames() {
    const selection = this.editMode.selection;
    const out = selection.authored ? [selection.name] : [];
    for (const name of this.names) if (name !== selection.name) out.push(name);
    return out;
  }

  clear() {
    if (this.names.size === 0) return;
    this.names.clear();
    this._changed();
  }

  /**
   * Select these placed entities: the first in the inspector, the others here.
   * @param {string[]} names
   */
  selectNames(names) {
    const editMode = this.editMode;
    const scene = editMode.debugUI.scene;
    // The file's names once (a record lookup per name was 17 to 30 ms for littleCity's 1,243 trees).
    const inFile = new Set();
    for (const record of scene?.sceneFile?.entities || []) inFile.add(record.name);
    const live = names.filter((name) => inFile.has(name) && indexOfName(scene, name) >= 0);
    this.names.clear();
    if (live.length === 0) {
      editMode.selection.clear();
      this._changed();
      return;
    }
    editMode.selection.select(indexOfName(scene, live[0]));
    for (let k = 1; k < live.length; k++) this.names.add(live[k]);
    this._changed();
  }

  // ---- the tool (EditMode.addTool) ----

  press(x, y, e) {
    const editMode = this.editMode;
    const scene = editMode.debugUI.scene;
    const selection = editMode.selection;
    const hit = pickEntityAt(x, y, -1, selection._classNameOf, selection._unpickable);
    const name = hit < 0 ? null : nameOfIndex(scene, hit);
    if (e.shiftKey) {
      if (name === null) return true; // nothing placed there: Shift+click does nothing
      if (selection.name === name) {
        const next = this.names.values().next();
        if (next.done) selection.clear();
        else {
          this.names.delete(next.value);
          selection.select(indexOfName(scene, next.value));
        }
      } else if (this.names.has(name)) {
        this.names.delete(name);
      } else if (!selection.authored) {
        selection.select(hit);
      } else {
        this.names.add(name);
      }
      this._changed();
      return true;
    }
    if (hit >= 0) {
      // On an entity: the move tool selects it, or drags what is selected. A member of a group brings the group.
      if (name !== null && (name === selection.name || this.names.has(name))) return false;
      this.names.clear();
      const group = name === null ? null : groupsOf(scene.sceneFile).find((g) => g.includes(name));
      if (group) for (const member of group) if (member !== name && recordOf(scene, member) !== null) this.names.add(member);
      this._changed();
      return false;
    }
    // Empty ground: a box, or a click that clears the selection.
    this._pressed = true;
    this._boxing = false;
    this._x0 = this._x1 = x;
    this._y0 = this._y1 = y;
    this._screenX = e.clientX;
    this._screenY = e.clientY;
    return true;
  }

  move(x, y, e) {
    if (!this._pressed) return;
    if (!this._boxing) {
      const dx = e.clientX - this._screenX;
      const dy = e.clientY - this._screenY;
      if (dx * dx + dy * dy < BOX_THRESHOLD_PX * BOX_THRESHOLD_PX) return;
      this._boxing = true;
    }
    this._x1 = x;
    this._y1 = y;
  }

  release() {
    if (!this._pressed) return;
    this._pressed = false;
    if (!this._boxing) {
      this.names.clear();
      this.editMode.selection.clear();
      this._changed();
      return;
    }
    this._boxing = false;
    this.selectNames(this._namesInBox(this._x0, this._y0, this._x1, this._y1));
  }

  cancel() {
    this._pressed = false;
    this._boxing = false;
    this.names.clear();
  }

  onKey(e) {
    const editMode = this.editMode;
    if (e.key === 'Escape' && this.names.size > 0) {
      this.clear();
      return true;
    }
    if (!(e.ctrlKey || e.metaKey)) return false;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    if (key === 'a') {
      const entities = editMode.debugUI.scene?.sceneFile?.entities || [];
      this.selectNames(entities.map((r) => r.name));
      return true;
    }
    if (key === 'g') {
      if (e.shiftKey) editMode.ungroupSelected();
      else editMode.groupSelected();
      return true;
    }
    return false;
  }

  /** The box while it is drawn, and the outline of the others selected (moved with the drag while it runs). */
  drawOverlay(ctx, camera, zoom) {
    if (this._boxing) {
      const x = (Math.min(this._x0, this._x1) - camera.x) * zoom;
      const y = (Math.min(this._y0, this._y1) - camera.y) * zoom;
      const w = Math.abs(this._x1 - this._x0) * zoom;
      const h = Math.abs(this._y1 - this._y0) * zoom;
      ctx.save();
      ctx.setLineDash(BOX_DASH);
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.95)';
      ctx.fillStyle = 'rgba(147, 197, 253, 0.08)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
    if (this.names.size === 0) return;
    const editMode = this.editMode;
    const scene = editMode.debugUI.scene;
    const move = editMode.move;
    const dx = move.dragging ? move._toX - move._fromX : 0;
    const dy = move.dragging ? move._toY - move._fromY : 0;
    ctx.save();
    ctx.strokeStyle = move.dragging ? 'rgba(52, 211, 153, 0.95)' : 'rgba(250, 204, 21, 0.9)';
    if (move.dragging) ctx.setLineDash(BOX_DASH);
    ctx.lineWidth = 2;
    for (const name of this.names) {
      const i = indexOfName(scene, name);
      if (i < 0 || !entityBox(i, this._box)) continue;
      this._strokeBox(ctx, camera, zoom, dx, dy);
    }
    ctx.restore();
  }

  _strokeBox(ctx, camera, zoom, dx, dy) {
    const box = this._box;
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
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.lineTo(p[6], p[7]);
    ctx.closePath();
    ctx.stroke();
  }

  /** The placed entities whose box touches the rectangle, in file order. */
  _namesInBox(xa, ya, xb, yb) {
    const scene = this.editMode.debugUI.scene;
    const minX = Math.min(xa, xb);
    const maxX = Math.max(xa, xb);
    const minY = Math.min(ya, yb);
    const maxY = Math.max(ya, yb);
    const box = this._box;
    const out = [];
    for (const record of scene?.sceneFile?.entities || []) {
      const i = indexOfName(scene, record.name);
      if (i < 0 || this.editMode.layers?.unpickable(i) === true) continue; // a locked or hidden layer's
      if (!entityBox(i, box)) {
        const x = Transform.x[i];
        const y = Transform.y[i];
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(record.name);
        continue;
      }
      // The turned box's extent on each axis.
      const ex = Math.abs(box[4]) * box[2] + Math.abs(box[5]) * box[3];
      const ey = Math.abs(box[5]) * box[2] + Math.abs(box[4]) * box[3];
      if (box[0] + ex >= minX && box[0] - ex <= maxX && box[1] + ey >= minY && box[1] - ey <= maxY) out.push(record.name);
    }
    return out;
  }

  /** The inspector and the scene list show the change. */
  _changed() {
    const debugUI = this.editMode.debugUI;
    debugUI.canvas?.startLoop?.();
    this.editMode.selection.showCount?.(this.names.size);
    debugUI.hosted?.onSelectionChanged();
  }
}

/** The running file's name for the live entity at `index`, or null (runtime, or not the same entity any more). */
function nameOfIndex(scene, index) {
  const names = scene?._namedEntities;
  if (!names) return null;
  for (const [name] of names) if (indexOfName(scene, name) === index) return name;
  return null;
}
