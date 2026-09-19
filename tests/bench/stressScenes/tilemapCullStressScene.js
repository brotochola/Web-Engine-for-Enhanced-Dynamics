import WEED from '/src/index.js';
import { TilemapCullPanDriver } from './tilemapCull/tilemapCullPanDriver.js';

const { Scene, Camera, LAYER_KIND } = WEED;

const SEED = 0x711e;
const MAP_PX = 64 * 32;

/** GPU GID tilemap + moving camera. Not getTileId (that's TilemapStressScene). */
export class TilemapCullStressScene extends Scene {
  static config = {
    worldWidth: MAP_PX,
    worldHeight: MAP_PX,
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
    layers: {
      ground: {
        kind: LAYER_KIND.TILEMAP,
        tilemap: 'benchMap',
        scale: 1,
        zIndex: 0.5,
      },
    },
  };

  static assets = {
    tilemaps: {
      benchMap: {
        json: '/tests/bench/stressScenes/tilemapStress/benchMap.json',
        png: '/demos/img/tilemap/2.png',
      },
    },
  };

  static entities = [[TilemapCullPanDriver, 1]];

  create() {
    this.spawnEntity(TilemapCullPanDriver, { seed: SEED });
    Camera.setZoom(0.55);
    Camera.centerOn(MAP_PX * 0.5, MAP_PX * 0.5);
  }
}
