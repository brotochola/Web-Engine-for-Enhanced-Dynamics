import { ShadowCaster } from '../../src/components/ShadowCaster.js';
import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  randomColor,
  ShapeType,
  Flash,
  ParticleEmitter,
} = WEED;

export class House extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter];

  setup() {
    // Override Boid's physics properties for prey behavior
    // this.rigidBody.maxVel = 0;
    // this.rigidBody.static = 1; // Static body - nothing can move it
    const type = Math.random() > 0.5 ? 1 : 2;
    this.setSprite('house' + type);

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 180;
    this.collider.height = 110;
    this.collider.offsetY = -50;
    this.collider.offsetX = 0;
    this.lightEmitter.lightColor = 0xffffaa;

    this.lightEmitter.height = 100;
    this.lightEmitter.lightIntensity = 4000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;

    this.setScale(1, 1);
    this.collider.visualRange = 300;

  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    const count = Math.floor(damage * 8) + 3;
    ParticleEmitter.emit({
      count,
      texture: 'square',
      x: hitX,
      y: hitY,
      z: -20,
      angleXY: { min: 0, max: 360 },
      speed: { min: 1.5, max: 4 },
      vz: { min: 2, max: 6 },
      lifespan: { min: 400, max: 800 },
      gravity: 0.35,
      scale: { min: 0.15, max: 0.4 },
      alpha: { min: 0.7, max: 1 },
      tint: { min: 0xffff00, max: 0xffffff },
      rotation: { min: 0, max: 360 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

    Flash.create({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      intensity: 5000,
      hasGlowSprite: 1,
    });
  }

  onSpawned(spawnConfig = {}) { }

  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  tick(dtRatio) {
    // Solo loggear la primera TallLight para no spamear
    // console.log(
    //   `House[${this.index}] neighbors: ${this.neighborCount}, visualRange: ${this.collider.visualRange}, active: ${this.collider.active}`
    // );
  }
}
