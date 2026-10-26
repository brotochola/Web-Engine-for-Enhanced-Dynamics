// NetRock - a static obstacle. Host and clients spawn the same rocks from the race
// seed (sprite and scale come in the spawn config, not from rng() in a worker), so
// they are never replicated.

import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, RigidBody, enums } = WEED;
const { ShapeType } = enums;

export class NetRock extends GameObject {
  static components = [Collider, SpriteRenderer, RigidBody];

  onSpawned(spawnConfig = {}) {
    const scale = spawnConfig.scale ?? 1;
    this.rigidBody.static = 1;
    this.setSprite(spawnConfig.sprite || 'rock1');
    this.setScale(spawnConfig.flip ? -scale : scale, scale);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.66;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = this.spriteRenderer.originalWidth * 0.4 * scale;
    this.collider.visualRange = 0;
    this.x = spawnConfig.x || 0;
    this.y = spawnConfig.y || 0;
  }
}
