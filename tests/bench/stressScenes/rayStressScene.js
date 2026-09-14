import WEED from '/src/index.js';
import { RayStressDriver } from './ray/rayStressDriver.js';
import { RayStressEntity } from './ray/rayStressEntity.js';

const { Scene, Camera } = WEED;

const OBSTACLE_COUNT = 2000;
const SEED = 0xc0ffee;

/** L2 intermediate bench: dense static colliders + deterministic ray flood each tick. */
export class RayStressScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 4000,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  static entities = [
    [RayStressDriver, 1],
    [RayStressEntity, OBSTACLE_COUNT],
  ];

  create() {
    // Deterministic obstacle layout (same seed as L1 microbench philosophy).
    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const margin = 64;
    const worldW = this.config.worldWidth;
    const worldH = this.config.worldHeight;

    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      const isBox = rng() >= 0.7;
      this.spawnEntity(RayStressEntity, {
        x: margin + rng() * (worldW - 2 * margin),
        y: margin + rng() * (worldH - 2 * margin),
        shape: isBox ? 'box' : 'circle',
        radius: 4 + rng() * 16,
        width: 8 + rng() * 32,
        height: 8 + rng() * 32,
        collisionLayer: (rng() * 8) | 0,
      });
    }

    this.spawnEntity(RayStressDriver, { seed: SEED });

    Camera.centerOn(worldW * 0.5, worldH * 0.5);
    Camera.setZoom(0.45);
  }
}
