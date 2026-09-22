import WEED from '/src/index.js';
import { MovedBody, MovedTicker } from './movedBodies/movedBody.js';

const { Scene, Camera } = WEED;

/** ~5% teleport every tick, the rest static. visualRange high. */
export const MIXED_COUNT = 22000;
export const MIXED_DYNAMIC_EVERY = 20;
const COLS = 140;
const SPACING = 48;

function mixedConfig(spatialExtra) {
  const rows = Math.ceil(MIXED_COUNT / COLS);
  const worldW = COLS * SPACING + 400;
  const worldH = rows * SPACING + 400;
  return {
    worldWidth: worldW,
    worldHeight: worldH,
    seed: 0x51aed,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 48,
      noLimitFPS: false,
      ...spatialExtra,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: true,
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

function placeMixed(scene) {
  const start = 200;
  const maxX = scene.config.worldWidth - 200;
  for (let i = 0; i < MIXED_COUNT; i++) {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    const dynamic = i % MIXED_DYNAMIC_EVERY === 0;
    scene.spawnEntity(MovedTicker, {
      x: start + col * SPACING,
      y: start + row * SPACING,
      dynamic,
      visualRange: 170,
      radius: 8,
      vx: 6,
      minX: start,
      maxX,
    });
  }
  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
  Camera.setZoom(0.35);
}

export class MovedBodiesMixedScene extends Scene {
  static config = mixedConfig(null);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[MovedTicker, MIXED_COUNT]];
  create() {
    placeMixed(this);
  }
}

