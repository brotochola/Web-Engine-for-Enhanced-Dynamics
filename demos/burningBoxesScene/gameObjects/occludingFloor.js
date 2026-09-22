import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, LightOccluder, enums } = WEED;
const { ShapeType } = enums;

export class OccludingFloor extends GameObject {
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer, LightOccluder];

  onSpawned(spawnConfig = {}) {
    const config = spawnConfig || {};
    const width = config.width || 100;
    const height = config.height || 100;

    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.shapeType = ShapeType.Box;
    this.collider.friction = config.friction ?? 0.6;
    this.rigidBody.static = 1;
    this.rotation = config.rotation ?? 0;
    // Lights find this slab via their own range plus the collider half-extent.
    // visualRange 0 skips this body's neighbor walk (a 6800-wide floor would scan the world).
    this.collider.visualRange = 0;

    const sprite = config.sprite || 'box';
    this.setSprite(sprite);
    const origW = this.spriteRenderer.originalWidth || (sprite === 'box' ? 8 : 554);
    const origH = this.spriteRenderer.originalHeight || origW;
    this.setScale(width / origW, height / origH);
    this.setAnchor(0.5, 0.5);
    this.setTint(config.tint ?? (sprite === 'box' ? 0x666666 : 0xffffff));
    this.setAlpha(config.alpha ?? (sprite === 'box' ? 0.8 : 1));

    // const rx = config.repeatX != null ? config.repeatX : sprite === 'box' ? 0 : origW;
    // const ry = config.repeatY != null ? config.repeatY : sprite === 'box' ? 0 : origH;
    // this.spriteRenderer.repeatX = rx | 0;
    // this.spriteRenderer.repeatY = ry | 0;
  }
}
