// PredatorScene.js - Predators vs Prey gameplay scene
// Demonstrates the new Scene-based architecture for WeedJS

import WEED from "/src/index.js";
import { Boid } from "../boid.js";
import { Prey } from "../prey.js";
import { Predator } from "../predator.js";
import { Player } from "../player.js";
import { TallLight } from "../tallLight.js";
import { PreySpawner } from "../PreySpawner.js";
import { House } from "../House.js";

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
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: false,
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
      useMainThreadAsLogicWorker: false, //this is buggy, dont use it for now
      mainThreadMaxJobsPerFrame: 5,
    },

    // Physics configuration
    physics: {
      subStepCount: 0,
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
      house: "/demos/img/house.png",
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
    [PreySpawner, 1],
    [Prey, 20000],
    [Predator, 8],
    [Player, 1],
    [TallLight, 10],
    [Boid, 0], // Register but don't pre-allocate
    [House, 20],
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Scene-specific properties
    this.numberOfPrey = 1000;
    this.numberOfPredators = 1;
    this.numberOfBoids = 0;
    this.numberOfTallLights = 10;
    this.numberOfHouses = 10;

    // Player reference (will be set in create())
    this.playerEntity = null;

    this.frameCount = 0;
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
    this.spawnHouses(this.numberOfHouses);
    this.spawnEntity(PreySpawner, {});

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
    this.playerEntity = this.spawnEntity(Player, {
      x: this.config.worldWidth / 2,
      y: this.config.worldHeight / 2,
      vx: 0,
      vy: 0,
    });
  }
  spawnHouses(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(House, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  spawnPrey(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Prey, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnPredators(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Predator, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnBoids(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Boid, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        vx: 0,
        vy: 0,
      });
    }
  }

  spawnLights(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(TallLight, {
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
      this.spawnEntity(Prey, {
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
      this.spawnEntity(Predator, {
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
