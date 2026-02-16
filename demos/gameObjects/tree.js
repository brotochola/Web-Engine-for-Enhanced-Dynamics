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

  onSpawned(spawnConfig = {}) { }
}
