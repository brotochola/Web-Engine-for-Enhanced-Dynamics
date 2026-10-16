// Bit planet. No Box2D. Walker probes bits. Drops separate through the spatial hash.
// Z fill, X erase, [ ] brush, Q pour, A/D walk, W/space jump. Click paints.

import { PlanetManager } from './gameObjects/planetManager.js';
import { Walker } from './gameObjects/walker.js';
import { WaterDrop } from './gameObjects/waterDrop.js';
import { PlanetGrid, CELL, GRID, PLANET_RADIUS } from './planetGrid.js';
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

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
      cellSize: 8,
      maxEntitiesPerCell: 16,
      maxNeighbors: 32,
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
    },
  };

  static assets = {
    textures: {
      square: '/demos/img/10_10_square.png',
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
    this.spawnEntity(PlanetManager, { forceProcessOnLogicWorker: 0 });
    this.spawnEntity(Walker, { forceProcessOnLogicWorker: 0 });
    const pcx = (GRID >> 1) * CELL;
    const surface = (GRID >> 1) * CELL - PLANET_RADIUS * CELL;
    for (let i = 0; i < PUDDLE; i++) {
      const col = i % 12;
      const row = (i / 12) | 0;
      this.spawnEntity(WaterDrop, {
        x: pcx + (col - 5.5) * 10,
        y: surface - 24 - row * 10,
        vy: 80,
      });
    }
  }
}
