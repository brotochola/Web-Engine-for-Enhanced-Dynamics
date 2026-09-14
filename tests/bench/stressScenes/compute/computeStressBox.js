import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

/** Fed collider for ComputeStressScene (no tick work). */
export class ComputeStressBox extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer];
  static tickInterval = 16;

  onSpawned({
    x = 0,
    y = 0,
    width = 24,
    height = 24,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.visualRange = 64;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setScale(Math.max(width, height) / 14);
    this.setAlpha(0.7);
    this.setLayer('sim');
  }

  tick() {}
}
