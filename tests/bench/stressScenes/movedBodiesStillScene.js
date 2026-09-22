import WEED from '/src/index.js';
import { MovedBody } from './movedBodies/movedBody.js';

const { Scene, Camera } = WEED;

/** Static colliders, visualRange 0. Rebuild is the spatial cost. Raise COUNT until STEP_MS >= 8. */
export const STILL_COUNT = 60000;
const COLS = 220;
const SPACING = 40;

function stillConfig(spatialExtra, physicsExtra) {
  const rows = Math.ceil(STILL_COUNT / COLS);
  const worldW = COLS * SPACING + 400;
  const worldH = rows * SPACING + 400;
  return {
    worldWidth: worldW,
    worldHeight: worldH,
    seed: 0x57111,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      maxEntitiesPerCell: 32,
      noLimitFPS: false,
      ...spatialExtra,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: true,
      ...physicsExtra,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 64,
    },
    lighting: { enabled: false },
  };
}

function placeStill(scene, visualRange) {
  const start = 200;
  for (let i = 0; i < STILL_COUNT; i++) {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    scene.spawnEntity(MovedBody, {
      x: start + col * SPACING,
      y: start + row * SPACING,
      dynamic: false,
      visualRange,
      radius: 8,
    });
  }
  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
  Camera.setZoom(0.2);
}

export class MovedBodiesStillScene extends Scene {
  static config = stillConfig(null);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedBody, STILL_COUNT]];
  create() {
    placeStill(this, 0);
  }
}

/** Same pile, visualRange high, so neighbor search is the cost. */
export const STILL_NEIGHBOR_COUNT = 60000;

export class MovedBodiesStillNeighborsScene extends Scene {
  static config = stillConfig(null);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedBody, STILL_NEIGHBOR_COUNT]];
  create() {
    const start = 200;
    for (let i = 0; i < STILL_NEIGHBOR_COUNT; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      this.spawnEntity(MovedBody, {
        x: start + col * SPACING,
        y: start + row * SPACING,
        dynamic: false,
        visualRange: 170,
        radius: 8,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.35);
  }
}

export class MovedBodiesStillIncrementalScene extends MovedBodiesStillScene {
  static config = stillConfig({ incrementalMovers: true });
  static entities = [[MovedBody, STILL_COUNT]];
}

export class MovedBodiesAwakeScene extends Scene {
  static config = stillConfig(null, { sleeping: false });
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedBody, STILL_COUNT]];
  create() {
    const start = 200;
    for (let i = 0; i < STILL_COUNT; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      this.spawnEntity(MovedBody, {
        x: start + col * SPACING,
        y: start + row * SPACING,
        dynamic: true,
        solver: true,
        visualRange: 0,
        radius: 8,
        vx: 40,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.2);
  }
}

export class MovedBodiesAwakeIncrementalScene extends MovedBodiesAwakeScene {
  static config = stillConfig({ incrementalMovers: true }, { sleeping: false });
  static entities = [[MovedBody, STILL_COUNT]];
}

export class MovedBodiesStillNeighborsIdleScene extends MovedBodiesStillNeighborsScene {
  static config = stillConfig({ skipIdleNeighbors: true });
  static entities = [[MovedBody, STILL_NEIGHBOR_COUNT]];
}

const AWAKE_NEIGHBOR_COUNT = 22000;

export class MovedBodiesAwakeNeighborsScene extends Scene {
  static config = stillConfig(null, { sleeping: false });
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedBody, AWAKE_NEIGHBOR_COUNT]];
  create() {
    const start = 200;
    for (let i = 0; i < AWAKE_NEIGHBOR_COUNT; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      this.spawnEntity(MovedBody, {
        x: start + col * SPACING,
        y: start + row * SPACING,
        dynamic: true,
        solver: true,
        visualRange: 170,
        radius: 8,
        vx: 30,
      });
    }
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.35);
  }
}

export class MovedBodiesAwakeNeighborsIncrementalScene extends MovedBodiesAwakeNeighborsScene {
  static config = stillConfig({ incrementalMovers: true }, { sleeping: false });
  static entities = [[MovedBody, AWAKE_NEIGHBOR_COUNT]];
}
