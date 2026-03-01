import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,

  ShadowCaster,
  RigidBody,
  ShapeType,
  ParticleEmitter,
  randomColor,
  Flash,

} = WEED;

export class Barrel extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, RigidBody, ShadowCaster];

  setup() {
    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 2;
    this.rigidBody.friction = 0.8;
    this.setSprite('barrel' + Math.floor(Math.random() * 3 + 1));

    this.setScale(Math.random() > 0.5 ? 1 : 1);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;

    this.collider.visualRange = 50;

    // Shadow uses default heightMultiplier = 1 (matches sprite scale)
  }

  onSpawned(spawnConfig = {}) { }

  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {

    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * radius) + radius * 0.5,
      x: hitX,
      y: hitY,
      z: - Math.random() * this.spriteRenderer.originalHeight,
      angleXY: { min: 0, max: 360 },
      speed: { min: radius * 0.2, max: radius * 0.4 },
      rotation: { min: 0, max: 360 },
      vz: -Math.random() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 0.5 },
      texture: '_whiteCircle',
      tint: { min: 0xffff00, max: 0xffbb00 },
      alpha: { min: 0.8, max: 1 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

    this.addAcceleration(hitX - this.x, hitY - this.y);

    Flash.create({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      intensity: Math.random() * 1000 + 1000,
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
