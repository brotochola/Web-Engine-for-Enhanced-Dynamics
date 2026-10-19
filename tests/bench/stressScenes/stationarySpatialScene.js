import WEED from '/src/index.js';
import { StationarySpatialEntity } from './stationary/stationarySpatialEntity.js';

/**
 * E-04b. Read `numberOfPhysicsWorkers` from the query string so the Box2D worker-count
 * sweep can drive this scene per arm. Falls back to the engine default (4) when
 * the parameter is absent, so every existing invocation is unchanged.
 *
 * This scene is the SLEEPING-heavy half of the sweep: gravity is zero and the
 * probe reported `Awake 0`, so the solver has almost nothing to decompose and
 * extra Box2D threads should be close to pure spin.
 */
const SCENE_QUERY =
  typeof location !== 'undefined' && location.search
    ? new URLSearchParams(location.search)
    : new URLSearchParams('');
function sceneNumberParam(name, fallback) {
  const raw = SCENE_QUERY.get(name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const { Scene, Camera } = WEED;

export class StationarySpatialScene extends Scene {
  static config = {
    worldWidth: 5000,
    worldHeight: 5000,
    seed: 424242,
    spatial: {
      numberOfSpatialWorkers: 2,
      cellSize: 128,
      maxNeighbors: 512,
      maxEntitiesPerCell: 128,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
    },
    physics: {
      numberOfPhysicsWorkers: sceneNumberParam('numberOfPhysicsWorkers', 4),
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 20000,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  static entities = [[StationarySpatialEntity, 9000]];

  create() {
    const cols = 100;
    const spacing = 45;
    const startX = 300;
    const startY = 300;

    for (let i = 0; i < 9000; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(StationarySpatialEntity, {
        x: startX + col * spacing,
        y: startY + row * spacing,
        radius: 10,
        visualRange: 170,
      });
    }

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.45);
  }
}
