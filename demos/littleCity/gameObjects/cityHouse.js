import WEED from '/src/index.js';

const {
  GameObject,
  Collider,
  SpriteRenderer,
  LightEmitter,
  RigidBody,
  enums,
  rng,
} = WEED;
const { ShapeType } = enums;

const HOUSE_COUNT = 63;

export class CityHouse extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, LightEmitter, RigidBody];
  static houseCount = HOUSE_COUNT;

  onSpawned(spawnConfig = {}) {
    this.rigidBody.static = 1;
    const n = 1 + ((rng() * HOUSE_COUNT) | 0);
    const id = n < 10 ? `0${n}` : `${n}`;
    this.setSprite(`house_${id}`);

    // objects JSON footprint ~293×262; collider sits toward the base
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 200;
    this.collider.height = 110;
    this.collider.offsetY = -50;
    this.collider.offsetX = 0;
    this.collider.visualRange = 300;

    this.lightEmitter.lightColor = 0xffffaa;
    this.lightEmitter.height = 100;
    this.lightEmitter.lightIntensity = 4000;
    this.lightEmitter.active = 0;
    this.lightEmitter.hasGlowSprite = 0;

    this.setScale(1, 1);
  
  }

  onDespawned() {}

  tick() {}
}
