import WEED from '/src/index.js';
import { ParticleEmitDriver, ParticleEmitDriver32 } from './particles/particleEmitDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0ffee;

/** L2 intermediate bench: fixed-rate emitFlat burst spawn + fast recycle. No decals. */
export class ParticleEmitStressScene extends Scene {
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
      maxParticles: 60000,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 60000,
    },
    lighting: {
      enabled: false,
    },
  };

  static entities = [[ParticleEmitDriver, 1]];

  create() {
    this.spawnEntity(ParticleEmitDriver, { seed: SEED });

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.3);
  }
}

export class ParticleEmitStressScene3W extends Scene {
  static config = {
    ...ParticleEmitStressScene.config,
    logic: {
      ...ParticleEmitStressScene.config.logic,
      numberOfLogicWorkers: 3,
    },
  };

  static entities = [[ParticleEmitDriver32, 4]];

  create() {
    for (let i = 0; i < 4; i++) {
      this.spawnEntity(ParticleEmitDriver32, { seed: SEED + i * 17, emitPerTick: 32 });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.3);
  }
}
