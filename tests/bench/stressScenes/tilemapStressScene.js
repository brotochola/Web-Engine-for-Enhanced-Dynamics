import WEED from '/src/index.js';
import { TilemapStressQuerier } from './tilemapStress/tilemapStressQuerier.js';

const { Scene, Camera } = WEED;

const SEED = 0x711e;
const QUERIERS = 64;

/** Bench scene: seeded getTileId at a fixed rate. Kernel-only tilemap is not enough. */
export class TilemapStressScene extends Scene {
  static config = {
    worldWidth: 2048,
    worldHeight: 2048,
    seed: SEED,
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
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static assets = {
    tilemaps: {
      benchMap: {
        json: '/tests/bench/stressScenes/tilemapStress/benchMap.json',
        png: '/demos/img/tilemap/2.png',
      },
    },
  };

  static entities = [[TilemapStressQuerier, QUERIERS]];

  create() {
    for (let i = 0; i < QUERIERS; i++) {
      this.spawnEntity(TilemapStressQuerier, {
        x: 80 + (i % 8) * 40,
        y: 80 + ((i / 8) | 0) * 40,
        salt: i * 17,
      });
    }
    Camera.centerOn(1024, 1024);
    Camera.setZoom(0.4);
  }
}
