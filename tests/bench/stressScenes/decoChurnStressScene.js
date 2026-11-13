import WEED from '/src/index.js';
import { DecoChurnDriver } from './decorations/decoChurnDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xdec0c4;
const WORLD_W = 4000;
const WORLD_H = 3000;
const DRIVERS = 8;
/** `?churn=N`: spawns and despawns per driver tick (default 8); `?liveCap=N`: each driver's live decorations (default
 * 500, at most 2400: eight drivers under maxDecorations, so every driver reaches its cap and churns; at 2500 the pool
 * filled first and the drivers short of their cap never despawned). The despawn cost grows with both. */
const knob = (name, fallback, max) => {
  const n = Number(WEED.params?.get(name));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};
const SPAWN_PER_TICK = knob('churn', 8, 256);
const DESPAWN_PER_TICK = SPAWN_PER_TICK;
const LIVE_CAP = knob('liveCap', 500, 2400);

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
    DecoChurnDriver.spawn({
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
