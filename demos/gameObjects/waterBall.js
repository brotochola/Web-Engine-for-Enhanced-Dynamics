import WEED from '/src/index.js';

const { GameObject, Mouse, RigidBody, Collider, SpriteRenderer, mixTint } = WEED;

const BASE_WATER_TINT = 0x0000aa;
const SPLASH_TINT = 0xffffff;

class WaterBall extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() { }

  onSpawned(spawnConfig = {}) {
    this.rigidBody.maxVel = 80;
    this.rigidBody.maxAcc = 8;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.02

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    this.setSprite('_lightGradient');
    this.setLayer('water');
    this.setTint(BASE_WATER_TINT);
    this.setAlpha(0.9);

    // Small collider + larger visual = dense packing with lots of gradient overlap.
    // Physics prevents co-location; the metaball shader merges overlapping gradients
    // into a smooth continuous surface.
    const colliderRadius = 10;
    this.collider.radius = colliderRadius;
    this.collider.visualRange = colliderRadius * 8;

    RigidBody.mass[this.index] *= 2;
    RigidBody.invMass[this.index] = 1 / (RigidBody.mass[this.index] || 1);

    this.setScale(5);
  }

  tick(dtRatio) {
    const speedFactor = Math.min(1, (this.rigidBody.speed) / (this.rigidBody.maxVel));
    const tint = mixTint(BASE_WATER_TINT, SPLASH_TINT, speedFactor);

    this.setTint(tint);
    // this.setTint(0x000077)
    this.setAlpha(0.4 + speedFactor * 0.6);

    if (Mouse.isButton1Down) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 40000) return;
      this.addAcceleration(dx * 0.2, dy * 0.2);
    }
  }

  onCollisionEnter(otherIndex) {
    const rb = RigidBody
    const otherSpeed = rb.speed[otherIndex]
    const mySpeed = rb.speed[this.index]

    const difVelX = rb.vx[otherIndex] - rb.vx[this.index]
    const difVelY = rb.vy[otherIndex] - rb.vy[this.index]
    const difVel = difVelX + difVelY
    const energy = difVel * rb.mass[otherIndex]
    const energyRatio = energy / 10000

    if (energyRatio < 3) return

    ParticleEmitter.emit({
      count: Math.floor(energyRatio * 0.5),
      x: this.x,
      y: this.y,
      z: -this.radius,
      texture: '_whiteCircle',
      alpha: { min: 0.25, max: 0.5 },
      scale: { min: 0.66, max: 2 },
      lifespan: { min: 500, max: 4000 },
      angleXY: { min: -180, max: 0 },
      speed: { min: mySpeed, max: otherSpeed },
      gravity: 0.7,
      vz: -energyRatio * 0.1 - 0.01,
      despawnOnGroundContact: true,
      tweenToAlpha0: true,

    });

  }
}

export { WaterBall };
