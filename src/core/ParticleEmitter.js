// ParticleEmitter.js - Static API for emitting particles
// Used by game entities to spawn visual particle effects
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { randomRange, randomColor } from "./utils.js";

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
      `ParticleEmitter: Initialized with ${maxParticles} particles (indices 0-${
        maxParticles - 1
      })`
    );
  }

  /**
   * Emit particles with the given configuration
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
   * @param {string} config.texture - Texture name (from bigAtlas)
   * @param {number|{min,max}} [config.tint=0xFFFFFF] - Color tint or range (RGB channels interpolated separately)
   * @param {number|{min,max}} [config.scale=1] - Scale or range
   * @param {number|{min,max}} [config.alpha=1] - Alpha (opacity) or range
   * @param {number} [config.fadeOnTheFloor=0] - Time in ms to fade out particles when they hit the floor
   * @param {boolean} [config.stayOnTheFloor=false] - If true, particle stamps a decal on floor and despawns immediately
   * @returns {number} - Number of particles actually spawned
   *
   * @example
   * // Polar mode (recommended for circular spread)
   * ParticleEmitter.emit({
   *   count: 10,
   *   x: this.x,
   *   y: this.y,
   *   z: -30,
   *   angleXY: { min: 0, max: 360 },  // full circle
   *   speed: { min: 1, max: 3 },
   *   vz: { min: -3, max: -1 },
   *   lifespan: { min: 800, max: 1200 },
   *   gravity: 0.15,
   *   texture: "blood",
   * });
   *
   * @example
   * // Cartesian mode (square distribution)
   * ParticleEmitter.emit({
   *   count: 10,
   *   x: this.x,
   *   y: this.y,
   *   vx: { min: -2, max: 2 },
   *   vy: { min: -1, max: 1 },
   *   texture: "spark",
   * });
   */
  static emit(config) {
    if (!this.initialized) {
      console.warn("ParticleEmitter.emit() called before initialization");
      return 0;
    }

    const count = Math.round(randomRange(config.count, 1));
    let spawned = 0;

    // Resolve texture name to textureId (frame index in bigAtlas)
    let textureId = 0;
    if (config.texture) {
      // Get frame index from bigAtlas
      textureId =
        SpriteSheetRegistry.getAnimationIndex("bigAtlas", config.texture) ?? 0;
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
    const scale = ParticleComponent.scale;
    const alpha = ParticleComponent.alpha;
    const tint = ParticleComponent.tint;
    const baseTint = ParticleComponent.baseTint;
    const particleTextureId = ParticleComponent.textureId;
    const fadeOnTheFloor = ParticleComponent.fadeOnTheFloor;
    const timeOnFloor = ParticleComponent.timeOnFloor;
    const initialAlpha = ParticleComponent.initialAlpha;
    const stayOnTheFloor = ParticleComponent.stayOnTheFloor;

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
        scale[i] = randomRange(config.scale, 1);
        alpha[i] = randomRange(config.alpha, 1);
        const particleColor = randomColor(config.tint);
        tint[i] = particleColor;
        baseTint[i] = particleColor; // Store original color for lighting calculation
        particleTextureId[i] = textureId;
        fadeOnTheFloor[i] = config.fadeOnTheFloor ?? 0;
        timeOnFloor[i] = 0;
        initialAlpha[i] = 0;

        // Blood decal system: if true, particle stamps decal on floor hit and despawns
        stayOnTheFloor[i] = config.stayOnTheFloor ? 1 : 0;

        spawned++;
        // Claim this particle
        active[i] = 1;
      }
    }

    return spawned;
  }
}
