import WEED from '/src/index.js';

const { GameObject, Collider } = WEED;

/** No sprite: 300k create() must stay inside the bench evaluate timeout. */
export class EntityIdSpatialBody extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [Collider];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.collider.radius = 10;
    this.collider.visualRange = 170;
  }

  tick() {}
}
