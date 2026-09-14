import WEED from '/src/index.js';
import { DecalStampDriver } from './decals/decalStampDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xdec411;

/** L2 intermediate bench: seeded blood-decal stamp flood each tick. */
export class DecalStampStressScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,
    particle: {
      maxParticles: 4000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
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
    this.spawnEntity(DecalStampDriver, { seed: SEED });

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.6);
  }
}
