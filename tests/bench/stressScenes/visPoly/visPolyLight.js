import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyLight extends GameObject {
  static components = [Collider, LightEmitter];

  setup() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.collider.visualRange = 900;
    this.lightEmitter.lightColor = 0xffffff;
    this.lightEmitter.lightIntensity = 400;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;
  }

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
  }
}
