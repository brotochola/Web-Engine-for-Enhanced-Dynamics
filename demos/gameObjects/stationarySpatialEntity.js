import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class StationarySpatialEntity extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [Collider, SpriteRenderer];

  onSpawned({ x = 0, y = 0, radius = 12, visualRange = 180 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;

    this.collider.radius = radius;
    this.collider.visualRange = visualRange;

    this.setSprite('ball');
    this.setScale((radius * 2) / 14);
    this.setAnchor(0.5, 0.5);
    this.setAlpha(0.85);
  }

  tick() {
    // Intentionally empty: this benchmark isolates stationary spatial reuse.
  }
}
