import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

/** Dynamic ball pile to saturate Box2D under L2 busy-physics A/B. */
export class RayStressBusyBall extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  static tickInterval = 16;

  onSpawned({ x = 0, y = 0, radius = 10 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.05;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = radius;
    this.collider.visualRange = radius * 3;
    // Distinct layer so ray drivers can skip busy pile if desired.
    this.collider.collisionLayer = 7;
    this.setSprite('ball');
    this.setAnchor(0.5, 0.5);
    this.setScale((radius * 2) / 14);
    this.setAlpha(0.55);
  }

  tick() {}
}
