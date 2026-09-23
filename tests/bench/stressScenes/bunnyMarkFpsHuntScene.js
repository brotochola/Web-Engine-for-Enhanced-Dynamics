import WEED from '/src/index.js';
import { Bunny } from '../../../demos/bunnyMarkScene/gameObjects/bunny.js';
import { BunnySpawner } from '../../../demos/bunnyMarkScene/gameObjects/bunnySpawner.js';

const { Scene, Camera, GameObject } = WEED;

function huntCount() {
  const raw = new URLSearchParams(globalThis.location?.search || '').get('bunnies');
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 65000;
}

const N = huntCount();

/** Headless FPS hunt. Not the demo default. Width 32 so N can pass 65535. */
export class BunnyMarkFpsHuntScene extends Scene {
  static config = {
    entityIdWidth: 32,
    worldWidth: typeof window !== 'undefined' ? window.innerWidth : 1920,
    worldHeight: typeof window !== 'undefined' ? window.innerHeight : 1080,
    seed: 1,
    spatial: {
      numberOfSpatialWorkers: 0,
      cellSize: 1024,
      maxNeighbors: 0,
      noLimitFPS: false,
    },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySortingInCPU: false,
      maxVisibleRenderables: N,
    },
    preRender: { skipCull: true },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [
    [Bunny, N],
    [BunnySpawner, 1],
  ];

  create() {
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setZoom(1);
    Camera.centerOn(cx, cy);
    const rng = globalThis.rng;
    for (let i = 0; i < N; i++) {
      this.spawnEntity(Bunny, {
        x: this.config.worldWidth * rng(),
        y: this.config.worldHeight * rng(),
      });
    }
    this.spawnEntity(BunnySpawner, { x: cx, y: cy });
    void GameObject.getPoolStats(Bunny).active;
  }
}
