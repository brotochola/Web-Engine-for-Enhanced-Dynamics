// entityPicker.js — an entity param filled by clicking the entity in the view (VISUAL_EDITOR_PLAN.md D4, ED-27,
// ED-45). The param's row in the inspector has a pick button (paramWidgets.js); after it, the next primary click on
// the view picks the placed entity there and sets the param to its name, as one change (EditMode.editSelected: one
// undo, one respawn). The entity must be another one the scene file places, of the class the param declares (its
// `class`, when it has one); a click on anything else says why in the status line and keeps picking. Esc, the button
// again, a swap or leaving edit mode stops it. While picking, the entity under the pointer is boxed: green when a click
// would take it, red when not.
//
// Cost: nothing until the button. A pointer move while picking tests the active entities under it (pick.js's exact
// tests, no allocation); the box is drawn from buffers made once.

import { Transform } from '../../../components/transform.js';
import { Messages } from '../../messages.js';
import { entityBox, pointOnEntity } from './pick.js';
import { writeParam } from './sceneDocument.js';

/** Classes never picked: the engine's own helpers (pick.js). */
const UNPICKABLE = 'Flash';
const INF = Infinity;

const OK_COLOR = 'rgba(52, 211, 153, 0.95)';
const NO_COLOR = 'rgba(248, 113, 113, 0.95)';
const LINE_DASH = Object.freeze([4, 4]);
const NO_DASH = Object.freeze([]);

/**
 * A status line that stays until replaced: a mode's hint (EditMode._setStatus without its timeout).
 * @param {object} editMode
 * @param {string} text
 * @param {boolean} isError
 */
export function holdStatus(editMode, text, isError) {
  editMode._setStatus(text, isError);
  clearTimeout(editMode._statusTimer);
  editMode._statusTimer = 0;
}

/** A class's name with its article: "a Door", "an Elevator". */
const aOrAn = (name) => (/^[AEIOU]/.test(name) ? `an ${name}` : `a ${name}`);

/** The running scene file's name for the live entity at `index`, or null (runtime, or not live). */
function placedNameOf(scene, index) {
  const names = scene?._namedEntities;
  if (!names) return null;
  const packed = index * 65536 + (Messages.spawnGen[index] | 0);
  for (const [name, p] of names) if (p === packed) return name;
  return null;
}

export class EntityPickTool {
  /** @param {object} editMode - the EditMode it edits through */
  constructor(editMode) {
    this.editMode = editMode;
    /** The entity param being filled (its key), or null when not picking. */
    this.key = null;
    /** The class it takes (its declaration's `class`), or null for any. */
    this.className = null;
    /** The placed entity whose param it is (its name when picking started). */
    this._owner = null;
    /** The param row's button, shown pressed while picking. */
    this._button = null;
    /** What the status line says while picking: put back by stop() only when it still says it. */
    this._hint = '';
    /** The entity under the pointer, and whether a click would take it. */
    this._hover = -1;
    this._hoverOk = false;
    /** One pass's finds (_find): the best hit to take, and the smallest hit of any kind. */
    this._found = -1;
    this._any = -1;
    this._box = new Float64Array(6);
    this._corners = new Float64Array(8);
  }

  /** Whether a click on the view fills a param now. */
  get picking() {
    return this.key !== null;
  }

  /**
   * The pick button of an entity param's row: the next click on the view fills it (the button again stops). While the
   * game plays (the editor page's inspector shows then) it goes back to editing first, and picks from there.
   * @param {string} key - the param
   * @param {string|undefined|null} className - the class it takes, or any
   * @param {object} [button] - the row's button, shown pressed while picking
   * @returns {boolean} whether it is picking now
   */
  start(key, className, button = null) {
    const editMode = this.editMode;
    const selection = editMode.selection;
    const again = this.key === key && this._owner === selection.name;
    this.stop();
    if (again || !selection.authored) return false;
    if (!editMode.active) {
      // Back to editing first (EditMode.edit: the level's start, ED-80); the selection is taken back by name.
      editMode.edit().then((editing) => {
        if (editing) this.start(key, className, button);
      });
      return false;
    }
    if (editMode.placing !== null) editMode.startPlacing(editMode.placing);
    this.key = key;
    this.className = typeof className === 'string' && className !== '' ? className : null;
    this._owner = selection.name;
    this._button = button;
    button?.classList?.add('active');
    this._say(`Click ${this._wanted()} in the view: ${this._owner}.${key} names it. Esc cancels`, false);
    return true;
  }

  /** Stop picking (Esc, the button again, a pick, a swap, leaving edit mode). */
  stop() {
    if (this.key === null) return;
    this.key = null;
    this.className = null;
    this._owner = null;
    this._button?.classList?.remove('active');
    this._button = null;
    this._hover = -1;
    const editMode = this.editMode;
    if (editMode.status === this._hint) editMode._setStatus('', false);
    this._hint = '';
  }

  cancel() {
    this.stop();
  }

  /** While picking, every primary press on the view is the pick's. */
  press(x, y) {
    if (this.key === null) return false;
    const editMode = this.editMode;
    if (editMode.selection.name !== this._owner) {
      this.stop(); // another entity was selected: its params are not the ones being filled
      return false;
    }
    this._find(x, y);
    const key = this.key;
    const owner = this._owner;
    if (this._found >= 0) {
      const target = placedNameOf(editMode.debugUI.scene, this._found);
      this.stop();
      editMode.editSelected(`${owner}.${key}`, (record, description) => writeParam(record, description, key, target));
      editMode._setStatus(`${owner}.${key}: ${target}`, false);
      return true;
    }
    const any = this._any;
    if (any < 0) {
      this._say(`Nothing there: click ${this._wanted()}, or Esc`, true);
    } else {
      const anyClass = this._classOf(any);
      const anyName = placedNameOf(editMode.debugUI.scene, any);
      if (this.className !== null && anyClass !== this.className) {
        this._say(`${anyName ?? `${anyClass} #${any}`} is ${aOrAn(anyClass)}: ${owner}.${key} takes ${this._wanted()}. Esc cancels`, true);
      } else {
        this._say(`${anyClass} #${any} was spawned by code: ${owner}.${key} names an entity the scene file places. Esc cancels`, true);
      }
    }
    return true;
  }

  /** The pointer with no button down, while picking: what is under it is boxed. */
  hover(x, y, e) {
    if (this.key === null) return;
    const canvas = this.editMode.debugUI.gameEngine?.canvas;
    if (e && e.target !== canvas) {
      this._hover = -1;
      return;
    }
    this._find(x, y);
    this._hover = this._found >= 0 ? this._found : this._any;
    this._hoverOk = this._found >= 0;
  }

  onKey(e) {
    if (this.key === null || e.key !== 'Escape') return false;
    this.stop();
    return true;
  }

  drawOverlay(ctx, camera, zoom) {
    if (this.key === null) return;
    const selection = this.editMode.selection;
    if (selection.name !== this._owner) {
      this.stop();
      return;
    }
    const i = this._hover;
    if (i < 0 || Transform.active[i] !== 1) return;
    const box = this._box;
    if (!entityBox(i, box)) return;
    const cx = (box[0] - camera.x) * zoom;
    const cy = (box[1] - camera.y) * zoom;
    const hw = box[2] * zoom + 3;
    const hh = box[3] * zoom + 3;
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
    const color = this._hoverOk ? OK_COLOR : NO_COLOR;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(p[0]) | 0, Math.round(p[1]) | 0);
    ctx.lineTo(Math.round(p[2]) | 0, Math.round(p[3]) | 0);
    ctx.lineTo(Math.round(p[4]) | 0, Math.round(p[5]) | 0);
    ctx.lineTo(Math.round(p[6]) | 0, Math.round(p[7]) | 0);
    ctx.closePath();
    ctx.stroke();
    // From the entity whose param it fills to the one a click would name.
    const from = selection.index;
    if (this._hoverOk && from >= 0 && Transform.active[from] === 1) {
      ctx.setLineDash(LINE_DASH);
      ctx.beginPath();
      ctx.moveTo(Math.round((Transform.x[from] - camera.x) * zoom) | 0, Math.round((Transform.y[from] - camera.y) * zoom) | 0);
      ctx.lineTo(Math.round(cx) | 0, Math.round(cy) | 0);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    ctx.restore();
  }

  /**
   * The entities under a world point, in one pass: _found, the smallest the param can take (another placed entity, of
   * its class), and _any, the smallest of any kind (to say why a click takes nothing). Each -1 when there is none.
   */
  _find(x, y) {
    const editMode = this.editMode;
    const scene = editMode.debugUI.scene;
    const self = editMode.selection.index;
    const active = Transform.active;
    const types = Transform.entityType;
    const box = this._box;
    let found = -1;
    let foundArea = INF;
    let any = -1;
    let anyArea = INF;
    for (let i = 0; active && i < active.length; i++) {
      if (active[i] !== 1 || i === self || editMode.layers?.unpickable(i) === true) continue; // locked or hidden (ED-24)
      const className = editMode.debugUI.tools._classNameForType(types[i]);
      if (className === UNPICKABLE || !pointOnEntity(i, x, y)) continue;
      const area = entityBox(i, box) ? box[2] * box[3] : 0;
      if (area < anyArea) {
        any = i;
        anyArea = area;
      }
      if (area >= foundArea || (this.className !== null && className !== this.className)) continue;
      if (placedNameOf(scene, i) === null) continue;
      found = i;
      foundArea = area;
    }
    this._found = found;
    this._any = any;
  }

  _classOf(index) {
    return this.editMode.debugUI.tools._classNameForType(Transform.entityType[index]);
  }

  /** "a Door", or "a placed entity". */
  _wanted() {
    return this.className === null ? 'a placed entity' : aOrAn(this.className);
  }

  /** A status line that stays while picking. */
  _say(text, isError) {
    this._hint = text;
    holdStatus(this.editMode, text, isError);
  }
}
