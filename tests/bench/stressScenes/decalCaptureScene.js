import WEED from '/src/index.js';
import { DecalCaptureDriver } from './decals/decalCaptureDriver.js';

const { Scene, Camera } = WEED;

function query(name, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  } catch {
    return fallback;
  }
}

/**
 * E-552: a still floor of seeded blood decals over the whole world, for byte-for-byte captures (compareCaptures.mjs).
 * `?resolution=` decalsResolution (2: 512 px tiles, so the stamped tiles take several array chunks), `?zoom=` the
 * camera's zoom, `?backend=` webgl or webgpu.
 */
export class DecalCaptureScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,
    particle: {
      maxParticles: 100,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: query('resolution', 0.5),
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { gravity: { x: 0, y: 0 }, noLimitFPS: false },
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 32, noLimitFPS: false },
    renderer: {
      backend: query('backend', 'webgl'),
      noLimitFPS: false,
      maxVisibleRenderables: 200,
    },
    lighting: { enabled: false },
  };

  static assets = { textures: { blood: '/demos/img/blood.png' } };

  static entities = [[DecalCaptureDriver, 1]];

  create() {
    DecalCaptureDriver.spawn({ seed: 0xdeca1 });
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(query('zoom', 0.6));
  }
}
