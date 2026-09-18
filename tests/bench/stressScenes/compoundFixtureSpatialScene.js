/**
 * Compound-fixture spatial stress.
 * Load knobs: ISLAND_COUNT, TRIANGLES_PER_ISLAND, VISUAL_RANGE, maxFixturePoolSize.
 * Primary: spatialMax_STEP_MS. Load: BODY_COUNT.
 */
import WEED from '/src/index.js';
import { CompoundSpatialIsland } from './compoundFixture/compoundSpatialIsland.js';

const { Scene, Camera } = WEED;

export const ISLAND_COUNT = 6000;
export const TRIANGLES_PER_ISLAND = 10;
export const VISUAL_RANGE = 220;
export const WORLD_W = 14000;
export const WORLD_H = 14000;
const SEED = 0xcf17;

export class CompoundFixtureSpatialScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 255,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: ISLAND_COUNT * TRIANGLES_PER_ISLAND + 64,
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[CompoundSpatialIsland, ISLAND_COUNT]];

  create() {
    const cols = 80;
    const spacing = 150;
    const startX = 400;
    const startY = 400;
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(CompoundSpatialIsland, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        rotation: (i * 0.17) % (Math.PI * 2),
        triangles: TRIANGLES_PER_ISLAND,
        visualRange: VISUAL_RANGE,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.35);
  }
}
