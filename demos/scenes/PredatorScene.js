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
import { PersonWithFSM } from "../PersonWithFSM.js";
import { Tree } from "../tree.js";
import { Barrel } from "../barrel.js";
import { Rock } from "../rock.js";
import { Fire } from "../fire.js";
import { Explosion } from "../explosion.js";

const { DecorationPool } = WEED;

const excludedLPCAnimations = [
  "spellcast_up",
  "spellcast_left",
  "spellcast_down",
  "spellcast_right",
  "thrust_up",
  "thrust_left",
  "thrust_down",
  "thrust_right",
  "slash_up",
  "slash_left",
  "slash_down",
  "slash_right",
  "climb",
  "emote_up",
  "emote_left",
  "emote_down",
  "emote_right",
];

export class PredatorScene extends WEED.Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 10240,
    worldHeight: 7680,
    seed: 123456,
    debugUpdateInterval: 100,

    // Spatial hash grid configuration
    spatial: {
      cellSize: 128,
      maxNeighbors: 500,
      maxEntitiesPerCell: 64, //this is very important!!
      numberOfSpatialWorkers: 2, // Multiple workers for parallel neighbor detection
      noLimitFPS: true,
    },

    particle: {
      noLimitFPS: true,
      maxParticles: 20000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },

    decoration: {
      maxDecorations: 10000, // Non-interactive decorations like grass
    },

    // Logic configuration
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 3,
      numberOfEntitiesPerJob: 250,
    },

    // Physics configuration
    physics: {
      subStepCount: 0,
      noLimitFPS: true,
      maxCollisionPairs: 1000000,
      boundaryElasticity: 0,
      collisionResponseStrength: 0.9,
      verletDamping: 0.99,
      gravity: { x: 0, y: 0 },
    },

    renderer: {
      noLimitFPS: true,
      ySorting: true,
      interpolation: true,
      cullingRatio: 0.33,
    },

    lighting: {
      enabled: true,
      lightingAmbient: 0,
      maxLights: 100,
      shadowsEnabled: true,
      maxShadowCastingLights: 100,
      maxShadowsPerLight: 500,
      maxShadowsPerEntity: 10,
      maxShadowSprites: 1000,
      maxFlashes: 50,
      resolution: 0.25,
    },

    navigation: {
      noLimitFPS: true,
      enabled: true,
      cellSize: 64,
      maxFlowfields: 16,
      maxPaths: 64,
      maxPathLength: 128,
    },
  };

  // ========================================
  // STATIC ASSETS CONFIGURATION
  // ========================================

  static assets = {
    textures: {
      rock1: "/demos/img/rock1.png",
      rock2: "/demos/img/rock2.png",
      rock3: "/demos/img/rock3.png",
      rock4: "/demos/img/rock4.png",
      bg: "/demos/img/bg.png",
      bunny: "/demos/img/bunny.png",
      blood: "/demos/img/blood.png",
      tallLight: "/demos/img/tallLight.png",
      house1: "/demos/img/house1.png",
      house2: "/demos/img/house2.png",
      grass1: "/demos/img/g1.png",
      grass2: "/demos/img/g2.png",
      grass3: "/demos/img/g3.png",
      grass4: "/demos/img/g4.png",
      tree1: "/demos/img/tree1.png",
      tree2: "/demos/img/tree2.png",
      barrel1: "/demos/img/barrel1.png",
      barrel2: "/demos/img/barrel2.png",
      barrel3: "/demos/img/barrel3.png",
      square: "/demos/img/10_10_square.png",
      smoke: "/demos/img/smoke.png",
    },
    spritesheets: {
      civil1: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil1.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil2: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil2.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil3: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil3.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil4: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil4.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil5: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil5.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil6: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil6.png",
        excludeAnimations: excludedLPCAnimations,
      },
      civil7: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/civil7.png",
        excludeAnimations: excludedLPCAnimations,
      },
      poli: {
        json: "/demos/img/civil1.json",
        png: "/demos/img/poli.png",
        excludeAnimations: excludedLPCAnimations,
      },
      fire: {
        json: "/demos/img/fuego/fuego.json",
        png: "/demos/img/fuego/fuego.png",
      },
      explosions: {
        json: "/demos/img/explosions/explosions.json",
        png: "/demos/img/explosions/explosions.png",
      },
    },
    tilemaps: {
      predatorsBG: {
        json: "/demos/img/tilemap/t.json",
        png: "/demos/img/tilemap/t.png",
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
    [House, 100],
    [TallLight, 300],
    [PersonWithFSM, 20000], // FSM-based civilians
    [Tree, 1000],
    [Barrel, 100],
    [Rock, 1000],
    [Fire, 100],
    [Explosion, 100],
    // Grass now uses DecorationPool instead of GameObject
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    // Scene-specific properties
    this.numberOfPrey = 10000;
    this.numberOfPredators = 1;
    this.numberOfBoids = 0;
    this.numberOfTallLights = 200;
    this.numberOfHouses = 100;
    this.numberOfGrass = 10000;
    this.numberOfPersonsWithFSM = 5000; // FSM-based civilians
    this.numberOfTrees = 1000;
    this.numberOfBarrels = 100;
    this.numberOfRocks = 1000;
    // Player reference (will be set in create())
    this.playerEntity = null;

    this.frameCount = 0;
  }

  create() {
    // Set tilemap background
    this.setTilemapBackground("predatorsBG", { scale: 2 });

    // Spawn initial entities
    console.log("🎬 PredatorScene: Spawning entities...");

    // Spawn player first
    this.spawnPlayer();

    this.spawnPredators(this.numberOfPredators);
    this.spawnBoids(this.numberOfBoids);
    this.spawnLights(this.numberOfTallLights);
    this.spawnPrey(this.numberOfPrey);
    this.spawnHouses(this.numberOfHouses);
    this.spawnGrass(this.numberOfGrass);
    this.spawnPersonsWithFSM(this.numberOfPersonsWithFSM);
    this.spawnEntity(PreySpawner, {});
    this.spawnTrees(this.numberOfTrees);
    this.spawnBarrels(this.numberOfBarrels);
    this.spawnRocks(this.numberOfRocks);
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
  spawnBarrels(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Barrel, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  spawnRocks(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Rock, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
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

  spawnPersonsWithFSM(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(PersonWithFSM, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  spawnGrass(count) {
    console.log("Spawning grass...");
    // Spawn grass using DecorationPool (lightweight, no GameObject overhead)
    for (let i = 0; i < count; i++) {
      const scale = 0.75 + this.rng() * 0.5
      const grassType = Math.floor(this.rng() * 4) + 1; // grass1 to grass9
      DecorationPool.spawn({
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        texture: "grass" + grassType,
        scale: scale,
        alpha: 0.7 + this.rng() * 0.3,
        anchorX: 0.5,
        anchorY: 1.0, // Bottom anchor for grass
      });
    }
  }

  spawnTrees(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Tree, {
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
