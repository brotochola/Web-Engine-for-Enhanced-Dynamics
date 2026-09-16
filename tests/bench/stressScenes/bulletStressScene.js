import WEED from '/src/index.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { BulletStressDriver } from './bullets/bulletStressDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xb011e7;
const INTERIOR = 240;
const WALL = 48;
const WORLD_W = 4000;
const WORLD_H = 3000;

/** Dense in-world bullets: walls so they die inside, driver keeps the pool full. */
export class BulletStressScene extends Scene {
  static config = {
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
      numberOfLogicWorkers: 1,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    bullet: { maxBullets: 2048, maxImpactsPerFrame: 128 },
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
    [RayStressEntity, INTERIOR + 4],
    [BulletStressDriver, 1],
  ];

  create() {
    let a = SEED >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    this.spawnEntity(RayStressEntity, {
      x: WORLD_W * 0.5,
      y: WALL * 0.5,
      shape: 'box',
      width: WORLD_W,
      height: WALL,
    });
    this.spawnEntity(RayStressEntity, {
      x: WORLD_W * 0.5,
      y: WORLD_H - WALL * 0.5,
      shape: 'box',
      width: WORLD_W,
      height: WALL,
    });
    this.spawnEntity(RayStressEntity, {
      x: WALL * 0.5,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: WALL,
      height: WORLD_H,
    });
    this.spawnEntity(RayStressEntity, {
      x: WORLD_W - WALL * 0.5,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: WALL,
      height: WORLD_H,
    });

    const inner = WALL + 80;
    for (let i = 0; i < INTERIOR; i++) {
      this.spawnEntity(RayStressEntity, {
        x: inner + rng() * (WORLD_W - 2 * inner),
        y: inner + rng() * (WORLD_H - 2 * inner),
        shape: rng() >= 0.7 ? 'box' : 'circle',
        radius: 6 + rng() * 18,
        width: 12 + rng() * 28,
        height: 8 + rng() * 28,
      });
    }

    this.spawnEntity(BulletStressDriver, { seed: SEED });

    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.28);
  }
}
