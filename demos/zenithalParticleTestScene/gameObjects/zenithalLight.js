import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class ZenithalLight extends GameObject {

  static components = [Collider, LightEmitter];

  onSpawned(spawnConfig = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 1;
    this.collider.visualRange = 700;

    this.lightEmitter.color = 0xffffff;
    this.lightEmitter.radius = 1732;
    this.lightEmitter.active = 1;
    this.lightEmitter.glow = 0.6;
  
  }
}
