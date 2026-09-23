/**
 * Playable Bunny Mark shape at N=1 prerender: full isItOnScreen.fill(0).
 * Headed hunt only. Not the 20k stress row.
 */
import WEED from '/src/index.js';
import { Bunny } from '/demos/bunnyMarkScene/gameObjects/bunny.js';

const { Scene, Camera } = WEED;

const N = 250000;

export class BunnyMarkN1HuntScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,
    entityIdWidth: 32,
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
      interpolation: true,
    },
    preRender: {
      skipCull: true,
      interpolation: false,
      entityBlockSize: 256,
      numberOfPreRenderWorkers: 1,
    },
    lighting: { enabled: false },
  };

  static assets = { textures: { bunny: '/demos/img/bunny.png' } };

  static entities = [[Bunny, N]];

  create() {
    const rng = globalThis.rng;
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    for (let i = 0; i < N; i++) {
      this.spawnEntity(Bunny, { x: w * rng(), y: h * rng() });
    }
    Camera.setZoom(1);
    Camera.centerOn(w * 0.5, h * 0.5);
  }
}
