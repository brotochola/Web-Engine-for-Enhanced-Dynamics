/**
 * Geometry-dirty compound stress: replacePolygons every tick, same vertex count.
 * Load knobs: ISLAND_COUNT, TRIANGLES_PER_ISLAND, maxFixturePoolSize.
 * Primary: physics_STEP_MS. Load: BODY_COUNT.
 * Set USE_REPLACE_POLYGONS_FLAT for MF5 hyp side.
 */
import WEED from '/src/index.js';
import { CompoundDirtyIsland } from './compoundFixture/compoundDirtyIsland.js';

const { Scene, Camera } = WEED;

export const ISLAND_COUNT = 3072;
export const TRIANGLES_PER_ISLAND = 8;
export const USE_REPLACE_POLYGONS_FLAT = true;
export const WORLD_W = 2800;
export const WORLD_H = 2800;

export class CompoundGeometryDirtyScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x61d7,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: ISLAND_COUNT * TRIANGLES_PER_ISLAND * 2 + 64,
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[CompoundDirtyIsland, ISLAND_COUNT]];

  create() {
    const cols = 48;
    const spacing = 140;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(CompoundDirtyIsland, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        triangles: TRIANGLES_PER_ISLAND,
        phase: i & 1,
        useFlat: USE_REPLACE_POLYGONS_FLAT,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.35);
  }
}
