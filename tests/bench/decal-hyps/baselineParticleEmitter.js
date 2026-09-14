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
// emitFlat(config)     — no ground; always integrate XY; screenY = y
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
import { CAMERA_TYPES } from './ConfigDefaults.js';
import { randomRange, randomColor, rng } from './utils.js';

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

  // Alias for backwards compatibility
  static get maxParticles() {
    return this.maxCount;
  }

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
   * @param {Object} config - Same shape as emit(); floor flags are ignored by the worker
   * @returns {number} - Number of particles actually spawned
   */
  static emitFlat(config) {
    const o = this._flatOverrides;
    o.gravity = config.gravity ?? 0;
    return this._spawn(config, o);
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

    if (cfg.spritesheet && cfg.animation !== undefined) {
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
    const rotC = ParticleComponent.rotC;
    const rotS = ParticleComponent.rotS;
    const flipX = ParticleComponent.flipX;
    const flipY = ParticleComponent.flipY;
    const blendMode = ParticleComponent.blendMode;
    const layerId = ParticleComponent.layerId;
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
      z[i] = randomRange(cfg.z, 0);

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
      vz[i] = randomRange(cfg.vz, 0);

      lifespan[i] = randomRange(cfg.lifespan, 1000);
      currentLife[i] = 0;

      gravity[i] = cfg.gravity ?? 0.15;

      const uniformScale = randomRange(cfg.scale, 1);
      scaleX[i] =
        cfg.scaleX !== undefined ? randomRange(cfg.scaleX, uniformScale) : uniformScale;
      scaleY[i] =
        cfg.scaleY !== undefined ? randomRange(cfg.scaleY, uniformScale) : uniformScale;
      alpha[i] = randomRange(cfg.alpha, 1);
      const particleColor = randomColor(cfg.tint);
      tint[i] = particleColor;
      baseTint[i] = particleColor;
      particleTextureId[i] = textureId;

      if (cfg.rotC != null && cfg.rotS != null) {
        rotC[i] = cfg.rotC;
        rotS[i] = cfg.rotS;
      } else if (cfg.rotation == null) {
        rotC[i] = 1;
        rotS[i] = 0;
      } else {
        const rotationDeg = randomRange(cfg.rotation, 0);
        if (rotationDeg === 0) {
          rotC[i] = 1;
          rotS[i] = 0;
        } else {
          const rotationRad = (rotationDeg * Math.PI) / 180;
          rotC[i] = Math.cos(rotationRad);
          rotS[i] = Math.sin(rotationRad);
        }
      }
      flipX[i] = cfg.flipX ? 1 : 0;
      flipY[i] = cfg.flipY ? 1 : 0;
      fadeOnTheFloor[i] = flatMode ? 0 : (cfg.fadeOnTheFloor ?? 0);
      timeOnFloor[i] = 0;

      tweenMask[i] = 0;
      easeId[i] = 0;

      stayOnTheFloor[i] = flatMode ? 0 : (cfg.stayOnTheFloor ? 1 : 0);
      despawnOnGroundContact[i] = flatMode ? 0 : (cfg.despawnOnGroundContact ? 1 : 0);

      blendMode[i] = cfg.blendMode ?? DECAL_STAMPS_BLEND_MODE.normal;
      layerId[i] = cfg.layerId ?? 0;

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
