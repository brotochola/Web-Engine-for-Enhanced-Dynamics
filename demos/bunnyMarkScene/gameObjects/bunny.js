import WEED from '/src/index.js';
import { BunnyMotion } from '../components/bunnyMotion.js';
import {
  toyWorldBounce,
  TOY_LEFT,
  TOY_RIGHT,
  TOY_TOP,
  TOY_BOTTOM,
} from '/src/util/toyWorldBounce.js';

const { GameObject, SpriteRenderer, Transform } = WEED;

const BUNNY_SCALE = 0.5;

export class Bunny extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [SpriteRenderer, BunnyMotion];
  static reportMarkActive = true;

  onSpawned(spawnConfig = {}) {
    const rng = globalThis.rng;
    this.setSprite('_whiteCircle');
    this.setAnchor(0.5, 0.5);
    this.setScale(BUNNY_SCALE);
    this.setTint((rng() * 0xffffff) | 0);
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.bunnyMotion.vx = rng() * 10 - 5;
    this.bunnyMotion.vy = rng() * 10 - 5;
  }

  static tickAll(list, count, dtRatio) {
    toyWorldBounce(
      Transform.x,
      Transform.y,
      BunnyMotion.vx,
      BunnyMotion.vy,
      list,
      count,
      dtRatio,
      TOY_LEFT,
      TOY_RIGHT,
      TOY_TOP,
      TOY_BOTTOM,
    );
  }
}
