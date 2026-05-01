import WEED from '/src/index.js';
import { QueryChurnTag } from '../components/queryChurnTag.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class QueryChurnEntity extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [Collider, SpriteRenderer, QueryChurnTag];
  static tickInterval = 4;

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.collider.radius = 8;
    this.collider.visualRange = 64;
    this.setSprite('ball');
    this.setScale(1.1);
    this.setAnchor(0.5, 0.5);
    this.setAlpha(0.8);
  }

  tick() {
    // Intentionally light: this benchmark stresses active query publication,
    // not entity behavior.
  }
}
