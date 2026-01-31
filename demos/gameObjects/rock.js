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
    this.collider.radius = 22 * this.scale;
    this.collider.offsetY = -this.collider.radius;

    this.collider.visualRange = 0;

    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = this.collider.radius * 3;
  }

  onSpawned(spawnConfig = {}) {}
}
