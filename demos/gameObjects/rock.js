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

  onSpawned(spawnConfig = {}) { }
}
