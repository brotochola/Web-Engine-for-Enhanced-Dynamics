import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class Crate extends GameObject {
  static components = [Collider, SpriteRenderer];

  static spawnParams = {
    size: { value: 32, min: 8, max: 128, step: 1 },
  };

  onSpawned(params) {
    this.collider.width = params.size;
    this.collider.height = params.size;
  }
}
