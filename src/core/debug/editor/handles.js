// handles.js — handles on the selected placed entity in edit mode (VISUAL_EDITOR_PLAN.md Stage 4): its collider's size
// (ED-20: a box's edges and corners, a circle's radius, a polygon's vertices), its light's reach (ED-22), the points
// of its points params (ED-27), and a line to each entity its entity params name.
//
// A handle changes the spawn param that drives what it shows: the one named like the component's column, as "Copy to
// scene" pairs them (liveInspector.js): a box's `width` and `height`, a circle's `radius`, a light's `lightIntensity`
// (its reach is √intensity × 10 px: lightRadius.js) or `sqrtLightIntensity`. A polygon's vertices are a points param's
// when one holds them, in the entity's frame: a param whose points are the live polygon's vertices is taken for it,
// and remembered per class. Any other points param is drawn in world coordinates: a route the entity walks, as the
// guide's Guard has.
//
// A drag draws a ghost, and nothing is spawned or written while it lasts; letting go writes the record once through
// EditMode.editSelected (one undo, one respawn). Sizes and points snap to the grid step (G). A box keeps its opposite
// edge where it was (its x and y follow), or its center with Alt held. Alt+click on a points param's line adds a point
// there, Del over a point removes it, and the param's + in the inspector adds one after the last. A handle whose param
// the class does not declare is drawn dimmed: pressing it says why in the status line, and a drag does nothing.
// Runtime entities have no handles.
//
// Cost: what the handles are (the plan) is worked out when the selection, the document or the collider's shape
// changes. A frame reads the live components into buffers made then, and draws with whole-pixel coordinates: nothing
// is allocated per frame.

import { Transform } from '../../../components/transform.js';
import { Collider } from '../../../components/collider.js';
import { LightEmitter } from '../../../components/lightEmitter.js';
import { ShapeType, MAX_POLYGON_VERTICES } from '../../../util/configDefaults.js';
import { LIGHT_INFLUENCE_RADIUS_SCALE } from '../../../util/lightRadius.js';
import { Camera } from '../../camera.js';
import { KIND_NUMBER, KIND_ENTITY, KIND_POINTS } from '../../spawnParams.js';
import { snapTo } from './moveTool.js';
import { recordOf, paramsOf, indexOfName, writeParam, writePosition } from './sceneDocument.js';

/** Handle kinds. */
export const H_BOX = 1;
export const H_CIRCLE = 2;
/** A polygon vertex that no points param holds: always dimmed. */
export const H_VERTEX = 3;
export const H_LIGHT = 4;
export const H_POINT = 5;

const SHAPE_NONE = 0;
const SHAPE_BOX = 1;
const SHAPE_CIRCLE = 2;
const SHAPE_POLYGON = 3;

/** A box handle's sides, by its `sub`: (dx + 1) · 3 + (dy + 1); 4, the center, is not a handle. */
const BOX_DX = Int8Array.of(-1, -1, -1, 0, 0, 0, 1, 1, 1);
const BOX_DY = Int8Array.of(-1, 0, 1, -1, 0, 1, -1, 0, 1);
/** A circle's handles: right, down, left, up. A light's sit on the diagonals, apart from a collider's. */
const RING_X = Float64Array.of(1, 0, -1, 0);
const RING_Y = Float64Array.of(0, 1, 0, -1);
const LIGHT_X = Float64Array.of(Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2);
const LIGHT_Y = Float64Array.of(Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2);

/** Screen pixels: a handle's half size (hovered: bigger), how near a press must be, a drag's start. */
const HANDLE_PX = 4;
const HOVER_PX = 6;
export const HIT_PX = 8;
const DRAG_THRESHOLD_PX = 3;
/**
 * Handles keep this far from the shape's center on screen: a ring's, and a box's from its middle lines. On a thin
 * platform zoomed out they sit outside it, so a press on its body is the move tool's; a drag goes from where it was
 * pressed, so the handle's own place does not jump the size.
 */
const MIN_RING_PX = 14;
const MIN_HALF_PX = HIT_PX + 4;
/** World pixels between the last point and one the + adds (when there is no segment to go on from). */
const NEW_POINT_GAP = 64;

const TWO_PI = Math.PI * 2;
const COLLIDER_COLOR = 'rgba(96, 165, 250, 1)';
const LIGHT_COLOR = 'rgba(250, 204, 21, 1)';
const POINTS_COLOR = 'rgba(244, 114, 182, 1)';
const LINK_COLOR = 'rgba(196, 181, 253, 0.85)';
const GHOST_COLOR = 'rgba(52, 211, 153, 0.95)';
const HANDLE_FILL = 'rgba(255, 255, 255, 0.95)';
const DIM_FILL = 'rgba(110, 110, 110, 0.6)';
const DIM_COLOR = 'rgba(170, 170, 170, 0.55)';
const LABEL_FONT = '11px monospace';
const LABEL_BACK = 'rgba(0, 0, 0, 0.7)';
const LABEL_TEXT = 'rgba(255, 255, 255, 0.95)';
const GHOST_DASH = Object.freeze([6, 4]);
const RING_DASH = Object.freeze([10, 6]);
const LINK_DASH = Object.freeze([3, 4]);
const NO_DASH = Object.freeze([]);
const NO_CONFIG = Object.freeze({});

// The live shape as a frame lays it out (G) and as a drag started and would end (D): indices into Float64Arrays.
const G_CX = 0; // the collider's center
const G_CY = 1;
const G_C = 2; // the entity's turn
const G_S = 3;
const G_W = 4; // a box's size, a circle's radius
const G_H = 5;
const G_R = 6;
const G_OX = 7; // the origin of the entity's frame: its position plus its turned collider offset
const G_OY = 8;
const G_LX = 9; // the light's center and reach
const G_LY = 10;
const G_LR = 11;
const G_SIZE = 12;
const D_FROM_W = 0;
const D_FROM_H = 1;
const D_FROM_R = 2;
const D_FROM_V = 3; // the light param's column value
const D_TO_W = 4;
const D_TO_H = 5;
const D_TO_R = 6;
const D_TO_V = 7;
const D_SHIFT_X = 8; // the box center's move, in the world
const D_SHIFT_Y = 9;
const D_TO_PX = 10; // the dragged point, in its param's frame
const D_TO_PY = 11;
const D_LABEL_X = 12; // where the pointer is (the value's label)
const D_LABEL_Y = 13;
const D_PRESS_X = 14; // where the drag was pressed, in the world
const D_PRESS_Y = 15;
const D_SIZE = 16;

/**
 * The view a frame draws with: the camera's x and y (the world at the screen's top-left) and the zoom. A frame works
 * its screen points out inline, in whole pixels, so no double crosses a call (a call TurboFan leaves out of line
 * boxes it: CLAUDE.md, E-85) and a canvas call takes small integers.
 */
const VIEW = new Float64Array(3);

/** A position written into a record: to the thousandth of a pixel. */
const tidy = (value) => Math.round(value * 1000) / 1000;

/**
 * The position of a declared number param named `key`, or -1.
 * @param {object|null} description - describeSpawnParams
 */
function numberParam(description, key) {
  if (description === null) return -1;
  const k = description.indexOf[key];
  return k !== undefined && description.kinds[k] === KIND_NUMBER ? k : -1;
}

/** What the collider and light are now, as a number: the plan is worked out again when it changes. */
function shapeSignature(i) {
  let signature = 0;
  if (Collider.active && Collider.active[i] === 1) {
    signature = 1 + Collider.shapeType[i] * 2 + (Collider.polyCount[i] | 0) * 16;
    if (Collider.fixtureCount && Collider.fixtureCount[i] > 0) signature += 256;
  }
  if (LightEmitter.active && LightEmitter.active[i] === 1) signature += 512;
  return signature;
}

/** Whether flat x, y pairs are the entity's polygon vertices (local, in any order). */
function holdsPolygon(i, pts) {
  const n = Collider.polyCount[i] | 0;
  if (n < 3 || pts.length !== n * 2) return false;
  const base = i * MAX_POLYGON_VERTICES;
  const vx = Collider.polyVertexX;
  const vy = Collider.polyVertexY;
  for (let j = 0; j < n; j++) {
    const x = pts[2 * j];
    const y = pts[2 * j + 1];
    let found = false;
    for (let v = 0; v < n && !found; v++) {
      found = Math.abs(vx[base + v] - x) <= 1e-3 * (1 + Math.abs(x)) && Math.abs(vy[base + v] - y) <= 1e-3 * (1 + Math.abs(y));
    }
    if (!found) return false;
  }
  return true;
}

/** Twice the signed area of flat x, y pairs (the shoelace): positive is makePolygon's winding. */
function twiceArea(pts) {
  const n = pts.length >> 1;
  let twice = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    twice += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return twice;
}

/**
 * Whether flat x, y pairs make a polygon a collider takes: 3 to 8 vertices, convex (collinear vertices pass), wound
 * the way `sign` says (the sign of twiceArea of the polygon it replaces).
 * @param {ArrayLike<number>} pts
 * @param {number} sign - 1 or -1
 */
export function convexPolygon(pts, sign) {
  const n = pts.length >> 1;
  if (n < 3 || n > MAX_POLYGON_VERTICES) return false;
  if (!(twiceArea(pts) * sign > 1e-8)) return false;
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? n - 1 : i - 1;
    const b = i + 1 < n ? i + 1 : 0;
    const cross =
      (pts[2 * i] - pts[2 * a]) * (pts[2 * b + 1] - pts[2 * i + 1]) - (pts[2 * i + 1] - pts[2 * a + 1]) * (pts[2 * b] - pts[2 * i]);
    if (cross * sign < -1e-6) return false;
  }
  return true;
}

/** One points param of the selected entity, as the plan holds it. */
function pointsSlot(key, pts, local) {
  return { key, pts, local, polygon: false };
}

/** A points param's value as x, y pairs: an array or a Float64Array of numbers, an odd last one left out. */
function pairsOf(value) {
  if (!(Array.isArray(value) || value instanceof Float64Array)) return new Float64Array(0);
  const out = new Float64Array(value.length & ~1);
  for (let j = 0; j < out.length; j++) out[j] = Number.isFinite(value[j]) ? value[j] : 0;
  return out;
}

export class HandlesTool {
  /** @param {object} editMode - the EditMode it edits through (editSelected, selection, move.snap, history) */
  constructor(editMode) {
    this.editMode = editMode;

    // ---- the plan: what the selected entity's handles are, worked out when it changes ----
    this._planIndex = -1;
    this._planPacked = NaN;
    this._planName = null;
    this._planPosition = -1;
    this._planShape = -1;
    /** Whether the selection has handles: a placed entity, live, whose record the file has. */
    this._planOk = false;
    this._className = '';
    this._description = null;
    this._shape = SHAPE_NONE;
    this._widthK = -1;
    this._heightK = -1;
    this._radiusK = -1;
    this._light = false;
    this._lightK = -1;
    /** The light's param is sqrtLightIntensity (reach / 10), not lightIntensity ((reach / 10)²). */
    this._lightIsSqrt = false;
    /** Its points params: { key, pts, local, polygon } each. */
    this._slots = [];
    /** The slot that holds the polygon collider's vertices, or -1. */
    this._polygonSlot = -1;
    /** The entities its entity params name (their indices), and how many. */
    this._links = new Int32Array(0);
    this._linkCount = 0;
    /** Points params found holding their entity's polygon, in its frame (`Class.key`): kept across selections. */
    this._localKeys = new Set();

    // ---- the handles now: world positions (and on screen, a frame's), what each is; buffers grown with the plan ----
    this._count = 0;
    this._hx = new Float64Array(0);
    this._hy = new Float64Array(0);
    this._sx = new Int32Array(0);
    this._sy = new Int32Array(0);
    this._kind = new Uint8Array(0);
    this._slot = new Int32Array(0);
    this._sub = new Int32Array(0);
    this._on = new Uint8Array(0);
    this._geo = new Float64Array(G_SIZE);

    // ---- a drag ----
    /** The dragged handle's kind; 0 when there is no drag. */
    this._drag = 0;
    this._dragSlot = -1;
    this._dragSub = -1;
    /** The dragged entity (index · 65536 + spawn generation): a respawn under the drag (an undo) ends it. */
    this._dragPacked = NaN;
    /** Past the drag threshold: a drag, not a click. */
    this._moved = false;
    this._pressX = NaN;
    this._pressY = NaN;
    /** The shape as the drag started (a copy of _geo) and the values it would write (D_*). */
    this._from = new Float64Array(G_SIZE);
    this._values = new Float64Array(D_SIZE);
    /** What the drag would set, beside the pointer; its width on screen once measured. */
    this._label = '';
    this._labelWidth = NaN;
    this._corners = new Float64Array(8);

    // ---- the handle under the pointer, with no button down ----
    this._hoverKind = 0;
    this._hoverSlot = -1;
    this._hoverSub = -1;
  }

  /** Whether a handle is being dragged. */
  get dragging() {
    return this._drag !== 0 && this._moved;
  }

  // ---- the plan ----

  /** Work the plan out again when the selection, the document or the shape changed; false when there are no handles. */
  _ensurePlan() {
    const editMode = this.editMode;
    const selection = editMode.selection;
    const index = selection.index;
    if (index < 0 || selection.name === null || !Transform.active || Transform.active[index] !== 1) return false;
    if (editMode.layers?.locked(index) === true) return false; // a locked layer's entity (ED-24): no handles
    const signature = shapeSignature(index);
    if (
      index !== this._planIndex ||
      selection.packed !== this._planPacked ||
      selection.name !== this._planName ||
      editMode.history.position !== this._planPosition ||
      signature !== this._planShape
    ) {
      this._buildPlan(index, signature);
    }
    return this._planOk;
  }

  _buildPlan(index, signature) {
    const editMode = this.editMode;
    const selection = editMode.selection;
    const scene = editMode.debugUI.scene;
    this._planIndex = index;
    this._planPacked = selection.packed;
    this._planName = selection.name;
    this._planPosition = editMode.history.position;
    this._planShape = signature;
    this._planOk = false;
    this._shape = SHAPE_NONE;
    this._widthK = -1;
    this._heightK = -1;
    this._radiusK = -1;
    this._light = false;
    this._lightK = -1;
    this._lightIsSqrt = false;
    this._slots = [];
    this._polygonSlot = -1;
    this._linkCount = 0;
    this._clearHover();
    const found = recordOf(scene, selection.name);
    if (found === null) return;
    const record = found.record;
    const description = paramsOf(scene, record);
    const config = record.config || NO_CONFIG;
    this._description = description;
    this._className = record.class;

    if (Collider.active && Collider.active[index] === 1) {
      const type = Collider.shapeType[index];
      if (type === ShapeType.Box) {
        this._shape = SHAPE_BOX;
        this._widthK = numberParam(description, 'width');
        this._heightK = numberParam(description, 'height');
      } else if (type === ShapeType.Circle) {
        this._shape = SHAPE_CIRCLE;
        this._radiusK = numberParam(description, 'radius');
      } else if (type === ShapeType.Polygon && (Collider.polyCount[index] | 0) >= 3 && !(Collider.fixtureCount?.[index] > 0)) {
        this._shape = SHAPE_POLYGON;
      }
    }
    if (LightEmitter.active && LightEmitter.active[index] === 1) {
      this._light = true;
      this._lightK = numberParam(description, 'lightIntensity');
      if (this._lightK < 0) {
        this._lightK = numberParam(description, 'sqrtLightIntensity');
        this._lightIsSqrt = this._lightK >= 0;
      }
    }

    let points = 0;
    let links = 0;
    if (description !== null) {
      for (let k = 0; k < description.keys.length; k++) {
        const key = description.keys[k];
        if (description.kinds[k] === KIND_POINTS) {
          const pts = pairsOf(Object.hasOwn(config, key) ? config[key] : description.defaults[k]);
          this._slots.push(pointsSlot(key, pts, this._localKeys.has(`${record.class}.${key}`)));
          points += pts.length >> 1;
        } else if (description.kinds[k] === KIND_ENTITY && typeof config[key] === 'string') {
          links++;
        }
      }
    }
    if (this._shape === SHAPE_POLYGON) {
      for (let s = 0; s < this._slots.length; s++) {
        const slot = this._slots[s];
        if (!slot.local && holdsPolygon(index, slot.pts)) {
          slot.local = true;
          this._localKeys.add(`${record.class}.${slot.key}`);
        }
        if (slot.local) {
          slot.polygon = true;
          this._polygonSlot = s;
          break;
        }
      }
    }
    if (links > 0) {
      if (this._links.length < links) this._links = new Int32Array(links);
      for (let k = 0; k < description.keys.length; k++) {
        const name = config[description.keys[k]];
        if (description.kinds[k] !== KIND_ENTITY || typeof name !== 'string') continue;
        const target = indexOfName(scene, name);
        if (target >= 0) this._links[this._linkCount++] = target;
      }
    }
    // Room for every handle: a box's 8 (or a circle's 4, or a polygon's vertices), a light's 4, and the points.
    const need = 8 + MAX_POLYGON_VERTICES + 4 + points;
    if (this._hx.length < need) {
      const size = (need + 31) & ~31;
      this._hx = new Float64Array(size);
      this._hy = new Float64Array(size);
      this._sx = new Int32Array(size);
      this._sy = new Int32Array(size);
      this._kind = new Uint8Array(size);
      this._slot = new Int32Array(size);
      this._sub = new Int32Array(size);
      this._on = new Uint8Array(size);
    }
    this._planOk = true;
  }

  // ---- the handles, where they are now ----

  /**
   * Lay the handles out from the live components, in world coordinates. The positions are stored here, inline, and
   * only integers go to _tag: a double passed to a call TurboFan leaves out of line is boxed, and this runs each frame.
   */
  _layout(zoom) {
    const i = this._planIndex;
    const G = this._geo;
    const hx = this._hx;
    const hy = this._hy;
    const tx = Transform.x[i];
    const ty = Transform.y[i];
    const c = Transform.rotC ? Transform.rotC[i] : 1;
    const s = Transform.rotS ? Transform.rotS[i] : 0;
    const hasCollider = Collider.active !== undefined && Collider.active !== null && Collider.active[i] === 1;
    const ox = hasCollider ? Collider.offsetX[i] : 0;
    const oy = hasCollider ? Collider.offsetY[i] : 0;
    const minRing = MIN_RING_PX / zoom;
    G[G_C] = c;
    G[G_S] = s;
    G[G_OX] = tx + c * ox - s * oy;
    G[G_OY] = ty + s * ox + c * oy;
    let n = 0;

    // The points first: where they sit on a collider's handle, they are the ones meant.
    const slots = this._slots;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      const pts = slot.pts;
      const local = slot.local;
      for (let j = 0; j + 1 < pts.length; j += 2) {
        const px = pts[j];
        const py = pts[j + 1];
        hx[n] = local ? G[G_OX] + c * px - s * py : px;
        hy[n] = local ? G[G_OY] + s * px + c * py : py;
        n = this._tag(n, H_POINT, k, j >> 1, 1);
      }
    }

    switch (this._shape) {
      case SHAPE_BOX: {
        const minHalf = MIN_HALF_PX / zoom;
        G[G_CX] = G[G_OX];
        G[G_CY] = G[G_OY];
        G[G_W] = Collider.width[i];
        G[G_H] = Collider.height[i];
        const hw = G[G_W] * 0.5 > minHalf ? G[G_W] * 0.5 : minHalf;
        const hh = G[G_H] * 0.5 > minHalf ? G[G_H] * 0.5 : minHalf;
        for (let d = 0; d < 9; d++) {
          if (d === 4) continue;
          const lx = BOX_DX[d] * hw;
          const ly = BOX_DY[d] * hh;
          hx[n] = G[G_CX] + c * lx - s * ly;
          hy[n] = G[G_CY] + s * lx + c * ly;
          n = this._tag(n, H_BOX, -1, d, (BOX_DX[d] === 0 || this._widthK >= 0) && (BOX_DY[d] === 0 || this._heightK >= 0) ? 1 : 0);
        }
        break;
      }
      case SHAPE_CIRCLE: {
        // A circle's offset does not turn with the entity (pointInCollider, the collider overlay).
        G[G_CX] = tx + ox;
        G[G_CY] = ty + oy;
        G[G_R] = Collider.radius[i];
        const r = G[G_R] > minRing ? G[G_R] : minRing;
        for (let k = 0; k < 4; k++) {
          hx[n] = G[G_CX] + RING_X[k] * r;
          hy[n] = G[G_CY] + RING_Y[k] * r;
          n = this._tag(n, H_CIRCLE, -1, k, this._radiusK >= 0 ? 1 : 0);
        }
        break;
      }
      case SHAPE_POLYGON:
        if (this._polygonSlot < 0) {
          const count = Collider.polyCount[i] | 0;
          const base = i * MAX_POLYGON_VERTICES;
          for (let v = 0; v < count; v++) {
            const vx = Collider.polyVertexX[base + v];
            const vy = Collider.polyVertexY[base + v];
            hx[n] = G[G_OX] + c * vx - s * vy;
            hy[n] = G[G_OY] + s * vx + c * vy;
            n = this._tag(n, H_VERTEX, -1, v, 0);
          }
        }
        break;
      default:
        break;
    }

    if (this._light) {
      G[G_LX] = tx;
      G[G_LY] = ty;
      G[G_LR] = LightEmitter.sqrtLightIntensity[i] * LIGHT_INFLUENCE_RADIUS_SCALE;
      const r = G[G_LR] > minRing ? G[G_LR] : minRing;
      for (let k = 0; k < 4; k++) {
        hx[n] = tx + LIGHT_X[k] * r;
        hy[n] = ty + LIGHT_Y[k] * r;
        n = this._tag(n, H_LIGHT, -1, k, this._lightK >= 0 ? 1 : 0);
      }
    }
    this._count = n;
  }

  /** What handle `n` is (its position is already stored); the next handle's index. */
  _tag(n, kind, slot, sub, on) {
    this._kind[n] = kind;
    this._slot[n] = slot;
    this._sub[n] = sub;
    this._on[n] = on;
    return n + 1;
  }

  /** The handles on screen, in whole pixels, for a frame's drawing (VIEW holds its camera). */
  _project() {
    const vx = VIEW[0];
    const vy = VIEW[1];
    const zoom = VIEW[2];
    for (let h = 0; h < this._count; h++) {
      this._sx[h] = Math.round((this._hx[h] - vx) * zoom) | 0;
      this._sy[h] = Math.round((this._hy[h] - vy) * zoom) | 0;
    }
  }

  /** The handle nearest a world point within HIT_PX on screen, or -1. */
  _handleAt(x, y, zoom) {
    const reach = HIT_PX / zoom;
    let best = -1;
    let bestDistance = reach * reach;
    for (let h = 0; h < this._count; h++) {
      const dx = this._hx[h] - x;
      const dy = this._hy[h] - y;
      const d = dx * dx + dy * dy;
      if (d < bestDistance || (best < 0 && d === bestDistance)) {
        best = h;
        bestDistance = d;
      }
    }
    return best;
  }

  /** The handles of the selection now, for tests and the smoke: [{ kind, slot, sub, x, y, on }]. */
  handles() {
    const out = [];
    if (!this._ensurePlan()) return out;
    this._layout(Camera.zoom || 1);
    for (let h = 0; h < this._count; h++) {
      out.push({ kind: this._kind[h], slot: this._slot[h], sub: this._sub[h], x: this._hx[h], y: this._hy[h], on: this._on[h] === 1 });
    }
    return out;
  }

  // ---- the pointer ----

  /** A primary press on the view: a handle takes it (a dimmed one says why); Alt on a points line adds a point. */
  press(x, y, e) {
    if (!this._ensurePlan()) return false;
    const zoom = Camera.zoom || 1;
    this._layout(zoom);
    const h = this._handleAt(x, y, zoom);
    if (h < 0) return e?.altKey === true && this._insertAt(x, y, zoom);
    if (this._on[h] === 0) {
      this._explain(h);
      return true;
    }
    const kind = this._kind[h];
    const slot = this._slot[h];
    const sub = this._sub[h];
    const i = this._planIndex;
    this._drag = kind;
    this._dragSlot = slot;
    this._dragSub = sub;
    this._dragPacked = this.editMode.selection.packed;
    this._moved = false;
    this._pressX = e ? e.clientX : NaN;
    this._pressY = e ? e.clientY : NaN;
    this._from.set(this._geo);
    const V = this._values;
    V[D_FROM_W] = this._geo[G_W];
    V[D_FROM_H] = this._geo[G_H];
    V[D_FROM_R] = kind === H_LIGHT ? this._geo[G_LR] : this._geo[G_R];
    V[D_FROM_V] = this._lightIsSqrt ? LightEmitter.sqrtLightIntensity[i] : this._light ? LightEmitter.lightIntensity[i] : NaN;
    V[D_TO_W] = V[D_FROM_W];
    V[D_TO_H] = V[D_FROM_H];
    V[D_TO_R] = V[D_FROM_R];
    V[D_TO_V] = V[D_FROM_V];
    V[D_SHIFT_X] = 0;
    V[D_SHIFT_Y] = 0;
    V[D_PRESS_X] = x;
    V[D_PRESS_Y] = y;
    if (kind === H_POINT) {
      V[D_TO_PX] = this._slots[slot].pts[2 * sub];
      V[D_TO_PY] = this._slots[slot].pts[2 * sub + 1];
    }
    this._label = '';
    return true;
  }

  move(x, y, e) {
    if (this._drag === 0) return;
    if (!this._moved) {
      const dx = (e ? e.clientX : this._pressX) - this._pressX;
      const dy = (e ? e.clientY : this._pressY) - this._pressY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      this._moved = true;
    }
    if (this.editMode.selection.packed !== this._dragPacked) {
      this._endDrag(); // the entity went, or was respawned under the drag
      return;
    }
    const V = this._values;
    const F = this._from;
    const step = this.editMode.move.snap;
    V[D_LABEL_X] = x;
    V[D_LABEL_Y] = y;
    let label = '';
    switch (this._drag) {
      case H_BOX:
        this._dragBox(x, y, e?.altKey === true, step);
        label = `${V[D_TO_W]} × ${V[D_TO_H]}`;
        break;
      case H_CIRCLE: {
        const grown = this._outward(x, y, F[G_CX], F[G_CY]);
        V[D_TO_R] = this._clamp(this._radiusK, snapTo(V[D_FROM_R] + grown, step), 1);
        label = `radius ${V[D_TO_R]}`;
        break;
      }
      case H_LIGHT: {
        const grown = this._outward(x, y, F[G_LX], F[G_LY]);
        let reach = snapTo(V[D_FROM_R] + grown, step);
        if (reach < 0) reach = 0;
        const scale = LIGHT_INFLUENCE_RADIUS_SCALE;
        const value = this._clamp(this._lightK, this._lightIsSqrt ? reach / scale : (reach * reach) / (scale * scale), 0);
        V[D_TO_V] = value;
        V[D_TO_R] = (this._lightIsSqrt ? value : Math.sqrt(value)) * scale;
        label = `${this._description.keys[this._lightK]} ${value} (reach ${Math.round(V[D_TO_R])} px)`;
        break;
      }
      case H_POINT: {
        const slot = this._slots[this._dragSlot];
        const pts = slot.pts;
        // The point moves as far as the pointer has, in its param's frame.
        let dx = x - V[D_PRESS_X];
        let dy = y - V[D_PRESS_Y];
        if (slot.local) {
          const rx = dx;
          dx = F[G_C] * rx + F[G_S] * dy;
          dy = -F[G_S] * rx + F[G_C] * dy;
        }
        V[D_TO_PX] = snapTo(pts[2 * this._dragSub] + dx, step);
        V[D_TO_PY] = snapTo(pts[2 * this._dragSub + 1] + dy, step);
        label = `${slot.key}[${this._dragSub}] ${V[D_TO_PX]}, ${V[D_TO_PY]}`;
        break;
      }
      default:
        break;
    }
    if (label !== this._label) {
      this._label = label;
      this._labelWidth = NaN;
    }
  }

  /** How much farther from a center the pointer is than the press was: what a ring grows by. */
  _outward(x, y, cx, cy) {
    const V = this._values;
    const ax = x - cx;
    const ay = y - cy;
    const bx = V[D_PRESS_X] - cx;
    const by = V[D_PRESS_Y] - cy;
    return Math.sqrt(ax * ax + ay * ay) - Math.sqrt(bx * bx + by * by);
  }

  /**
   * A box handle dragged to a world point: the moving edge (or corner) goes as far as the pointer has since the press,
   * the size snapped, and the opposite one stays (the center moves by half the change); with Alt the center stays and
   * both sides move.
   */
  _dragBox(x, y, aboutCenter, step) {
    const F = this._from;
    const V = this._values;
    const c = F[G_C];
    const s = F[G_S];
    // How far the pointer went since the press, along the box's own axes.
    const rx = x - V[D_PRESS_X];
    const ry = y - V[D_PRESS_Y];
    const lx = c * rx + s * ry;
    const ly = -s * rx + c * ry;
    const dx = BOX_DX[this._dragSub];
    const dy = BOX_DY[this._dragSub];
    const sides = aboutCenter ? 2 : 1;
    let w = F[G_W];
    let h = F[G_H];
    let shiftX = 0;
    let shiftY = 0;
    if (dx !== 0) {
      w = this._clamp(this._widthK, snapTo(F[G_W] + sides * dx * lx, step), 1);
      if (!aboutCenter) shiftX = (dx * (w - F[G_W])) * 0.5;
    }
    if (dy !== 0) {
      h = this._clamp(this._heightK, snapTo(F[G_H] + sides * dy * ly, step), 1);
      if (!aboutCenter) shiftY = (dy * (h - F[G_H])) * 0.5;
    }
    V[D_TO_W] = w;
    V[D_TO_H] = h;
    V[D_SHIFT_X] = c * shiftX - s * shiftY;
    V[D_SHIFT_Y] = s * shiftX + c * shiftY;
  }

  /** A value within a number param's min and max, and at least `floor`. */
  _clamp(k, value, floor) {
    const entry = this._description.entries[k];
    let v = value;
    if (entry.max !== undefined && v > entry.max) v = entry.max;
    if (entry.min !== undefined && v < entry.min) v = entry.min;
    return v < floor ? floor : v;
  }

  /** Letting go of a drag: its change, written once (one undo, one respawn). */
  release() {
    const drag = this._drag;
    const moved = this._moved;
    const slot = this._dragSlot;
    const sub = this._dragSub;
    const packed = this._dragPacked;
    this._endDrag();
    if (drag === 0 || !moved || this.editMode.selection.packed !== packed || !this._ensurePlan()) return;
    const V = this._values;
    const editMode = this.editMode;
    const name = editMode.selection.name;
    const keys = this._description.keys;
    switch (drag) {
      case H_BOX: {
        const toW = V[D_TO_W];
        const toH = V[D_TO_H];
        const shiftX = V[D_SHIFT_X];
        const shiftY = V[D_SHIFT_Y];
        const widthKey = toW !== V[D_FROM_W] ? keys[this._widthK] : null;
        const heightKey = toH !== V[D_FROM_H] ? keys[this._heightK] : null;
        if (widthKey === null && heightKey === null) return;
        editMode.editSelected(`resize ${name}`, (record, description) => {
          if (widthKey !== null) writeParam(record, description, widthKey, toW);
          if (heightKey !== null) writeParam(record, description, heightKey, toH);
          if (shiftX !== 0 || shiftY !== 0) writePosition(record, tidy(record.x + shiftX), tidy(record.y + shiftY));
        });
        break;
      }
      case H_CIRCLE: {
        const toR = V[D_TO_R];
        const key = keys[this._radiusK];
        if (toR !== V[D_FROM_R]) editMode.editSelected(`${name}.${key}`, (record, description) => writeParam(record, description, key, toR));
        break;
      }
      case H_LIGHT: {
        const value = V[D_TO_V];
        const key = keys[this._lightK];
        if (value !== V[D_FROM_V]) editMode.editSelected(`${name}.${key}`, (record, description) => writeParam(record, description, key, value));
        break;
      }
      case H_POINT: {
        const pts = this._slots[slot].pts;
        if (V[D_TO_PX] === pts[2 * sub] && V[D_TO_PY] === pts[2 * sub + 1]) return;
        const next = Array.from(pts);
        next[2 * sub] = V[D_TO_PX];
        next[2 * sub + 1] = V[D_TO_PY];
        this._writePoints(slot, next, `move ${name}.${this._slots[slot].key}[${sub}]`);
        break;
      }
      default:
        break;
    }
  }

  _endDrag() {
    this._drag = 0;
    this._moved = false;
    this._dragSlot = -1;
    this._dragSub = -1;
    this._dragPacked = NaN;
    this._label = '';
  }

  /** The pointer with no button down: the handle under it shows, and Del removes a point under it. */
  hover(x, y, e) {
    const canvas = this.editMode.debugUI.gameEngine?.canvas;
    if ((e && e.target !== canvas) || !this._ensurePlan()) {
      this._clearHover();
      return;
    }
    const zoom = Camera.zoom || 1;
    this._layout(zoom);
    const h = this._handleAt(x, y, zoom);
    if (h < 0) {
      this._clearHover();
      return;
    }
    this._hoverKind = this._kind[h];
    this._hoverSlot = this._slot[h];
    this._hoverSub = this._sub[h];
  }

  _clearHover() {
    this._hoverKind = 0;
    this._hoverSlot = -1;
    this._hoverSub = -1;
  }

  /** Esc drops a drag; Del (or Backspace) over a point removes it. */
  onKey(e) {
    if (e.key === 'Escape' && this._drag !== 0) {
      this._endDrag();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && this._drag === 0 && this._hoverKind === H_POINT) {
      return this._removePoint(this._hoverSlot, this._hoverSub);
    }
    return false;
  }

  /** Edit mode left, a swap: no drag, no hover. */
  cancel() {
    this._endDrag();
    this._clearHover();
  }

  // ---- points: add, insert, remove ----

  /**
   * The inspector's + of a points param: a point after the last, a segment's length on from it (64 px from a lone
   * one; 64 px right of the entity for the first). A polygon's goes in the middle of its closing edge.
   * @returns {number} the respawned entity's index, or -1
   */
  addPoint(key) {
    if (!this._ensurePlan()) return -1;
    let s = -1;
    for (let k = 0; k < this._slots.length; k++) if (this._slots[k].key === key) s = k;
    if (s < 0) return -1;
    const slot = this._slots[s];
    const pts = slot.pts;
    const n = pts.length >> 1;
    const step = this.editMode.move.snap;
    let px;
    let py;
    if (slot.polygon) {
      if (n >= MAX_POLYGON_VERTICES) {
        this.editMode._setStatus(`A polygon collider takes at most ${MAX_POLYGON_VERTICES} points`, true);
        return -1;
      }
      px = (pts[2 * n - 2] + pts[0]) * 0.5;
      py = (pts[2 * n - 1] + pts[1]) * 0.5;
    } else {
      if (n >= 2) {
        px = 2 * pts[2 * n - 2] - pts[2 * n - 4];
        py = 2 * pts[2 * n - 1] - pts[2 * n - 3];
      } else if (n === 1) {
        px = pts[0] + NEW_POINT_GAP;
        py = pts[1];
      } else if (slot.local) {
        px = NEW_POINT_GAP;
        py = 0;
      } else {
        const found = recordOf(this.editMode.debugUI.scene, this.editMode.selection.name);
        px = found.record.x + NEW_POINT_GAP;
        py = found.record.y;
      }
      px = snapTo(px, step);
      py = snapTo(py, step);
    }
    const next = Array.from(pts);
    next.push(px, py);
    return this._writePoints(s, next, `${this.editMode.selection.name}.${key}: add a point`);
  }

  /** Alt+click near a points param's line: a point there, between the two it lies between. */
  _insertAt(x, y, zoom) {
    const reach = HIT_PX / zoom;
    let bestSlot = -1;
    let bestAfter = -1;
    let bestDistance = reach * reach;
    let at = 0; // the handle of each slot's first point: the points lead the handle list, slot by slot
    for (let s = 0; s < this._slots.length; s++) {
      const slot = this._slots[s];
      const n = slot.pts.length >> 1;
      const segments = slot.polygon && n >= 3 ? n : n - 1;
      for (let j = 0; j < segments; j++) {
        const a = at + j;
        const b = at + (j + 1 < n ? j + 1 : 0);
        const d = distanceToSegmentSq(x, y, this._hx[a], this._hy[a], this._hx[b], this._hy[b]);
        if (d < bestDistance) {
          bestDistance = d;
          bestSlot = s;
          bestAfter = j;
        }
      }
      at += n;
    }
    if (bestSlot < 0) return false;
    const slot = this._slots[bestSlot];
    if (slot.polygon && slot.pts.length >> 1 >= MAX_POLYGON_VERTICES) {
      this.editMode._setStatus(`A polygon collider takes at most ${MAX_POLYGON_VERTICES} points`, true);
      return true;
    }
    const F = this._geo;
    let px = x;
    let py = y;
    if (slot.local) {
      const rx = x - F[G_OX];
      const ry = y - F[G_OY];
      px = F[G_C] * rx + F[G_S] * ry;
      py = -F[G_S] * rx + F[G_C] * ry;
    }
    const step = this.editMode.move.snap;
    const next = Array.from(slot.pts);
    next.splice(2 * (bestAfter + 1), 0, snapTo(px, step), snapTo(py, step));
    this._writePoints(bestSlot, next, `${this.editMode.selection.name}.${slot.key}: add a point`);
    return true;
  }

  /** Del over a point: it goes (a polygon keeps at least 3). */
  _removePoint(s, j) {
    const slot = this._slots[s];
    if (slot === undefined) return false;
    if (slot.polygon && slot.pts.length >> 1 <= 3) {
      this.editMode._setStatus('A polygon collider needs at least 3 points', true);
      return true;
    }
    const next = Array.from(slot.pts);
    next.splice(2 * j, 2);
    this._clearHover();
    this._writePoints(s, next, `${this.editMode.selection.name}.${slot.key}: remove point ${j}`);
    return true;
  }

  /** Write a points param's new x, y pairs, once; a polygon's must stay one a collider takes. */
  _writePoints(s, next, label) {
    const slot = this._slots[s];
    if (slot.polygon && !convexPolygon(next, twiceArea(slot.pts) < 0 ? -1 : 1)) {
      this.editMode._setStatus(`${this._className}.${slot.key}: that is not a convex polygon, and a collider takes only those`, true);
      return -1;
    }
    const key = slot.key;
    return this.editMode.editSelected(label, (record, description) => writeParam(record, description, key, next));
  }

  /** A dimmed handle was pressed: why it does nothing. */
  _explain(h) {
    const name = this._className;
    let text;
    switch (this._kind[h]) {
      case H_BOX: {
        const d = this._sub[h];
        const missing = [];
        if (BOX_DX[d] !== 0 && this._widthK < 0) missing.push('width');
        if (BOX_DY[d] !== 0 && this._heightK < 0) missing.push('height');
        text = `${name} has no ${missing.join(' or ')} param: its collider is set in code`;
        break;
      }
      case H_CIRCLE:
        text = `${name} has no radius param: its collider is set in code`;
        break;
      case H_VERTEX:
        text =
          this._slots.length === 0
            ? `${name} has no points param: its polygon is set in code`
            : `None of ${name}'s points params holds its polygon: it is set in code`;
        break;
      case H_LIGHT:
        text = `${name} has no lightIntensity param: its light is set in code`;
        break;
      default:
        return;
    }
    this.editMode._setStatus(text, true);
  }

  // ---- drawing ----

  /** The overlay's frame while editing: what the handles hold on to, a drag's ghost, the handles, the value. */
  drawOverlay(ctx, camera, zoom) {
    if (!this._ensurePlan()) return;
    this._layout(zoom);
    VIEW[0] = camera.x;
    VIEW[1] = camera.y;
    VIEW[2] = zoom;
    this._project();
    ctx.save();
    ctx.lineWidth = 1.5;
    this._drawOutlines(ctx);
    const dragging = this._drag !== 0 && this._moved;
    if (dragging) this._drawGhost(ctx);
    this._drawHandles(ctx);
    if (dragging && this._label !== '') this._drawLabel(ctx);
    ctx.restore();
  }

  _drawOutlines(ctx) {
    const G = this._geo;
    const vx = VIEW[0];
    const vy = VIEW[1];
    const zoom = VIEW[2];
    if (this._shape === SHAPE_CIRCLE) {
      ctx.strokeStyle = this._radiusK >= 0 ? COLLIDER_COLOR : DIM_COLOR;
      ctx.beginPath();
      ctx.arc(
        Math.round((G[G_CX] - vx) * zoom) | 0,
        Math.round((G[G_CY] - vy) * zoom) | 0,
        G[G_R] > 0 ? Math.round(G[G_R] * zoom) | 0 : 0, // arc throws on a negative radius
        0,
        TWO_PI,
      );
      ctx.stroke();
    }
    if (this._light) {
      ctx.strokeStyle = this._lightK >= 0 ? LIGHT_COLOR : DIM_COLOR;
      ctx.setLineDash(RING_DASH);
      ctx.beginPath();
      ctx.arc(
        Math.round((G[G_LX] - vx) * zoom) | 0,
        Math.round((G[G_LY] - vy) * zoom) | 0,
        G[G_LR] > 0 ? Math.round(G[G_LR] * zoom) | 0 : 0,
        0,
        TWO_PI,
      );
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    // Each points param's line (a polygon's closed), and a polygon no param holds, from the handles laid out: the
    // handles of one param (or the vertices) are next to each other.
    const sx = this._sx;
    const sy = this._sy;
    let h = 0;
    while (h < this._count) {
      const kind = this._kind[h];
      if (kind !== H_POINT && kind !== H_VERTEX) {
        h++;
        continue;
      }
      const slot = this._slot[h];
      let end = h + 1;
      while (end < this._count && this._kind[end] === kind && this._slot[end] === slot) end++;
      ctx.strokeStyle = kind === H_VERTEX ? DIM_COLOR : POINTS_COLOR;
      ctx.beginPath();
      ctx.moveTo(sx[h], sy[h]);
      for (let k = h + 1; k < end; k++) ctx.lineTo(sx[k], sy[k]);
      if (kind === H_VERTEX || this._slots[slot].polygon) ctx.closePath();
      ctx.stroke();
      h = end;
    }
    // A line to each entity the entity params name.
    if (this._linkCount > 0) {
      const i = this._planIndex;
      const fromX = Math.round((Transform.x[i] - vx) * zoom) | 0;
      const fromY = Math.round((Transform.y[i] - vy) * zoom) | 0;
      ctx.strokeStyle = LINK_COLOR;
      ctx.setLineDash(LINK_DASH);
      ctx.beginPath();
      for (let k = 0; k < this._linkCount; k++) {
        const t = this._links[k];
        if (Transform.active[t] !== 1) continue;
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(Math.round((Transform.x[t] - vx) * zoom) | 0, Math.round((Transform.y[t] - vy) * zoom) | 0);
      }
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
  }

  /** Where the drag would put things: dashed, in the move ghost's green. */
  _drawGhost(ctx) {
    const F = this._from;
    const V = this._values;
    const vx = VIEW[0];
    const vy = VIEW[1];
    const zoom = VIEW[2];
    ctx.strokeStyle = GHOST_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash(GHOST_DASH);
    ctx.beginPath();
    switch (this._drag) {
      case H_BOX: {
        const cx = F[G_CX] + V[D_SHIFT_X];
        const cy = F[G_CY] + V[D_SHIFT_Y];
        const hw = V[D_TO_W] * 0.5;
        const hh = V[D_TO_H] * 0.5;
        const c = F[G_C];
        const s = F[G_S];
        const p = this._corners;
        p[0] = cx - c * hw + s * hh;
        p[1] = cy - s * hw - c * hh;
        p[2] = cx + c * hw + s * hh;
        p[3] = cy + s * hw - c * hh;
        p[4] = cx + c * hw - s * hh;
        p[5] = cy + s * hw + c * hh;
        p[6] = cx - c * hw - s * hh;
        p[7] = cy - s * hw + c * hh;
        for (let k = 0; k < 8; k += 2) {
          const x = Math.round((p[k] - vx) * zoom) | 0;
          const y = Math.round((p[k + 1] - vy) * zoom) | 0;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        break;
      }
      case H_CIRCLE:
      case H_LIGHT: {
        const ring = this._drag === H_LIGHT;
        ctx.arc(
          Math.round(((ring ? F[G_LX] : F[G_CX]) - vx) * zoom) | 0,
          Math.round(((ring ? F[G_LY] : F[G_CY]) - vy) * zoom) | 0,
          V[D_TO_R] > 0 ? Math.round(V[D_TO_R] * zoom) | 0 : 0,
          0,
          TWO_PI,
        );
        break;
      }
      case H_POINT: {
        const slot = this._slots[this._dragSlot];
        const pts = slot.pts;
        const n = pts.length >> 1;
        for (let j = 0; j < n; j++) {
          const moved = j === this._dragSub;
          const px = moved ? V[D_TO_PX] : pts[2 * j];
          const py = moved ? V[D_TO_PY] : pts[2 * j + 1];
          const wx = slot.local ? F[G_OX] + F[G_C] * px - F[G_S] * py : px;
          const wy = slot.local ? F[G_OY] + F[G_S] * px + F[G_C] * py : py;
          const x = Math.round((wx - vx) * zoom) | 0;
          const y = Math.round((wy - vy) * zoom) | 0;
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (slot.polygon) ctx.closePath();
        break;
      }
      default:
        break;
    }
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineWidth = 1.5;
  }

  _drawHandles(ctx) {
    const sx = this._sx;
    const sy = this._sy;
    for (let h = 0; h < this._count; h++) {
      const kind = this._kind[h];
      const on = this._on[h] === 1;
      const hovered = on && kind === this._hoverKind && this._slot[h] === this._hoverSlot && this._sub[h] === this._hoverSub;
      const color = !on ? DIM_COLOR : kind === H_LIGHT ? LIGHT_COLOR : kind === H_POINT ? POINTS_COLOR : COLLIDER_COLOR;
      const size = hovered ? HOVER_PX : HANDLE_PX;
      const x = sx[h];
      const y = sy[h];
      ctx.fillStyle = !on ? DIM_FILL : hovered ? color : HANDLE_FILL;
      ctx.strokeStyle = color;
      if (kind === H_BOX) {
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
        ctx.strokeRect(x - size, y - size, size * 2, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size, 0, TWO_PI);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** The value the drag would write, beside the pointer (its width measured once per value). */
  _drawLabel(ctx) {
    ctx.font = LABEL_FONT;
    if (this._labelWidth !== this._labelWidth) this._labelWidth = Math.ceil(ctx.measureText(this._label).width) | 0;
    const V = this._values;
    const x = (Math.round((V[D_LABEL_X] - VIEW[0]) * VIEW[2]) | 0) + 14;
    const y = (Math.round((V[D_LABEL_Y] - VIEW[1]) * VIEW[2]) | 0) - 14;
    ctx.fillStyle = LABEL_BACK;
    ctx.fillRect(x - 4, y - 9, this._labelWidth + 8, 18);
    ctx.fillStyle = LABEL_TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._label, x, y);
  }
}

/** The squared distance from a point to a segment. */
function distanceToSegmentSq(x, y, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const length = ex * ex + ey * ey;
  let t = length > 0 ? ((x - ax) * ex + (y - ay) * ey) / length : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = ax + t * ex - x;
  const dy = ay + t * ey - y;
  return dx * dx + dy * dy;
}
