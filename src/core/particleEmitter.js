// ParticleEmitter.js - Static API for emitting particles
// Used by game entities to spawn visual particle effects
// Particles are NOT GameObjects - they use ParticleComponent directly
//
// EXTENDS SharedAtomicPool for thread-safe free list management
//
// ═══════════════════════════════════════════════════════════════════════════
// SPAWN MODES
// ═══════════════════════════════════════════════════════════════════════════
//
// emit(config)         — heighted; screenY = y + z (topdown / iso)
// emitZenithal(config) — heighted; XY on floor, scale/alpha from -z
// emitFlat(config)     — no ground; XY + optional vy gravity; screenY = y
//
// Zenithal projection curve (zenithalMaxHeight / ScaleFactor / AlphaFade) is
// scene-level only — not per-emit params.
//
// ═══════════════════════════════════════════════════════════════════════════
// TEXTURE SPECIFICATION
// ═══════════════════════════════════════════════════════════════════════════
//
// Particles and decals can use ANY texture from the bigAtlas:
//
// 1. Static textures (from assets.textures):
//    emit({ texture: "blood" })
//    emit({ texture: "smoke" })
//
// 2. Prefixed animation names (uses first frame):
//    emit({ texture: "civil1_hurt" })
//    emit({ texture: "fire_burn" })
//
// 3. Specific frame names:
//    emit({ texture: "civil1_hurt_5" })
//    Decal.stamp({ texture: "civil1_hurt_5" })
//
// 4. Helper syntax for animation frames (recommended):
//    emit({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//    Decal.stamp({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//
// The helper syntax resolves to the frame name automatically.
// ═══════════════════════════════════════════════════════════════════════════

import { ParticleComponent } from '../components/particleComponent.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { SharedAtomicPool } from './sharedAtomicPool.js';
import { CAMERA_TYPES, PARTICLE_EASE } from '../util/configDefaults.js';
import { randomRange, randomColor, rng } from '../util/utils.js';
import { Layer } from './layer.js';
import { syncParticleFeed } from '../util/layerFeed.js';
import {
  PARTICLE_EASE_SHIFT,
  PARTICLE_TWEEN,
  resolveParticleOp,
  resolveParticleColorOp,
} from '../util/particleTween.js';
/** The emit's batch of acquired slots: 16-bit, or 32-bit for a pool past 65 535 slots (E-129). */
const ACQUIRE_BATCH_U16 = new Uint16Array(256);

export const DECAL_STAMPS_BLEND_MODE = Object.freeze({
  normal: 0,
  multiply: 1,
});

export class ParticleEmitter extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'ParticleEmitter';
  // E-129: 32-bit slot ids past 65 535 particles.
  static slotIdsFromMax = true;
  static _warnedPoolExhausted = false;
  static _opA = { from: 0, to: 0, tween: false, ease: 0 };
  static _opB = { from: 0, to: 0, tween: false, ease: 0 };

  // Hot-path scratches (per-worker module instance; emit is sync/non-reentrant)
  static _cfgScratch = Object.create(null);
  // Every key _spawn reads from cfg, plus `layer` / `layers` (read by
  // Layer.resolveSubscriptions). Every public emit path copies only these keys, so a
  // missing one is silently ignored (tests/node/particleEmitConfigKeys.test.js).
  static _cfgFieldList = [
    'count', 'flat', 'viewMode', 'texture', 'spritesheet', 'animation', 'frame', 'anim',
    'x', 'y', 'z', 'dirX', 'dirY', 'speed', 'spread', 'angleXY',
    'vx', 'vy', 'vz', 'lifespan', 'gravity',
    'scale', 'scaleX', 'scaleY', 'alpha', 'tint',
    'rotC', 'rotS', 'rotation', 'angularVelocity', 'flipX', 'flipY',
    'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact',
    'bounces', 'bounciness', 'bounceFriction',
    'blendMode', 'layer', 'layers', 'renderOnly', 'lightIntensity',
  ];
  static _alongLineScratch = Object.create(null);
  static _acquireBatch = ACQUIRE_BATCH_U16;
  static _topdownOverrides = { flat: 0, viewMode: CAMERA_TYPES.TOPDOWN };
  static _zenithalOverrides = { flat: 0, viewMode: CAMERA_TYPES.ZENITHAL };
  static _flatOverrides = {
    flat: 1,
    viewMode: CAMERA_TYPES.TOPDOWN,
    gravity: 0,
    z: 0,
    vz: 0,
  };
  /**
   * Initialize the emitter with particle pool size
   * Called during Scene buffer setup and again when workers bind SABs
   * @param {number} maxParticles - Number of particles in pool
   */
  static initialize(maxParticles) {
    // Call base class initialize with the count
    super.initialize(maxParticles);
    this._warnedPoolExhausted = false;
  }

  static initializeFreeList(freeListBuffer, freeListTopBuffer) {
    super.initializeFreeList(freeListBuffer, freeListTopBuffer);
    this._acquireBatch = this.freeList instanceof Uint32Array ? new Uint32Array(256) : ACQUIRE_BATCH_U16;
  }

  static returnToPool(index) {
    const i = index | 0;
    if (ParticleComponent.lightSqrt && ParticleComponent.lightSqrt[i]) {
      ParticleComponent.lightSqrt[i] = 0;
    }
    if (ParticleComponent.layerMask) {
      const old = ParticleComponent.layerMask[i] | 0;
      if (old) {
        ParticleComponent.layerMask[i] = 0;
        syncParticleFeed(i, old, 0);
      }
    }
    if (ParticleComponent.renderOnly && ParticleComponent.renderOnly[i]) {
      ParticleComponent.renderOnly[i] = 0;
      if (ParticleComponent.renderOnlyLive) Atomics.add(ParticleComponent.renderOnlyLive, 0, -1);
    }
    super.returnToPool(index);
  }

  /**
   * Heighted particles: drawn at screenY = y + z (topdown / side / iso), y-sorted by their ground row y.
   * @param {Object} config - Particle emission configuration
   * @returns {number} - Number of particles actually spawned
   */
  static emit(config) {
    return this._spawn(config, this._topdownOverrides);
  }

  /**
   * Heighted particles with zenithal presentation: XY on floor, scale/alpha from -z.
   * Projection curve comes from scene particle.zenithal* knobs.
   * @param {Object} config - Same shape as emit()
   * @returns {number} - Number of particles actually spawned
   */
  static emitZenithal(config) {
    return this._spawn(config, this._zenithalOverrides);
  }

  /**
   * Flat (screen-plane) particles: no ground plane, always integrate XY.
   * Gravity (px/frame², dtRatio ≈ 1 at 60fps) applies to vy. Floor flags ignored.
   * @param {Object} config - Same shape as emit(); floor flags are ignored by the worker
   * @returns {number} - Number of particles actually spawned
   */
  static emitFlat(config) {
    const o = this._flatOverrides;
    o.gravity = config.gravity ?? 0;
    return this._spawn(config, o);
  }

  /**
   * Flat particles sampled uniformly along segment (x0,y0)→(x1,y1).
   * Remaining fields match emitFlat(); each sample uses count: 1 at the lerped position.
   * @param {Object} config
   * @param {number} config.x0
   * @param {number} config.y0
   * @param {number} config.x1
   * @param {number} config.y1
   * @param {number|{min:number,max:number}} [config.count=8] - sample count along line
   * @returns {number}
   */
  static emitAlongLine(config) {
    const x0 = config.x0;
    const y0 = config.y0;
    const x1 = config.x1;
    const y1 = config.y1;
    const n = Math.max(1, Math.round(randomRange(config.count ?? 8, 8)));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const o = this._flatOverrides;
    o.gravity = config.gravity ?? 0;
    const bag = this._alongLineScratch;
    const fields = this._cfgFieldList;
    for (let f = 0; f < fields.length; f++) {
      const k = fields[f];
      bag[k] = config[k];
    }
    bag.count = 1;
    let spawned = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      bag.x = x0 + dx * t;
      bag.y = y0 + dy * t;
      spawned += this._spawn(bag, o);
    }
    return spawned;
  }

  /**
   * Merge config + overrides into reusable scratch (stable shape — see _cfgFieldList).
   * Assign each known field instead of delete-all + for-in (V8 dictionary mode).
   */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    const fields = this._cfgFieldList;
    for (let f = 0; f < fields.length; f++) {
      const k = fields[f];
      s[k] = config[k];
    }
    if (modeOverrides) {
      for (const k in modeOverrides) s[k] = modeOverrides[k];
    }
    return s;
  }

  /**
   * Shared spawn loop. modeOverrides merge over config (flat / viewMode / forced z etc).
   * @param {Object} config
   * @param {Object} modeOverrides
   * @returns {number}
   */
  static _spawn(config, modeOverrides) {
    if (!this.initialized) {
      return 0;
    }

    const cfg = modeOverrides ? this._mergeCfg(config, modeOverrides) : config;
    const flatMode = cfg.flat ? 1 : 0;
    const viewMode = cfg.viewMode ?? CAMERA_TYPES.TOPDOWN;

    const count = Math.round(randomRange(cfg.count, 1));
    let spawned = 0;
    const lightSqrt = ParticleComponent.lightSqrt;
    let lightSqrtConst = 0;
    let lightLo = 0;
    let lightHi = 0;
    let lightRange = false;
    const rawLight = cfg.lightIntensity;
    if (typeof rawLight === 'number') {
      if (Number.isFinite(rawLight) && rawLight > 0) lightSqrtConst = Math.sqrt(rawLight);
    } else if (rawLight && typeof rawLight === 'object') {
      const lo = +rawLight.min;
      const hi = +rawLight.max;
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= 0) {
        lightRange = true;
        lightLo = lo;
        lightHi = hi;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEXTURE RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════
    let textureId = 0;
    let textureName = cfg.texture;

    if (cfg.spritesheet && cfg.animation !== undefined && !Array.isArray(cfg.frame)) {
      textureName = SpriteSheetRegistry.getFrameName(
        cfg.spritesheet,
        cfg.animation,
        cfg.frame ?? 0
      );

      if (!textureName) {
        console.warn(
          `ParticleEmitter.emit: Could not resolve frame for ` +
          `spritesheet="${cfg.spritesheet}", animation="${cfg.animation}", frame=${cfg.frame ?? 0}`
        );
      }
    }

    if (textureName) {
      textureId = SpriteSheetRegistry.getTextureId(textureName);
    }

    const active = ParticleComponent.active;
    const x = ParticleComponent.x;
    const y = ParticleComponent.y;
    const z = ParticleComponent.z;
    const vx = ParticleComponent.vx;
    const vy = ParticleComponent.vy;
    const vz = ParticleComponent.vz;
    const lifespan = ParticleComponent.lifespan;
    const currentLife = ParticleComponent.currentLife;
    const gravity = ParticleComponent.gravity;
    const scaleX = ParticleComponent.scaleX;
    const scaleY = ParticleComponent.scaleY;
    const alpha = ParticleComponent.alpha;
    const tint = ParticleComponent.tint;
    const baseTint = ParticleComponent.baseTint;
    const particleTextureId = ParticleComponent.textureId;
    const fadeOnTheFloor = ParticleComponent.fadeOnTheFloor;
    const timeOnFloor = ParticleComponent.timeOnFloor;
    const initialAlpha = ParticleComponent.initialAlpha;
    const stayOnTheFloor = ParticleComponent.stayOnTheFloor;
    const despawnOnGroundContact = ParticleComponent.despawnOnGroundContact;
    const bounces = ParticleComponent.bounces;
    const bounciness = ParticleComponent.bounciness;
    const bounceFriction = ParticleComponent.bounceFriction;
    // Floor bounces: heighted particles only (emitFlat has no floor).
    const bouncing = !flatMode && cfg.bounces != null;
    const tweenMask = ParticleComponent.tweenMask;
    const easeIdArr = ParticleComponent.easeId;
    const easeIdsArr = ParticleComponent.easeIds;
    const alphaFrom = ParticleComponent.alphaFrom;
    const alphaTo = ParticleComponent.alphaTo;
    const scaleXFrom = ParticleComponent.scaleXFrom;
    const scaleXTo = ParticleComponent.scaleXTo;
    const scaleYFrom = ParticleComponent.scaleYFrom;
    const scaleYTo = ParticleComponent.scaleYTo;
    const tintFrom = ParticleComponent.tintFrom;
    const tintTo = ParticleComponent.tintTo;
    const rotFrom = ParticleComponent.rotFrom;
    const rotTo = ParticleComponent.rotTo;
    const angularVelFrom = ParticleComponent.angularVelFrom;
    const angularVelTo = ParticleComponent.angularVelTo;
    const hasAngularVel = ParticleComponent.hasAngularVel;
    const animCountArr = ParticleComponent.animCount;
    const animModeArr = ParticleComponent.animMode;
    const animFrames = ParticleComponent.animFrames;
    const rotC = ParticleComponent.rotC;
    const rotS = ParticleComponent.rotS;
    const flipX = ParticleComponent.flipX;
    const flipY = ParticleComponent.flipY;
    const blendMode = ParticleComponent.blendMode;
    const layerMask = ParticleComponent.layerMask;
    const subMask = Layer.resolveSubscriptions(cfg);
    const flat = ParticleComponent.flat;
    const viewModeArr = ParticleComponent.viewMode;
    if (!flat || !viewModeArr) {
      console.error(
        'ParticleEmitter._spawn: ParticleComponent schema missing — hard-reload after schema change'
      );
      return 0;
    }

    while (spawned < count) {
      const want = Math.min(count - spawned, this._acquireBatch.length);
      const got = this.acquireIndices(want, this._acquireBatch, 0);
      if (got <= 0) {
        break;
      }
      for (let b = 0; b < got; b++) {
      const i = this._acquireBatch[b];

      x[i] = randomRange(cfg.x);
      y[i] = randomRange(cfg.y);
      // P5: flat particles never read z (see particleIntegrate.js's flat branch) —
      // skip the write + randomRange call entirely.
      if (!flatMode) z[i] = randomRange(cfg.z, 0);

      let particleVx, particleVy;

      if (cfg.dirX != null && cfg.dirY != null && cfg.speed !== undefined) {
        // Unit dir + speed (+ optional spread radians) — no deg/atan2
        const speed = randomRange(cfg.speed, 0);
        let dx = cfg.dirX;
        let dy = cfg.dirY;
        if (cfg.spread != null) {
          const ang =
            typeof cfg.spread === 'number'
              ? (rng() * 2 - 1) * cfg.spread
              : randomRange(cfg.spread, 0);
          if (ang !== 0) {
            const sc = Math.cos(ang);
            const ss = Math.sin(ang);
            const rdx = dx * sc - dy * ss;
            const rdy = dx * ss + dy * sc;
            dx = rdx;
            dy = rdy;
          }
        }
        particleVx = dx * speed;
        particleVy = dy * speed;
      } else if (cfg.angleXY !== undefined && cfg.speed !== undefined) {
        const angleDeg = randomRange(cfg.angleXY, 0);
        const angleRad = (angleDeg * Math.PI) / 180;
        const speed = randomRange(cfg.speed, 0);

        particleVx = speed * Math.cos(angleRad);
        particleVy = speed * Math.sin(angleRad);
      } else {
        particleVx = randomRange(cfg.vx, 0);
        particleVy = randomRange(cfg.vy, 0);
      }

      vx[i] = particleVx;
      vy[i] = particleVy;
      // P5: flat particles never read vz either — skip the write.
      if (!flatMode) vz[i] = randomRange(cfg.vz, 0);

      lifespan[i] = randomRange(cfg.lifespan, 1000);
      currentLife[i] = 0;

      gravity[i] = cfg.gravity ?? 0.15;

      // Visual ops: number | {min,max} | {from,to[,ease]} (endpoints may nest {min,max}). Each tweened
      // property keeps its own ease (below).
      let mask = 0;
      let easeAlpha = 0;
      let easeScaleX = 0;
      let easeScaleY = 0;
      let easeTint = 0;
      let easeRot = 0;
      let easeAngVel = -1; // -1: angular velocity is not tweened

      if (cfg.scale == null && cfg.scaleX != null && cfg.scaleY != null) {
        const ox = resolveParticleOp(cfg.scaleX, 1, this._opA);
        const oy = resolveParticleOp(cfg.scaleY, 1, this._opB);
        scaleX[i] = ox.from;
        scaleY[i] = oy.from;
        scaleXFrom[i] = ox.from;
        scaleXTo[i] = ox.to;
        scaleYFrom[i] = oy.from;
        scaleYTo[i] = oy.to;
        if (ox.tween) { mask |= PARTICLE_TWEEN.SCALEX; easeScaleX = ox.ease; }
        if (oy.tween) { mask |= PARTICLE_TWEEN.SCALEY; easeScaleY = oy.ease; }
      } else {
        const os = resolveParticleOp(cfg.scale ?? cfg.scaleX ?? cfg.scaleY, 1, this._opA);
        scaleX[i] = os.from;
        scaleY[i] = os.from;
        scaleXFrom[i] = os.from;
        scaleXTo[i] = os.to;
        scaleYFrom[i] = os.from;
        scaleYTo[i] = os.to;
        if (os.tween) {
          mask |= PARTICLE_TWEEN.SCALEX | PARTICLE_TWEEN.SCALEY;
          easeScaleX = os.ease;
          easeScaleY = os.ease;
        }
      }

      const oa = resolveParticleOp(cfg.alpha, 1, this._opA);
      alpha[i] = oa.from;
      alphaFrom[i] = oa.from;
      alphaTo[i] = oa.to;
      if (oa.tween) { mask |= PARTICLE_TWEEN.ALPHA; easeAlpha = oa.ease; }

      const oc = resolveParticleColorOp(cfg.tint, 0xffffff, this._opA);
      tint[i] = oc.from;
      baseTint[i] = oc.from;
      tintFrom[i] = oc.from;
      tintTo[i] = oc.to;
      if (oc.tween) { mask |= PARTICLE_TWEEN.TINT; easeTint = oc.ease; }

      if (cfg.rotC != null && cfg.rotS != null) {
        rotC[i] = cfg.rotC;
        rotS[i] = cfg.rotS;
        rotFrom[i] = 0;
        rotTo[i] = 0;
      } else {
        const or = resolveParticleOp(cfg.rotation, 0, this._opA);
        const fromRad = (or.from * Math.PI) / 180;
        const toRad = (or.to * Math.PI) / 180;
        rotFrom[i] = fromRad;
        rotTo[i] = toRad;
        rotC[i] = Math.cos(fromRad);
        rotS[i] = Math.sin(fromRad);
        if (or.tween) { mask |= PARTICLE_TWEEN.ROT; easeRot = or.ease; }
      }

      if (cfg.angularVelocity != null) {
        const ov = resolveParticleOp(cfg.angularVelocity, 0, this._opA);
        const fromRad = (ov.from * Math.PI) / 180;
        angularVelFrom[i] = fromRad;
        angularVelTo[i] = ov.tween ? (ov.to * Math.PI) / 180 : fromRad;
        hasAngularVel[i] = 1;
        if (ov.tween) easeAngVel = ov.ease;
      } else {
        angularVelFrom[i] = 0;
        angularVelTo[i] = 0;
        hasAngularVel[i] = 0;
      }

      flipX[i] = cfg.flipX ? 1 : 0;
      flipY[i] = cfg.flipY ? 1 : 0;
      fadeOnTheFloor[i] = flatMode ? 0 : (cfg.fadeOnTheFloor ?? 0);
      timeOnFloor[i] = 0;
      initialAlpha[i] = 0;

      // One ease for every tweened property when they agree (the usual case: the kernel eases once);
      // otherwise MIXED_EASE, and easeIds holds each property's.
      let ease = -1;
      let mixed = false;
      if (mask & PARTICLE_TWEEN.ALPHA) ease = easeAlpha;
      if (mask & PARTICLE_TWEEN.SCALEX) { if (ease < 0) ease = easeScaleX; else if (easeScaleX !== ease) mixed = true; }
      if (mask & PARTICLE_TWEEN.SCALEY) { if (ease < 0) ease = easeScaleY; else if (easeScaleY !== ease) mixed = true; }
      if (mask & PARTICLE_TWEEN.TINT) { if (ease < 0) ease = easeTint; else if (easeTint !== ease) mixed = true; }
      if (mask & PARTICLE_TWEEN.ROT) { if (ease < 0) ease = easeRot; else if (easeRot !== ease) mixed = true; }
      if (easeAngVel >= 0) { if (ease < 0) ease = easeAngVel; else if (easeAngVel !== ease) mixed = true; }
      if (mixed) {
        mask |= PARTICLE_TWEEN.MIXED_EASE;
        easeIdsArr[i] =
          ((easeAlpha << PARTICLE_EASE_SHIFT.ALPHA) |
            (easeScaleX << PARTICLE_EASE_SHIFT.SCALEX) |
            (easeScaleY << PARTICLE_EASE_SHIFT.SCALEY) |
            (easeTint << PARTICLE_EASE_SHIFT.TINT) |
            (easeRot << PARTICLE_EASE_SHIFT.ROT) |
            ((easeAngVel < 0 ? 0 : easeAngVel) << PARTICLE_EASE_SHIFT.ANGULAR_VELOCITY)) >>> 0;
      } else {
        easeIdsArr[i] = 0;
      }
      tweenMask[i] = mask;
      easeIdArr[i] = ease < 0 ? PARTICLE_EASE.LERP : ease;

      animCountArr[i] = 0;
      animModeArr[i] = 0;

      if (Array.isArray(cfg.frame) && cfg.spritesheet && cfg.animation !== undefined) {
        const animBase = i * 8;
        const frames = cfg.frame;
        const n = Math.min(8, frames.length);
        let wrote = 0;
        for (let f = 0; f < n; f++) {
          const fname = SpriteSheetRegistry.getFrameName(cfg.spritesheet, cfg.animation, frames[f]);
          if (!fname) continue;
          animFrames[animBase + wrote] = SpriteSheetRegistry.getTextureId(fname);
          wrote++;
        }
        if (wrote > 1 && cfg.anim !== 'random') {
          animCountArr[i] = wrote;
          animModeArr[i] = 1;
          particleTextureId[i] = animFrames[animBase];
        } else if (wrote > 0) {
          const pick = wrote === 1 ? 0 : ((rng() * wrote) | 0);
          particleTextureId[i] = animFrames[animBase + pick];
        } else {
          particleTextureId[i] = textureId;
        }
      } else {
        particleTextureId[i] = textureId;
      }

      stayOnTheFloor[i] = flatMode ? 0 : (cfg.stayOnTheFloor ? 1 : 0);
      despawnOnGroundContact[i] = flatMode ? 0 : (cfg.despawnOnGroundContact ? 1 : 0);
      if (bouncing) {
        const n = Math.round(randomRange(cfg.bounces, 0));
        bounces[i] = n > 255 ? 255 : n > 0 ? n : 0;
        bounciness[i] = randomRange(cfg.bounciness, 0.5);
        bounceFriction[i] = randomRange(cfg.bounceFriction, 0.7);
      } else {
        bounces[i] = 0;
      }

      blendMode[i] = cfg.blendMode ?? DECAL_STAMPS_BLEND_MODE.normal;
      if (layerMask) {
        layerMask[i] = subMask;
        syncParticleFeed(i, 0, subMask);
      }

      flat[i] = flatMode;
      viewModeArr[i] = viewMode;
      if (ParticleComponent.renderOnly) {
        const on = cfg.renderOnly ? 1 : 0;
        ParticleComponent.renderOnly[i] = on;
        if (on && ParticleComponent.renderOnlyLive) Atomics.add(ParticleComponent.renderOnlyLive, 0, 1);
      }

      if (lightSqrt) {
        let s = lightSqrtConst;
        if (lightRange) {
          const v = lightLo + rng() * (lightHi - lightLo);
          s = v > 0 ? Math.sqrt(v) : 0;
        }
        lightSqrt[i] = s;
      }

      active[i] = 1;

      spawned++;
      }
    }

    if (spawned < count && !this._warnedPoolExhausted) {
      this._warnedPoolExhausted = true;
      console.warn(
        `ParticleEmitter.emit: pool exhausted; spawned ${spawned}/${count}. ` +
        'Increase particle.maxParticles.'
      );
    }

    return spawned;
  }

  /**
   * Reset all particle emitter state (extends parent reset)
   * Called when switching scenes to clear stale static state
   */
  static reset() {
    super.reset();
    this._warnedPoolExhausted = false;
    this._acquireBatch = ACQUIRE_BATCH_U16;
  }
}
