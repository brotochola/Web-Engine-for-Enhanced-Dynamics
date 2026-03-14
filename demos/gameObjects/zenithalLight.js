import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class ZenithalLight extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, LightEmitter];

  setup() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 1;
    this.collider.visualRange = 700;

    this.lightEmitter.lightColor = 0xffffff;
    this.lightEmitter.lightIntensity = 30000;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
  }

  onSpawned(spawnConfig = {}) { }
}
