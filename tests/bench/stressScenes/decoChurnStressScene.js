import WEED from '/src/index.js';
import { DecoChurnDriver } from './decorations/decoChurnDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xdec0c4;
const WORLD_W = 4000;
const WORLD_H = 3000;
const DRIVERS = 8;
const SPAWN_PER_TICK = 8;
const DESPAWN_PER_TICK = 8;
const LIVE_CAP = 500;

function churnConfig(numberOfLogicWorkers) {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
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
      numberOfLogicWorkers,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 20000, swayDecimation: 1 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 8000,
    },
    lighting: { enabled: false },
  };
}

function plantChurnDrivers(scene) {
  for (let s = 0; s < DRIVERS; s++) {
    scene.spawnEntity(DecoChurnDriver, {
      seed: SEED + s * 41,
      spawnPerTick: SPAWN_PER_TICK,
      despawnPerTick: DESPAWN_PER_TICK,
      liveCap: LIVE_CAP,
    });
  }
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(0.22);
}

export class DecoChurnStressScene1W extends Scene {
  static config = churnConfig(1);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoChurnDriver, DRIVERS]];
  create() {
    plantChurnDrivers(this);
  }
}

export class DecoChurnStressScene3W extends Scene {
  static config = churnConfig(3);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoChurnDriver, DRIVERS]];
  create() {
    plantChurnDrivers(this);
  }
}
