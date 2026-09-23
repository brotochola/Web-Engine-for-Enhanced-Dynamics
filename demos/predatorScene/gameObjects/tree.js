import WEED from '/src/index.js';
import { ParticleEmitter } from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  ShadowCaster,
  enums, rng,
  CameraInOutListener,
} = WEED;
const { ShapeType } = enums;

export class Tree extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    // const count = Math.floor(damage * 8) + 3;
    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(rng() * radius) + radius * 0.5,
      x: hitX + (rng() * radius - radius * 0.5),
      y: hitY + (rng() * radius - radius * 0.5),
      z: - rng() * 40,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 8 },
      rotation: { min: 0, max: 360 },
      vz: -rng() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 1 },
      texture: '_whiteCircle',
      tint: { min: 0x4A3728, max: 0xC4A484 },
      alpha: 1,
      stayOnTheFloor: true,

    });
  }

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    const factor = this.scaleY * 0.005
    // this.rotation = factor * Math.sin(accumulatedTime * factor * 0.33 + this.index);
  }

  onSpawned(spawnConfig = {}) {
    this.rigidBody.static = 1;
    const whichTree = rng() > 0.5 ? 1 : 2;
    this.setSprite('tree' + whichTree);
    const scale = rng() * 0.5 + 1;
    this.setScale(rng() > 0.5 ? scale : -scale, scale);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * scale;
    this.spriteRenderer.anchorY = 0.95;
    this.spriteRenderer.anchorX = 0.45;
    this.collider.visualRange = this.collider.radius * 10;
  }

}
