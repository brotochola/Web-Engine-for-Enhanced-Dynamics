// PredatorScene.js - Predators vs Prey gameplay scene
// Demonstrates the new Scene-based architecture for WeedJS

import WEED from "/src/index.js";
import { Boid } from "../boid.js";
import { Prey } from "../prey.js";
import { Predator } from "../predator.js";
import { Player } from "../player.js";
import { TallLight } from "../tallLight.js";

export class PredatorScene extends WEED.Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 5000,
    worldHeight: 2000,
    seed: 123456,

    // Spatial hash grid configuration
    spatial: {
      cellSize: 128,
      maxNeighbors: 1500,
      noLimitFPS: true,
    },

    particle: {
      noLimitFPS: true,
      maxParticles: 50000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },

    // Logic configuration
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 3,
      numberOfEntitiesPerJob: 250,
      useMainThreadAsLogicWorker: true,
      mainThreadMaxJobsPerFrame: 0,
    },

    // Physics configuration
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      maxCollisionPairs: 1000000,
      boundaryElasticity: 0,
      collisionResponseStrength: 0.9,
      verletDamping: 0.99,
      gravity: { x: 0, y: 0 },
    },

    renderer: {
      noLimitFPS: false,
      bg: "bg",
      bgTileScale: 1,
      ySorting: true,
    },

    lighting: {
      enabled: true,
      lightingAmbient: 0,
      maxLights: 100,
      shadowsEnabled: true,
      maxShadowCastingLights: 100,
      maxShadowsPerLight: 500,
      maxShadowsPerEntity: 5,
      maxFlashes: 50,
    },
  };

  // ========================================
  // STATIC ASSETS CONFIGURATION
  // ========================================

  static assets = {
    textures: {
      bg: "/demos/img/bg.png",
      bunny: "/demos/img/bunny.png",
      blood: "/demos/img/blood.png",
      tallLight: "/demos/img/tallLight.png",
    },
    spritesheets: {
      civil1: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil1.png",
      },
      civil2: {
        json: "/demos/img/civil2.json",
        png: "/demos/img/civil2.png",
      },
      civil3: {
        json: "/demos/img/civil3.json",
        png: "/demos/img/civil3.png",
      },
      civil4: {
        json: "/demos/img/civil4.json",
        png: "/demos/img/civil4.png",
      },
      civil5: {
        json: "/demos/img/civil5.json",
        png: "/demos/img/civil5.png",
      },
      civil6: {
        json: "/demos/img/civil6.json",
        png: "/demos/img/civil6.png",
      },
      civil7: {
        json: "/demos/img/civil7.json",
        png: "/demos/img/civil7.png",
      },
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [Prey, 15000],
    [Predator, 8],
    [Player, 1],
    [TallLight, 10],
    [Boid, 0], // Register but don't pre-allocate
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Scene-specific properties
    this.numberOfPrey = 15000;
    this.numberOfPredators = 8;
    this.numberOfBoids = 0;
    this.numberOfTallLights = 10;

    // Player reference (will be set in create())
    this.playerEntity = null;
  }

  create() {
    // Spawn initial entities
    console.log("🎬 PredatorScene: Spawning entities...");

    // Spawn player first
    this.spawnPlayer();

    this.spawnPredators(this.numberOfPredators);
    this.spawnBoids(this.numberOfBoids);
    this.spawnLights(this.numberOfTallLights);
    this.spawnPrey(this.numberOfPrey);

    console.log("✅ PredatorScene: Entities spawned!");
  }

  update(time, delta) {
    // Optional: Add scene-specific per-frame logic here
    // For example, spawning waves of enemies, checking win conditions, etc.
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnPlayer() {
    this.playerEntity = this.spawnEntity("Player", {
      x: this.config.worldWidth / 2,
      y: this.config.worldHeight / 2,
      vx: 0,
      vy: 0,
    });
  }

  spawnPrey(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("Prey", {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnPredators(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("Predator", {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnBoids(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("Boid", {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnLights(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity("TallLight", {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  // ========================================
  // PUBLIC SPAWNING METHODS (for UI buttons)
  // ========================================

  spawnRandomPrey() {
    this.spawnPrey(1);
  }

  spawnRandomPredator() {
    this.spawnPredators(1);
  }

  async spawnPreyAtMouse() {
    // Access Mouse through the component system
    const { Mouse } = await import("/src/core/Mouse.js");
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity("Prey", {
        x: Mouse.x,
        y: Mouse.y,
        vx: 0,
        vy: 0,
      });
    }
  }

  async spawnPredatorAtMouse() {
    // Access Mouse through the component system
    const { Mouse } = await import("/src/core/Mouse.js");
    if (Mouse.x > 0 && Mouse.y > 0) {
      this.spawnEntity("Predator", {
        x: Mouse.x,
        y: Mouse.y,
        vx: 0,
        vy: 0,
      });
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
