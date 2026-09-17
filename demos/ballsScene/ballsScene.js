// BallsScene.js - Gravity and Separation Physics Demo
// Demonstrates balls with physics, gravity, and collision

import { Ball } from './gameObjects/ball.js';
import { Floor } from './gameObjects/floor.js';

import WEED from '/src/index.js';
const { Scene, Camera, Keyboard, Mouse, Box2d, Query, RigidBody } = WEED;

export class BallsScene extends Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 4000,
    worldHeight: 5000,
    seed: 123456,

    // Spatial hash grid configuration
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 100,
      maxNeighbors: 512,
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
      box2dWorkerCount: 4,
      subStepCount: 4,
      noLimitFPS: false,
      gravity: { x: 0, y: 1800 },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 11000,
    },

    lighting: {
      enabled: false,
    },
    // debug: {
    //   maxDebugDrawEntries: 30192,
    //   collectDetailedStats: true,
    // },
  };

  // ========================================
  // STATIC ASSETS CONFIGURATION
  // ========================================

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [Ball, 20000], // Pre-allocate pool for 10000 balls
    [Floor, 1000], // Pre-allocate pool for floor and walls
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);
  }

  create() {
    // Spawn floor and walls first (static colliders)
    console.log('🎬 BallsScene: Spawning floor and walls...');
    this.spawnFloorAndWalls();

    // Spawn initial entities
    console.log('🎬 BallsScene: Spawning balls...');

    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);

    console.log('✅ BallsScene: Balls spawned!');
    // Camera.setZoom(0.5);
  }
  createNewGame() {
    this.spawnBalls(9000);
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    if (Keyboard.isPressed('e')) {
      Box2d.explode({
        x: Mouse.x,
        y: Mouse.y,
        radius: 400,
        impulsePerLength: 12,
      });
    }
    Query.queryActiveEntities([RigidBody]);
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnFloorAndWalls() {
    const wallThickness = 1000; // Thickness of walls and floor
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    // Floor - at the bottom
    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: worldHeight + wallThickness * 0.5 - 50,
      width: worldWidth,
      height: wallThickness,
    });

    // Top wall
    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: -wallThickness / 2,
      width: worldWidth,
      height: wallThickness,
    });

    // Left wall
    this.spawnEntity(Floor, {
      x: -wallThickness / 2 + 50,
      y: worldHeight / 2,
      width: wallThickness,
      height: worldHeight,
    });

    // Right wall
    this.spawnEntity(Floor, {
      x: worldWidth + wallThickness / 2 - 50,
      y: worldHeight / 2,
      width: wallThickness,
      height: worldHeight,
    });
  }

  spawnBalls(count) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        this.spawnEntity(Ball, {
          x: 0.2 * this.config.worldWidth + this.rng() * this.config.worldWidth * 0.6,
          y: 0.2 * this.config.worldHeight + this.rng() * this.config.worldHeight * 0.6,
          vx: 0,
          vy: 0,
          // radius:20
        });
      }, i * 0.01)

    }
  }

  // ========================================
  // PUBLIC SPAWNING METHODS (for UI buttons)
  // ========================================

  spawnRandomBall() {
    this.spawnEntity(Ball, {
      x: this.rng() * this.config.worldWidth,
      y: this.rng() * this.config.worldHeight,
      vx: 0,
      vy: 0,
    });
  }

  async spawnBallAtMouse() {
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity(Ball, {
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

  clearAllEntities() {
    if (confirm('Clear all balls?')) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: 'clearAll' });
      });
    }
  }
}
