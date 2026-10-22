// Round planet. No Box2D. The ground is PlanetGrid, a bit array the scene owns.
// The walker probes those bits. Drops separate in the spatial hash and draw as metaballs.
// The planet picture is one world rectangle. The manager copies dirty chunks with
// Layer.get('planet').updateTexture('cells', PlanetGrid.cells, x, y, width, height).
// Z fill, X erase, [ ] brush, Q pour, A/D walk, W or space jump. Click paints.

import { PlanetManager } from './gameObjects/planetManager.js';
import { Walker } from './gameObjects/walker.js';
import { WaterDrop } from './gameObjects/waterDrop.js';
import { PlanetGrid, CELL, GRID, PLANET_RADIUS } from './planetGrid.js';
import WEED from '/src/index.js';

const { Scene, Camera, BLEND_MODES } = WEED;

const WORLD = GRID * CELL;
const PUDDLE = 120;

export class PlanetScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 3,
    debug: {

      collectDetailedStats: true,

      collectGpuStats: true,
    },
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 32,
      maxEntitiesPerCell: 128,
      maxNeighbors: 128,
      neighborTickInterval: 1,
      neighborReuseSkin: 0,
      noLimitFPS: false,
    },

    logic: {
      numberOfLogicWorkers: 1,
      noLimitFPS: false,
    },

    particle: {
      maxParticles: 0,
      decals: false,
    },

    physics: {
      enabled: false,
    },

    lighting: {
      enabled: false,
    },

    renderer: {
      backend: 'webgl',
    },

    layers: {
      // Ground picture. The fragment reads `cells`. The camera, including roll, moves the mesh.
      planet: {
        zIndex: 1,
        shader: {
          fragment: {
            webgl: '/demos/planetScene/shaders/planetLook.frag',
            webgpu: '/demos/planetScene/shaders/planetLook.wgsl',
          },
          worldRect: { width: WORLD, height: WORLD },
          textures: [
            {
              name: 'cells',
              format: 'r8unorm',
              size: { width: GRID / 8, height: GRID },
            },
          ],
          uniforms: {
            uCell: { value: CELL, type: 'f32' },
            uGW: { value: GRID, type: 'f32' },
            uPCX: { value: GRID * 0.5, type: 'f32' },
            uPCY: { value: GRID * 0.5, type: 'f32' },
            uPR: { value: PLANET_RADIUS, type: 'f32' },
          },
        },
      },
      // Soft disks added together, then a water body. Above the ground, under the walker.
      water: {
        zIndex: 2.5,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        maxItems: 2000,
        ySorting: false,
        shader: {
          fragment: 'planetWater',
          containerBlend: BLEND_MODES.ADD,
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
    },
    shaders: {
      planetWater: '/demos/shaders/planetWater.frag',
    },
  };

  static entities = [
    [PlanetManager, 1],
    [Walker, 1],
    [WaterDrop, 2000],
  ];

  static sharedResources = [
    [PlanetGrid, PlanetGrid.schemaFor(GRID, GRID)],
  ];

  create() {
    Camera.setFree(false);
    Camera.setZoom(1);
    const pcx = (GRID >> 1) * CELL;
    const surface = (GRID >> 1) * CELL - PLANET_RADIUS * CELL;
    Camera.centerOn(pcx, surface - 80);
  }

  createNewGame() {
    PlanetManager.spawn({ forceProcessOnLogicWorker: 0 });
    Walker.spawn({ forceProcessOnLogicWorker: 0 });
    const pcx = (GRID >> 1) * CELL;
    const surface = (GRID >> 1) * CELL - PLANET_RADIUS * CELL;
    for (let i = 0; i < PUDDLE; i++) {
      const col = i % 12;
      const row = (i / 12) | 0;
      WaterDrop.spawn({
        x: pcx + (col - 5.5) * 10,
        y: surface - 24 - row * 10,
        vy: 80,
      });
    }
  }
}
