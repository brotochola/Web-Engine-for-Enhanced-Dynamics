// Box2D planet. The ground is a bit grid this scene owns. Dirty chunks are blurred, then marched.
// World gravity is zero. Loose chunks and the walker pull themselves inward.
// Z fills, X erases, click paints, Q pours. A/D walk, W or space jumps outward. Wheel zooms.

import { WorldGrid } from './worldGrid.js';
import { WorldGridManager } from './gameObjects/worldGridManager.js';
import { PlanetIsland } from './gameObjects/planetIsland.js';
import { PlanetPull } from './gameObjects/planetPull.js';
import { PlanetWalker } from './gameObjects/planetWalker.js';
import { PlanetLamp } from './gameObjects/planetLamp.js';
import { N, CELL, RADIUS, CX, CY, G, PARTICLE_R } from './planetGravity.js';
import WEED from '/src/index.js';

const { Scene, Camera, Mouse, LAYER_KIND, BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } = WEED;

WorldGrid.disk = {
  cols: N,
  rows: N,
  cell: CELL,
  cx: N >> 1,
  cy: N >> 1,
  radius: RADIUS,
  bedrock: 4,
};
WorldGrid.gravityCenter = { x: CX, y: CY, g: G };
WorldGrid.cols = N;
WorldGrid.rows = N;
WorldGridManager.islandClass = PlanetIsland;

const WORLD = N * CELL;

export class PlanetPhysicsScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 3,

    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 64,
      maxNeighbors: 32,
      noLimitFPS: false,
    },

    logic: {
      numberOfLogicWorkers: 2,
      noLimitFPS: false,
    },

    particle: {
      maxParticles: 0,
      decals: false,
    },

    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: 65535,
      sleeping: false,
      liquidFun: {
        enabled: true,
        radius: PARTICLE_R,
        maxCount: 4000,
        subSteps: 2,
      },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },

    lighting: {
      enabled: true,
      raycasted: true,
      shadowsEnabled: false,
      baseAmbient: 0,
      maxLights: 40,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: 1024,
      sun: { enabled: false },
    },

    layers: {
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2,
        blendMode: BLEND_MODES.NORMAL,
        shader: {
          fragment: 'rockContour',
          containerBlend: BLEND_MODES.NORMAL,
          uniforms: {
            uCutoff: { value: 0.08, type: 'f32' },
            uRimWidth: { value: 0.0018, type: 'f32' },
            uRimColor: { value: [1, 1, 1], type: 'vec3<f32>' },
            uRimAlpha: { value: 0.85, type: 'f32' },
          },
        },
      },
      water: {
        zIndex: 4,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        scaleMode: LAYER_SCALE_MODE.LINEAR,
        maxItems: 0,
        ySorting: false,
        shader: {
          fragment: 'planetWater',
          containerBlend: BLEND_MODES.ADD,
          densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
          splat: {
            radius: 18,
            falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
            useParticleTint: true,
            intensity: 0.22,
          },
          uniforms: {
            uCutoff: { value: 0.18, type: 'f32' },
            uRim: { value: 0.32, type: 'f32' },
            uDepth: { value: 0.45, type: 'f32' },
            uBodyAlpha: { value: 0.88, type: 'f32' },
            uEdgeAlpha: { value: 0.55, type: 'f32' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      square: '/demos/img/10_10_square.png',
      rocky: '/demos/img/rocky.jpg',
    },
    shaders: {
      planetWater: '/demos/planetPhysicsScene/shaders/planetWater.frag',
      rockContour: {
        webgl: '/demos/shaders/rockContour.frag',
        webgpu: '/demos/shaders/rockContour.wgsl',
      },
    },
  };

  static entities = [
    [WorldGridManager, 1],
    [PlanetIsland, 2048],
    [PlanetPull, 1],
    [PlanetWalker, 1],
    [PlanetLamp, 400],
  ];

  static sharedResources = [
    [WorldGrid, WorldGrid.schemaFor(N, N)],
  ];

  create() {
    WorldGridManager.islandClass = PlanetIsland;
    Camera.setFree(false);
    Camera.setZoom(1);
    Camera.centerOn(CX, CY - RADIUS * CELL);
  }

  createNewGame() {
    this.spawnEntity(WorldGridManager, { forceProcessOnLogicWorker: 1 });
  }

  update() {
    if (Mouse.wheel) {
      Camera.targetZoom *= Math.exp(-Mouse.wheel * 0.001);
    }
  }
}
