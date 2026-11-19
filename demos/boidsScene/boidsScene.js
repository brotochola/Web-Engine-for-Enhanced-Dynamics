// BoidsScene.js - 10k flocking showcase
// Bare demo: squares + classic boids rules, no tilemap/lights

import { Boid } from '/demos/predatorScene/gameObjects/boid.js';
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

// `?boids=<n>`: the flock spawned (40 000 by default, the pool's 65 000 at most), a load knob for spatial sittings:
// 40 000 boids run each spatial worker about 5 ms, under the 6 ms floor a STEP_MS verdict needs.
// N-253: physics scenes take up to 1 048 575 entities now: `?boids=` past 65 000 grows the pool, Box2D's memory
// (about 2 KB a boid with its contacts) and the render cap with it.
const BOIDS_ASKED = Math.max(0, Math.min(1048000, Number(WEED.params?.get('boids') ?? 40000) | 0));
const POOL = Math.max(65000, BOIDS_ASKED);
// The flock spawns over several frames: all 40 000 at once queued 286 000 Box2D commands in a 4 096 ring.
const BOIDS_PER_FRAME = 1000;
const BOIDS = BOIDS_ASKED;

export class BoidsScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 4000,
    seed: 123456,
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
      // The flock spawns BOIDS_PER_FRAME a frame (7 commands a boid, so 7 000 a frame): 16 384 holds a frame's burst.
      commandRingCapacity: 16384,
      wasmMemoryMB: Math.min(2048, Math.max(128, Math.ceil(POOL / 500))),
      gravity: { x: 0, y: 0 },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: Math.max(65530, POOL),
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
    this.boidsSpawned = 0;
  }

  create() {
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
  }

  createNewGame() {
    this.boidsSpawned = 0;
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    if (this.boidsSpawned < BOIDS) {
      const batch = Math.min(BOIDS_PER_FRAME, BOIDS - this.boidsSpawned);
      this.spawnBoids(batch);
      this.boidsSpawned += batch;
    }
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
