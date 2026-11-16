import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

/** The view the sprites fill (the scene sets the world to it, the camera at zoom 1 on its centre). */
export const VIEW = { w: 1920, h: 1080 };

/** A sprite that never changes once spawned: its row is drawn keyed, its statics sent once. */
export class PackStill extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, scale = 0.25, z = 0 } = {}) {
    this.setSprite('bunny');
    this.setScale(scale);
    this.x = x;
    this.y = y;
    if (z !== 0) this.spriteRenderer.zIndex = z;
  }
}

/** A sprite that drifts every frame (its pose changes; its statics do not), wrapping at the view's edges. */
export class PackMover extends PackStill {
  tick() {
    const i = this.index;
    let x = WEED.Transform.x[i] + 0.7;
    let y = WEED.Transform.y[i] + 0.3;
    if (x >= VIEW.w) x -= VIEW.w;
    if (y >= VIEW.h) y -= VIEW.h;
    this.x = x;
    this.y = y;
  }
}

/** A sprite whose tint flips every frame: its statics change, so its key is marked and its statics go up again. */
export class PackChurner extends PackStill {
  tick() {
    this.tint = (this.tint & 0xffffff) === 0xffffff ? 0xeeddcc : 0xffffff;
  }
}
