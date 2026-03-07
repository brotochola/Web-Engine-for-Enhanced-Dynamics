import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  ShadowCaster,
  ShapeType,
  SoundManager,
} = WEED;

export class Rock extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    this.setSprite('rock' + Math.floor(Math.random() * 4 + 1));
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = this.spriteRenderer.originalWidth * 0.4 * this.scale;
    // this.collider.offsetY = -this.collider.radius;

    this.collider.visualRange = 0;

    this.shadowCaster.heightMultiplier = 2
    this.shadowCaster.anchorOffsetY = 0.17

    this.spriteRenderer.anchorY = 0.66
    this.spriteRenderer.anchorX = 0.5

    // Shadow uses default heightMultiplier = 1 (matches sprite scale)
  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = Math.random() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.55, 0.85, 1.12);

    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: 10 + Math.random() * 10,
      x: hitX,
      y: hitY,
      z: - Math.random() * this.spriteRenderer.originalHeight,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 4 },
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

  }

  onSpawned(spawnConfig = {}) { }
}
