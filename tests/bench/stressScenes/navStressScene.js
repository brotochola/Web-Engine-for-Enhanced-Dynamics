import WEED from '/src/index.js';
import { NavStressAgent } from './navStress/navStressAgent.js';

const { Scene, Camera } = WEED;

export class NavStressScene extends Scene {
  static config = {
    worldWidth: 2048,
    worldHeight: 2048,
    seed: 777,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    navigation: {
      enabled: true,
      cellSize: 32,
      maxFlowfields: 16,
      maxPaths: 32,
      maxProcessingMsPerFrame: 2,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static entities = [[NavStressAgent, 64]];

  create() {
    const targets = 24;
    for (let i = 0; i < 48; i++) {
      const t = i % targets;
      const col = t % 6;
      const row = (t / 6) | 0;
      this.spawnEntity(NavStressAgent, {
        x: 80 + (i % 8) * 40,
        y: 80 + ((i / 8) | 0) * 40,
        tx: 400 + col * 220,
        ty: 400 + row * 220,
      });
    }
    Camera.centerOn(1024, 1024);
    Camera.setZoom(0.4);
  }
}
