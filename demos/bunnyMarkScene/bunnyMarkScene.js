import WEED from '/src/index.js';
import { Bunny } from './gameObjects/bunny.js';
import { BunnySpawner } from './gameObjects/bunnySpawner.js';

const { Scene, Camera, GameObject } = WEED;

function bunnySearchParam(name) {
    const search = globalThis.location && globalThis.location.search;
    if (typeof search !== 'string') return null;
    return new URLSearchParams(search).get(name);
}

// `?bunnies=<n>` sets the bunnies spawned at the start, their pool and the render queue (default 250 000): the count a
// GPU holds at 60 fps is found by a sweep. `?still=1` spawns them at rest, so the frame is the same picture every time
// (image comparisons).
const INITIAL_BUNNIES = (() => {
    const n = parseInt(bunnySearchParam('bunnies') ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 250_000;
})();
const STILL = bunnySearchParam('still') === '1';
// `?interpolation=0`: the renderer draws the queue's poses as they come, so Pixi packs the bunnies as keyed frames.
const INTERPOLATION = bunnySearchParam('interpolation') !== '0';

const HUD_CSS =
    'position:fixed;left:12px;bottom:12px;z-index:940;pointer-events:none;' +
    'color:#eee;font:14px/1.45 system-ui,sans-serif;background:rgba(0,0,0,0.55);' +
    'padding:8px 12px;border-radius:6px;';

export class BunnyMarkScene extends Scene {
    static config = {
        worldWidth: typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1920,
        worldHeight: typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 1080,
        entityIdWidth: 32,
        seed: 1,
        debug: {
            maxDebugDrawEntries: 30192,
            collectDetailedStats: true,
            verboseWorkers: true,
        },
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
            // ?backend=webgpu runs Pixi's WebGPU backend (E-97b paces its frames).
            backend: bunnySearchParam('backend') === 'webgpu' ? 'webgpu' : 'webgl',
            noLimitFPS: false,
            ySort: false,
            maxVisibleRenderables: INITIAL_BUNNIES,
            interpolation: INTERPOLATION,
        },
        preRender: {
            skipCull: true,
            interpolation: false,
            packGpuSprites: "pixi",// bunnySearchParam('packGpuSprites') || 'pixi',
        },
        lighting: { enabled: false },
    };

    static assets = {
        textures: { "bunny": "/demos/img/bunny.png" },
    };

    static entities = [
        [Bunny, INITIAL_BUNNIES],
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
            const x = this.config.worldWidth * rng();
            const y = this.config.worldHeight * rng();
            // An xy-only config rides the spawn ring; `still` travels in create()'s extras, only when asked for.
            Bunny.spawn(STILL ? { x, y, still: true } : { x, y });
        }
        BunnySpawner.spawn({ x: cx, y: cy });
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
