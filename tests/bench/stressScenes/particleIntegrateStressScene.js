import WEED from '/src/index.js';
import { ParticleIntegrateDriver } from './particles/particleIntegrateDriver.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0ffee;

/**
 * `?tween=1`: every particle fades and shrinks over its life with a rotating
 * ease, so the integrate loop runs the ease per particle (E-59). Default 0
 * keeps the untweened population.
 */
export const TWEEN = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('tween') === '1' ? 1 : 0;
  } catch {
    return 0;
  }
})();

/**
 * `?camRot=<radians>` turns the camera. A turned view culls particles with the
 * box around it, about twice the view at 45° on 16:9 (review E-51b). Default 0.
 */
export const CAM_ROT = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('camRot');
    const v = raw ? Number(raw) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
})();

export const stressSceneConfig = {
  requested: { tween: TWEEN, camRot: CAM_ROT },
};

/** L2 intermediate bench: large heighted (gravity + despawnOnGroundContact) population. No decals. */
export class ParticleIntegrateStressScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 65535,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 55000,
    },
    lighting: {
      enabled: false,
    },
  };

  static entities = [[ParticleIntegrateDriver, 1]];

  create() {
    this.spawnEntity(ParticleIntegrateDriver, { seed: SEED, tween: TWEEN });

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.3);
    if (CAM_ROT) Camera.setAngle(CAM_ROT);
  }
}
