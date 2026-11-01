import WEED from '/src/index.js';

const { GameObject, ParticleEmitter, PARTICLE_EASE: E } = WEED;

// Big initial burst + a steady trickle top-up so a large heighted population
// stays airborne (falling under gravity) for most of the measurement window,
// stressing PARTICLE_PHYSICS_MS / BUILD_ACTIVE_VISIBLE_MS / ACTIVE_PARTICLES.
// NOTE: ParticleEmitter._spawn treats `gravity` as a plain scalar (cfg.gravity ?? 0.15,
// see src/core/particleEmitter.js), NOT a {min,max} range like x/y/z/vx/vy/vz/lifespan/scale.
const INITIAL_BURST = 60000;
const TOPUP_PER_TICK = 4000;
const GRAVITY = 0.08;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 64;
// `tween` (scene `?tween=1`, E-59): every particle fades and shrinks over its
// life, one ease per particle, so the integrate loop runs the ease each step.
// `spin` (scene `?spin=1`, E-80): every particle also turns (a rotation tween
// and an angular velocity) and changes colour (a tint tween), so the integrate
// runs its sin/cos and the tint lerp per particle: more particle-worker load.
const EASES = [E.LERP, E.QUAD_OUT, E.CUBIC_IN, E.QUAD_INOUT, E.EXPO_OUT, E.BACK_IN, E.BOUNCE_OUT];

/** Emits a large heighted population (gravity + despawnOnGroundContact) once, then trickles. */
export class ParticleIntegrateDriver extends GameObject {
  static components = [];

  onSpawned({ seed = 0xc0de1234, tween = 0, spin = 0 } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._seed = seed >>> 0;
    this._rng = this._mulberry32(this._seed);
    this._sink = 0;
    this._burstDone = false;
    this._tween = tween | 0;
    this._spin = spin | 0;
    this._ticks = 0;
  }

  /** Spawn-time scale, or a fade-and-shrink tween with the given ease; with spin, turning and tinting too. */
  _look(ease) {
    const look = this._tween
      ? { scale: { from: { min: 0.4, max: 1 }, to: 0.2, ease }, alpha: { from: 1, to: 0, ease } }
      : { scale: { min: 0.4, max: 1 }, alpha: undefined };
    look.rotation = this._spin ? { from: { min: 0, max: 360 }, to: { min: -360, max: 720 }, ease } : undefined;
    look.angularVelocity = this._spin ? { from: -90, to: 90, ease } : undefined;
    look.tint = this._spin ? { from: 0xff2040, to: 0x20ff80, ease } : undefined;
    return look;
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
      const chunks = this._tween || this._spin ? EASES.length : 1;
      for (let k = 0; k < chunks; k++) {
        const look = this._look(EASES[k]);
        this._sink += ParticleEmitter.emit({
          count: Math.floor(INITIAL_BURST / chunks),
          x: { min: MARGIN, max: WORLD_W - MARGIN },
          y: { min: MARGIN, max: WORLD_H - MARGIN },
          z: { min: -2000, max: -300 },
          vx: { min: -15, max: 15 },
          vy: { min: -15, max: 15 },
          vz: { min: -2, max: 2 },
          gravity: GRAVITY,
          despawnOnGroundContact: true,
          lifespan: { min: 8000, max: 20000 },
          scale: look.scale,
          alpha: look.alpha,
          rotation: look.rotation,
          angularVelocity: look.angularVelocity,
          tint: look.tint,
        });
      }
    }

    const rng = this._rng;
    const cx = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
    const cy = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
    const look = this._look(EASES[this._ticks++ % EASES.length]);

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
      scale: look.scale,
      alpha: look.alpha,
      rotation: look.rotation,
      angularVelocity: look.angularVelocity,
      tint: look.tint,
    });
  }
}
