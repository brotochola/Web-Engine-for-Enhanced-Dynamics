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

  // A scene file's tree sets its radius (levels/city.scene.json); the scale follows it.
  static spawnParams = {
    radius: { value: 18, min: 4, max: 80, step: 0.5, tip: 'Collider radius; the sprite scales with it' },
  };

  onSpawned(params) {
    this.rigidBody.static = 1;
    const n = 1 + ((rng() * TREE_COUNT) | 0);
    const id = n < 10 ? `0${n}` : `${n}`;
    this.setSprite(`tree_${id}`);

    this.spriteRenderer.anchorY = 0.95;
    this.spriteRenderer.anchorX = 0.45;
    const radius = params.radius;
    const scale = Math.max(0.6, radius / 18);
    this.setScale(rng() > 0.5 ? scale : -scale, scale);

    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = radius;
    this.collider.visualRange = radius * 10;
  }

  tick() {}
}
