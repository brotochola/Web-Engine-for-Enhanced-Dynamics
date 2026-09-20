import WEED from '/src/index.js';
import { BunnyMotion } from '../components/bunnyMotion.js';

const { GameObject, SpriteRenderer, Transform, Camera, rng } = WEED;

const GRAVITY = 0.75;
const BUNNY_SCALE = 2;
const HALF_SIZE = 8;
// const FLOOR_DAMP = 0.999;

export class Bunny extends GameObject {
    static scriptUrl = import.meta.url;
    static components = [SpriteRenderer, BunnyMotion];

    onSpawned(spawnConfig = {}) {
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
        const xs = Transform.x;
        const ys = Transform.y;
        const vxs = BunnyMotion.vx;
        const vys = BunnyMotion.vy;
        const bounds = Camera.getViewportBounds();
        const left = bounds.left + HALF_SIZE;
        const right = bounds.right - HALF_SIZE;
        const top = bounds.top + HALF_SIZE;
        const bottom = bounds.bottom - HALF_SIZE;
        const g = GRAVITY * dtRatio;

        for (let n = 0; n < count; n++) {
            const i = list[n];
            let vx = vxs[i];
            let vy = vys[i] + g;
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
                vy = -vy //* FLOOR_DAMP;
            }

            xs[i] = x;
            ys[i] = y;
            vxs[i] = vx;
            vys[i] = vy;
        }
    }
}
