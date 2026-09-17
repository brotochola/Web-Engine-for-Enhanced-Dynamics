import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, CollisionListener, enums } = WEED;
const { ShapeType } = enums;

/** Dynamic or static collider with CollisionListener so logic drains the contact ring. */
export class ContactDrainBody extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener];
  static tickInterval = 16;

  onSpawned({
    x = 0,
    y = 0,
    radius = 10,
    width = 24,
    height = 24,
    shape = 'circle',
    isStatic = false,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = isStatic ? 1 : 0;
    this.rigidBody.linearDamping = 0.05;
    this._hits = 0;
    this._stays = 0;
    this._exits = 0;

    if (shape === 'box') {
      this.collider.shapeType = ShapeType.Box;
      this.collider.width = width;
      this.collider.height = height;
      this.setScale(Math.max(width, height) / 14);
    } else {
      this.collider.shapeType = ShapeType.Circle;
      this.collider.radius = radius;
      this.setScale((radius * 2) / 14);
    }
    this.collider.visualRange = 0;
    this.collider.collisionLayer = 0;
    this.setSprite('ball');
    this.setAnchor(0.5, 0.5);
    this.setAlpha(isStatic ? 0.9 : 0.7);
  }

  onCollisionEnter() {
    this._hits++;
  }

  onCollisionStay() {
    this._stays++;
  }

  onCollisionExit() {
    this._exits++;
  }

  tick() {}
}
