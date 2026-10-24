import WEED from '/src/index.js';
import { DecalStampDriver } from './decals/decalStampDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xdec411;

/**
 * `?resolution=` sets decalsResolution, the tile pixels per world unit: 1 gives each tile four times the pixels
 * of the default 0.5, which loads Pixi's per-tile premultiply and upload past the 3 ms floor (W21c's owner pair).
 */
function decalQueryNumber(name, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(name);
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
const DECAL_RESOLUTION = decalQueryNumber('resolution', 0.5);

/** L2 intermediate bench: seeded blood-decal stamp flood each tick. */
export class DecalStampStressScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,
    particle: {
      maxParticles: 4000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: DECAL_RESOLUTION,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
    },
    physics: {
      gravity: { x: 0, y: 0 },
      noLimitFPS: false,
    },
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 2000,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      blood: '/demos/img/blood.png',
    },
  };

  static entities = [[DecalStampDriver, 1]];

  create() {
    DecalStampDriver.spawn({ seed: SEED });

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.6);
  }
}
