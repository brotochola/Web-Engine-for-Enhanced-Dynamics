/**
 * Decal *blit* stress (PIXI.Sprite per tile + ImageBitmap upload).
 * Not DecalStampStressScene (that row is particle stamp).
 * Primary: pixi_STEP_MS. Load: DECAL_TILES_UPLOADED.
 */
import WEED from '/src/index.js';
import { DecalBlitDriver } from './decals/decalBlitDriver.js';

const { Scene, Camera } = WEED;

export const TILE_SIZE = 32;
export const WORLD_W = 4096;
export const WORLD_H = 4096;
export const TILES_X = WORLD_W / TILE_SIZE;
export const TILES_Y = WORLD_H / TILE_SIZE;
export const STAMPS_PER_TICK = 1024;
/** Hunt: 1024 uploads crosses 8 ms; 32 uploads + 16k sprites is 0.9 ms (upload dominates). */
export const MAX_UPLOADS = 1024;

export class DecalBlitStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0xdecb11,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: true,
      decalsTileSize: TILE_SIZE,
      decalsResolution: 0.5,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxDecalTileUploadsPerFrame: MAX_UPLOADS,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: {
      blood: '/demos/img/blood.png',
    },
  };

  static entities = [[DecalBlitDriver, 1]];

  create() {
    this.spawnEntity(DecalBlitDriver, {
      seed: 0xdecb11,
      tilesX: TILES_X,
      tilesY: TILES_Y,
      tileSize: TILE_SIZE,
      stampsPerTick: STAMPS_PER_TICK,
      cx: WORLD_W * 0.5,
      cy: WORLD_H * 0.5,
    });
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.45);
  }
}
