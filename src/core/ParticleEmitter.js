// ParticleEmitter.js - Static API for emitting particles
// Used by game entities to spawn visual particle effects
// Particles are NOT GameObjects - they use ParticleComponent directly
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
import { randomRange, randomColor } from './utils.js';

export const DECAL_STAMPS_BLEND_MODE = {
  normal: 0,
  multiply: 1,
};

export class ParticleEmitter {
  // Particle pool size (set during initialization)
  static maxParticles = 0;
  static initialized = false;

  /**
   * Initialize the emitter with particle pool size
   * Called automatically by logic worker during init
   * @param {number} maxParticles - Number of particles in pool
   */
  static initialize(maxParticles) {
    this.maxParticles = maxParticles;
    this.initialized = true;
    console.log(
      `ParticleEmitter: Initialized with ${maxParticles} particles (indices 0-${maxParticles - 1})`
    );
  }

  /**
   * Emit particles with the given configuration.
   *
   * TEXTURE OPTIONS:
   * - Use `texture` for direct texture/frame names
   * - Use `spritesheet` + `animation` + `frame` to specify an animation frame
   *
   * @param {Object} config - Particle emission configuration
   * @param {number} [config.count=1] - Number of particles to emit
   * @param {number|{min,max}} config.x - X position or range
   * @param {number|{min,max}} config.y - Y position or range
   * @param {number|{min,max}} [config.z=0] - Z position (height) or range
   * @param {number|{min,max}} [config.angleXY] - Velocity angle in degrees (0=right, 90=down). Use with speed.
   * @param {number|{min,max}} [config.speed] - Velocity magnitude. Use with angleXY.
   * @param {number|{min,max}} [config.vx=0] - X velocity or range (ignored if angleXY/speed provided)
   * @param {number|{min,max}} [config.vy=0] - Y velocity or range (ignored if angleXY/speed provided)
   * @param {number|{min,max}} [config.vz=0] - Z velocity or range
   * @param {number|{min,max}} [config.lifespan=1000] - Lifetime in ms or range
   * @param {number} [config.gravity=0.15] - Gravity strength
   * @param {string} [config.texture] - Texture name (from bigAtlas). Can be:
   *   - Static texture: "blood", "smoke"
   *   - Prefixed animation: "civil1_hurt" (uses first frame)
   *   - Specific frame: "civil1_hurt_5"
   * @param {string} [config.spritesheet] - Spritesheet name for frame resolution (e.g., "civil1")
   * @param {string} [config.animation] - Animation name for frame resolution (e.g., "hurt")
   * @param {number} [config.frame=0] - Frame index within animation (0 = first, -1 = last)
   * @param {number|{min,max}} [config.tint=0xFFFFFF] - Color tint or range (RGB channels interpolated separately)
   * @param {number|{min,max}} [config.scale=1] - Scale or range
   * @param {number|{min,max}} [config.alpha=1] - Alpha (opacity) or range
   * @param {number} [config.fadeOnTheFloor=0] - Time in ms to fade out particles when they hit the floor
   * @param {boolean} [config.stayOnTheFloor=false] - If true, particle stamps a decal on floor and despawns immediately
   * @param {boolean} [config.despawnOnGroundContact=false] - If true, particle despawns immediately when touching the ground (no decal stamping)
   * @returns {number} - Number of particles actually spawned
   *
   * @example
   * // Using direct texture name
   * ParticleEmitter.emit({
   *   count: 10,
   *   x: this.x,
   *   y: this.y,
   *   texture: "blood",
   *   angleXY: { min: 0, max: 360 },
   *   speed: { min: 1, max: 3 },
   * });
   *
   * @example
   * // Using spritesheet + animation + frame (for specific animation frame)
   * ParticleEmitter.emit({
   *   count: 1,
   *   x: this.x,
   *   y: this.y,
   *   spritesheet: "civil1",
   *   animation: "hurt",
   *   frame: -1,  // Last frame of hurt animation
   *   stayOnTheFloor: true,  // Stamp as decal
   * });
   */
  /**
   * Stamp a decal directly onto the floor tilemap.
   * Convenience wrapper that creates an "instant stamp" particle.
   *
   * TEXTURE OPTIONS:
   * - Use `texture` for direct texture/frame names
   * - Use `spritesheet` + `animation` + `frame` to specify an animation frame
   *
   * @param {Object} config - Decal configuration
   * @param {number|{min,max}} config.x - X position or range
   * @param {number|{min,max}} config.y - Y position or range
   * @param {string} [config.texture] - Texture name (from bigAtlas). Can be:
   *   - Static texture: "blood", "burn_mark"
   *   - Prefixed animation: "civil1_hurt" (uses first frame)
   *   - Specific frame: "civil1_hurt_5"
   * @param {string} [config.spritesheet] - Spritesheet name for frame resolution (e.g., "civil1")
   * @param {string} [config.animation] - Animation name for frame resolution (e.g., "hurt")
   * @param {number} [config.frame=0] - Frame index within animation (0 = first, -1 = last)
   * @param {number|{min,max}} [config.scale=1] - Scale or range
   * @param {number|{min,max}} [config.scaleX] - X scale (overrides scale if provided)
   * @param {number|{min,max}} [config.scaleY] - Y scale (overrides scale if provided)
   * @param {number|{min,max}} [config.alpha=1] - Alpha (opacity) or range
   * @param {number|{min,max}} [config.tint=0xFFFFFF] - Color tint or range
   * @param {number|{min,max}} [config.rotation=0] - Rotation in degrees or range
   * @param {number} [config.count=1] - Number of decals to stamp
   * @returns {number} - Number of decals actually spawned
   *
   * @example
   * // Stamp a static texture
   * ParticleEmitter.stampDecal({
   *   x: this.x,
   *   y: this.y,
   *   texture: "burn_mark",
   *   scale: { min: 0.8, max: 1.2 },
   *   rotation: { min: 0, max: 360 },
   *   alpha: 0.9,
   * });
   *
   * @example
   * // Stamp the last frame of an animation (e.g., dead body)
   * ParticleEmitter.stampDecal({
   *   x: this.x,
   *   y: this.y,
   *   spritesheet: "civil1",
   *   animation: "hurt",
   *   frame: -1,  // Last frame
   *   scaleX: this.spriteRenderer.scaleX,
   *   scaleY: this.spriteRenderer.scaleY,
   *   tint: this.spriteRenderer.baseTint,
   * });
   */
  static stampDecal(config) {
    return this.emit({
      ...config,
      z: 0,
      lifespan: 100,
      stayOnTheFloor: true,
      vx: 0,
      vy: 0,
      vz: 0,
      gravity: 1,
    });
  }

  static emit(config) {
    if (!this.initialized) {
      console.warn('ParticleEmitter.emit() called before initialization');
      return 0;
    }

    const count = Math.round(randomRange(config.count, 1));
    let spawned = 0;

    // ═══════════════════════════════════════════════════════════════════════
    // TEXTURE RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════
    // Two ways to specify a texture:
    //
    // 1. Direct name (config.texture):
    //    - "blood" → static texture
    //    - "civil1_hurt" → prefixed animation (first frame)
    //    - "civil1_hurt_5" → specific frame name
    //
    // 2. Helper params (config.spritesheet + config.animation + config.frame):
    //    - { spritesheet: "civil1", animation: "hurt", frame: -1 }
    //    - Resolves to "civil1_hurt_5" (last frame)
    // ═══════════════════════════════════════════════════════════════════════
    let textureId = 0;
    let textureName = config.texture;

    // If helper params provided, resolve to frame name first
    if (config.spritesheet && config.animation !== undefined) {
      textureName = SpriteSheetRegistry.getFrameName(
        config.spritesheet,
        config.animation,
        config.frame ?? 0
      );

      if (!textureName) {
        console.warn(
          `ParticleEmitter.emit: Could not resolve frame for ` +
          `spritesheet="${config.spritesheet}", animation="${config.animation}", frame=${config.frame ?? 0}`
        );
      }
    }

    // Resolve texture name to numeric ID
    if (textureName) {
      textureId = SpriteSheetRegistry.getTextureId(textureName);
    }

    // Cache array references for performance
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
    const tweenToAlpha0 = ParticleComponent.tweenToAlpha0;
    const rotation = ParticleComponent.rotation;
    const flipX = ParticleComponent.flipX;
    const flipY = ParticleComponent.flipY;
    const blendMode = ParticleComponent.blendMode;

    // Scan for inactive particles (indices 0 to maxParticles-1)
    for (let i = 0; i < this.maxParticles && spawned < count; i++) {
      if (active[i] === 0) {
        // Position
        x[i] = randomRange(config.x);
        y[i] = randomRange(config.y);
        z[i] = randomRange(config.z, 0);

        // Velocity
        let particleVx, particleVy;

        if (config.angleXY !== undefined && config.speed !== undefined) {
          // Polar mode: angleXY (degrees) + speed
          const angleDeg = randomRange(config.angleXY, 0);
          const angleRad = (angleDeg * Math.PI) / 180;
          const speed = randomRange(config.speed, 0);

          particleVx = speed * Math.cos(angleRad);
          particleVy = speed * Math.sin(angleRad);
        } else {
          // Cartesian mode: vx/vy ranges
          particleVx = randomRange(config.vx, 0);
          particleVy = randomRange(config.vy, 0);
        }

        vx[i] = particleVx;
        vy[i] = particleVy;
        vz[i] = randomRange(config.vz, 0);

        // Lifecycle
        lifespan[i] = randomRange(config.lifespan, 1000);
        currentLife[i] = 0;

        // Physics
        gravity[i] = config.gravity ?? 0.15;

        // Visual properties
        // Support both uniform scale and independent scaleX/scaleY
        const uniformScale = randomRange(config.scale, 1);
        scaleX[i] =
          config.scaleX !== undefined ? randomRange(config.scaleX, uniformScale) : uniformScale;
        scaleY[i] =
          config.scaleY !== undefined ? randomRange(config.scaleY, uniformScale) : uniformScale;
        alpha[i] = randomRange(config.alpha, 1);
        const particleColor = randomColor(config.tint);
        tint[i] = particleColor;
        baseTint[i] = particleColor; // Store original color for lighting calculation
        particleTextureId[i] = textureId;

        // Rotation (convert degrees to radians) and flipping
        const rotationDeg = randomRange(config.rotation, 0);
        rotation[i] = (rotationDeg * Math.PI) / 180;
        flipX[i] = config.flipX ? 1 : 0;
        flipY[i] = config.flipY ? 1 : 0;
        fadeOnTheFloor[i] = config.fadeOnTheFloor ?? 0;
        timeOnFloor[i] = 0;

        // Alpha tweening: fade from initial alpha to 0 over lifespan
        tweenToAlpha0[i] = config.tweenToAlpha0 ? 1 : 0;
        initialAlpha[i] = config.tweenToAlpha0 ? alpha[i] : 0;

        // Blood decal system: if true, particle stamps decal on floor hit and despawns
        stayOnTheFloor[i] = config.stayOnTheFloor ? 1 : 0;

        // Ground despawn: if true, particle despawns immediately on ground contact (no decal)
        despawnOnGroundContact[i] = config.despawnOnGroundContact ? 1 : 0;

        // Decal blend mode: 0 = normal (alpha over), 1 = multiply
        blendMode[i] = config.blendMode ?? DECAL_STAMPS_BLEND_MODE.normal;

        spawned++;
        // Claim this particle
        active[i] = 1;
      }
    }

    return spawned;
  }
}
