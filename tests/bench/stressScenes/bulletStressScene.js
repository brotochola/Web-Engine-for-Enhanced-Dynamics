import WEED from '/src/index.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { BulletStressDriver } from './bullets/bulletStressDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xb011e7;
const INTERIOR = 240;
const WALL = 48;
const WORLD_W = 4000;
const WORLD_H = 3000;
/** ?physics=0: no physics worker; the walls and props are colliders without bodies (the bullets still hit them). */
const PHYSICS = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('physics') !== '0';
  } catch {
    return true;
  }
})();

/**
 * ?bullets=N: the load knob. The pool (40 000 by default), the drivers' spawn rate and the queue scale with it, so
 * the pool stays as full and the bullets on screen grow with N (under 65 536 the pool keeps its 16-bit slots).
 */
const BULLETS = (() => {
  try {
    const n = Number(new URLSearchParams(globalThis.location?.search || '').get('bullets'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40000;
  } catch {
    return 40000;
  }
})();

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
      numberOfLogicWorkers: 3,
      staggeredUpdates: false,
    },
    physics: {
      enabled: PHYSICS,
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    bullet: { maxBullets: BULLETS, maxImpactsPerFrame: 256 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: BULLETS + 2000,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };

  static entities = [
    [RayStressEntity, INTERIOR + 4],
    [BulletStressDriver, 8],
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

    RayStressEntity.spawn({
      x: WORLD_W * 0.5,
      y: WALL * 0.5,
      shape: 'box',
      width: WORLD_W,
      height: WALL,
    });
    RayStressEntity.spawn({
      x: WORLD_W * 0.5,
      y: WORLD_H - WALL * 0.5,
      shape: 'box',
      width: WORLD_W,
      height: WALL,
    });
    RayStressEntity.spawn({
      x: WALL * 0.5,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: WALL,
      height: WORLD_H,
    });
    RayStressEntity.spawn({
      x: WORLD_W - WALL * 0.5,
      y: WORLD_H * 0.5,
      shape: 'box',
      width: WALL,
      height: WORLD_H,
    });

    const inner = WALL + 80;
    for (let i = 0; i < INTERIOR; i++) {
      RayStressEntity.spawn({
        x: inner + rng() * (WORLD_W - 2 * inner),
        y: inner + rng() * (WORLD_H - 2 * inner),
        shape: rng() >= 0.7 ? 'box' : 'circle',
        radius: 6 + rng() * 18,
        width: 12 + rng() * 28,
        height: 8 + rng() * 28,
      });
    }

    for (let s = 0; s < 8; s++) {
      BulletStressDriver.spawn({ seed: SEED + s * 97, spawnPerTick: Math.round((180 * BULLETS) / 40000) });
    }

    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.28);
  }
}
