import WEED from '/src/index.js';
import { ParticleEmitter } from '../../src/index.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  ShadowCaster,
  ShapeType,
} = WEED;

export class Tree extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    // this.rigidBody.static = 1;
    const whichTree = Math.random() > 0.5 ? 1 : 2;
    this.setSprite('tree' + whichTree);
    const scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? scale : -scale, scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * scale;
    // this.collider.offsetY = -this.collider.radius * 0.5;
    this.spriteRenderer.anchorY = 0.95;
    this.spriteRenderer.anchorX = 0.45;

    this.collider.visualRange = this.collider.radius * 10

    // Shadow uses default heightMultiplier = 1 (matches sprite scale)
  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    // const count = Math.floor(damage * 8) + 3;
    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * radius) + radius * 0.5,
      x: hitX + (Math.random() * radius - radius * 0.5),
      y: hitY + (Math.random() * radius - radius * 0.5),
      z: - Math.random() * 40,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 8 },
      rotation: { min: 0, max: 360 },
      vz: -Math.random() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 1 },
      texture: '_whiteCircle',
      tint: { min: 0x4A3728, max: 0xC4A484 },
      alpha: 1,
      stayOnTheFloor: true,

    });
  }

  onSpawned(spawnConfig = {}) { }
}
