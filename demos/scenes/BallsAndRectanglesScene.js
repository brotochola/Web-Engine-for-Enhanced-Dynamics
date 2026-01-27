// BallsAndRectanglesScene.js - Physics Demo with Balls and Boxes
// Demonstrates mixed circle and rectangle collisions

import { Ball } from "/demos/gameObjects/ball.js";
import { Box } from "/demos/gameObjects/box.js";
import { Camera } from "/src/core/Camera.js";
import WEED from "/src/index.js";

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
      subStepCount: 5,
      noLimitFPS: false,
      maxCollisionPairs: 100000,
      verletDamping: 0.99,
      boundaryElasticity: 0.3,
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
      box: "/demos/img/box_100_100.png",
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

    // Camera control settings
    this.cameraPanSpeed = 10; // Pixels per frame at zoom 1
    this.cameraFollowX = 0;
    this.cameraFollowY = 0;
  }

  create() {
    // Spawn initial entities
    console.log("🎬 BallsAndRectanglesScene: Spawning entities...");

    this.spawnBalls(this.numberOfBalls);
    this.spawnBoxes(this.numberOfBoxes);

    // Initialize camera at world center
    this.cameraFollowX = this.config.worldWidth / 2;
    this.cameraFollowY = this.config.worldHeight / 2;
    Camera.centerOn(this.cameraFollowX, this.cameraFollowY);

    console.log(
      `✅ BallsAndRectanglesScene: Spawned ${this.numberOfBalls} balls and ${this.numberOfBoxes} boxes!`
    );
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
      this.spawnEntity("Ball", {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnBoxes(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("Box", {
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

  spawnRandomBox() {
    this.spawnEntity("Box", {
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

  async spawnBoxAtMouse() {
    const { Mouse } = await import("/src/core/Mouse.js");
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity("Box", {
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
    if (confirm("Clear all entities?")) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: "clearAll" });
      });
    }
  }
}
