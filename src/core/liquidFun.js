// LiquidFun.js — Box2D liquidfun-c particle physics API (not Weed CPU ParticleEmitter).

import { Box2dCommandRing } from '../box2d/box2dCommandRing.js';
import {
  liquidFunQueryAABB,
  liquidFunQueryAABBAsync,
  liquidFunRayCast,
  liquidFunRayCastAsync,
} from '../box2d/liquidFunQuery.js';
import {
  liquidFunExtract,
  liquidFunExtractAsync,
} from '../box2d/liquidFunExtract.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { bindLiquidFunGroups, LIQUIDFUN_GROUPS_MAX } from '../util/liquidFunGroups.js';
import { bindLiquidFunRender } from '../render/liquidFunRender.js';
import { Layer } from './layer.js';

// Bits match liquidfun-c lfParticleFlag (not Google LiquidFun's extra listener bits).
export const LIQUIDFUN_FLAGS = Object.freeze({
  WATER: 0,
  ZOMBIE: 1 << 0,
  WALL: 1 << 1,
  VISCOUS: 1 << 2,
  TENSILE: 1 << 3,
  ELASTIC: 1 << 4,
  POWDER: 1 << 5,
  SPRING: 1 << 6,
  BARRIER: 1 << 7,
  STATIC_PRESSURE: 1 << 8,
  COLOR_MIXING: 1 << 9,
  REPULSIVE: 1 << 10,
  REACTIVE: 1 << 11,
});

/** Google b2ParticleGroupFlag subset (group construction, not particle bits). */
export const LIQUIDFUN_GROUP_FLAGS = Object.freeze({
  SOLID: 1 << 0,
  RIGID: 1 << 1,
  CAN_BE_EMPTY: 1 << 2,
});

function resolveLifespanSec(lifespan) {
  if (lifespan == null) return { minSec: 0, maxSec: 0 };
  if (typeof lifespan === 'number') {
    const sec = lifespan * 0.001;
    return { minSec: sec, maxSec: sec };
  }
  return {
    minSec: lifespan.min != null ? lifespan.min * 0.001 : 0,
    maxSec: lifespan.max != null ? lifespan.max * 0.001 : 0,
  };
}

function resolveRange(value, defaultVal = 1) {
  if (value == null) return null;
  if (typeof value === 'number') return { min: value, max: value };
  const min = value.min != null ? value.min : defaultVal;
  const max = value.max != null ? value.max : min;
  return { min, max };
}

function resolveEmit(options) {
  const o = options || {};
  let textureId = o.textureId | 0;
  if (!textureId && o.texture) {
    textureId = SpriteSheetRegistry.getTextureId(o.texture) | 0;
  }
  const life = resolveLifespanSec(o.lifespan);
  const viscousScale = o.viscousScale != null ? o.viscousScale : 1;
  const lightIntensity = o.lightIntensity > 0 ? +o.lightIntensity : 0;
  const layerMask = Layer.resolveSubscriptions(o);
  return {
    posX: o.posX,
    posY: o.posY,
    halfWidth: o.halfWidth,
    halfHeight: o.halfHeight,
    radius: o.radius,
    systemId: o.systemId || 0,
    flags: o.flags != null ? o.flags : LIQUIDFUN_FLAGS.WATER,
    spacing: o.spacing != null ? o.spacing : 0,
    strength: o.strength != null ? o.strength : 0,
    viscousScale: viscousScale > 0 ? viscousScale : 1,
    trackGroup: !!o.trackGroup || lightIntensity > 0,
    lightIntensity,
    groupFlags: o.groupFlags != null ? o.groupFlags >>> 0 : 0,
    tint: o.tint != null ? o.tint : 0,
    textureId,
    lifetimeMinSec: life.minSec,
    lifetimeMaxSec: life.maxSec,
    fadeToAlpha0: !!o.fadeToAlpha0,
    scale: resolveRange(o.scale, 1),
    alpha: resolveRange(o.alpha, 1),
    layerMask,
    hasSprite: o.scale != null || o.alpha != null,
    userData: o.userData != null ? o.userData >>> 0 : 0,
    color: o.color != null ? o.color >>> 0 : 0,
    vx: o.vx || 0,
    vy: o.vy || 0,
    omega: o.omega || 0,
  };
}

function enqueueEmitParams(resolved) {
  Box2dCommandRing.enqueueSetLiquidFunEmit(
    resolved.spacing,
    resolved.strength,
    resolved.tint,
    resolved.textureId,
    resolved.viscousScale,
    resolved.trackGroup,
    resolved.groupFlags,
  );
  if (resolved.lifetimeMaxSec > 0) {
    Box2dCommandRing.enqueueSetLiquidFunLifespan(
      resolved.lifetimeMinSec,
      resolved.lifetimeMaxSec,
      resolved.fadeToAlpha0,
    );
  }
  if (resolved.hasSprite) {
    const s = resolved.scale || { min: 1, max: 1 };
    const a = resolved.alpha || { min: 1, max: 1 };
    Box2dCommandRing.enqueueSetLiquidFunScale(
      s.min,
      s.max,
      a.min,
      a.max,
    );
  }
  if (resolved.lightIntensity > 0) {
    Box2dCommandRing.enqueueSetLiquidFunLight(resolved.lightIntensity);
  }
  Box2dCommandRing.enqueueSetLiquidFunLayers(resolved.layerMask);
  Box2dCommandRing.enqueueSetLiquidFunPayload(
    resolved.userData >>> 0,
    packedRgba(resolved.tint, resolved.color),
    resolved.vx || 0,
    resolved.vy || 0,
    resolved.omega || 0,
  );
}

function packedRgba(tint, color) {
  if (color) return color >>> 0;
  const t = tint >>> 0;
  if (!t) return 0;
  if ((t >>> 24) === 0) return (0xff000000 | t) >>> 0;
  return t;
}

let _groupsViews = null;
let _renderViews = null;
/** Last bindHeapPose payload — bindSabs must re-apply or getViews() falls back to thin SAB (no userData/groupIndex). */
let _heapPose = null;
/** Cached mix of HEAP pose + thin emit SAB — same object every getViews(). */
let _particleViews = null;
const _groupsScratch = [];

/**
 * LiquidFun particle physics (WASM / command ring). Separate from ParticleEmitter
 * (Weed CPU visual particles).
 */
export class LiquidFun {
  /** Called when scene allocates the groups SAB. Prefer bindSabs. */
  static bindGroupsSab(sab) {
    _groupsViews = sab ? bindLiquidFunGroups(sab, LIQUIDFUN_GROUPS_MAX) : null;
  }

  /**
   * Bind LiquidFun groups + thin emit SAB on this realm (main or any AbstractWorker).
   * HEAP pose (x/y/alpha/count) is bound later via bindHeapPose on box2dReady.
   * @param {{ groups?: SharedArrayBuffer|null, render?: SharedArrayBuffer|null, maxCount?: number }} opts
   */
  static bindSabs({ groups = null, render = null, maxCount = 0 } = {}) {
    _groupsViews = groups ? bindLiquidFunGroups(groups, LIQUIDFUN_GROUPS_MAX) : null;
    const n = maxCount | 0;
    _renderViews = render && n > 0 ? bindLiquidFunRender(render, n) : null;
    _particleViews = null;
    if (_heapPose) LiquidFun.bindHeapPose(_heapPose);
  }

  /** Unbind all LiquidFun views (scene teardown). */
  static unbindSabs() {
    _groupsViews = null;
    _renderViews = null;
    _particleViews = null;
    _heapPose = null;
  }

  /**
   * Bind live particle pose onto the WASM HEAP SAB (same pattern as Transform).
   * @param {{ sab: SharedArrayBuffer, countByteOffset: number, xByteOffset: number, yByteOffset: number, vxByteOffset?: number, vyByteOffset?: number, alphaByteOffset: number, weightByteOffset?: number, flagsByteOffset?: number, viscousScaleByteOffset?: number, groupIndexByteOffset?: number, userDataByteOffset?: number, colorByteOffset?: number, maxCount: number }} payload
   */
  static bindHeapPose(payload) {
    if (!payload?.sab || !(payload.maxCount > 0)) {
      _heapPose = null;
      if (_particleViews) {
        _particleViews.count = _renderViews?.count ?? null;
        _particleViews.x = _renderViews?.x ?? null;
        _particleViews.y = _renderViews?.y ?? null;
        _particleViews.vx = null;
        _particleViews.vy = null;
        _particleViews.alpha = _renderViews?.alpha ?? null;
        _particleViews.weight = null;
        _particleViews.flags = null;
        _particleViews.viscousScale = null;
        _particleViews.groupIndex = null;
        _particleViews.userData = null;
        _particleViews.color = null;
      }
      return;
    }
    _heapPose = payload;
    const sab = payload.sab;
    const n = payload.maxCount | 0;
    const count = new Int32Array(sab, payload.countByteOffset | 0, 1);
    const x = new Float32Array(sab, payload.xByteOffset | 0, n);
    const y = new Float32Array(sab, payload.yByteOffset | 0, n);
    const vx =
      payload.vxByteOffset > 0 ? new Float32Array(sab, payload.vxByteOffset | 0, n) : null;
    const vy =
      payload.vyByteOffset > 0 ? new Float32Array(sab, payload.vyByteOffset | 0, n) : null;
    const alpha =
      payload.alphaByteOffset > 0 ? new Float32Array(sab, payload.alphaByteOffset | 0, n) : null;
    const weight =
      payload.weightByteOffset > 0 ? new Float32Array(sab, payload.weightByteOffset | 0, n) : null;
    const flags =
      payload.flagsByteOffset > 0 ? new Uint32Array(sab, payload.flagsByteOffset | 0, n) : null;
    const viscousScale =
      payload.viscousScaleByteOffset > 0
        ? new Float32Array(sab, payload.viscousScaleByteOffset | 0, n)
        : null;
    const groupIndex =
      payload.groupIndexByteOffset > 0
        ? new Int32Array(sab, payload.groupIndexByteOffset | 0, n)
        : null;
    const userData =
      payload.userDataByteOffset > 0 ? new Uint32Array(sab, payload.userDataByteOffset | 0, n) : null;
    const color =
      payload.colorByteOffset > 0 ? new Uint32Array(sab, payload.colorByteOffset | 0, n) : null;
    _particleViews = LiquidFun._mergeParticleViews({
      count,
      x,
      y,
      vx,
      vy,
      alpha,
      weight,
      flags,
      viscousScale,
      groupIndex,
      userData,
      color,
      maxCount: n,
    });
  }

  static _mergeParticleViews(heap) {
    const thin = _renderViews;
    return {
      count: heap.count,
      x: heap.x,
      y: heap.y,
      vx: heap.vx || null,
      vy: heap.vy || null,
      alpha: heap.alpha || thin?.alpha || null,
      weight: heap.weight || null,
      flags: heap.flags || null,
      viscousScale: heap.viscousScale || null,
      groupIndex: heap.groupIndex || null,
      userData: heap.userData || null,
      color: heap.color || null,
      scaleX: thin?.scaleX || null,
      scaleY: thin?.scaleY || null,
      rotC: thin?.rotC || null,
      rotS: thin?.rotS || null,
      tint: thin?.tint || null,
      textureId: thin?.textureId || null,
      baseAlpha: thin?.baseAlpha || null,
      layerMask: thin?.layerMask || null,
      px: thin?.px || null,
      py: thin?.py || null,
      firstIndex: null,
      lastIndex: null,
      maxCount: heap.maxCount | 0,
    };
  }

  static getParticleCount() {
    return _particleViews.count[0]
  }

  /**
   * Zero-alloc particle views (HEAP pose + thin emit fields). Same object every call.
   * Live count = views.count[0]. Null until bindSabs (and ideally bindHeapPose) ran.
   */
  static getViews() {
    if (_particleViews) return _particleViews;
    if (_renderViews) {
      _particleViews = {
        count: _renderViews.count,
        x: _renderViews.x,
        y: _renderViews.y,
        vx: null,
        vy: null,
        alpha: _renderViews.alpha,
        weight: null,
        flags: null,
        viscousScale: null,
        groupIndex: null,
        userData: null,
        color: null,
        scaleX: _renderViews.scaleX,
        scaleY: _renderViews.scaleY,
        rotC: _renderViews.rotC,
        rotS: _renderViews.rotS,
        tint: _renderViews.tint,
        textureId: _renderViews.textureId,
        baseAlpha: _renderViews.baseAlpha,
        layerMask: _renderViews.layerMask,
        px: _renderViews.px,
        py: _renderViews.py,
        maxCount: _renderViews.maxCount,
      };
      return _particleViews;
    }
    return null;
  }

  /** @deprecated Prefer getViews() */
  static getParticleViews() {
    return LiquidFun.getViews();
  }

  /** Zero-alloc group SoA (including lightIntensity by id). Null until bindSabs. */
  static getGroupViews() {
    return _groupsViews;
  }

  static createSystem({ radius = 10, maxCount = 10000, subSteps = 1, systemId = 0, strictContactCheck = false } = {}) {
    Box2dCommandRing.enqueueCreateParticleSystem(systemId, radius, maxCount, subSteps, strictContactCheck);
  }

  static setTuning(tuning) {
    Box2dCommandRing.enqueueSetParticleTuning(tuning || {});
  }

  static setGroupViscousScale(groupId, scale) {
    Box2dCommandRing.enqueueSetGroupViscousScale(groupId, scale);
  }

  static joinParticleGroups(groupA, groupB) {
    Box2dCommandRing.enqueueJoinParticleGroups(groupA, groupB);
  }

  static splitParticleGroup(groupId) {
    Box2dCommandRing.enqueueSplitParticleGroup(groupId);
  }

  static applyForce(index, fx, fy) {
    Box2dCommandRing.enqueueParticleApplyForce(index, fx, fy);
  }

  static applyLinearImpulse(index, ix, iy) {
    Box2dCommandRing.enqueueParticleApplyImpulse(index, ix, iy);
  }

  static groupApplyForce(groupId, fx, fy) {
    Box2dCommandRing.enqueueGroupApplyForce(groupId, fx, fy);
  }

  static groupApplyLinearImpulse(groupId, ix, iy) {
    Box2dCommandRing.enqueueGroupApplyImpulse(groupId, ix, iy);
  }

  /**
   * Alive LiquidFun groups mirrored from the physics worker (≤1 step stale).
   * Reuses a scratch array — do not hold references across frames without copying.
   */
  static getGroups() {
    const v = _groupsViews;
    if (!v || !v.count) {
      _groupsScratch.length = 0;
      return _groupsScratch;
    }
    const n = v.count[0] | 0;
    const out = _groupsScratch;
    out.length = n;
    for (let i = 0; i < n; i++) {
      let g = out[i];
      if (!g) {
        g = {
          id: 0,
          particleCount: 0,
          viscousScale: 1,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          angularVelocity: 0,
          angle: 0,
          firstIndex: 0,
          lastIndex: 0,
          groupFlags: 0,
        };
        out[i] = g;
      }
      g.id = v.id[i] | 0;
      g.particleCount = v.particleCount[i] | 0;
      g.viscousScale = v.viscousScale[i];
      g.x = v.x[i];
      g.y = v.y[i];
      g.vx = v.vx[i];
      g.vy = v.vy[i];
      g.angularVelocity = v.angularVelocity[i];
      g.angle = v.angle[i];
      g.firstIndex = v.firstIndex ? v.firstIndex[i] | 0 : 0;
      g.lastIndex = v.lastIndex ? v.lastIndex[i] | 0 : 0;
      g.groupFlags = v.groupFlags ? v.groupFlags[i] | 0 : 0;
    }
    return out;
  }

  /** @deprecated Prefer getGroups() */
  static getParticleGroups() {
    return LiquidFun.getGroups();
  }

  /**
   * Emit box or circle particle group via command ring. Never CPU ParticleEmitter pool.
   * @param {Object} options — same fields as createParticleBox/Circle; `shape: 'box'|'circle'`
   */
  static emit(options) {
    if (options && options.shape === 'box') {
      LiquidFun.createParticleBox(options);
    } else {
      LiquidFun.createParticleCircle(options);
    }
  }

  static createParticleBox(options) {
    const r = resolveEmit(options);
    enqueueEmitParams(r);
    Box2dCommandRing.enqueueCreateParticleGroupBox(
      r.systemId,
      r.posX,
      r.posY,
      r.halfWidth,
      r.halfHeight,
      r.flags,
    );
  }

  static createParticleCircle(options) {
    const r = resolveEmit(options);
    enqueueEmitParams(r);
    Box2dCommandRing.enqueueCreateParticleGroupCircle(r.systemId, r.posX, r.posY, r.radius, r.flags);
  }

  static destroyGroup(groupId, systemId = 0) {
    Box2dCommandRing.enqueueDestroyParticleGroup(systemId, groupId);
  }

  static destroySystem(systemId = 0) {
    Box2dCommandRing.enqueueDestroyParticleSystem(systemId);
  }

  /** Remove all particles; keep the particle system (no remalloc / heap rebind). */
  static clear(systemId = 0) {
    Box2dCommandRing.enqueueClearLiquidFunParticles(systemId);
  }

  /** Sync QueryAABB (logic workers). Returns full hit count; fills `out` with particle indices. */
  static queryAABB(x0, y0, x1, y1, out) {
    return liquidFunQueryAABB(x0, y0, x1, y1, out);
  }

  /** Async QueryAABB (main thread). */
  static queryAABBAsync(x0, y0, x1, y1, out) {
    return liquidFunQueryAABBAsync(x0, y0, x1, y1, out);
  }

  /** Sync RayCast (logic workers). */
  static rayCast(x1, y1, x2, y2, out) {
    return liquidFunRayCast(x1, y1, x2, y2, out);
  }

  /** Async RayCast (main thread). */
  static rayCastAsync(x1, y1, x2, y2, out) {
    return liquidFunRayCastAsync(x1, y1, x2, y2, out);
  }

  static setUserData(index, bits) {
    Box2dCommandRing.enqueueSetParticleUserData(index, bits);
  }

  /** last exclusive, half-open. */
  static setUserDataRange(first, last, bits) {
    Box2dCommandRing.enqueueSetParticleUserDataRange(first, last, bits);
  }

  static setColor(index, rgba) {
    Box2dCommandRing.enqueueSetParticleColor(index, rgba);
  }

  /** last exclusive, half-open. */
  static setColorRange(first, last, rgba) {
    Box2dCommandRing.enqueueSetParticleColorRange(first, last, rgba);
  }

  static setFlags(index, bits) {
    Box2dCommandRing.enqueueSetParticleFlags(index, bits);
  }

  static setViscousScale(index, scale) {
    Box2dCommandRing.enqueueSetParticleViscousScale(index, scale);
  }

  /** last exclusive, half-open. */
  static setViscousScaleRange(first, last, scale) {
    Box2dCommandRing.enqueueSetParticleViscousScaleRange(first, last, scale);
  }

  static setGroupFlags(groupId, flags) {
    Box2dCommandRing.enqueueSetGroupFlags(groupId, flags);
  }

  static destroyParticle(index) {
    Box2dCommandRing.enqueueDestroyParticle(index);
  }

  static createParticle(options) {
    const o = options || {};
    Box2dCommandRing.enqueueSetLiquidFunPayload(
      o.userData != null ? o.userData >>> 0 : 0,
      packedRgba(o.tint, o.color),
      o.vx || 0,
      o.vy || 0,
      0,
    );
    Box2dCommandRing.enqueueCreateParticle(o.x, o.y, o.vx || 0, o.vy || 0, o.flags || 0);
  }

  /**
   * Pull live members out of a group into a new group. Indices invalid after.
   * Logic: sync (Atomics.wait). Main: extractAsync.
   * C always tracks the new group (`trackGroup` is ignored).
   * @returns {number} new group id, or -1
   */
  static extract(groupId, indices, count, opts) {
    return liquidFunExtract(groupId, indices, count, opts);
  }

  static extractAsync(groupId, indices, count, opts) {
    return liquidFunExtractAsync(groupId, indices, count, opts);
  }

  /** last exclusive. Total force is split across members. */
  static applyForceRange(first, last, fx, fy) {
    Box2dCommandRing.enqueueParticleApplyForceRange(first, last, fx, fy);
  }

  /** last exclusive. */
  static applyLinearImpulseRange(first, last, ix, iy) {
    Box2dCommandRing.enqueueParticleApplyImpulseRange(first, last, ix, iy);
  }
}
