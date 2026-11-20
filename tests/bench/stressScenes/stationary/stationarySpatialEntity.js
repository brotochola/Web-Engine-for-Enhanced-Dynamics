import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class StationarySpatialEntity extends GameObject {
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

  /**
   * The scene measures neighbour lists, so its entities read theirs. Main builds a list for every visualRange (SST-21),
   * but an older revision built one only for a type that read one (E-176): v0.14.0 built none here, and the scoreboard's
   * spatial row compared its grid alone (0.39 ms at 9000) with main's lists (R-1596).
   */
  tick() {
    if (this.neighborCount > 65535) this.rotation = 0;
  }
}
