// BallsScene.js - Gravity and Separation Physics Demo
// Demonstrates balls with physics, gravity, and collision

import { Ball } from "/demos/ball.js";

import WEED from "/src/index.js";
const { Scene, Camera, Mouse } = WEED;

export class BallsScene extends Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 9000,
    worldHeight: 4000,

    // Spatial hash grid configuration
    spatial: {
      cellSize: 50,
      maxNeighbors: 100,
      noLimitFPS: true,
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
      subStepCount: 1,
      noLimitFPS: true,
      maxCollisionPairs: 0, //this is to trigger the collision callbacks, not the resolve collisions
      verletDamping: 0.99,
      boundaryElasticity: 0,
      collisionResponseStrength: 0.9,
      gravity: { x: 0, y: 0.5 },
    },

    renderer: {
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
      ball: "/demos/img/bola.png",
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [Ball, 10000], // Pre-allocate pool for 10000 balls
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Scene-specific properties
    this.numberOfBalls = 5000;

    // Camera control settings
    this.cameraPanSpeed = 10; // Pixels per frame at zoom 1
    this.cameraFollowX = 0;
    this.cameraFollowY = 0;
  }

  create() {
    // Spawn initial entities
    console.log("🎬 BallsScene: Spawning balls...");

    this.spawnBalls(this.numberOfBalls);

    // Initialize camera at world center
    this.cameraFollowX = this.config.worldWidth / 2;
    this.cameraFollowY = this.config.worldHeight / 2;
    Camera.centerOn(this.cameraFollowX, this.cameraFollowY);

    console.log("✅ BallsScene: Balls spawned!");
  }

  update(time, delta) {
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
    this.cameraFollowX = Math.max(
      0,
      Math.min(this.cameraFollowX, this.config.worldWidth)
    );
    this.cameraFollowY = Math.max(
      0,
      Math.min(this.cameraFollowY, this.config.worldHeight)
    );

    // Update camera (handles smooth following and zoom lerping)
    Camera.follow(this.cameraFollowX, this.cameraFollowY, 0.15);
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnBalls(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Ball, {
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
    if (confirm("Clear all balls?")) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: "clearAll" });
      });
    }
  }
}
