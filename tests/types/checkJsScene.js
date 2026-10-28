// A game as the scaffold writes it, type-checked as JavaScript (checkJs) against types/weed.d.ts by
// `npm run check:types` (N-44): component fields on instances, onSpawned with the keys a class reads, and a
// scene's entities as JavaScript infers them.
import WEED from '@weed.js/engine';

const { Scene, GameObject, Collider, RigidBody, SpriteRenderer } = WEED;

export class Player extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  /** @param {{ x?: number, y?: number }} [config] */
  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    if (this.collider) {
      this.collider.shapeType = 1;
      this.collider.radius = 8;
    }
    if (this.rigidBody) this.rigidBody.linearDamping = 2;
    if (this.spriteRenderer) this.spriteRenderer.alpha = 0.5;
  }
}

export class Coin extends GameObject {
  onSpawned({ x, y }) {
    this.x = x;
    this.y = y;
  }
}

export class Level extends Scene {
  static entities = [[Player, 2], [Coin, 10]];
}
