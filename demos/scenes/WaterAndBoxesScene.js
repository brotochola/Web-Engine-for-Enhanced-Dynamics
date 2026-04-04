// WaterAndBoxesScene.js - Custom Layer Demo with Metaball Water
// Demonstrates the Layer system: water balls render into a separate layer
// with additive blending + threshold shader to produce a metaball effect,
// while boxes render in the default ENTITIES layer.

import { WaterBall } from '/demos/gameObjects/waterBall.js';
import { Box } from '/demos/gameObjects/box.js';
import { Floor } from '/demos/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import { Layer } from '/src/core/Layer.js';
import { BLEND_MODES } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';
const { Mouse } = WEED;

export class WaterAndBoxesScene extends WEED.Scene {
  // ========================================
  // STATIC SCENE CONFIGURATION
  // ========================================

  static config = {
    worldWidth: 4000,
    worldHeight: 3000,

    spatial: {
      cellSize: 128,
      maxNeighbors: 900,
      noLimitFPS: true,
      numberOfSpatialWorkers: 2,
      maxEntitiesPerCell: 256,
    },

    logic: {
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: true,
      maxParticles: 30000,
      decals: false,
    },

    physics: {
      subStepCount: 4,
      noLimitFPS: true,
      maxCollisionPairs: 100000,
      verletDamping: 0.997,
      boundaryElasticity: 0.1,
      collisionResponseStrength: 0.125,
      gravity: { x: 0, y: 1 },
      sleepThreshold: 0,
      wakeUpThreshold: 9999,
      sleepDuration: 9999999,
    },

    renderer: {
      noLimitFPS: true,
      ySorting: false
    },

    lighting: {
      enabled: false,
    },

    // Custom layer: water balls rendered with additive blending into a
    // RenderTexture, then a threshold fragment shader merges overlapping
    // gradients into blobby metaball shapes.
    layers: {
      water: {
        zIndex: 4,             // Render above default ENTITIES layer (zIndex 3)
        blendMode: BLEND_MODES.NORMAL,     // Final display blend of the post-processed sprite
        resolution: 0.33,         // Half-res RT for performance
        maxItems: 50000,
        ySorting: false, // no need to sort water balls
        shader: {
          fragment: 'metaball',
          containerBlend: BLEND_MODES.ADD, // Additive blend inside the RT (density field)
          uniforms: {
            uThreshold: { value: 0.8, type: 'f32' },
            uWaterColor: { value: [0.05, 0.1, 0.95], type: 'vec3<f32>' },
            uFoamIntensity: { value: 1.25, type: 'f32' },
            uFoamWidth: { value: 0.16, type: 'f32' },
            uSampleStep: { value: 0.0025, type: 'f32' },
            uOpacity: { value: 0.9, type: 'f32' },
            uTime: { value: 0.0, type: 'f32' },
          },
        },
      },
    },
  };

  // ========================================
  // STATIC ASSETS CONFIGURATION
  // ========================================

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
    },
    shaders: {
      metaball: '/demos/shaders/metaball.frag',
    },
  };

  // ========================================
  // STATIC ENTITY REGISTRATION
  // ========================================

  static entities = [
    [WaterBall, 20000],
    [Box, 500],
    [Floor, 1000],
  ];

  // ========================================
  // INSTANCE LIFECYCLE HOOKS
  // ========================================

  constructor(game) {
    super(game);
    this.numberOfWaterBalls = 2000;
    this.numberOfBoxes = 80;
    this.cameraPanSpeed = 10;
    this.cameraFollowX = 0;
    this.cameraFollowY = 0;
  }

  create() {
    console.log('WaterAndBoxesScene: Spawning entities...');

    this.spawnFloorAndWalls();
    this.spawnWaterBalls(4000);
    this.spawnBoxes(2);

    this.cameraFollowX = this.config.worldWidth / 2;
    this.cameraFollowY = this.config.worldHeight / 2;
    Camera.centerOn(this.cameraFollowX, this.cameraFollowY);

    console.log(
      `WaterAndBoxesScene: Spawned ${this.numberOfWaterBalls} water balls and ${this.numberOfBoxes} boxes`
    );
  }

  update(dtRatio, deltaTime, time) {
    const panSpeed = this.cameraPanSpeed / Camera.zoom;
    const kb = this.keyboard;

    if (kb.w || kb.arrowup) this.cameraFollowY -= panSpeed;
    if (kb.s || kb.arrowdown) this.cameraFollowY += panSpeed;
    if (kb.a || kb.arrowleft) this.cameraFollowX -= panSpeed;
    if (kb.d || kb.arrowright) this.cameraFollowX += panSpeed;

    this.cameraFollowX = Math.max(0, Math.min(this.cameraFollowX, this.config.worldWidth));
    this.cameraFollowY = Math.max(0, Math.min(this.cameraFollowY, this.config.worldHeight));

    Camera.follow(Mouse.x, Mouse.y, 0.15);
    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.001));

    Layer.water.setUniform('uTime', time * 0.002);
  }

  // ========================================
  // SPAWNING HELPERS
  // ========================================

  spawnFloorAndWalls() {
    const wallThickness = 600;
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: worldHeight + wallThickness / 4,
      width: worldWidth + wallThickness * 2,
      height: wallThickness,
    });

    this.spawnEntity(Floor, {
      x: worldWidth / 2,
      y: -wallThickness / 2,
      width: worldWidth + wallThickness * 2,
      height: wallThickness,
    });

    this.spawnEntity(Floor, {
      x: -wallThickness / 2,
      y: worldHeight / 2,
      width: wallThickness,
      height: worldHeight + wallThickness * 2,
    });

    this.spawnEntity(Floor, {
      x: worldWidth + wallThickness / 2,
      y: worldHeight / 2,
      width: wallThickness,
      height: worldHeight + wallThickness * 2,
    });
  }

  spawnWaterBalls(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity('WaterBall', {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }

  spawnBoxes(count) {
    for (let i = 0; i < count; i++) {
      this.spawnEntity('Box', {
        x: this.rng() * this.config.worldWidth,
        y: this.rng() * this.config.worldHeight,
      });
    }
  }
}
