import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

const BLOW = 8;

export class Blower extends GameObject {
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(spawnConfig = {}) {
    const config = spawnConfig || {};
    const width = config.width || 70;
    const height = config.height || 48;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.shapeType = ShapeType.Box;
    this.collider.friction = 0.4;
    this.collider.visualRange = Math.hypot(width, height) / 2 + 80;
    this.rigidBody.static = 1;
    this.rotation = config.rotation ?? 0;

    this.setSprite(config.sprite || '_white');
    const origW = this.spriteRenderer.originalWidth || 8;
    const origH = this.spriteRenderer.originalHeight || origW;
    this.setScale(width / origW, height / origH);
    this.setAnchor(0.5, 0.5);
    this.setTint(config.tint ?? 0x7ec8e3);
    this.setAlpha(1);

    this.setLayer('fire');
    this.setFeedBits(BLOW);
  }

  tick() {}
}
