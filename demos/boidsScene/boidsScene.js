// BoidsScene.js - 10k flocking showcase
// Bare demo: squares + classic boids rules, no tilemap/lights

import { Boid } from '/demos/predatorScene/gameObjects/boid.js';
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

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
      gravity: { x: 0, y: 0 },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 65530,
      ySorting: false,
    },
    preRender: {
      // skipCull: false,
      // fixedFps: 30,
      interpolation: true,
      // entityBlockSize: 256,
      numberOfPreRenderWorkers: 1,
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
    [Boid, 65000],
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
    this.spawnBoids(40000);
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
  }

  spawnBoids(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Boid, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: (this.rng() - 0.5) * 800,
        vy: (this.rng() - 0.5) * 800,
        sprite: 'square',
      });
    }
  }
}
