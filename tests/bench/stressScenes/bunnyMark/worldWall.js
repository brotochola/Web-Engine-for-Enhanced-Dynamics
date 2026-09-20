import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, enums } = WEED;
const { ShapeType } = enums;

export class WorldWall extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider];

  onSpawned(spawnConfig = {}) {
    const width = spawnConfig.width ?? 80;
    const height = spawnConfig.height ?? 80;
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.restitution = 1;
    this.collider.friction = 0;
    this.collider.collisionLayer = 0;
    this.collider.collisionMask = 2;
  }
}
