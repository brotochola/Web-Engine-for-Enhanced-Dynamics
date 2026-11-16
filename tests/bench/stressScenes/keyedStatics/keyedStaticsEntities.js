import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, BulletPool } = WEED;

/**
 * N-202's probe: a sprite that walks up and down a column of the view, its place a function of its index and the
 * clock (no state of its own, so any logic worker can tick it). Walkers cross the decorations' rows, so the y-sorted
 * draw order shifts every frame.
 */
export class KeyedStaticsWalker extends GameObject {
  static components = [SpriteRenderer];
  static band = { x0: 1900, x1: 2100, y0: 980, y1: 2020 };

  onSpawned() {
    this.setSprite('bunny');
    this.setAnchor(0.5, 1);
    this._place();
  }

  tick() {
    this._place();
  }

  _place() {
    const b = KeyedStaticsWalker.band;
    const i = this.index;
    const phase = (i * 0.6180339887) % 1;
    const t = performance.now() / 1000;
    const s = 0.5 + 0.5 * Math.sin((t * (0.35 + 0.25 * phase) + phase) * 2 * Math.PI);
    this.x = b.x0 + ((i * 37) % (b.x1 - b.x0));
    this.y = b.y0 + s * (b.y1 - b.y0);
  }
}

/**
 * N-202's probe: bullets with trails across a horizontal band of the view, `perTick` a tick from its left edge to a wall
 * at its right, so trail rows come and go every frame.
 */
export class KeyedStaticsBulletDriver extends GameObject {
  static components = [];
  static band = { x: 1060, y0: 1470, y1: 1530 };
  static perTick = 3;

  onSpawned() {
    this.x = -10000;
    this.y = -10000;
  }

  tick() {
    const b = KeyedStaticsBulletDriver.band;
    if (this._n === undefined) this._n = this.index * 7919;
    for (let k = 0; k < KeyedStaticsBulletDriver.perTick; k++) {
      const n = this._n++;
      const y = b.y0 + (((n * 0.6180339887) % 1) * (b.y1 - b.y0));
      BulletPool.spawn({
        x: b.x,
        y,
        vx: 1500,
        vy: 0,
        damage: 1,
        ownerId: this.index,
        shooterEntityType: 0,
        texture: 'bullet',
        scale: 1,
        anchorX: 1,
        anchorY: 0.5,
        trailWidth: 3,
      });
    }
  }
}
