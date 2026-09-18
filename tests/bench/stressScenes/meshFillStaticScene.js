/**
 * Static MESH fill stress. Camera fixed. Lots of fixtures (or primary boxes).
 * Load knobs: ISLAND_COUNT, TRIANGLES_PER_ISLAND, maxFixturePoolSize, USE_PRIMARY_BOX.
 * Primary: pixi_STEP_MS. Load: BODY_COUNT.
 */
import WEED from '/src/index.js';
import { MeshFillIsland } from './compoundFixture/meshFillIsland.js';

const { Scene, Camera, LAYER_KIND } = WEED;

export const ISLAND_COUNT = 6500;
export const TRIANGLES_PER_ISLAND = 8;
export const USE_PRIMARY_BOX = false;
export const WORLD_W = 12000;
export const WORLD_H = 12000;

export class MeshFillStaticScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x11e5,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: USE_PRIMARY_BOX ? 0 : ISLAND_COUNT * TRIANGLES_PER_ISLAND + 64,
      sleeping: true,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
    layers: {
      terrain: { kind: LAYER_KIND.MESH, zIndex: 2.9 },
    },
  };

  static assets = { textures: {} };

  static entities = [[MeshFillIsland, ISLAND_COUNT]];

  create() {
    const cols = 64;
    const spacing = 150;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(MeshFillIsland, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        triangles: TRIANGLES_PER_ISLAND,
        tint: 0x88aa66,
        spin: 0,
        usePrimaryBox: USE_PRIMARY_BOX,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.4);
  }
}
