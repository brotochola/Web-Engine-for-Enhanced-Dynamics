import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

export class RenderQueueStressEntity extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [SpriteRenderer];
  static tickInterval = 16;

  onSpawned({ x = 0, y = 0, scale = 0.8, tint = 0xffffff } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.setSprite('ball');
    this.setScale(scale);
    this.setAnchor(0.5, 0.5);
    this.setTint(tint);
    this.setAlpha(0.9);
  }

  tick() {
    // Intentionally empty: this benchmark isolates pre-render culling/sorting and Pixi queue consumption.
  }
}
