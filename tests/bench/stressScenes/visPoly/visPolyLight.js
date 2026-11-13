import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyLight extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.lightEmitter.shadowRange = 900; // the occluders it gathers (the light reaches 200): the scene's load
    this.lightEmitter.color = 0xffffff;
    this.lightEmitter.radius = 200;
    this.lightEmitter.active = 1;
    this.x = x;
    this.y = y;
  }
}
