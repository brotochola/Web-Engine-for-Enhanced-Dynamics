import WEED from '/src/index.js';
import { Bunny } from './bunny.js';

const { GameObject, Mouse } = WEED;

const BATCH = 1000;
const HOLD_EVERY = 8;

export class BunnySpawner extends GameObject {
    static scriptUrl = import.meta.url;
    static components = [];

    onSpawned() {
        this._holdFrames = 0;
    }

    tick() {
        // if (Mouse.isButton0Pressed) {
        //     this._holdFrames = 0;
        //     this._spawnBatch();
        //     return;
        // }
        if (Mouse.isButton0Down) {

            this._spawnBatch();

        }
        // this._holdFrames = 0;
    }

    _spawnBatch() {
        const x = Mouse.x;
        const y = Mouse.y;
        for (let i = 0; i < BATCH; i++) {
            if (!Bunny.spawn({ x, y })) break;
        }
        this.sendMessageToScene({
            msg: 'bunnyCount',
            count: GameObject.getPoolStats(Bunny).active,
        });
    }
}
