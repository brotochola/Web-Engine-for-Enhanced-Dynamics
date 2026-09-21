import WEED from '/src/index.js';
import { Bunny } from './gameObjects/bunny.js';
import { BunnySpawner } from './gameObjects/bunnySpawner.js';

const { Scene, Camera, GameObject } = WEED;

const INITIAL_BUNNIES = 150000;

const HUD_CSS =
    'position:fixed;left:12px;bottom:12px;z-index:940;pointer-events:none;' +
    'color:#eee;font:14px/1.45 system-ui,sans-serif;background:rgba(0,0,0,0.55);' +
    'padding:8px 12px;border-radius:6px;';

export class BunnyMarkScene extends Scene {
    static config = {
        worldWidth: window.innerWidth,
        worldHeight: window.innerHeight,
        entityIdWidth: 32,
        seed: 1,
        spatial: {
            // 0 = no spatial worker and no grid SAB. Inspect picks via click scan.
            numberOfSpatialWorkers: 0,
            cellSize: 1024,
            maxNeighbors: 0,
            noLimitFPS: false,
        },
        logic: {
            numberOfLogicWorkers: 1,
            noLimitFPS: false,
        },
        physics: {
            enabled: false,
            gravity: { x: 0, y: 0 },
            noLimitFPS: false,
        },
        particle: {
            maxParticles: 0,
            decals: false,
        },
        renderer: {
            backend: 'webgl',
            noLimitFPS: false,
            ySorting: false,
            maxVisibleRenderables: 160_000,
        },
        preRender: {
            skipCull: true,
        },
        lighting: { enabled: false },
    };

    static assets = {
        textures: {},
    };

    static entities = [
        [Bunny, 160_000],
        [BunnySpawner, 1],
    ];

    create() {
        const cx = this.config.worldWidth / 2;
        const cy = this.config.worldHeight / 2;
        Camera.setZoom(1);
        Camera.centerOn(cx, cy);

        this._buildHud();

        const rng = globalThis.rng;
        for (let i = 0; i < INITIAL_BUNNIES; i++) {
            this.spawnEntity(Bunny, {
                x: this.config.worldWidth * rng(),
                y: this.config.worldHeight * rng()
            });
        }
        this.spawnEntity(BunnySpawner, { x: cx, y: cy });
        this._setCount(GameObject.getPoolStats(Bunny).active);
    }

    onMessageFromGameObject(data) {
        if (data?.msg === 'bunnyCount') {
            this._setCount(data.count);
        }
    }

    async destroy() {
        this._removeHud();
        await super.destroy();
    }

    _buildHud() {
        const el = document.createElement('div');
        el.id = 'bunny-mark-hud';
        el.style.cssText = HUD_CSS;
        const hint = document.createElement('div');
        hint.textContent = 'Click: +100';
        const count = document.createElement('div');
        this._hudCount = count;
        el.appendChild(hint);
        el.appendChild(count);
        document.body.appendChild(el);
        this._hud = el;
        this._setCount(0);
    }

    _setCount(count) {
        if (this._hudCount) this._hudCount.textContent = `Bunnies: ${count}`;
    }

    _removeHud() {
        if (this._hud?.parentNode) this._hud.parentNode.removeChild(this._hud);
        this._hud = null;
        this._hudCount = null;
    }
}
