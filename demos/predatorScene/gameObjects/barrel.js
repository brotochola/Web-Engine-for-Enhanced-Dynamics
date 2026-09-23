import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  ShadowCaster,
  RigidBody,
  ParticleEmitter,
  randomColor,
  Flash,
  SoundManager,
  rng,
  enums,
} = WEED;
const { ShapeType } = enums;

export class Barrel extends GameObject {

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, RigidBody, ShadowCaster];

  setup() {
    this.rigidBody.linearDamping = 0.8;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;
    this.rigidBody.linearDamping = 10;
    this.collider.visualRange = 50;
    this.setFixedRotation(1);
  }

  onSpawned(spawnConfig = {}) {
    this.setSprite('barrel' + Math.floor(rng() * 3 + 1));
    this.setScale(1);
  }

  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = rng() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.6, 0.85, 1.15, 0, 0, hitX, hitY);

    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(rng() * radius) + radius * 0.5,
      x: hitX,
      y: hitY,
      z: - rng() * this.spriteRenderer.originalHeight,
      angleXY: { min: 0, max: 360 },
      speed: { min: radius * 0.2, max: radius * 0.4 },
      rotation: { min: 0, max: 360 },
      vz: -rng() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 0.5 },
      texture: '_whiteCircle',
      tint: { min: 0xffff00, max: 0xffbb00 },
      alpha: { min: 0.8, max: 1 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

    this.addVelocity((hitX - this.x) * 60, (hitY - this.y) * 60);

    Flash.spawn({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      intensity: rng() * 1000 + 1000,
      hasGlowSprite: 1,
    });
  }

  tick(dtRatio) {
    // Solo loggear la primera TallLight para no spamear
    // console.log(
    //   `House[${this.index}] neighbors: ${this.neighborCount}, visualRange: ${this.collider.visualRange}, active: ${this.collider.active}`
    // );
  }
}
