// ghost.js — where a change would put entities, drawn over the view before it is written (VISUAL_EDITOR_PLAN.md
// ED-53, ED-58): each entity's box (pick.js entityBox) moved by (dx, dy) and turned by dr about a pivot, dashed, as
// the move tool draws its drag's ghost. The editor never writes a live entity's pose to show it: a body's pose is the
// physics worker's (Box2D writes Transform's rotation and position every step), so it would not stay. The rotate
// handle and the inspector's dragged labels show their change through it.
//
// Cost: the indices in a buffer that grows only when more entities are shown than ever before; a frame draws from
// buffers made once.

import { entityBox } from './pick.js';

const GHOST_COLOR = 'rgba(52, 211, 153, 0.95)';
const GHOST_DASH = Object.freeze([4, 4]);

export class TransformGhost {
  constructor() {
    this._indices = new Int32Array(8);
    this._count = 0;
    this._dx = 0;
    this._dy = 0;
    this._dr = 0;
    this._px = 0;
    this._py = 0;
    this._box = new Float64Array(6);
    this._corners = new Float64Array(8);
  }

  get active() {
    return this._count > 0;
  }

  /**
   * Show these entities moved by (dx, dy) and turned by dr radians about (px, py).
   * @param {ArrayLike<number>} indices
   */
  show(indices, dx, dy, dr, px, py) {
    const n = indices.length;
    if (n > this._indices.length) this._indices = new Int32Array(Math.max(n, this._indices.length * 2));
    for (let k = 0; k < n; k++) this._indices[k] = indices[k];
    this._count = n;
    this._dx = dx;
    this._dy = dy;
    this._dr = dr;
    this._px = px;
    this._py = py;
  }

  /** One entity moved by (dx, dy), and turned by dr about its own origin at (px, py). */
  showOne(index, dx, dy, dr, px, py) {
    this._indices[0] = index;
    this._count = 1;
    this._dx = dx;
    this._dy = dy;
    this._dr = dr;
    this._px = px;
    this._py = py;
  }

  clear() {
    this._count = 0;
  }

  wantsOverlay() {
    return this._count > 0;
  }

  /** The ghosts, in the overlay's screen space (camera.x and camera.y: the view's top-left in the world). */
  drawOverlay(ctx, camera, zoom) {
    if (this._count === 0 || !camera) return;
    const cd = Math.cos(this._dr);
    const sd = Math.sin(this._dr);
    const box = this._box;
    const p = this._corners;
    ctx.save();
    ctx.setLineDash(GHOST_DASH);
    ctx.strokeStyle = GHOST_COLOR;
    ctx.lineWidth = 1.5;
    for (let k = 0; k < this._count; k++) {
      if (!entityBox(this._indices[k], box)) continue;
      // The box's center turned about the pivot, then moved; its own angle turned with it.
      const ox = box[0] - this._px;
      const oy = box[1] - this._py;
      const cx = (this._px + ox * cd - oy * sd + this._dx - camera.x) * zoom;
      const cy = (this._py + ox * sd + oy * cd + this._dy - camera.y) * zoom;
      const c = box[4] * cd - box[5] * sd;
      const s = box[5] * cd + box[4] * sd;
      const hw = box[2] * zoom;
      const hh = box[3] * zoom;
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
    ctx.restore();
  }
}
