// BallsScene.js - Gravity and Separation Physics Demo
// Demonstrates balls with physics, gravity, and collision

import { Scene } from "/src/core/Scene.js";
import { Ball } from "/demos/ball.js";

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
      maxNeighbors: 900,
      noLimitFPS: true,
    },

    // Logic configuration
    logic: {
      noLimitFPS: false,
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
      subStepCount: 2,
      noLimitFPS: true,
      maxCollisionPairs: 0,
      verletDamping: 0.99,
      boundaryElasticity: 0,
      collisionResponseStrength: 0.8,
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
    this.numberOfBalls = 10000; // Start with fewer balls
  }

  create() {
    // Spawn initial entities
    console.log("🎬 BallsScene: Spawning balls...");

    this.spawnBalls(this.numberOfBalls);

    console.log("✅ BallsScene: Balls spawned!");
  }

  update(time, delta) {
    // Optional: Add scene-specific per-frame logic here
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnBalls(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("Ball", {
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
    this.spawnEntity("Ball", {
      x: this.rng() * this.config.worldWidth,
      y: this.rng() * this.config.worldHeight,
      vx: 0,
      vy: 0,
    });
  }

  async spawnBallAtMouse() {
    const { Mouse } = await import("/src/core/Mouse.js");
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity("Ball", {
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
