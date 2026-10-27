// jointTool.js — the joints of the selected placed entity on the editor's overlay (VISUAL_EDITOR_PLAN.md ED-21): for
// each of the scene file's joints that names it, a line between its two anchors and a handle on each (filled on the
// selected entity's side). Alt+press on a handle drags it (a tool of EditMode.addTool, asked before the move tool);
// letting go writes the anchor, relative to its entity and in its frame, through editJoints: one undo. Alt, because
// an anchor often sits on its entity's center, where a plain press selects and moves the entity.
//
// Drawn each overlay frame from the document and the Transform columns, with no allocation: the anchors' world
// points go through a buffer made once.

import { Camera } from '../../camera.js';
import { Transform } from '../../../components/transform.js';
import { namedEntityIndex } from '../../sceneFileJoints.js';
import { snapTo } from './moveTool.js';
import { editJoints } from './jointsPanel.js';

/** How near a press must be to a handle, in screen px. */
const GRAB_PX = 8;
const HANDLE_PX = 5;
const LINE_COLOR = 'rgba(250, 204, 21, 0.9)';
const LINE_DASH = Object.freeze([4, 3]);
const NO_DASH = Object.freeze([]);
const TWO_PI = Math.PI * 2;

export class JointTool {
  /** @param {object} editMode */
  constructor(editMode) {
    this.editMode = editMode;
    /** The handle being dragged: its joint's position in the file, which anchor, and the entity it holds. */
    this._dragPosition = -1;
    this._dragKey = '';
    this._dragName = '';
    this._dragDoc = null;
    /** Where the dragged handle would land (world). */
    this._toX = NaN;
    this._toY = NaN;
    /** The world points of a joint's anchors: ax, ay, bx, by. */
    this._points = new Float64Array(4);
  }

  get dragging() {
    return this._dragPosition >= 0;
  }

  /** The world point of `anchor` (or the origin) on the live entity `index`, into _points at `at`. */
  _world(index, anchor, at) {
    const ax = anchor ? anchor[0] : 0;
    const ay = anchor ? anchor[1] : 0;
    const c = Transform.rotC ? Transform.rotC[index] : 1;
    const s = Transform.rotS ? Transform.rotS[index] : 0;
    this._points[at] = Transform.x[index] + c * ax - s * ay;
    this._points[at + 1] = Transform.y[index] + s * ax + c * ay;
  }

  /** The two anchors of the file's joint at `position` into _points; false while one of its entities is not live. */
  _anchors(scene, joint) {
    const a = namedEntityIndex(scene, joint.a);
    const b = namedEntityIndex(scene, joint.b);
    if (a < 0 || b < 0) return false;
    this._world(a, joint.anchorA, 0);
    this._world(b, joint.anchorB, 2);
    return true;
  }

  /** The selected placed entity's name, when the file's joints may show: edit mode, an authored selection. */
  _selectedName() {
    const selection = this.editMode.selection;
    return this.editMode.active && selection.authored && selection.index >= 0 ? selection.name : null;
  }

  press(x, y, e) {
    this.cancel();
    if (e?.altKey !== true) return false;
    const name = this._selectedName();
    const scene = this.editMode.debugUI.scene;
    const joints = scene?.sceneFile?.joints;
    if (name === null || !Array.isArray(joints)) return false;
    const reach = GRAB_PX / (Camera.zoom || 1);
    let best = reach * reach;
    for (let p = 0; p < joints.length; p++) {
      const joint = joints[p];
      if ((joint.a !== name && joint.b !== name) || !this._anchors(scene, joint)) continue;
      for (let end = 0; end < 2; end++) {
        const dx = this._points[end * 2] - x;
        const dy = this._points[end * 2 + 1] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > best) continue;
        best = d2;
        this._dragPosition = p;
        this._dragKey = end === 0 ? 'anchorA' : 'anchorB';
        this._dragName = end === 0 ? joint.a : joint.b;
      }
    }
    if (this._dragPosition < 0) return false;
    this._dragDoc = scene.sceneFile;
    this._toX = x;
    this._toY = y;
    return true;
  }

  move(x, y) {
    if (this._dragPosition < 0) return;
    const step = this.editMode.move?.snap ?? 1;
    this._toX = step > 1 ? snapTo(x, step) : x;
    this._toY = step > 1 ? snapTo(y, step) : y;
  }

  release() {
    const position = this._dragPosition;
    const key = this._dragKey;
    const name = this._dragName;
    const doc = this._dragDoc;
    this.cancel();
    const scene = this.editMode.debugUI.scene;
    if (position < 0 || scene?.sceneFile !== doc) return;
    const index = namedEntityIndex(scene, name);
    if (index < 0) return;
    // The point in the entity's frame, from its position.
    const dx = this._toX - Transform.x[index];
    const dy = this._toY - Transform.y[index];
    const c = Transform.rotC ? Transform.rotC[index] : 1;
    const s = Transform.rotS ? Transform.rotS[index] : 0;
    const local = [Math.round((c * dx + s * dy) * 100) / 100, Math.round((-s * dx + c * dy) * 100) / 100];
    editJoints(this.editMode, `move a joint anchor of ${name}`, (joints) => {
      if (joints[position]) joints[position][key] = local;
    });
  }

  cancel() {
    this._dragPosition = -1;
    this._dragKey = '';
    this._dragName = '';
    this._dragDoc = null;
  }

  /** Each joint of the selected entity: a dashed line between its anchors, a handle on each, the dragged one moved. */
  drawOverlay(ctx, camera, zoom) {
    const name = this._selectedName();
    const scene = this.editMode.debugUI.scene;
    const joints = scene?.sceneFile?.joints;
    if (name === null || !Array.isArray(joints)) return;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = LINE_COLOR;
    ctx.fillStyle = LINE_COLOR;
    for (let p = 0; p < joints.length; p++) {
      const joint = joints[p];
      if ((joint.a !== name && joint.b !== name) || !this._anchors(scene, joint)) continue;
      const points = this._points;
      if (p === this._dragPosition) {
        const at = this._dragKey === 'anchorA' ? 0 : 2;
        points[at] = this._toX;
        points[at + 1] = this._toY;
      }
      const ax = (points[0] - camera.x) * zoom;
      const ay = (points[1] - camera.y) * zoom;
      const bx = (points[2] - camera.x) * zoom;
      const by = (points[3] - camera.y) * zoom;
      ctx.setLineDash(LINE_DASH);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      for (let end = 0; end < 2; end++) {
        ctx.beginPath();
        ctx.arc(end === 0 ? ax : bx, end === 0 ? ay : by, HANDLE_PX, 0, TWO_PI);
        if ((end === 0 ? joint.a : joint.b) === name) ctx.fill();
        else ctx.stroke();
      }
    }
    ctx.restore();
  }
}
