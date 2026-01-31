// PredatorScene.js - Predators vs Prey gameplay scene
// Demonstrates the new Scene-based architecture for WeedJS

import WEED from '/src/index.js';
import { Boid } from '../gameObjects/boid.js';
import { Prey } from '../gameObjects/prey.js';
import { Predator } from '../gameObjects/predator.js';
// import { Player } from "../gameObjects/player.js";
import { TallLight } from '../gameObjects/tallLight.js';
import { PreySpawner } from '../gameObjects/preySpawner.js';
import { House } from '../gameObjects/house.js';

import { Tree } from '../gameObjects/tree.js';
import { Barrel } from '../gameObjects/barrel.js';
import { Rock } from '../gameObjects/rock.js';
import { Fire } from '../gameObjects/fire.js';
import { Explosion } from '../gameObjects/explosion.js';
import { MySoldier } from '../gameObjects/mySoldier.js';
import { Destination } from '../gameObjects/destination.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { DropMoney } from '../gameObjects/dropMoney.js';
import { DropAk47 } from '../gameObjects/dropAk47.js';
import { DropShotgun } from '../gameObjects/dropShotgun.js';
import { DropPistol } from '../gameObjects/dropPistol.js';
import { Civilian } from '../gameObjects/civilian.js';
import { CameraController } from '../gameObjects/cameraController.js';

const { DecorationPool } = WEED;

const excludedLPCAnimations = [
  'spellcast_up',
  'spellcast_left',
  'spellcast_down',
  'spellcast_right',
  'thrust_up',
  'thrust_left',
  'thrust_down',
  'thrust_right',
  // "slash_up",
  // "slash_left",
  // "slash_down",
  // "slash_right",
  'climb',
  'emote_up',
  'emote_left',
  'emote_down',
  'emote_right',
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
      maxNeighbors: 800,
      maxEntitiesPerCell: 64, //this is very important!!
      numberOfSpatialWorkers: 4, // Multiple workers for parallel neighbor detection
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
      numberOfLogicWorkers: 2,
      numberOfEntitiesPerJob: 250,
      staggeredUpdates: true, // Enable tick decimation (entities tick based on their tickInterval)
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
      rock1: '/demos/img/rock1.png',
      rock2: '/demos/img/rock2.png',
      rock3: '/demos/img/rock3.png',
      rock4: '/demos/img/rock4.png',
      bg: '/demos/img/bg.png',
      blood: '/demos/img/blood.png',
      tallLight: '/demos/img/tallLight.png',
      house1: '/demos/img/house1.png',
      house2: '/demos/img/house2.png',
      grass1: '/demos/img/g1.png',
      grass2: '/demos/img/g2.png',
      grass3: '/demos/img/g3.png',
      grass4: '/demos/img/g4.png',
      tree1: '/demos/img/tree1.png',
      tree2: '/demos/img/tree2.png',
      barrel1: '/demos/img/barrel1.png',
      barrel2: '/demos/img/barrel2.png',
      barrel3: '/demos/img/barrel3.png',
      square: '/demos/img/10_10_square.png',
      smoke: '/demos/img/smoke.png',
      target: '/demos/img/target.png',
      money: '/demos/img/drops/money.png',
      pistol: '/demos/img/drops/pistol.png',
      ak47: '/demos/img/drops/ak47.png',
      shotgun: '/demos/img/drops/shotgun.png',
      explosion_decal: '/demos/img/explosion_decal.png',
    },
    spritesheets: {
      civil1: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil1.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil2: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil2.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil3: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil3.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil4: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil4.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil5: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil5.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil6: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil6.png',
        excludeAnimations: excludedLPCAnimations,
      },
      civil7: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/civil7.png',
        excludeAnimations: excludedLPCAnimations,
      },
      poli: {
        json: '/demos/img/civil1.json',
        png: '/demos/img/poli.png',
        excludeAnimations: excludedLPCAnimations,
      },
      fire: {
        json: '/demos/img/fuego/fuego.json',
        png: '/demos/img/fuego/fuego.png',
      },
      explosions: {
        json: '/demos/img/explosions/explosions.json',
        png: '/demos/img/explosions/explosions.png',
      },
    },
    tilemaps: {
      myTilemap: {
        json: '/demos/img/tilemap/2.json',
        png: '/demos/img/tilemap/2.png',
      },
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    // [PreySpawner, 1],
    // [Prey, 2000],
    // [Predator, 8],
    // [Player, 1],
    [House, 2000],
    [TallLight, 300],
    [Civilian, 2000], // FSM-based civilians
    [Tree, 5000],
    [Barrel, 100],
    [Rock, 5000],
    [Fire, 100],
    [Explosion, 100],
    [MySoldier, 1000],
    [Destination, 1],
    [DropMoney, 1000],
    [DropAk47, 1000],
    [DropPistol, 1000],
    [DropShotgun, 1000],
    [CameraController, 1],
    // Grass now uses DecorationPool instead of GameObject
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    this.numberOfTallLights = 200;
    this.numberOfHouses = 100;
    this.numberOfGrass = 10000;

    this.numberOfTrees = 1000;
    this.numberOfBarrels = 100;
    this.numberOfRocks = 1000;

    // this.playerEntity = null;

    this.frameCount = 0;
  }

  create() {
    // Set tilemap background
    this.setTilemapBackground('myTilemap', { scale: 1 });

    // Spawn initial entities
    console.log('🎬 PredatorScene: Spawning entities...');

    // Spawn player first
    // this.spawnPlayer();

    this.spawnLights(this.numberOfTallLights);
    // this.spawnPrey(1000);
    // this.spawnHouses(this.numberOfHouses);
    this.spawnGrass(this.numberOfGrass);
    this.spawnCivilians(1000);
    // this.spawnEntity(PreySpawner, {});

    this.spawnEntity(CameraController, {});
    // this.spawnTrees(this.numberOfTrees);
    this.spawnBarrels(this.numberOfBarrels);
    // this.spawnRocks(this.numberOfRocks);
    this.spawnMySoldiers(2);
    this.spawnDestination();
    // this.spawnRocksTreesAndHouses();
  }

  spawnRocksTreesAndHouses() {
    fetch('/demos/trees_and_rocks.json')
      .then((response) => response.json())
      .then((data) => {
        data.rocks.forEach((rock) => {
          this.spawnEntity(Rock, {
            x: rock.x,
            y: rock.y,
            radius: rock.radius,
          });
        });
        data.trees.forEach((tree) => {
          this.spawnEntity(Tree, {
            x: tree.x,
            y: tree.y,
            radius: tree.radius,
          });
        });
        data.houses.forEach((house, i) => {
          if (i % 2 == 0) return;
          this.spawnEntity(House, {
            x: house.x,
            y: house.y,
            width: house.width,
            height: house.height,
          });
        });
        setTimeout(() => this.createNavGridForTheFlowField(), 500);
      });
    // this.spawnRocks(this.numberOfRocks);
    // this.spawnTrees(this.numberOfTrees);
    // this.spawnHouses(this.numberOfHouses);
  }

  createNavGridForTheFlowField() {
    NavGrid.updateNavGrid([
      ...Array.from(House.getAllActiveIndices()),
      ...Array.from(House.getAllActiveIndices()),
      ...Array.from(Rock.getAllActiveIndices()),
    ]);
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {

    // console.log(dtRatio, deltaTime, accumulatedTime, frameNumber)
    if (frameNumber % 300 === 0) {
      this.createNavGridForTheFlowField()
    }
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  // spawnPlayer() {
  //   this.playerEntity = this.spawnEntity(Player, {
  //     x: this.config.worldWidth / 2,
  //     y: this.config.worldHeight / 2,
  //     vx: 0,
  //     vy: 0,
  //   });
  // }
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

  spawnDestination() {
    this.spawnEntity(Destination, {
      x: 0,
      y: 0,
    });
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
  spawnMySoldiers(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(MySoldier, {
        x: this.config.worldWidth / 2 + rng() * count,
        y: this.config.worldHeight / 2 + rng() * count,
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

  spawnCivilians(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Civilian, {
        x: this.config.worldWidth / 2 + rng() * count,
        y: this.config.worldHeight / 2 + rng() * count,
      });
    }
  }

  spawnGrass(count) {
    console.log('Spawning grass...');
    // Spawn grass using DecorationPool (lightweight, no GameObject overhead)
    for (let i = 0; i < count; i++) {
      const scale = 0.75 + this.rng() * 0.5;
      const grassType = Math.floor(this.rng() * 4) + 1; // grass1 to grass9
      DecorationPool.spawn({
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
        texture: 'grass' + grassType,
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
    const { Mouse } = await import('/src/core/Mouse.js');
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
    const { Mouse } = await import('/src/core/Mouse.js');
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
    if (confirm('Clear all entities?')) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: 'clearAll' });
      });
    }
  }
}
