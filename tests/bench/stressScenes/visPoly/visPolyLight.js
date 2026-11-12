import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyLight extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.collider.visualRange = 900;
    this.lightEmitter.color = 0xffffff;
    this.lightEmitter.radius = 200;
    this.lightEmitter.active = 1;
    this.x = x;
    this.y = y;
  }
}
