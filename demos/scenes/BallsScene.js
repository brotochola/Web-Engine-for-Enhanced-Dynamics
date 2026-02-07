// BallsScene.js - Gravity and Separation Physics Demo
// Demonstrates balls with physics, gravity, and collision

import { Ball } from '/demos/gameObjects/ball.js';
import { Floor } from '/demos/gameObjects/floor.js';

import WEED from '/src/index.js';
const { Scene, Camera, Mouse } = WEED;

export class BallsScene extends Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 4000,
    worldHeight: 5000,

    // Spatial hash grid configuration
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 100,
      maxNeighbors: 512,
      noLimitFPS: true,
      collisionCandidateSearchMargin: 0.5
    },

    // Logic configuration
    logic: {
      noLimitFPS: true,
    },

    particle: {
      noLimitFPS: true,
      maxParticles: 0,
      decals: false,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },

    // Physics configuration
    physics: {
      subStepCount: 3, // Subdivide each 60fps frame into 4 constraint-solving passes
      noLimitFPS: true, // Run physics as fast as possible (uses fixed-timestep accumulator)
      maxCollisionPairs: 100000, //this is to trigger the collision callbacks, not the resolve collisions
      verletDamping: 0.9999,
      boundaryElasticity: 0,
      collisionResponseStrength: 0.66,
      gravity: { x: 0, y: 0.5 },
      sleepThreshold: 0.5,
      wakeUpThreshold: 0.5,
      sleepDuration: 10,
    },

    renderer: {
      noLimitFPS: true,
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
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [Ball, 10000], // Pre-allocate pool for 10000 balls
    [Floor, 1000], // Pre-allocate pool for floor and walls
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Camera control settings
    this.cameraPanSpeed = 10; // Pixels per frame at zoom 1
    this.cameraFollowX = 0;
    this.cameraFollowY = 0;
  }

  create() {
    // Spawn floor and walls first (static colliders)
    console.log('🎬 BallsScene: Spawning floor and walls...');
    this.spawnFloorAndWalls();

    // Spawn initial entities
    console.log('🎬 BallsScene: Spawning balls...');

    this.spawnBalls(9000);

    // Initialize camera at world center
    this.cameraFollowX = this.config.worldWidth / 2;
    this.cameraFollowY = this.config.worldHeight / 2;
    Camera.centerOn(this.cameraFollowX, this.cameraFollowY);

    console.log('✅ BallsScene: Balls spawned!');
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    // Handle WASD camera panning (use this.keyboard which is the main thread keyboard state)
    const panSpeed = this.cameraPanSpeed / Camera.zoom;
    const kb = this.keyboard;

    if (kb.w || kb.arrowup) {
      this.cameraFollowY -= panSpeed;
    }
    if (kb.s || kb.arrowdown) {
      this.cameraFollowY += panSpeed;
    }
    if (kb.a || kb.arrowleft) {
      this.cameraFollowX -= panSpeed;
    }
    if (kb.d || kb.arrowright) {
      this.cameraFollowX += panSpeed;
    }

    // Clamp camera target to world bounds
    this.cameraFollowX = Math.max(0, Math.min(this.cameraFollowX, this.config.worldWidth));
    this.cameraFollowY = Math.max(0, Math.min(this.cameraFollowY, this.config.worldHeight));

    // Update camera (handles smooth following and zoom lerping)
    Camera.follow(this.cameraFollowX, this.cameraFollowY, 0.15);

    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.001));

    if (frameNumber % (60 * 5) === 0) {
      this.printFPS()
    }

  }
  printFPS() {
    const smoothing = this.game.debugUI?.fpsSmoothing;
    if (!smoothing) {
      console.log('DebugUI not available');
      return;
    }

    const getSmoothedFPS = (s) => (s.sum / s.values.length).toFixed(2);

    // Log all worker FPS (smoothed, same as DebugUI)
    console.log('=== Worker FPS (averaged) ===', performance.now());
    for (let i = 0; i < smoothing.spatial.length; i++) {
      console.log(`Spatial ${i}: ${getSmoothedFPS(smoothing.spatial[i])} FPS`);
    }
    console.log(`Physics: ${getSmoothedFPS(smoothing.physics)} FPS`);
    console.log(`Renderer: ${getSmoothedFPS(smoothing.renderer)} FPS`);
    console.log(`Particle: ${getSmoothedFPS(smoothing.particle)} FPS`);
    for (let i = 0; i < smoothing.logic.length; i++) {
      console.log(`Logic ${i}: ${getSmoothedFPS(smoothing.logic[i])} FPS`);
    }
  }
  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnFloorAndWalls() {
    const wallThickness = 150; // Thickness of walls and floor
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    // Floor - at the bottom
    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: worldHeight - wallThickness / 2 - wallThickness * 3,
      width: worldWidth,
      height: wallThickness,
    });

    // Top wall
    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: wallThickness / 2,
      width: worldWidth,
      height: wallThickness,
    });

    // Left wall
    this.spawnEntity(Floor, {
      x: wallThickness / 2,
      y: worldHeight / 2,
      width: wallThickness,
      height: worldHeight,
    });

    // Right wall
    this.spawnEntity(Floor, {
      x: worldWidth - wallThickness / 2,
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
        });
      }, i)

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
