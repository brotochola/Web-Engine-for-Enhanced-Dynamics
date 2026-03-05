// PredatorScene.js - Predators vs Prey gameplay scene
// Demonstrates the new Scene-based architecture for WeedJS

import WEED from '/src/index.js';
import { Boid } from '../gameObjects/boid.js';

// import { Player } from "../gameObjects/player.js";
import { TallLight } from '../gameObjects/tallLight.js';

import { House } from '../gameObjects/house.js';

import { Tree } from '../gameObjects/tree.js';
import { Barrel } from '../gameObjects/barrel.js';
import { Rock } from '../gameObjects/rock.js';
import { Fire } from '../gameObjects/fire.js';
import { Explosion } from '../gameObjects/explosion.js';
import { MySoldier } from '../gameObjects/mySoldier.js';
import { Destination } from '../gameObjects/destination.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { containerRadius } from '../../src/core/utils.js';
import { DropMoney } from '../gameObjects/dropMoney.js';
import { DropAk47 } from '../gameObjects/dropAk47.js';
import { DropShotgun } from '../gameObjects/dropShotgun.js';
import { DropPistol } from '../gameObjects/dropPistol.js';
import { Civilian } from '../gameObjects/civilian.js';
import { CameraController } from '../gameObjects/cameraController.js';
import { Trash } from '../gameObjects/trash.js';
import { Bug } from '../gameObjects/bug.js';

const { DecorationPool, Mouse, Camera } = WEED;

export class BichosScene extends WEED.Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 10000,
    worldHeight: 5000,
    seed: 123456,
    debugUpdateInterval: 100,

    // Spatial hash grid configuration
    spatial: {
      cellSize: 128,
      maxNeighbors: 1024,
      maxEntitiesPerCell: 64, //this is very important!!
      numberOfSpatialWorkers: 1, // Multiple workers for parallel neighbor detection
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: true,
      maxParticles: 20000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
    },

    decoration: {
      maxDecorations: 30000, // Non-interactive decorations like grass
    },

    // Logic configuration
    logic: {
      noLimitFPS: true,
      numberOfLogicWorkers: 1,
      numberOfEntitiesPerJob: 250,
      staggeredUpdates: false, // Enable tick decimation (entities tick based on their tickInterval)
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
      sleepThreshold: 0.25,
      wakeUpThreshold: 0.3,
      sleepDuration: 20,
    },

    renderer: {
      noLimitFPS: false,
      ySorting: true,
      interpolation: true,
      cullingRatio: 0.33,
      startFadingDecorationsAtZoom: 0.5,
      hideDecorationsAtZoom: 0.25,
    },

    lighting: {
      enabled: true,
      baseAmbient: 0,
      maxLights: 100,
      shadowsEnabled: true,
      maxShadowCastingLights: 100,
      maxShadowsPerLight: 500,
      maxShadowsPerEntity: 10,
      maxShadowSprites: 1000,
      maxFlashes: 2048,
      resolution: 0.25,
    },

    navigation: {
      noLimitFPS: true,
      enabled: true,
      cellSize: 48,
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

      blood: '/demos/img/blood.png',
      tallLight: '/demos/img/tallLight.png',

      grass1: '/demos/img/g1.png',
      grass2: '/demos/img/g2.png',
      grass3: '/demos/img/g3.png',
      grass4: '/demos/img/g4.png',
      grass5: '/demos/img/g5.png',
      grass6: '/demos/img/g6.png',
      grass7: '/demos/img/g7.png',
      grass8: '/demos/img/g8.png',

      square: '/demos/img/10_10_square.png',
      smoke: '/demos/img/smoke.png',
      target: '/demos/img/target.png',

      explosion_decal: '/demos/img/explosion_decal.png',
    },
    spritesheets: {

      bicho: {
        json: '/demos/img/bicho/bicho.json',
        png: '/demos/img/bicho/bicho.png',
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

    // [Player, 1],

    [TallLight, 1500],
    [Rock, 5000],
    [Fire, 100],
    [Explosion, 100],
    [Destination, 1],
    [Bug, 10000],
    // [CameraController, 1],
    // [Trash, 100]
    // Grass now uses DecorationPool instead of GameObject
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);

    this.frameCount = 0;
  }

  async preload() {
    await this.setTilemapBackground('myTilemap', { scale: 1 });
  }

  create() {
    // Spawn initial entities
    // console.log('🎬 PredatorScene: Spawning entities...');

    // Spawn player first
    // this.spawnPlayer();

    this.spawnLights(100);
    this.spawnBugs(10000);
    // this.spawnHouses(this.numberOfHouses);
    this.spawnGrass(20000);
    // this.spawnCivilians(10000);
    // this.spawnTrash(100);
    // this.spawnEntity(PreySpawner, {});

    // this.spawnEntity(CameraController, {});
    // // this.spawnTrees(this.numberOfTrees);
    // this.spawnBarrels(this.numberOfBarrels);
    this.spawnRocks(500);
    // this.spawnMySoldiers(2500);
    // this.spawnDestination();
    // this.spawnRocksTreesAndHouses();
  }

  spawnTrash(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Trash, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
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
          });
        });
        this.createNavGridForTheFlowField();
      });
    // this.spawnRocks(this.numberOfRocks);
    // this.spawnTrees(this.numberOfTrees);
    // this.spawnHouses(this.numberOfHouses);
  }

  createNavGridForTheFlowField() {
    NavGrid.updateNavGrid([
      ...Tree.getAllActive(),
      ...House.getAllActive(),
      ...Rock.getAllActive(),
      ...Trash.getAllActive(),
      ...Fire.getAllActive(),
    ]);
  }

  printFPS() {
    const smoothing = this.game.debugUI?.fpsSmoothing;
    if (!smoothing) {
      console.log('DebugUI not available');
      return;
    }

    const getSmoothedFPS = (s) => (s.sum / s.values.length).toFixed(2);

    // Log all worker FPS (smoothed, same as DebugUI)
    console.log('=== Worker FPS (averaged) ===');
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

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {

    // if (Mouse.wheel != 0) {
    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.01));
    // }

    Camera.follow(Mouse.x, Mouse.y);

    // if (this.keyboard) {
    //   if (this.keyboard.w) {
    //     Camera.y -= 10;
    //   }
    //   if (this.keyboard.s) {
    //     Camera.y += 10;
    //   }
    //   if (this.keyboard.a) {
    //     Camera.x -= 10;
    //   }
    //   if (this.keyboard.d) {
    //     Camera.x += 10;
    //   }
    // }
    // if (frameNumber % (60 * 10) === 0) {
    //   this.printFPS()
    // }

    // // console.log(dtRatio, deltaTime, accumulatedTime, frameNumber)
    // if (frameNumber % 300 === 0) {
    //   this.createNavGridForTheFlowField()
    // }
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

  spawnBugs(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Bug, {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  spawnCivilians(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity(Civilian, {
        x: this.config.worldWidth * rng(),
        y: this.config.worldHeight * rng(),
      });
    }
  }

  /**
   * Pre-compute valid grass spawn positions from the "pasto" tilemap layer
   * Only positions where the layer has non-zero tile values are valid
   */
  computeGrassPositions() {
    const tilemapData = this.loadedTilemaps['myTilemap']?.data;
    if (!tilemapData) {
      console.warn('Tilemap not loaded, grass will spawn everywhere');
      return null;
    }

    // Find the "pasto" layer
    const pastoLayer = tilemapData.layers.find(
      layer => layer.name === 'green_grass' && layer.type === 'tilelayer'
    );

    if (!pastoLayer || !pastoLayer.data) {
      console.warn('Layer "green_grass" not found, grass will spawn everywhere');
      return null;
    }

    const tileWidth = tilemapData.tilewidth;
    const tileHeight = tilemapData.tileheight;
    const mapWidth = tilemapData.width;
    const mapHeight = tilemapData.height;

    // Collect all valid tile positions (where tile value != 0)
    const validPositions = [];
    for (let tileY = 0; tileY < mapHeight; tileY++) {
      for (let tileX = 0; tileX < mapWidth; tileX++) {
        const index = tileY * mapWidth + tileX;
        if (pastoLayer.data[index] !== 0) {
          // Store the world position (center of tile)
          validPositions.push({
            x: tileX * tileWidth + tileWidth / 2,
            y: tileY * tileHeight + tileHeight / 2,
            tileWidth,
            tileHeight,
          });
        }
      }
    }

    console.log(`Found ${validPositions.length} valid grass tiles in "pasto" layer`);
    return validPositions;
  }

  spawnGrass(count) {
    console.log('Spawning grass...');

    // Get valid positions from the "pasto" layer
    const validPositions = this.computeGrassPositions();

    // Spawn grass using DecorationPool (lightweight, no GameObject overhead)
    for (let i = 0; i < count; i++) {
      let x, y;

      if (validPositions && validPositions.length > 0) {
        // Pick a random valid tile and randomize position within it
        const tile = validPositions[Math.floor(this.rng() * validPositions.length)];
        // Random position within the tile bounds
        x = tile.x + (this.rng() - 0.5) * tile.tileWidth;
        y = tile.y + (this.rng() - 0.5) * tile.tileHeight;
      } else {
        // Fallback: spawn anywhere
        x = this.rng() * this.config.worldWidth;
        y = this.rng() * this.config.worldHeight;
      }

      const scale = 0.2 + this.rng() * 0.1;
      const grassType = Math.floor(this.rng() * 8) + 1; // grass1 to grass9
      DecorationPool.spawn({
        x,
        y,
        texture: 'grass' + grassType,
        scaleX: scale,
        scaleY: scale,
        alpha: 0.7 + this.rng() * 0.3,
        anchorX: 0.5,
        anchorY: 1.0, // Bottom anchor for grass
        sway: true,
        swayAmplitude: 0.05 + Math.random() * 0.03,
        swayFrequency: 1 + Math.random() * 2,
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

  clearAllEntities() {
    if (confirm('Clear all entities?')) {
      // Broadcast to all logic workers
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({ msg: 'clearAll' });
      });
    }
  }
}
