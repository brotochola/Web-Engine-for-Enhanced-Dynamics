import WEED from '/src/index.js';
import { ParticleIntegrateDriver } from './particles/particleIntegrateDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0ffee;

/** L2 intermediate bench: large heighted (gravity + despawnOnGroundContact) population. No decals. */
export class ParticleIntegrateStressScene extends Scene {
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
      maxParticles: 55000,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 55000,
    },
    lighting: {
      enabled: false,
    },
  };

  static entities = [[ParticleIntegrateDriver, 1]];

  create() {
    this.spawnEntity(ParticleIntegrateDriver, { seed: SEED });

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.3);
  }
}
