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

/** house_01 … house_63. */
const houseSprite = (n) => (n < 10 ? `house_0${n}` : `house_${n}`);

export class CityHouse extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, LightEmitter, RigidBody];
  static houseCount = HOUSE_COUNT;

  // The house's picture, picked in the editor (levels/city.scene.json); empty, its seed picks one of the 63.
  static spawnParams = {
    sprite: { value: '', type: 'sprite', tip: 'The house; empty: one of the 63, from its seed (🎲 for another)' },
  };

  onSpawned(params) {
    this.rigidBody.static = 1;
    const n = 1 + ((rng() * HOUSE_COUNT) | 0); // drawn either way, so a draw after it stays the same
    this.setSprite(params.sprite || houseSprite(n));

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
