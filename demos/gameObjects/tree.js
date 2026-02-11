import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  RigidBody,
  ShadowCaster,
  ShapeType,
} = WEED;

export class Tree extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, SpriteRenderer, ShadowCaster];

  setup() {
    // this.rigidBody.static = 1;
    this.setSprite('tree' + (Math.random() > 0.5 ? 1 : 2));
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 12 * this.scale;
    this.collider.offsetY = -this.collider.radius * 0.5;

    this.collider.visualRange = this.collider.radius * 10

    this.shadowCaster.shadowRadius = this.collider.radius * 2;
    this.shadowCaster.height = 120 * this.scale;
  }

  onSpawned(spawnConfig = {}) { }
}
