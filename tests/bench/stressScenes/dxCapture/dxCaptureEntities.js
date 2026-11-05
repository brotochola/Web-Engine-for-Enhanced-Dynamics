import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

/** A still sprite that casts shadows. */
export class DxCaptureProp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 16;
    this.collider.visualRange = 64;
    this.setSprite(config.texture || 'barrel1');
    this.setScale(config.scale || 2);
  }
}

/** A still point light. */
export class DxCaptureLamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.collider.visualRange = 400;
    this.lightEmitter.lightColor = config.color ?? 0xffcc88;
    this.lightEmitter.lightIntensity = config.intensity ?? 20000;
  }
}
