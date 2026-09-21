import WEED from '/src/index.js';

const {
  GameObject, Collider, SpriteRenderer, RigidBody, LightOccluder,
  LIGHT_OCCLUDER_MASK_SPRITE, enums,
} = WEED;
const { ShapeType } = enums;

export class ZenithalCar extends GameObject {

  static components = [Collider, SpriteRenderer, RigidBody, LightOccluder];

  setup() {
    this.setSprite('zenithal_car');

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 63;
    this.collider.height = 160;
    this.collider.visualRange = 100;

    this.rigidBody.linearDamping = 0.9;
    this.setAnchor(0.5, 0.5);
    // this.lightOccluder.maskMode = LIGHT_OCCLUDER_MASK_SPRITE
  }

  onSpawned(spawnConfig = {}) { }
}
