/**
 * Bunny Mark stress: N fixed, no click.
 * A = Box2D WASM owns Transform.x/y (HEAP); Bunny.tickAll still writes them.
 * C = physics.enabled false; same tickAll writes Weed pose SAB.
 * D = RigidBody + circle + 4 walls; Box2D integrates. No BunnyMotion.
 * Load key: logic0 MARK_ACTIVE (BUNNY_COUNT).
 */
import WEED from '/src/index.js';
import { Bunny } from '/demos/bunnyMarkScene/gameObjects/bunny.js';
import { BunnySolver } from './bunnyMark/bunnySolver.js';
import { WorldWall } from './bunnyMark/worldWall.js';
import { TOY_WORLD_W, TOY_WORLD_H } from '/src/util/toyWorldBounce.js';

const { Scene, Camera } = WEED;

export const BUNNY_COUNT = 20000;
export const WORLD_W = TOY_WORLD_W;
export const WORLD_H = TOY_WORLD_H;

const SHARED = {
  worldWidth: WORLD_W,
  worldHeight: WORLD_H,
  seed: 1,
  spatial: {
    numberOfSpatialWorkers: 0,
    cellSize: 1024,
    maxNeighbors: 0,
    noLimitFPS: false,
  },
  logic: {
    numberOfLogicWorkers: 1,
    noLimitFPS: false,
  },
  particle: {
    maxParticles: 0,
    decals: false,
  },
  renderer: {
    backend: 'webgl',
    noLimitFPS: false,
    ySorting: false,
    maxVisibleRenderables: 65535,
  },
  lighting: { enabled: false },
};

function spawnBunnies(scene, EntityClass, n) {
  const rng = globalThis.rng;
  for (let i = 0; i < n; i++) {
    scene.spawnEntity(EntityClass, {
      x: WORLD_W * rng(),
      y: WORLD_H * rng(),
    });
  }
  Camera.setZoom(1);
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
}

export class BunnyMarkStressScene extends Scene {
  static config = {
    ...SHARED,
    physics: {
      gravity: { x: 0, y: 0 },
      noLimitFPS: false,
    },
  };
  static assets = { textures: {} };
  static entities = [[Bunny, BUNNY_COUNT]];

  create() {
    spawnBunnies(this, Bunny, BUNNY_COUNT);
  }
}

export class BunnyMarkStressCScene extends Scene {
  static config = {
    ...SHARED,
    physics: {
      enabled: false,
      gravity: { x: 0, y: 0 },
      noLimitFPS: false,
    },
  };
  static assets = { textures: {} };
  static entities = [[Bunny, BUNNY_COUNT]];

  create() {
    spawnBunnies(this, Bunny, BUNNY_COUNT);
  }
}

/** Same mark, Box2D integrates. No BunnyMotion. No tick. */
export class BunnyMarkStressDScene extends Scene {
  static config = {
    ...SHARED,
    physics: {
      gravity: { x: 0, y: 0 },
      noLimitFPS: false,
      sleeping: false,
      subStepCount: 1,
    },
  };
  static assets = { textures: {} };
  static entities = [
    [BunnySolver, BUNNY_COUNT],
    [WorldWall, 4],
  ];

  create() {
    const t = 80;
    this.spawnEntity(WorldWall, {
      x: -t * 0.5,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H + t * 2,
    });
    this.spawnEntity(WorldWall, {
      x: WORLD_W + t * 0.5,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H + t * 2,
    });
    this.spawnEntity(WorldWall, {
      x: WORLD_W * 0.5,
      y: -t * 0.5,
      width: WORLD_W + t * 2,
      height: t,
    });
    this.spawnEntity(WorldWall, {
      x: WORLD_W * 0.5,
      y: WORLD_H + t * 0.5,
      width: WORLD_W + t * 2,
      height: t,
    });
    spawnBunnies(this, BunnySolver, BUNNY_COUNT);
  }
}
