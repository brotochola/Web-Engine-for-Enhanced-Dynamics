import WEED from '/src/index.js';

const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  ShadowCaster,
  enums,
  rng,
} = WEED;
const { ShapeType } = enums;

const TREE_COUNT = 18;

export class CityTree extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];
  static treeCount = TREE_COUNT;

  setup() {
    this.rigidBody.static = 1;
    const n = 1 + ((rng() * TREE_COUNT) | 0);
    const id = n < 10 ? `0${n}` : `${n}`;
    this.setSprite(`tree_${id}`);

    this.spriteRenderer.anchorY = 0.95;
    this.spriteRenderer.anchorX = 0.45;
  }

  onSpawned(spawnConfig = {}) {
    const radius = spawnConfig.radius ?? 18;
    const scale = Math.max(0.6, radius / 18);
    this.setScale(rng() > 0.5 ? scale : -scale, scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = radius;
    this.collider.visualRange = radius * 10;
  }

  tick() {}
}
