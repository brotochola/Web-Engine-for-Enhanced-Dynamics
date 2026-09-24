import WEED from '/src/index.js';
import { BunnyMotion } from '../components/bunnyMotion.js';

// Blob workers strip `/src/` imports, so tickAll cannot call toyWorldBounce.
// Same box as toyWorldBounce.js: 1920×1080, half size 8.

const { GameObject, SpriteRenderer, Transform } = WEED;

const BUNNY_SCALE = 1;

export class Bunny extends GameObject {
  static components = [SpriteRenderer, BunnyMotion];
  static reportMarkActive = true;

  onSpawned(spawnConfig = {}) {
    const rng = globalThis.rng;
    this.setSprite('bunny');
    this.setAnchor(0.5, 0.5);
    this.setScale(BUNNY_SCALE);
    this.setTint((rng() * 0xffffff) | 0);
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    this.bunnyMotion.vx = rng() * 1 - 0.5;
    this.bunnyMotion.vy = rng() * 1 - 0.5;
  }

  static tickAll(list, count, dtRatio) {
    const xs = Transform.x;
    const ys = Transform.y;
    const vxs = BunnyMotion.vx;
    const vys = BunnyMotion.vy;
    const n = count | 0;
    const left = 8;
    const right = 1912;
    const top = 8;
    const bottom = 1072;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      let vx = vxs[i];
      let vy = vys[i];
      let x = xs[i] + vx * dtRatio;
      let y = ys[i] + vy * dtRatio;
      if (x < left) {
        x = left;
        vx = -vx;
      } else if (x > right) {
        x = right;
        vx = -vx;
      }
      if (y < top) {
        y = top;
        vy = -vy;
      } else if (y > bottom) {
        y = bottom;
        vy = -vy;
      }
      xs[i] = x;
      ys[i] = y;
      vxs[i] = vx;
      vys[i] = vy;
    }
  }
}
