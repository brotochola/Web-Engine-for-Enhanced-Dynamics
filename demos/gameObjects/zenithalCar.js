import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, RigidBody, ShadowCaster, enums } = WEED;
const { ShapeType } = enums;

export class ZenithalCar extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [Collider, SpriteRenderer, RigidBody, ShadowCaster];

  setup() {
    this.setSprite('zenithal_car');

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 22;
    this.collider.visualRange = 100;

    this.rigidBody.maxVel = 3;
    this.rigidBody.friction = 0.9;
    this.setAnchor(0.5, 0.5)

    this.shadowCaster.heightMultiplier = 1.5;
  }

  onSpawned(spawnConfig = {}) { }
}
