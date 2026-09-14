import WEED from '/src/index.js';

const { GameObject, ParticleEmitter } = WEED;

// Big initial burst + a steady trickle top-up so a large heighted population
// stays airborne (falling under gravity) for most of the measurement window,
// stressing PARTICLE_PHYSICS_MS / BUILD_ACTIVE_VISIBLE_MS / ACTIVE_PARTICLES.
// NOTE: ParticleEmitter._spawn treats `gravity` as a plain scalar (cfg.gravity ?? 0.15,
// see src/core/particleEmitter.js), NOT a {min,max} range like x/y/z/vx/vy/vz/lifespan/scale.
const INITIAL_BURST = 15000;
const TOPUP_PER_TICK = 150;
const GRAVITY = 0.08;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 64;

/** Emits a large heighted population (gravity + despawnOnGroundContact) once, then trickles. */
export class ParticleIntegrateDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ seed = 0xc0de1234 } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._seed = seed >>> 0;
    this._rng = this._mulberry32(this._seed);
    this._sink = 0;
    this._burstDone = false;
  }

  _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  tick() {
    // Deferred to first tick (not onSpawned) so ParticleEmitter's shared free list is
    // guaranteed ready in this worker context — same lazy-init pattern as RayStressDriver.
    if (!this._burstDone) {
      this._burstDone = true;
      this._sink += ParticleEmitter.emit({
        count: INITIAL_BURST,
        x: { min: MARGIN, max: WORLD_W - MARGIN },
        y: { min: MARGIN, max: WORLD_H - MARGIN },
        z: { min: -2000, max: -300 },
        vx: { min: -15, max: 15 },
        vy: { min: -15, max: 15 },
        vz: { min: -2, max: 2 },
        gravity: GRAVITY,
        despawnOnGroundContact: true,
        lifespan: { min: 8000, max: 20000 },
        scale: { min: 0.4, max: 1 },
      });
    }

    const rng = this._rng;
    const cx = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
    const cy = MARGIN + rng() * (WORLD_H - 2 * MARGIN);

    this._sink += ParticleEmitter.emit({
      count: TOPUP_PER_TICK,
      x: { min: cx - 200, max: cx + 200 },
      y: { min: cy - 200, max: cy + 200 },
      z: { min: -2000, max: -300 },
      vx: { min: -15, max: 15 },
      vy: { min: -15, max: 15 },
      vz: { min: -2, max: 2 },
      gravity: GRAVITY,
      despawnOnGroundContact: true,
      lifespan: { min: 8000, max: 20000 },
      scale: { min: 0.4, max: 1 },
    });
  }
}
