// WaterAndBoxesScene.js - Custom Layer Demo with Metaball Water
// Demonstrates the Layer system: water balls render into a separate layer
// with additive blending + threshold shader to produce a metaball effect,
// while boxes render in the default ENTITIES layer.

import { WaterBall } from './gameObjects/waterBall.js';
import { Box } from '/demos/ballsAndRectanglesScene/gameObjects/box.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import { BLEND_MODES } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

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
      noLimitFPS: false,
      numberOfSpatialWorkers: 2,
      maxEntitiesPerCell: 255, // hard cap: per-cell count is stored as Uint8 in the grid SAB
    },

    logic: {
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 30000,
      decals: false,
    },

    physics: {
      subStepCount: 4,
      noLimitFPS: false,

      gravity: { x: 0, y: 3600 },
      sleeping: false,
    },

    preRender: {
      noLimitFPS: false,
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySorting: false,
      maxVisibleRenderables: 50000,
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
        resolution: 0.25,         // Half-res RT for performance
        maxItems: 50000,
        ySorting: false, // no need to sort water balls
        shader: {
          fragment: 'metaball',
          containerBlend: BLEND_MODES.ADD, // Additive blend inside the RT (density field)
          uniforms: {
            uThreshold: { value: 0.8, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Threshold', tip: 'Density needed before water draws. Higher = tighter blobs.' },
            uWaterColor: { value: [0.05, 0.1, 0.95], type: 'vec3<f32>', min: 0, max: 1, step: 0.01, label: 'Water color', tip: 'Base water RGB. Unused by the current metaball look (sprite tint wins).' },
            uFoamIntensity: { value: 1.25, type: 'f32', min: 0, max: 4, step: 0.05, label: 'Foam', tip: 'How strong the white foam band is at the surface.' },
            uFoamWidth: { value: 0.16, type: 'f32', min: 0.01, max: 1, step: 0.01, label: 'Foam width', tip: 'How wide the foam band around the surface is.' },
            uSampleStep: { value: 0.0025, type: 'f32', min: 0.0005, max: 0.02, step: 0.0005, label: 'Sample step', tip: 'Neighbor sample distance for foam slope. Bigger = thicker foam edges.' },
            uOpacity: { value: 0.9, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Opacity', tip: 'Water body alpha.' },
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
  }

  create() {
    this.spawnFloorAndWalls();

    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10, zoomSensitivity: 0.001 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
  }

  createNewGame() {
    console.log('WaterAndBoxesScene: Spawning entities...');
    this.spawnWaterBalls(4000);
    this.spawnBoxes(2);
    console.log(
      `WaterAndBoxesScene: Spawned ${this.numberOfWaterBalls} water balls and ${this.numberOfBoxes} boxes`
    );
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
