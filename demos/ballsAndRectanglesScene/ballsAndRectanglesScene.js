// BallsAndRectanglesScene.js - Physics Demo with Balls and Boxes
// Demonstrates mixed circle and rectangle collisions

import { Ball } from '/demos/ballsScene/gameObjects/ball.js';
import { Box } from './gameObjects/box.js';
import { Camera } from '/src/core/camera.js';
import WEED from '/src/index.js';

export class BallsAndRectanglesScene extends WEED.Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 9000,
    worldHeight: 4000,

    // Spatial hash grid configuration
    spatial: {
      cellSize: 100, // Larger cells for boxes
      maxNeighbors: 900,
      noLimitFPS: false,
    },

    // Logic configuration
    logic: {
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },

    // Physics configuration
    physics: {
      subStepCount: 5,
      noLimitFPS: false,

      gravity: { x: 0, y: 1800 },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },

    lighting: {
      enabled: false,
    },
  };

  // ========================================
  // STATIC ASSETS CONFIGURATION
  // ========================================

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
      box: '/demos/img/box_100_100.png',
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [Ball, 5000], // Pre-allocate pool for 5000 balls
    [Box, 1500], // Pre-allocate pool for 500 boxes
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Scene-specific properties
    this.numberOfBalls = 2000;
    this.numberOfBoxes = 100;
  }

  create() {
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
  }

  createNewGame() {
    console.log('🎬 BallsAndRectanglesScene: Spawning entities...');
    this.spawnBalls(this.numberOfBalls);
    this.spawnBoxes(this.numberOfBoxes);
    console.log(
      `✅ BallsAndRectanglesScene: Spawned ${this.numberOfBalls} balls and ${this.numberOfBoxes} boxes!`
    );
  }

  update(time, delta) {
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnBalls(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity('Ball', {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnBoxes(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity('Box', {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  // ========================================
  // PUBLIC SPAWNING METHODS (for UI buttons)
  // ========================================

  spawnRandomBall() {
    this.spawnEntity('Ball', {
      x: this.rng() * this.config.worldWidth,
      y: this.rng() * this.config.worldHeight,
      vx: 0,
      vy: 0,
    });
  }

  spawnRandomBox() {
    this.spawnEntity('Box', {
      x: this.rng() * this.config.worldWidth,
      y: this.rng() * this.config.worldHeight,
      vx: 0,
      vy: 0,
    });
  }

  async spawnBallAtMouse() {
    const { Mouse } = await import('/src/core/mouse.js');
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity('Ball', {
        x: Mouse.x,
        y: Mouse.y,
        vx: 0,
        vy: 0,
      });
    }
  }

  async spawnBoxAtMouse() {
    const { Mouse } = await import('/src/core/mouse.js');
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity('Box', {
        x: Mouse.x,
        y: Mouse.y,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnMultipleBalls(count = 10) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.spawnRandomBall();
      }, i * 50);
    }
  }

  spawnMultipleBoxes(count = 10) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.spawnRandomBox();
      }, i * 50);
    }
  }

  clearAllEntities() {
    if (confirm('Clear all entities?')) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: 'clearAll' });
      });
    }
  }
}
