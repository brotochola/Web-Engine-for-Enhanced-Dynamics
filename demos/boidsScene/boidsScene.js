// BoidsScene.js - 10k flocking showcase
// Bare demo: squares + classic boids rules, no tilemap/lights

import { Boid } from '/demos/predatorScene/gameObjects/boid.js';
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

// `?boids=<n>`: the flock spawned (40 000 by default), a load knob for spatial sittings: 40 000 boids run each spatial
// worker about 5 ms, under the 6 ms floor a STEP_MS verdict needs. The pool holds 65 000, or the flock past that up to
// the engine's 500 000 entities (the scene then takes 32-bit entity ids: entityIdWidth 'auto'), so a capacity search
// (tests/bench/runCapacity.mjs) can go past the 65 000 that 60 fps already held. `?ids=32` takes 32-bit ids at any
// flock, so the search compares like with like on both sides of 65 535.
const BOIDS = Math.max(0, Math.min(500000, Number(WEED.params?.get('boids') ?? 40000) | 0));
const POOL = Math.max(65000, BOIDS);
const ENTITY_ID_WIDTH = WEED.params?.get('ids') === '32' ? 32 : 'auto';

export class BoidsScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 4000,
    seed: 123456,
    entityIdWidth: ENTITY_ID_WIDTH,
    // debug: {
    //   maxDebugDrawEntries: 30192,
    //   collectDetailedStats: true,
    // },
    spatial: {
      cellSize: 20,
      maxNeighbors: 128,
      maxEntitiesPerCell: 20,
      numberOfSpatialWorkers: 2,
      noLimitFPS: false,
      neighborReuseSkin: 0.01,
      neighborReuseMaxFrames: 30,
      neighborTickInterval: 15,
    },

    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 4,
      staggeredUpdates: true, // required for Boid.tickInterval
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
    },

    physics: {
      subStepCount: 0,
      noLimitFPS: false,
      sleeping: false,
      gravity: { x: 0, y: 0 },
      // Every boid is a body: 65 000 fill about 87 MB of the default 128 (with the render queue's regions), so a
      // flock past the pool's 65 000 gets 128 MB for each 65 000.
      ...(BOIDS > 65000 ? { wasmMemoryMB: Math.min(2048, 128 * Math.ceil(BOIDS / 65000)) } : {}),
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: Math.max(65530, BOIDS),
      ySort: false,
    },
    preRender: {
      // skipCull: false,
      // fixedFps: 30,
      interpolation: true,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      square: '/demos/img/10_10_square.png',
    },
  };

  static entities = [
    [Boid, POOL],
  ];

  constructor(game) {
    super(game);
  }

  create() {
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
  }

  createNewGame() {
    this.spawnBoids(BOIDS);
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
  }

  spawnBoids(count) {
    for (let i = 0; i < count; i++) {
      Boid.spawn({
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: (this.rng() - 0.5) * 800,
        vy: (this.rng() - 0.5) * 800,
        sprite: 'square',
      });
    }
  }
}
