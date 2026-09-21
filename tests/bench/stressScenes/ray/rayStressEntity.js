import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

/** Static collider + RigidBody obstacle for Ray vs Box2D stress (circle or box). */
export class RayStressEntity extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  static tickInterval = 16;

  onSpawned({
    x = 0,
    y = 0,
    shape = 'circle',
    radius = 12,
    width = 24,
    height = 24,
    collisionLayer = 0,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;

    this.rigidBody.static = 1;

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
    this.collider.visualRange = 64;
    this.collider.collisionLayer = collisionLayer;

    this.setSprite('ball');
    this.setAnchor(0.5, 0.5);
    this.setAlpha(0.75);
  }

  tick() {
    // Static obstacles — driver owns the ray workload.
  }
}
