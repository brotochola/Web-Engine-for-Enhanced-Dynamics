// DX-DIRSPRITE: a sprite drawn from several directions. The game says where the entity looks (`facing`, or where it moves,
// or its rotation) and which directionless animation it plays (`setAnimation('walk')`); the component draws the animation
// of the direction nearest the facing, from the sheet's direction table (spriteDirections.js). The sprite does not turn:
// it changes frames.
//
// Who writes what: the game writes facing, facingFrom, turnMargin and the animation it asks for (mode, animation). The
// resolver writes directionIndex and the sprite's animationState and flip: in the setters, so a tick reads the direction
// it just asked for, and in the logic worker's pass after the ticks, which follows velocity and rotation, and calls
// onDirectionChanged.

import { Component } from '../core/component.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { angleDistance, pickDirection, wrapAngle } from '../core/spriteDirections.js';
import { warnOnce } from '../util/dxWarn.js';
import { LightEmitter } from './lightEmitter.js';
import { RigidBody } from './rigidBody.js';
import { SpriteRenderer } from './spriteRenderer.js';
import { Transform } from './transform.js';

/** Where `facing` comes from, each frame. */
export const FACING_FROM = Object.freeze({ MANUAL: 0, VELOCITY: 1, ROTATION: 2 });
const FACING_FROM_NAMES = ['manual', 'velocity', 'rotation'];

/** What the entity asked for: nothing yet, a directionless animation, or a sheet's animation shown as it is. */
const MODE_NONE = 0;
const MODE_GROUP = 1;
const MODE_PINNED = 2;
/** No direction drawn (directionIndex), or none told to the game yet (notified). */
export const NO_DIRECTION = 255;

/** Under this speed (px/s with a body; px a frame from the pose without one) an entity keeps the facing it had. */
export const FACING_MIN_SPEED = 4;
const FACING_MIN_STEP = 0.05;
/** turnMargin's default: this share of the step between two directions. */
export const TURN_MARGIN_SHARE = 0.1;

const EMPTY = Object.freeze({ count: 0 });

/**
 * A sheet's table as the resolver reads it: the proxy's plain arrays as typed ones, once per sheet id and thread.
 * @param {number} sheetId
 */
function tableOf(sheetId) {
  const cache = DirectionalSprite._tables;
  let t = cache[sheetId];
  if (t !== undefined) return t;
  const name = SpriteSheetRegistry.getSpritesheetName(sheetId);
  const src = name ? SpriteSheetRegistry.spritesheets.get(name)?.directions : null;
  if (!src || !(src.count > 0)) {
    t = EMPTY;
  } else {
    t = {
      count: src.count,
      uniform: src.uniform === true,
      start: +src.start,
      step: +src.step,
      angles: Float64Array.from(src.angles),
      names: src.names.slice(),
      groups: src.groups.slice(),
      groupIndex: new Map(src.groups.map((g, k) => [g, k])),
      anim: Uint8Array.from(src.anim),
      flip: Uint8Array.from(src.flip),
      hasFlip: src.hasFlip === true,
      groupOfAnim: Int16Array.from(src.groupOfAnim),
      margin: TURN_MARGIN_SHARE * ((Math.PI * 2) / src.count),
      cos: Float64Array.from(src.angles, Math.cos),
      sin: Float64Array.from(src.angles, Math.sin),
      // A heading stays in its direction while within half the gap to its nearer neighbour plus half the margin (the
      // margin is spent on both sides of a border): cos² of that, per direction, for the test without atan2; with the
      // default margin and with 0. A side 90° or wider does not hold the test: 2 (never kept that way).
      keepCos2: new Float64Array(src.count),
      keepCos2Zero: new Float64Array(src.count),
    };
    for (let k = 0; k < t.count; k++) {
      const n = t.count;
      const prev = n > 1 ? angleDistance(t.angles[k], t.angles[(k + n - 1) % n]) : Math.PI * 2;
      const next = n > 1 ? angleDistance(t.angles[k], t.angles[(k + 1) % n]) : Math.PI * 2;
      const gap = (prev < next ? prev : next) * 0.5;
      const withMargin = gap + t.margin * 0.5;
      t.keepCos2[k] = withMargin < Math.PI * 0.5 ? Math.cos(withMargin) ** 2 : 2;
      t.keepCos2Zero[k] = gap < Math.PI * 0.5 ? Math.cos(gap) ** 2 : 2;
    }
  }
  cache[sheetId] = t;
  return t;
}

export class DirectionalSprite extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    facing: Float32Array, // radians in the world (y down: π/2 looks south, at the camera); with a source, at the last turn
    facingFrom: Uint8Array, // FACING_FROM
    aimX: Float32Array, // with 'velocity' or 'rotation': the vector the facing is, kept without an atan2 a frame
    aimY: Float32Array,
    turnMargin: Float32Array, // radians past the border before the direction changes; NaN = TURN_MARGIN_SHARE of a step
    mode: Uint8Array, // MODE_*
    animation: Uint8Array, // the group (MODE_GROUP) or the sheet's animation (MODE_PINNED)
    directionIndex: Uint8Array, // the direction drawn, NO_DIRECTION before the first
    notified: Uint8Array, // the direction onDirectionChanged last heard, NO_DIRECTION before the first
    lastX: Float32Array, // the pose at the last resolve: velocity for an entity without a body
    lastY: Float32Array,
  };

  /** setAnimation brings the sprite; DirectionalSprite draws through it. */
  static get requires() {
    return [SpriteRenderer];
  }

  /** @internal the resolver's tables, by sheet id (this thread's). */
  static _tables = [];

  static clearArrays() {
    super.clearArrays();
    DirectionalSprite._tables = [];
  }

  /** A spawned slot's defaults (GameObject's reset). */
  static resetRow(i) {
    DirectionalSprite.active[i] = 1;
    DirectionalSprite.facing[i] = Math.PI / 2;
    DirectionalSprite.facingFrom[i] = FACING_FROM.MANUAL;
    DirectionalSprite.turnMargin[i] = Number.NaN;
    DirectionalSprite.aimX[i] = 0;
    DirectionalSprite.aimY[i] = 0;
    DirectionalSprite.mode[i] = MODE_NONE;
    DirectionalSprite.animation[i] = 0;
    DirectionalSprite.directionIndex[i] = NO_DIRECTION;
    DirectionalSprite.notified[i] = NO_DIRECTION;
    DirectionalSprite.lastX[i] = Transform.x ? Transform.x[i] : 0;
    DirectionalSprite.lastY[i] = Transform.y ? Transform.y[i] : 0;
    if (SpriteRenderer.inheritTransformRotation) {
      SpriteRenderer.inheritTransformRotation[i] = 0;
      SpriteRenderer.spriteRotC[i] = 1;
      SpriteRenderer.spriteRotS[i] = 0;
    }
  }

  /** Where it looks, in world radians (like `rotation`): π/2 is south. With facingFrom 'velocity' or 'rotation', read-only in effect. */
  get facing() {
    const i = this.index;
    if (DirectionalSprite.facingFrom[i] !== FACING_FROM.MANUAL) {
      const x = DirectionalSprite.aimX[i];
      const y = DirectionalSprite.aimY[i];
      if (x !== 0 || y !== 0) return Math.atan2(y, x);
    }
    return DirectionalSprite.facing[i];
  }
  set facing(radians) {
    const i = this.index;
    const v = +radians;
    if (v !== v) return;
    // E-363: the same facing again resolves to what is drawn (the column holds floats, so compare the float).
    if (
      DirectionalSprite.facing[i] === Math.fround(v) &&
      DirectionalSprite.aimX[i] === 0 &&
      DirectionalSprite.aimY[i] === 0 &&
      DirectionalSprite.directionIndex[i] !== NO_DIRECTION
    ) {
      return;
    }
    DirectionalSprite.facing[i] = v;
    DirectionalSprite.aimX[i] = 0;
    DirectionalSprite.aimY[i] = 0;
    DirectionalSprite.resolve(i);
  }

  /** 'manual' (default: the game writes facing), 'velocity' (where it moves; still, the last) or 'rotation'. */
  get facingFrom() {
    return FACING_FROM_NAMES[DirectionalSprite.facingFrom[this.index]] || 'manual';
  }
  set facingFrom(source) {
    const k = typeof source === 'number' ? source | 0 : FACING_FROM_NAMES.indexOf(source);
    if (!(k >= 0 && k < FACING_FROM_NAMES.length)) {
      throw new Error(`DirectionalSprite.facingFrom: '${source}' is not one of ${FACING_FROM_NAMES.join(', ')}`);
    }
    const i = this.index;
    // E-363: the source it already has (Predator's FSM sets 'velocity' again in each state's onEnter): nothing to
    // resolve, and the position delta keeps running (a reset stalled a facing from positions for a frame).
    if (DirectionalSprite.facingFrom[i] === k) return;
    DirectionalSprite.facingFrom[i] = k;
    DirectionalSprite.lastX[i] = Transform.x[i];
    DirectionalSprite.lastY[i] = Transform.y[i];
    DirectionalSprite.resolve(i);
  }

  /** Radians past the border between two directions before it changes; default a tenth of the step (9° with four). */
  get turnMargin() {
    const i = this.index;
    const m = DirectionalSprite.turnMargin[i];
    if (m === m) return m;
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    return t.count > 0 ? t.margin : 0;
  }
  set turnMargin(radians) {
    const v = +radians;
    DirectionalSprite.turnMargin[this.index] = v >= 0 ? v : Number.NaN;
  }

  /** The direction drawn: its name in the sheet ('left', 'downRight', '12'), or null before the first. */
  get direction() {
    const i = this.index;
    const k = DirectionalSprite.directionIndex[i];
    if (k === NO_DIRECTION) return null;
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    return k < t.count ? t.names[k] : null;
  }

  /** The direction drawn as world radians (π/2 south), NaN before the first: where a mirrored or rendered frame looks. */
  get directionAngle() {
    const i = this.index;
    const k = DirectionalSprite.directionIndex[i];
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    return k < t.count ? t.angles[k] : Number.NaN;
  }

  /** The direction drawn as a number (an index into the sheet's directions, from east), NO_DIRECTION (255) before the first. */
  get directionIndex() {
    return DirectionalSprite.directionIndex[this.index];
  }

  /** The sheet's directions, in order from east (world angles increase clockwise on the screen). */
  get directions() {
    const t = tableOf(SpriteRenderer.spritesheetId[this.index]);
    return t.count > 0 ? t.names.slice() : [];
  }

  /** Look at a point of the world. */
  lookAt(x, y) {
    const i = this.index;
    const dx = x - Transform.x[i];
    const dy = y - Transform.y[i];
    if (dx === 0 && dy === 0) return;
    DirectionalSprite.facing[i] = Math.atan2(dy, dx);
    DirectionalSprite.resolve(i);
  }

  /**
   * setAnimation on an entity with this component: a directionless name of the sheet's table plays in the facing's
   * direction; any other name is looked up as a plain animation (pinned: shown as it is until the next directionless one).
   * @returns {boolean} true when `name` is one of the sheet's directionless animations
   */
  static setGroup(i, name) {
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    if (t.count === 0) return false;
    const g = t.groupIndex.get(name);
    if (g === undefined) return false;
    // E-363: the group it already plays: the frame pass keeps its direction.
    if (DirectionalSprite.mode[i] === MODE_GROUP && DirectionalSprite.animation[i] === g) return true;
    DirectionalSprite.mode[i] = MODE_GROUP;
    DirectionalSprite.animation[i] = g;
    DirectionalSprite.resolve(i);
    return true;
  }

  /** A plain animation shown as it is (setAnimation('walk_left') on a directional entity). */
  static pin(i, animIndex) {
    // E-363: the animation it already shows pinned.
    if (
      DirectionalSprite.mode[i] === MODE_PINNED &&
      DirectionalSprite.animation[i] === animIndex &&
      SpriteRenderer.animationState[i] === animIndex
    ) {
      return;
    }
    DirectionalSprite.mode[i] = MODE_PINNED;
    DirectionalSprite.animation[i] = animIndex;
    DirectionalSprite.resolve(i);
  }

  /** Whether entity i plays a directionless animation (then `animIndex`, the sheet's, names its group). */
  static groupOf(i, animIndex) {
    if (DirectionalSprite.mode[i] !== MODE_GROUP) return null;
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    const g = t.count > 0 && animIndex < t.groupOfAnim.length ? t.groupOfAnim[animIndex] : -1;
    return g >= 0 ? t.groups[g] : null;
  }

  /** The animation a group's name asks for is missing from the sheet's table: said once per sheet and name. */
  static warnNoGroup(className, i, name) {
    const sheet = SpriteSheetRegistry.getSpritesheetName(SpriteRenderer.spritesheetId[i]) || '?';
    const t = tableOf(SpriteRenderer.spritesheetId[i]);
    const why = t.count === 0
      ? `sheet "${sheet}" has no directions: give assets.spritesheets.${sheet}.directions, or name its animations <name>_<direction> (walk_up, walk_left…)`
      : `"${name}" is not one of sheet "${sheet}"'s directionless animations (${t.groups.join(', ')}) nor one of its animations`;
    warnOnce(`${className}:${sheet}:${name}`, 'DX-DIRSPRITE', `${className}.setAnimation('${name}'): ${why}.`);
  }

  /**
   * Bring entity i's drawn animation up to date: its facing from its source, the direction nearest it, and that
   * direction's animation and flip. The setters call it, and the logic worker's pass once a frame.
   * @returns {number} the direction drawn, NO_DIRECTION when there is none
   */
  static resolve(i) {
    const mode = DirectionalSprite.mode[i];
    if (mode === MODE_NONE) return NO_DIRECTION;
    const sheetId = SpriteRenderer.spritesheetId[i];
    if (!sheetId) return NO_DIRECTION;
    if (mode === MODE_PINNED) {
      setState(i, DirectionalSprite.animation[i]);
      return DirectionalSprite.directionIndex[i];
    }
    const t = tableOf(sheetId);
    const count = t.count;
    if (count === 0) return NO_DIRECTION;
    const cur = DirectionalSprite.directionIndex[i];
    const m = DirectionalSprite.turnMargin[i];
    const from = DirectionalSprite.facingFrom[i];
    let dir = cur;
    if (from === FACING_FROM.MANUAL) {
      dir = pickDirection(t, DirectionalSprite.facing[i], cur, m === m ? m : t.margin);
    } else {
      let vx;
      let vy;
      let moved = true;
      if (from === FACING_FROM.ROTATION) {
        vx = Transform.rotC[i];
        vy = Transform.rotS[i];
      } else if (RigidBody.active && RigidBody.active[i]) {
        vx = RigidBody.vx[i];
        vy = RigidBody.vy[i];
        moved = vx * vx + vy * vy > FACING_MIN_SPEED * FACING_MIN_SPEED;
      } else {
        const x = Transform.x[i];
        const y = Transform.y[i];
        vx = x - DirectionalSprite.lastX[i];
        vy = y - DirectionalSprite.lastY[i];
        DirectionalSprite.lastX[i] = x;
        DirectionalSprite.lastY[i] = y;
        moved = vx * vx + vy * vy > FACING_MIN_STEP * FACING_MIN_STEP;
      }
      if (moved) {
        DirectionalSprite.aimX[i] = vx;
        DirectionalSprite.aimY[i] = vy;
        // Still within the current direction: a dot product says so, without the angle (most frames of most entities).
        let kept = false;
        if (cur < count && (m !== m || m === 0)) {
          const dot = vx * t.cos[cur] + vy * t.sin[cur];
          kept = dot > 0 && dot * dot >= (vx * vx + vy * vy) * (m === 0 ? t.keepCos2Zero[cur] : t.keepCos2[cur]);
        }
        if (!kept) {
          const facing = Math.atan2(vy, vx);
          DirectionalSprite.facing[i] = facing;
          dir = pickDirection(t, facing, cur, m === m ? m : t.margin);
        }
      } else if (cur >= count) {
        dir = pickDirection(t, DirectionalSprite.facing[i], cur, m === m ? m : t.margin);
      }
    }
    if (dir !== cur) DirectionalSprite.directionIndex[i] = dir;
    const g = DirectionalSprite.animation[i];
    const k = (g < t.groups.length ? g : 0) * count + dir;
    setState(i, t.anim[k]);
    if (t.hasFlip) flipX(i, t.flip[k] === 1);
    return dir;
  }

  /** wrapAngle, for game code that compares facings. */
  static wrapAngle = wrapAngle;
}

/** GameObject.setAnimationState for a static caller: the sprite's animation, its bounds and its dirty flags. */
function setState(i, anim) {
  if (SpriteRenderer.animationState[i] === anim) return;
  SpriteRenderer.animationState[i] = anim;
  SpriteRenderer.updateBounds(i);
  SpriteRenderer.renderDirty[i] = 1;
  SpriteRenderer.keyedDirty[i] = 1;
}

/** GameObject's flipX for a static caller: the sprite's mirror, and a light that follows it. */
function flipX(i, on) {
  if (((SpriteRenderer.flip[i] & 1) !== 0) === on) return;
  const follows = LightEmitter.active && LightEmitter.active[i] && LightEmitter.followFlip[i] !== 0;
  SpriteRenderer.flip[i] ^= 1;
  SpriteRenderer.scaleX[i] = -SpriteRenderer.scaleX[i];
  SpriteRenderer.updateBounds(i);
  SpriteRenderer.renderDirty[i] = 1;
  SpriteRenderer.keyedDirty[i] = 1;
  if (follows) LightEmitter.mirrorX(i);
}
