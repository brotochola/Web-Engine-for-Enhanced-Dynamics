import WEED from '/src/index.js';

const {
  GameObject,
  Mouse,
  RigidBody,
  Collider,
  CollisionListener,
  SpriteRenderer,
  ParticleEmitter,
  Transform,
  mixTint,
} = WEED;

const BASE_WATER_TINT = 0x0033ff;
const SPLASH_TINT = 0xbbeeff;
/** Tint scale only — world `physics.maximumLinearSpeed` clamps velocity. */
const WATER_SPEED_REF = 7200;
/** Particle worker still integrates in frame units (~px/frame @ 60Hz). Box2D vel is px/s. */
const PX_PER_FRAME = 60;
/** Ignore soft contacts (px/s relative). */
const SPLASH_SPEED_MIN = 350;
/** Relative speed that maps to full splash intensity (px/s). */
const SPLASH_SPEED_FULL = 3500;

class WaterBall extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, CollisionListener, SpriteRenderer];

  setup() { }

  onSpawned(spawnConfig = {}) {
    this.rigidBody.linearDamping = 0.02

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    this.setSprite('_lightGradient');
    this.setLayer('water');
    this.setTint(BASE_WATER_TINT);
    this.setAlpha(0.9);

    // Small collider + larger visual = dense packing with lots of gradient overlap.
    // Physics prevents co-location; the metaball shader merges overlapping gradients
    // into a smooth continuous surface.
    const colliderRadius = 20;
    this.collider.radius = colliderRadius;
    this.collider.visualRange = colliderRadius * 6;

    RigidBody.mass[this.index] *= 0.1;
    RigidBody.invMass[this.index] = 1 / (RigidBody.mass[this.index] || 1);

    this.setScale(this.collider.radius * 0.5);
    this.setAlpha(0.33)
    this.setTint(BASE_WATER_TINT)
  }

  tick(dtRatio) {
    const speedFactor = Math.min(1, (this.rigidBody.speed) / WATER_SPEED_REF);
    const tint = mixTint(BASE_WATER_TINT, SPLASH_TINT, speedFactor * 0.25);

    // this.setTint(tint);

    // this.setAlpha(0.4 + speedFactor * 0.1);

    if (Mouse.isButton1Down) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 360000) return;
      const force = 3600000 / dist2;
      this.addAcceleration(dx * force, dy * force);
    }
  }

  onCollisionEnter(otherIndex) {
    if (WaterBall.entityType == Transform.entityType[otherIndex]) return;

    const rb = RigidBody;
    const i = this.index;
    const relVx = rb.vx[otherIndex] - rb.vx[i];
    const relVy = rb.vy[otherIndex] - rb.vy[i];
    const impactSpeed = Math.hypot(relVx, relVy); // px/s
    if (impactSpeed < SPLASH_SPEED_MIN) return;

    // Mass-weighted intensity so heavy boxes splash more than light taps.
    const massFactor = Math.min(3, Math.sqrt(Math.max(1, rb.mass[otherIndex]) / 2000));
    const intensity = Math.min(1.4, ((impactSpeed - SPLASH_SPEED_MIN) / (SPLASH_SPEED_FULL - SPLASH_SPEED_MIN)) * massFactor);

    const invImpact = 1 / impactSpeed;
    const dirX = relVx * invImpact;
    const dirY = relVy * invImpact;
    const fanRad = ((55 + intensity * 70) * Math.PI) / 180;
    // Convert impact to particle frame-speed — punchy spray.
    const spray = Math.min(28, Math.max(6, (impactSpeed / PX_PER_FRAME) * 0.85));
    const r = this.radius;

    // Main droplets — big, bright, long arc (dir + spread, no atan2→deg).
    ParticleEmitter.emit({
      count: Math.floor(18 + intensity * 55),
      x: this.x,
      y: this.y,
      z: -r * (0.6 + rng() * 0.8),
      texture: '_whiteCircle',
      tint: { min: 0x66aaff, max: 0xffffff },
      alpha: { from: { min: 0.55, max: 1 }, to: 0 },
      scale: { min: 0.55, max: 1.6 + intensity * 1.4 },
      lifespan: { min: 500, max: 1400 + intensity * 1200 },
      dirX,
      dirY,
      spread: fanRad,
      speed: { min: spray * 0.55, max: spray },
      gravity: 0.55,
      vz: { min: -(3 + intensity * 8), max: -(1 + intensity * 3) },
      despawnOnGroundContact: true,
    });

    // Fine mist — dense cloud around hit.
    ParticleEmitter.emit({
      count: Math.floor(14 + intensity * 40),
      x: this.x,
      y: this.y,
      z: -r * 0.4,
      texture: '_whiteCircle',
      tint: { min: 0xaaccff, max: 0xffffff },
      alpha: { from: { min: 0.35, max: 0.75 }, to: 0 },
      scale: { min: 0.25, max: 0.85 },
      lifespan: { min: 350, max: 900 + intensity * 600 },
      angleXY: { min: 0, max: 360 },
      speed: { min: spray * 0.25, max: spray * 0.75 },
      gravity: 0.28,
      vz: { min: -(1.5 + intensity * 4), max: -0.4 },
      despawnOnGroundContact: true,

    });
  }
}

export { WaterBall };
