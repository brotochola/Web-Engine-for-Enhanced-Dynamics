import WEED from '/src/index.js';
import { SpawnStormDriver } from './spawnStorm/spawnStormDriver.js';
import { SpawnStormEntity } from './spawnStorm/spawnStormEntity.js';

const { Scene, Camera, SpriteRenderer } = WEED;

export class SpawnStormScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: 909090,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 8000,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };

  static entities = [
    [SpawnStormDriver, 1],
    [SpawnStormEntity, 8192],
  ];

  static queries = [[SpriteRenderer]];

  create() {
    this.spawnEntity(SpawnStormDriver, {});
    for (let i = 0; i < 2000; i++) {
      this.spawnEntity(SpawnStormEntity, {
        x: 200 + (i % 32) * 36,
        y: 200 + ((i / 32) | 0) * 36,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.55);
  }
}
