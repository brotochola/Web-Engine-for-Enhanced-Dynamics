import WEED from '/src/index.js';

const { GameObject } = WEED;

/** Off-screen placeholder so deco-fixed scenes keep a non-zero entity SoA. */
export class DecoFixedAnchor extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned() {
    this.x = -10000;
    this.y = -10000;
  }
}
