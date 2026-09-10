import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

const HEAT = 1;

export class BurningBox extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.rigidBody.linearDamping = 0.01;
  }

  ignite() {
    this.setFeedBits(this.getFeedBits() | HEAT);
    return this;
  }

  extinguish() {
    this.setFeedBits(this.getFeedBits() & ~HEAT);
    return this;
  }

  onSpawned(spawnConfig = {}) {
    const config = spawnConfig || {};
    this.setSprite(config.sprite || 'box');

    const width = config.width || 100;
    const height = config.height || 100;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.friction = config.friction ?? 0.6;
    this.collider.visualRange = Math.hypot(width, height) / 2 + 200;

    const origW = this.spriteRenderer.originalWidth || 100;
    const origH = this.spriteRenderer.originalHeight || 100;
    this.setScale(width / origW, height / origH);
    this.setAnchor(0.5, 0.5);
    this.setTint(config.tint ?? 0xc68642);
    this.setAlpha(1);

    this.rigidBody.static = config.static ? 1 : 0;
    this.feedLayer('fire');
    if (config.startIgnited) this.ignite();
  }

  tick() {}
}
