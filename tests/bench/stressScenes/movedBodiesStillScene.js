import WEED from '/src/index.js';
import { MovedBody, MovedTicker } from './movedBodies/movedBody.js';

const { Scene, Camera } = WEED;

/** Static colliders, visualRange 0. Rebuild is the spatial cost. Raise COUNT until STEP_MS >= 8. */
export const STILL_COUNT = 60000;
const COLS = 220;
const SPACING = 40;

function queryInt(name, fallback, max) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
  } catch {
    return fallback;
  }
}

/** MovedBodiesStillScene only. `?bodies=N`: bodies in the lattice (default 60 000; 16-bit ids, so at most 65 000). */
export const STILL_BODIES = queryInt('bodies', STILL_COUNT, 65000) || STILL_COUNT;
/**
 * MovedBodiesStillScene only. `?moverEvery=N`: every Nth body is dynamic and moves along its row
 * every tick (a teleport, so in physics' moved list each step), the rest stay static: 20 is 5 %
 * awake. 0 (the default) keeps all of them static.
 */
export const STILL_MOVER_EVERY = queryInt('moverEvery', 0, 1000000);
const STILL_MOVERS = STILL_MOVER_EVERY > 0 ? Math.ceil(STILL_BODIES / STILL_MOVER_EVERY) : 0;

export const stressSceneConfig = {
  requested: { bodies: STILL_BODIES, moverEvery: STILL_MOVER_EVERY },
};

function stillConfig(spatialExtra, physicsExtra, count = STILL_COUNT) {
  const rows = Math.ceil(count / COLS);
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

function placeStill(scene, visualRange, count = STILL_COUNT, moverEvery = 0) {
  const start = 200;
  const maxX = scene.config.worldWidth - 200;
  for (let i = 0; i < count; i++) {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    const x = start + col * SPACING;
    const y = start + row * SPACING;
    if (moverEvery > 0 && i % moverEvery === 0) {
      MovedTicker.spawn({ x, y, dynamic: true, visualRange, radius: 8, vx: 4, minX: start, maxX });
    } else {
      MovedBody.spawn({ x, y, dynamic: false, visualRange, radius: 8 });
    }
  }
  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
  Camera.setZoom(0.2);
}

/** `?bodies=` and `?moverEvery=` (above) set its size and its awake share (E-126's owner pair). */
export class MovedBodiesStillScene extends Scene {
  // A teleport is a command: room for a few ticks of them before physics drains the ring.
  static config = stillConfig(null, STILL_MOVERS > 0 ? { commandRingCapacity: 4 * STILL_MOVERS + 4096 } : null, STILL_BODIES);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  // MovedTicker is listed whatever ?moverEvery says (a pool of 0 without it): a worker evaluates this module
  // without the page's query, and finds the entity classes through this list (bindSceneGraph).
  static entities = [[MovedBody, STILL_BODIES - STILL_MOVERS], [MovedTicker, STILL_MOVERS]];
  create() {
    placeStill(this, 0, STILL_BODIES, STILL_MOVER_EVERY);
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
      MovedBody.spawn({
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

export class MovedBodiesAwakeScene extends Scene {
  static config = stillConfig(null, { sleeping: false });
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedBody, STILL_COUNT]];
  create() {
    const start = 200;
    for (let i = 0; i < STILL_COUNT; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      MovedBody.spawn({
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
      MovedBody.spawn({
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

