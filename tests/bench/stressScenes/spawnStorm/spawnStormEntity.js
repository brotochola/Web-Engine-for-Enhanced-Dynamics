import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class SpawnStormEntity extends GameObject {
  static components = [Collider, SpriteRenderer];
  static tickInterval = 8;

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.collider.radius = 6;
    this.setSprite('ball');
    this.setScale(0.8);
    this.setAnchor(0.5, 0.5);
  }

  tick() {}
}
