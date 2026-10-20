// Tween.js — scene tween pool. Every logic worker ticks its own block of slots
// with scaled dt (one writer per slot; see Tween.tick).
// Slot count is config.tween.maxTweens (TWEEN_DEFAULTS).
// Paint writes SpriteRenderer, or MeshRenderer when the entity has no sprite.
// xy is refused on a dynamic RigidBody. Zoom writes Camera.targetZoom.

import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Camera } from './camera.js';
import { PARTICLE_EASE } from '../util/configDefaults.js';
import { applyParticleEase } from '../util/particleTween.js';
import { logicBlockRange } from '../util/logicOwner.js';

export const TWEEN_KIND_PAINT = 0;
export const TWEEN_KIND_XY = 1;
export const TWEEN_KIND_ZOOM = 2;

const KIND_PAINT = TWEEN_KIND_PAINT;
const KIND_XY = TWEEN_KIND_XY;
const KIND_ZOOM = TWEEN_KIND_ZOOM;

// Slot states in `active`. A claim goes 0 -> CLAIMING, writes every field, then
// publishes LIVE; tick, cancel and save act on LIVE only. Several logic workers tick
// the pool, so a slot must never read LIVE with the previous tween's fields.
const SLOT_FREE = 0;
const SLOT_LIVE = 1;
const SLOT_CLAIMING = 2;

const PAINT_ALPHA = 1;
const PAINT_SCALEX = 2;
const PAINT_SCALEY = 4;
const PAINT_TINT = 8;
const XY_X = 1;
const XY_Y = 2;

const EASE_NAME = Object.freeze({
  lerp: PARTICLE_EASE.LERP,
  'quad.in': PARTICLE_EASE.QUAD_IN,
  'quad.out': PARTICLE_EASE.QUAD_OUT,
  'quad.inout': PARTICLE_EASE.QUAD_INOUT,
  'cubic.in': PARTICLE_EASE.CUBIC_IN,
  'cubic.out': PARTICLE_EASE.CUBIC_OUT,
  'cubic.inout': PARTICLE_EASE.CUBIC_INOUT,
  'expo.in': PARTICLE_EASE.EXPO_IN,
  'expo.out': PARTICLE_EASE.EXPO_OUT,
  'expo.inout': PARTICLE_EASE.EXPO_INOUT,
  'back.in': PARTICLE_EASE.BACK_IN,
  'back.out': PARTICLE_EASE.BACK_OUT,
  'back.inout': PARTICLE_EASE.BACK_INOUT,
  'bounce.out': PARTICLE_EASE.BOUNCE_OUT,
});

function align4(n) {
  return (n + 3) & ~3;
}

/**
 * Bytes for a pool of `count` slots.
 * @param {number} count
 */
export function tweenBufferBytes(count) {
  const n = count | 0;
  let o = 0;
  o = align4(o + n * 4);
  o = align4(o + n);
  o = align4(o + n);
  o = align4(o + n);
  o += n * 2;
  o = align4(o);
  o += n * 4 * 10;
  o += n * 4 * 2;
  return o;
}

function easeIdOf(ease) {
  if (typeof ease === 'string') {
    const id = EASE_NAME[ease];
    return id === undefined ? PARTICLE_EASE.LERP : id;
  }
  const n = ease | 0;
  return n >= 0 && n <= PARTICLE_EASE.BOUNCE_OUT ? n : PARTICLE_EASE.LERP;
}

function isDynamic(entityIndex) {
  const active = RigidBody.active;
  if (!active || !active[entityIndex]) return false;
  const stat = RigidBody.static;
  return !stat || !stat[entityIndex];
}

let _warnedFull = false;

export function resetTweenFullWarn() {
  _warnedFull = false;
}

function warnFull() {
  if (_warnedFull) return;
  _warnedFull = true;
  console.warn(`WeedJS: Tween pool is full (${Tween.capacity})`);
}

export class Tween {
  /** Slot count from the bound buffer. 0 until bind. */
  static capacity = 0;
  /** Next slot to try. Filling a pool from 0 every time is O(n²). */
  static _claimCursor = 0;
  static active = null;
  static ease = null;
  static mask = null;
  static kind = null;
  static entity = null;
  static duration = null;
  static elapsed = null;
  static from0 = null;
  static to0 = null;
  static from1 = null;
  static to1 = null;
  static from2 = null;
  static to2 = null;
  static from3 = null;
  static to3 = null;
  static tintFrom = null;
  static tintTo = null;

  /**
   * @param {SharedArrayBuffer | ArrayBuffer | null} sab
   * @param {number} [count]
   */
  static bind(sab, count) {
    if (!sab) {
      this.active = null;
      this.capacity = 0;
      return;
    }
    const n = count | 0;
    this.capacity = n;
    this._claimCursor = 0;
    let o = 0;
    this.active = new Int32Array(sab, o, n);
    o = align4(o + n * 4);
    this.ease = new Uint8Array(sab, o, n);
    o = align4(o + n);
    this.mask = new Uint8Array(sab, o, n);
    o = align4(o + n);
    this.kind = new Uint8Array(sab, o, n);
    o = align4(o + n);
    this.entity = new Uint16Array(sab, o, n);
    o = align4(o + n * 2);
    const take = () => {
      const view = new Float32Array(sab, o, n);
      o += n * 4;
      return view;
    };
    this.duration = take();
    this.elapsed = take();
    this.from0 = take();
    this.to0 = take();
    this.from1 = take();
    this.to1 = take();
    this.from2 = take();
    this.to2 = take();
    this.from3 = take();
    this.to3 = take();
    this.tintFrom = new Uint32Array(sab, o, n);
    o += n * 4;
    this.tintTo = new Uint32Array(sab, o, n);
  }

  static unbind() {
    this.active = null;
    this.capacity = 0;
    this._claimCursor = 0;
  }

  /**
   * @param {number} entityIndex
   * @param {{ alpha?: number, tint?: number, scaleX?: number, scaleY?: number, x?: number, y?: number }} props
   * @param {number} ms
   * @param {number|string} [ease]
   * @returns {number} slot, or -1
   */
  /**
   * @param {number} entityIndex
   * @param {{ alpha?: number, tint?: number, scaleX?: number, scaleY?: number, x?: number, y?: number }} props
   * @param {number} ms
   * @param {number|string} [ease]
   * @returns {number} slot, or -1
   */
  static to(entityIndex, props, ms, ease) {
    if (!props) return -1;
    const ent = entityIndex | 0;
    const wantsXy = props.x !== undefined || props.y !== undefined;
    const wantsPaint = props.alpha !== undefined || props.scaleX !== undefined ||
                       props.scaleY !== undefined || props.tint !== undefined;

    if (wantsXy && isDynamic(ent)) {
      if (!wantsPaint) return -1;
      return this._start(KIND_PAINT, ent, props, ms, ease);
    }

    if (wantsXy && wantsPaint) {
      const slotXy = this._start(KIND_XY, ent, props, ms, ease);
      const slotPaint = this._start(KIND_PAINT, ent, props, ms, ease);
      return slotXy >= 0 ? slotXy : slotPaint;
    }

    if (wantsXy) {
      return this._start(KIND_XY, ent, props, ms, ease);
    }
    return this._start(KIND_PAINT, ent, props, ms, ease);
  }

  /**
   * @param {number} zoom
   * @param {number} ms
   * @param {number|string} [ease]
   * @returns {number}
   */
  static toZoom(zoom, ms, ease) {
    if (!(ms > 0)) {
      Camera.targetZoom = +zoom;
      return -1;
    }
    return this._start(KIND_ZOOM, 0, { zoom: +zoom }, ms, ease);
  }

  /**
   * Cancel active tweens on an entity.
   * @param {number} entityIndex
   * @param {number} [kind]
   */
  static cancel(entityIndex, kind = null) {
    const active = this.active;
    if (!active) return;
    const ent = entityIndex | 0;
    for (let i = 0; i < this.capacity; i++) {
      if (active[i] !== SLOT_LIVE) continue;
      if (this.entity[i] === ent && (kind === null || this.kind[i] === kind)) {
        Atomics.store(active, i, SLOT_FREE);
      }
    }
  }

  static _claim() {
    const active = this.active;
    const n = this.capacity;
    if (!active || n <= 0) return -1;
    const start = this._claimCursor;
    for (let k = 0; k < n; k++) {
      const i = start + k;
      const slot = i < n ? i : i - n;
      if (Atomics.compareExchange(active, slot, SLOT_FREE, SLOT_CLAIMING) === SLOT_FREE) {
        this._claimCursor = slot + 1 < n ? slot + 1 : 0;
        return slot;
      }
    }
    warnFull();
    return -1;
  }

  static _start(kind, entityIndex, props, ms, ease) {
    const dur = ms > 0 ? ms : 0;
    if (!(dur > 0)) {
      this._applyImmediate(kind, entityIndex, props);
      return -1;
    }
    const slot = this._claim();
    if (slot < 0) return -1;
    this.kind[slot] = kind;
    this.entity[slot] = entityIndex;
    this.ease[slot] = easeIdOf(ease);
    this.duration[slot] = dur;
    this.elapsed[slot] = 0;
    this.mask[slot] = 0;
    this.from0[slot] = 0;
    this.to0[slot] = 0;
    this.from1[slot] = 0;
    this.to1[slot] = 0;
    this.from2[slot] = 0;
    this.to2[slot] = 0;
    this.from3[slot] = 0;
    this.to3[slot] = 0;

    if (kind === KIND_ZOOM) {
      this.mask[slot] = 1;
      this.from0[slot] = Camera.targetZoom || Camera.zoom || 1;
      this.to0[slot] = +props.zoom;
    } else if (kind === KIND_XY) {
      let mask = 0;
      const x = Transform.x ? Transform.x[entityIndex] : 0;
      const y = Transform.y ? Transform.y[entityIndex] : 0;
      if (props.x !== undefined) {
        mask |= XY_X;
        this.from0[slot] = x;
        this.to0[slot] = +props.x;
      }
      if (props.y !== undefined) {
        mask |= XY_Y;
        this.from1[slot] = y;
        this.to1[slot] = +props.y;
      }
      this.mask[slot] = mask;
    } else {
      const spriteOn = SpriteRenderer.active && SpriteRenderer.active[entityIndex];
      const meshOn = !spriteOn && MeshRenderer.active && MeshRenderer.active[entityIndex];
      let mask = 0;
      if (props.alpha !== undefined) {
        mask |= PAINT_ALPHA;
        const cur = spriteOn
          ? SpriteRenderer.alpha[entityIndex]
          : meshOn
            ? MeshRenderer.alpha[entityIndex]
            : 1;
        this.from0[slot] = cur;
        this.to0[slot] = +props.alpha;
      }
      if (props.scaleX !== undefined && spriteOn) {
        mask |= PAINT_SCALEX;
        this.from1[slot] = SpriteRenderer.scaleX[entityIndex];
        this.to1[slot] = +props.scaleX;
      }
      if (props.scaleY !== undefined && spriteOn) {
        mask |= PAINT_SCALEY;
        this.from2[slot] = SpriteRenderer.scaleY[entityIndex];
        this.to2[slot] = +props.scaleY;
      }
      if (props.tint !== undefined) {
        mask |= PAINT_TINT;
        const cur = spriteOn
          ? SpriteRenderer.tint[entityIndex]
          : meshOn
            ? MeshRenderer.tint[entityIndex]
            : 0xffffff;
        this.tintFrom[slot] = cur >>> 0;
        this.tintTo[slot] = props.tint >>> 0;
      }
      this.mask[slot] = mask;
    }

    Atomics.store(this.active, slot, SLOT_LIVE);
    return slot;
  }

  static _applyImmediate(kind, entityIndex, props) {
    if (kind === KIND_ZOOM) {
      Camera.targetZoom = +props.zoom;
      return;
    }
    if (kind === KIND_XY) {
      if (props.x !== undefined && Transform.x) Transform.x[entityIndex] = +props.x;
      if (props.y !== undefined && Transform.y) Transform.y[entityIndex] = +props.y;
      return;
    }
    const spriteOn = SpriteRenderer.active && SpriteRenderer.active[entityIndex];
    const meshOn = !spriteOn && MeshRenderer.active && MeshRenderer.active[entityIndex];
    if (props.alpha !== undefined) {
      const a = +props.alpha;
      if (spriteOn) SpriteRenderer.alpha[entityIndex] = a;
      else if (meshOn) MeshRenderer.alpha[entityIndex] = a;
    }
    if (props.scaleX !== undefined && spriteOn) {
      SpriteRenderer.scaleX[entityIndex] = +props.scaleX;
    }
    if (props.scaleY !== undefined && spriteOn) {
      SpriteRenderer.scaleY[entityIndex] = +props.scaleY;
    }
    if (props.tint !== undefined) {
      const c = props.tint >>> 0;
      if (spriteOn) SpriteRenderer.tint[entityIndex] = c;
      else if (meshOn) MeshRenderer.tint[entityIndex] = c;
    }
    if (spriteOn && SpriteRenderer.renderDirty) SpriteRenderer.renderDirty[entityIndex] = 1;
    if (meshOn && MeshRenderer.renderDirty && !MeshRenderer.renderDirty[entityIndex]) {
      MeshRenderer.renderDirty[entityIndex] = 1;
      const ep = MeshRenderer.paintEpoch;
      if (ep) ep[0] = (ep[0] + 1) >>> 0;
    }
  }

  /**
   * Advance this worker's block of slots: with W logic workers, worker i ticks
   * logicBlockRange(capacity, i, W), so every slot has exactly one writer and no worker
   * scans the whole pool. That worker is not necessarily the one that ticks the tweened
   * entity: do not tween a property the entity's own tick also writes (REVIEW_PLAN N-6).
   * @param {number} dt
   * @param {number} [workerIndex]
   * @param {number} [workerCount]
   * @returns {number} live slots advanced
   */
  static tick(dt, workerIndex = 0, workerCount = 1) {
    const active = this.active;
    if (!active) return 0;
    const step = dt > 0 ? dt : 0;
    const nSlots = this.capacity;
    let from = 0;
    let to = nSlots;
    if ((workerCount | 0) > 1) {
      const range = logicBlockRange(nSlots, workerIndex | 0, workerCount | 0);
      from = range.start;
      to = range.end;
    }
    let n = 0;
    for (let i = from; i < to; i++) {
      if (active[i] !== SLOT_LIVE) continue;
      n++;
      const dur = this.duration[i];
      const elapsed = this.elapsed[i] + step;
      this.elapsed[i] = elapsed;
      let t = dur > 0 ? elapsed / dur : 1;
      let done = false;
      if (t >= 1) {
        t = 1;
        done = true;
      }
      this._apply(i, applyParticleEase(t, this.ease[i]));
      if (done) Atomics.store(active, i, SLOT_FREE);
    }
    return n;
  }

  static _apply(slot, eased) {
    const kind = this.kind[slot];
    const mask = this.mask[slot];
    const ent = this.entity[slot];
    if (kind === KIND_ZOOM) {
      Camera.targetZoom = this.from0[slot] + (this.to0[slot] - this.from0[slot]) * eased;
      return;
    }
    if (kind === KIND_XY) {
      if ((mask & XY_X) && Transform.x) {
        Transform.x[ent] = this.from0[slot] + (this.to0[slot] - this.from0[slot]) * eased;
      }
      if ((mask & XY_Y) && Transform.y) {
        Transform.y[ent] = this.from1[slot] + (this.to1[slot] - this.from1[slot]) * eased;
      }
      return;
    }
    const spriteOn = SpriteRenderer.active && SpriteRenderer.active[ent];
    const meshOn = !spriteOn && MeshRenderer.active && MeshRenderer.active[ent];
    if (mask & PAINT_ALPHA) {
      const a = this.from0[slot] + (this.to0[slot] - this.from0[slot]) * eased;
      if (spriteOn) SpriteRenderer.alpha[ent] = a;
      else if (meshOn) MeshRenderer.alpha[ent] = a;
    }
    if ((mask & PAINT_SCALEX) && spriteOn) {
      SpriteRenderer.scaleX[ent] = this.from1[slot] + (this.to1[slot] - this.from1[slot]) * eased;
    }
    if ((mask & PAINT_SCALEY) && spriteOn) {
      SpriteRenderer.scaleY[ent] = this.from2[slot] + (this.to2[slot] - this.from2[slot]) * eased;
    }
    if (mask & PAINT_TINT) {
      const c = lerpRgb(this.tintFrom[slot], this.tintTo[slot], eased);
      if (spriteOn) SpriteRenderer.tint[ent] = c;
      else if (meshOn) MeshRenderer.tint[ent] = c;
    }
    if (spriteOn && SpriteRenderer.renderDirty) SpriteRenderer.renderDirty[ent] = 1;
    if (meshOn && MeshRenderer.renderDirty && !MeshRenderer.renderDirty[ent]) {
      MeshRenderer.renderDirty[ent] = 1;
      const ep = MeshRenderer.paintEpoch;
      if (ep) ep[0] = (ep[0] + 1) >>> 0;
    }
  }
}

function lerpRgb(a, b, t) {
  const ar = (a >>> 16) & 255;
  const ag = (a >>> 8) & 255;
  const ab = a & 255;
  const br = (b >>> 16) & 255;
  const bg = (b >>> 8) & 255;
  const bb = b & 255;
  const r = (ar + (br - ar) * t + 0.5) | 0;
  const g = (ag + (bg - ag) * t + 0.5) | 0;
  const bl = (ab + (bb - ab) * t + 0.5) | 0;
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}
