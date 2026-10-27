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
import { applyParticleEase, lerpRgb, resolveEaseId } from '../util/particleTween.js';
import { logicBlockRange } from '../util/logicOwner.js';
import { EntityIdArray, entityIdBytes } from '../util/entityIdWidth.js';
import { Messages } from './messages.js';

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

/** repeat = this: run again forever. */
export const TWEEN_REPEAT_FOREVER = 0xffff;
const FLAG_YOYO = 1;

// Paint goes to the entity's sprite, or to its mesh when it has no live sprite.
const ON_SPRITE = 1;
const ON_MESH = 2;

function paintTarget(ent) {
  if (SpriteRenderer.active && SpriteRenderer.active[ent]) return ON_SPRITE;
  if (MeshRenderer.active && MeshRenderer.active[ent]) return ON_MESH;
  return 0;
}

function align4(n) {
  return (n + 3) & ~3;
}

/**
 * Bytes for a pool of `count` slots. The entity column follows entityIdWidth, so
 * call it after bindEntityIdWidth (Scene and workers do). `entityCount` > 0 adds
 * a live-tween count per entity, so a despawn only scans the pool for an entity
 * that has tweens.
 * @param {number} count
 * @param {number} [entityCount]
 */
export function tweenBufferBytes(count, entityCount = 0) {
  const n = count | 0;
  let o = 0;
  o = align4(o + n * 4);
  o = align4(o + n);
  o = align4(o + n);
  o = align4(o + n);
  o += n * entityIdBytes();
  o = align4(o);
  o += n * 4 * 10;
  o += n * 4 * 2;
  o = align4(o + n * 2); // repeat
  o = align4(o + n * 2); // doneMsg
  o = align4(o + n); // flags
  o += (entityCount | 0) * 2; // live tweens per entity
  return o;
}

function repeatCount(options) {
  if (!options || options.repeat === undefined) return 0;
  const r = options.repeat;
  if (r < 0 || r === Infinity) return TWEEN_REPEAT_FOREVER;
  return r >= TWEEN_REPEAT_FOREVER ? TWEEN_REPEAT_FOREVER - 1 : r | 0;
}

/** The same options without onComplete (the second slot of an xy + paint pair, zoom). */
function withoutDone(options) {
  if (!options || !options.onComplete) return options;
  return { delay: options.delay, repeat: options.repeat, yoyo: options.yoyo };
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
  /** Cycles left after this one (TWEEN_REPEAT_FOREVER = forever). */
  static repeat = null;
  /** onComplete message id + 1 (0 = none); sent to the entity when the last cycle ends. */
  static doneMsg = null;
  /** bit 0 yoyo. */
  static flags = null;
  /** Live tweens per entity (Atomics), so despawn skips the pool scan for an entity without any. */
  static entityTweens = new Uint16Array(0);

  /**
   * @param {SharedArrayBuffer | ArrayBuffer | null} sab
   * @param {number} [count]
   */
  static bind(sab, count, entityCount = 0) {
    if (!sab) {
      this.active = null;
      this.capacity = 0;
      this.entityTweens = new Uint16Array(0);
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
    const IdArray = EntityIdArray();
    this.entity = new IdArray(sab, o, n);
    o = align4(o + n * entityIdBytes());
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
    o += n * 4;
    this.repeat = new Uint16Array(sab, o, n);
    o = align4(o + n * 2);
    this.doneMsg = new Uint16Array(sab, o, n);
    o = align4(o + n * 2);
    this.flags = new Uint8Array(sab, o, n);
    o = align4(o + n);
    this.entityTweens = new Uint16Array(sab, o, entityCount | 0);
  }

  static unbind() {
    this.active = null;
    this.capacity = 0;
    this._claimCursor = 0;
    this.entityTweens = new Uint16Array(0);
  }

  /**
   * @param {number} entityIndex
   * @param {{ alpha?: number, tint?: number, scaleX?: number, scaleY?: number, x?: number, y?: number }} props
   * @param {number} ms
   * @param {number} [ease] a PARTICLE_EASE value (default lerp)
   * @param {{ delay?: number, repeat?: number, yoyo?: boolean, onComplete?: string }} [options]
   *   delay ms before it starts (from values are read now); repeat extra cycles
   *   (-1 or Infinity = forever); yoyo plays every other cycle backwards;
   *   onComplete: a name from the scene's static messages, sent to the entity as
   *   onMessage(name, -1, slot) when the last cycle ends.
   * @returns {number} slot, or -1
   */
  static to(entityIndex, props, ms, ease, options) {
    // On every path and before a slot is claimed: an ease that is not a PARTICLE_EASE value throws.
    const easeId = resolveEaseId(ease);
    if (!props) return -1;
    const ent = entityIndex | 0;
    const wantsXy = props.x !== undefined || props.y !== undefined;
    const wantsPaint = props.alpha !== undefined || props.scaleX !== undefined ||
                       props.scaleY !== undefined || props.tint !== undefined;

    if (wantsXy && isDynamic(ent)) {
      if (!wantsPaint) return -1;
      return this._start(KIND_PAINT, ent, props, ms, easeId, options);
    }

    if (wantsXy && wantsPaint) {
      // One onComplete for the pair: both end on the same frame.
      const slotXy = this._start(KIND_XY, ent, props, ms, easeId, options);
      const slotPaint = this._start(KIND_PAINT, ent, props, ms, easeId, slotXy >= 0 ? withoutDone(options) : options);
      return slotXy >= 0 ? slotXy : slotPaint;
    }

    if (wantsXy) {
      return this._start(KIND_XY, ent, props, ms, easeId, options);
    }
    return this._start(KIND_PAINT, ent, props, ms, easeId, options);
  }

  /**
   * @param {number} zoom
   * @param {number} ms
   * @param {number} [ease] a PARTICLE_EASE value (default lerp)
   * @returns {number}
   */
  static toZoom(zoom, ms, ease, options) {
    const easeId = resolveEaseId(ease);
    if (!(ms > 0)) {
      Camera.targetZoom = +zoom;
      return -1;
    }
    return this._start(KIND_ZOOM, 0, { zoom: +zoom }, ms, easeId, withoutDone(options));
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
        this._free(i);
      }
    }
  }

  /** A despawn: cancel the entity's tweens, but only scan the pool when it has some. */
  static cancelForDespawn(entityIndex) {
    const counts = this.entityTweens;
    if (entityIndex < counts.length && Atomics.load(counts, entityIndex) > 0) this.cancel(entityIndex);
  }

  /** LIVE -> FREE once (a cancel and a finishing tick can race); the winner fixes the count. */
  static _free(slot) {
    if (Atomics.compareExchange(this.active, slot, SLOT_LIVE, SLOT_FREE) !== SLOT_LIVE) return false;
    if (this.kind[slot] !== KIND_ZOOM) {
      const ent = this.entity[slot];
      if (ent < this.entityTweens.length) Atomics.sub(this.entityTweens, ent, 1);
    }
    return true;
  }

  /** After a save restore wrote slots directly: recount live tweens per entity. */
  static rebuildEntityCounts() {
    const counts = this.entityTweens;
    if (counts.length === 0 || !this.active) return;
    counts.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i] !== SLOT_LIVE || this.kind[i] === KIND_ZOOM) continue;
      const ent = this.entity[i];
      if (ent < counts.length) counts[ent]++;
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

  /** @param {number} easeId resolved by the caller (resolveEaseId), before any claim */
  static _start(kind, entityIndex, props, ms, easeId, options) {
    const dur = ms > 0 ? ms : 0;
    const delay = options && options.delay > 0 ? +options.delay : 0;
    if (!(dur > 0) && delay === 0) {
      this._applyImmediate(kind, entityIndex, props);
      return -1;
    }
    // Name check before claiming: a typo throws without leaking a slot.
    const doneId = options && options.onComplete ? Messages.idOf(options.onComplete) : -1;
    const slot = this._claim();
    if (slot < 0) return -1;
    this.kind[slot] = kind;
    this.entity[slot] = entityIndex;
    this.ease[slot] = easeId;
    this.duration[slot] = dur > 0 ? dur : 1e-6;
    this.elapsed[slot] = -delay;
    this.repeat[slot] = repeatCount(options);
    this.flags[slot] = options && options.yoyo ? FLAG_YOYO : 0;
    this.doneMsg[slot] = doneId + 1;
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
      const on = paintTarget(entityIndex);
      const spriteOn = on === ON_SPRITE;
      let mask = 0;
      if (props.alpha !== undefined) {
        mask |= PAINT_ALPHA;
        const cur = spriteOn
          ? SpriteRenderer.alpha[entityIndex]
          : on === ON_MESH
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
          : on === ON_MESH
            ? MeshRenderer.tint[entityIndex]
            : 0xffffff;
        this.tintFrom[slot] = cur >>> 0;
        this.tintTo[slot] = props.tint >>> 0;
      }
      this.mask[slot] = mask;
    }

    if (kind !== KIND_ZOOM && entityIndex < this.entityTweens.length) {
      Atomics.add(this.entityTweens, entityIndex, 1);
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
    let mask = 0;
    if (props.alpha !== undefined) mask |= PAINT_ALPHA;
    if (props.scaleX !== undefined) mask |= PAINT_SCALEX;
    if (props.scaleY !== undefined) mask |= PAINT_SCALEY;
    if (props.tint !== undefined) mask |= PAINT_TINT;
    this._writePaint(entityIndex, mask, +props.alpha, +props.scaleX, +props.scaleY, props.tint >>> 0);
  }

  /**
   * Paint values onto an entity: alpha and tint on its sprite or mesh, scale on
   * a sprite only; then mark it for re-render. The tick (eased values) and a
   * zero-duration tween (target values) both end here.
   */
  static _writePaint(ent, mask, alpha, scaleX, scaleY, tint) {
    const on = paintTarget(ent);
    if (on === ON_SPRITE) {
      if (mask & PAINT_ALPHA) SpriteRenderer.alpha[ent] = alpha;
      if (mask & PAINT_SCALEX) SpriteRenderer.scaleX[ent] = scaleX;
      if (mask & PAINT_SCALEY) SpriteRenderer.scaleY[ent] = scaleY;
      if (mask & PAINT_TINT) SpriteRenderer.tint[ent] = tint;
      if (SpriteRenderer.renderDirty) SpriteRenderer.renderDirty[ent] = 1;
    } else if (on === ON_MESH) {
      if (mask & PAINT_ALPHA) MeshRenderer.alpha[ent] = alpha;
      if (mask & PAINT_TINT) MeshRenderer.tint[ent] = tint;
      if (MeshRenderer.renderDirty && !MeshRenderer.renderDirty[ent]) {
        MeshRenderer.renderDirty[ent] = 1;
        const ep = MeshRenderer.paintEpoch;
        if (ep) ep[0] = (ep[0] + 1) >>> 0;
      }
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
      if (elapsed < 0) continue; // still in its delay
      let t = dur > 0 ? elapsed / dur : 1;
      if (t < 1) {
        this._apply(i, applyParticleEase(t, this.ease[i]));
      } else {
        this._apply(i, applyParticleEase(1, this.ease[i]));
        this._cycleEnd(i, elapsed - dur);
      }
    }
    return n;
  }

  /** A cycle reached t = 1: run again (repeat, yoyo) or finish (free, onComplete). */
  static _cycleEnd(slot, overshoot) {
    const rep = this.repeat[slot];
    if (rep !== 0) {
      if (rep !== TWEEN_REPEAT_FOREVER) this.repeat[slot] = rep - 1;
      this.elapsed[slot] = overshoot < this.duration[slot] ? overshoot : 0;
      if (this.flags[slot] & FLAG_YOYO) this._swapEnds(slot);
      return;
    }
    const ent = this.entity[slot];
    const done = this.doneMsg[slot];
    if (this._free(slot) && done !== 0) Messages.sendId(ent, done - 1, -1, slot);
  }

  /** Yoyo: the next cycle runs from where this one ended. */
  static _swapEnds(slot) {
    let v = this.from0[slot];
    this.from0[slot] = this.to0[slot];
    this.to0[slot] = v;
    v = this.from1[slot];
    this.from1[slot] = this.to1[slot];
    this.to1[slot] = v;
    v = this.from2[slot];
    this.from2[slot] = this.to2[slot];
    this.to2[slot] = v;
    v = this.from3[slot];
    this.from3[slot] = this.to3[slot];
    this.to3[slot] = v;
    v = this.tintFrom[slot];
    this.tintFrom[slot] = this.tintTo[slot];
    this.tintTo[slot] = v;
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
    // The same writes as _writePaint, inline: calling it from the tick cost
    // the 65535-tween kernel 4.9 % (review R9).
    const on = paintTarget(ent);
    const spriteOn = on === ON_SPRITE;
    const meshOn = on === ON_MESH;
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

