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
//    stampDecal({ texture: "civil1_hurt_5" })
//
// 4. Helper syntax for animation frames (recommended):
//    emit({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//    stampDecal({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//
// The helper syntax resolves to the frame name automatically.
// ═══════════════════════════════════════════════════════════════════════════

import { ParticleComponent } from '../components/ParticleComponent.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { SharedAtomicPool } from './SharedAtomicPool.js';
import { CAMERA_TYPES, PARTICLE_EASE } from './ConfigDefaults.js';
import { randomRange, randomColor, rng } from './utils.js';
import { Layer } from './Layer.js';
import {
  PARTICLE_TWEEN,
  resolveParticleOp,
  resolveParticleColorOp,
} from './particleTween.js';
export const DECAL_STAMPS_BLEND_MODE = Object.freeze({
  normal: 0,
  multiply: 1,
});

export class ParticleEmitter extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'ParticleEmitter';
  static _warnedPoolExhausted = false;

  // Hot-path scratches (per-worker module instance; emit is sync/non-reentrant)
  static _cfgScratch = Object.create(null);
  static _topdownOverrides = { flat: 0, viewMode: CAMERA_TYPES.TOPDOWN };
  static _zenithalOverrides = { flat: 0, viewMode: CAMERA_TYPES.ZENITHAL };
  static _flatOverrides = {
    flat: 1,
    viewMode: CAMERA_TYPES.TOPDOWN,
    gravity: 0,
    z: 0,
    vz: 0,
  };
  static _stampScratch = Object.create(null);

  /**
   * Initialize the emitter with particle pool size
   * Called automatically by logic worker during init
   * @param {number} maxParticles - Number of particles in pool
   */
  static initialize(maxParticles) {
    // Call base class initialize with the count
    super.initialize(maxParticles);
    this._warnedPoolExhausted = false;
  }

  /**
   * Heighted particles: screenY = y + z (topdown / side / iso).
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
    const { x0, y0, x1, y1, count = 8, ...rest } = config;
    const n = Math.max(1, Math.round(randomRange(count, 8)));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const o = this._flatOverrides;
    o.gravity = rest.gravity ?? 0;
    let spawned = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      spawned += this._spawn(
        {
          ...rest,
          count: 1,
          x: x0 + dx * t,
          y: y0 + dy * t,
        },
        o
      );
    }
    return spawned;
  }

  /** Merge config + overrides into reusable scratch (clears stale keys). */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    for (const k in s) delete s[k];
    for (const k in config) s[k] = config[k];
    for (const k in modeOverrides) s[k] = modeOverrides[k];
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
    const tweenMask = ParticleComponent.tweenMask;
    const easeIdArr = ParticleComponent.easeId;
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
        'ParticleEmitter._spawn: ParticleComponent.flat/viewMode missing — hard-reload after schema change'
      );
      return 0;
    }

    while (spawned < count) {
      const i = this.acquireIndex();
      if (i < 0) {
        break;
      }

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

      // Visual ops: number | {min,max} | {from,to[,ease]} (endpoints may nest {min,max})
      let mask = 0;
      let ease = PARTICLE_EASE.LERP;

      if (cfg.scale == null && cfg.scaleX != null && cfg.scaleY != null) {
        const ox = resolveParticleOp(cfg.scaleX, 1);
        const oy = resolveParticleOp(cfg.scaleY, 1);
        scaleX[i] = ox.from;
        scaleY[i] = oy.from;
        scaleXFrom[i] = ox.from;
        scaleXTo[i] = ox.to;
        scaleYFrom[i] = oy.from;
        scaleYTo[i] = oy.to;
        if (ox.tween) { mask |= PARTICLE_TWEEN.SCALEX; ease = ox.ease; }
        if (oy.tween) { mask |= PARTICLE_TWEEN.SCALEY; ease = oy.ease; }
      } else {
        const os = resolveParticleOp(cfg.scale ?? cfg.scaleX ?? cfg.scaleY, 1);
        scaleX[i] = os.from;
        scaleY[i] = os.from;
        scaleXFrom[i] = os.from;
        scaleXTo[i] = os.to;
        scaleYFrom[i] = os.from;
        scaleYTo[i] = os.to;
        if (os.tween) {
          mask |= PARTICLE_TWEEN.SCALEX | PARTICLE_TWEEN.SCALEY;
          ease = os.ease;
        }
      }

      const oa = resolveParticleOp(cfg.alpha, 1);
      alpha[i] = oa.from;
      alphaFrom[i] = oa.from;
      alphaTo[i] = oa.to;
      if (oa.tween) { mask |= PARTICLE_TWEEN.ALPHA; ease = oa.ease; }

      const oc = resolveParticleColorOp(cfg.tint, 0xffffff);
      tint[i] = oc.from;
      baseTint[i] = oc.from;
      tintFrom[i] = oc.from;
      tintTo[i] = oc.to;
      if (oc.tween) { mask |= PARTICLE_TWEEN.TINT; ease = oc.ease; }

      if (cfg.rotC != null && cfg.rotS != null) {
        rotC[i] = cfg.rotC;
        rotS[i] = cfg.rotS;
        rotFrom[i] = 0;
        rotTo[i] = 0;
      } else {
        const or = resolveParticleOp(cfg.rotation, 0);
        rotFrom[i] = or.from;
        rotTo[i] = or.to;
        const rad = (or.from * Math.PI) / 180;
        rotC[i] = Math.cos(rad);
        rotS[i] = Math.sin(rad);
        if (or.tween) { mask |= PARTICLE_TWEEN.ROT; ease = or.ease; }
      }

      if (cfg.angularVelocity != null) {
        const ov = resolveParticleOp(cfg.angularVelocity, 0);
        angularVelFrom[i] = ov.from;
        angularVelTo[i] = ov.tween ? ov.to : ov.from;
        hasAngularVel[i] = 1;
        if (ov.tween) ease = ov.ease;
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

      tweenMask[i] = mask;
      easeIdArr[i] = ease;

      animCountArr[i] = 0;
      animModeArr[i] = 0;
      const animBase = i * 8;
      for (let f = 0; f < 8; f++) animFrames[animBase + f] = 0;

      if (Array.isArray(cfg.frame) && cfg.spritesheet && cfg.animation !== undefined) {
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

      blendMode[i] = cfg.blendMode ?? DECAL_STAMPS_BLEND_MODE.normal;
      if (layerMask) layerMask[i] = subMask;

      flat[i] = flatMode;
      viewModeArr[i] = viewMode;

      active[i] = 1;

      spawned++;
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
   * Stamp a decal directly onto the floor tilemap.
   * Convenience wrapper that creates an "instant stamp" particle.
   *
   * @param {Object} config - Decal configuration
   * @returns {number} - Number of decals actually spawned
   */
  static stampDecal(config) {
    const s = this._stampScratch;
    for (const k in s) delete s[k];
    for (const k in config) s[k] = config[k];
    s.z = 0;
    s.lifespan = 100;
    s.stayOnTheFloor = true;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.gravity = 1;
    s.flat = 0;
    s.viewMode = CAMERA_TYPES.TOPDOWN;
    return this._spawn(s, null);
  }

  /**
   * Reset all particle emitter state (extends parent reset)
   * Called when switching scenes to clear stale static state
   */
  static reset() {
    super.reset();
    this._warnedPoolExhausted = false;
  }
}
