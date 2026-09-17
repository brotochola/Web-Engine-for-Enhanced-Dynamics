import WEED from '/src/index.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { BulletStormDriver } from './bullets/bulletStressDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xb011e7;
const INTERIOR = 64;
const WALL = 48;
const WORLD_W = 4000;
const WORLD_H = 3000;
const SHOOTERS = 8;
const SPAWN_PER_TICK = 80;
const MAX_BULLETS = 8192;

function stormConfig(numberOfLogicWorkers) {
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
    bullet: { maxBullets: MAX_BULLETS, maxImpactsPerFrame: 256 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 12000,
    },
    lighting: { enabled: false },
  };
}

const STORM_ASSETS = {
  textures: { ball: '/demos/img/bola.png' },
};

const STORM_ENTITIES = [
  [RayStressEntity, INTERIOR + 4],
  [BulletStormDriver, SHOOTERS],
];

function plantStorm(scene) {
  let a = SEED >>> 0;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  scene.spawnEntity(RayStressEntity, {
    x: WORLD_W * 0.5,
    y: WALL * 0.5,
    shape: 'box',
    width: WORLD_W,
    height: WALL,
  });
  scene.spawnEntity(RayStressEntity, {
    x: WORLD_W * 0.5,
    y: WORLD_H - WALL * 0.5,
    shape: 'box',
    width: WORLD_W,
    height: WALL,
  });
  scene.spawnEntity(RayStressEntity, {
    x: WALL * 0.5,
    y: WORLD_H * 0.5,
    shape: 'box',
    width: WALL,
    height: WORLD_H,
  });
  scene.spawnEntity(RayStressEntity, {
    x: WORLD_W - WALL * 0.5,
    y: WORLD_H * 0.5,
    shape: 'box',
    width: WALL,
    height: WORLD_H,
  });

  const inner = WALL + 80;
  for (let i = 0; i < INTERIOR; i++) {
    scene.spawnEntity(RayStressEntity, {
      x: inner + rng() * (WORLD_W - 2 * inner),
      y: inner + rng() * (WORLD_H - 2 * inner),
      shape: rng() >= 0.7 ? 'box' : 'circle',
      radius: 6 + rng() * 18,
      width: 12 + rng() * 28,
      height: 8 + rng() * 28,
    });
  }

  for (let s = 0; s < SHOOTERS; s++) {
    scene.spawnEntity(BulletStormDriver, { seed: SEED + s * 97, spawnPerTick: SPAWN_PER_TICK });
  }

  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(0.22);
}

export class BulletStormScene1W extends Scene {
  static config = stormConfig(1);
  static assets = STORM_ASSETS;
  static entities = STORM_ENTITIES;
  create() {
    plantStorm(this);
  }
}

export class BulletStormScene3W extends Scene {
  static config = stormConfig(3);
  static assets = STORM_ASSETS;
  static entities = STORM_ENTITIES;
  create() {
    plantStorm(this);
  }
}
