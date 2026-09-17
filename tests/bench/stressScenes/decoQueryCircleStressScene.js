import WEED from '/src/index.js';
import { DecoQueryCircleDriver } from './decorations/decoQueryCircleDriver.js';

const { Scene, Camera, Decoration } = WEED;

const SEED = 0xdec0c1;
const WORLD = 2000;
const MAX_DECORATIONS = 12000;
const PLANT = 8000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DecoQueryCircleStressScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 64,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: MAX_DECORATIONS, swayDecimation: 8 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 4000,
    },
    lighting: { enabled: false },
  };

  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoQueryCircleDriver, 1]];

  create() {
    const rng = mulberry32(SEED);
    this.spawnEntity(DecoQueryCircleDriver, { x: WORLD * 0.5, y: WORLD * 0.5 });
    for (let i = 0; i < PLANT; i++) {
      Decoration.spawn({
        x: 32 + rng() * (WORLD - 64),
        y: 32 + rng() * (WORLD - 64),
        texture: 'ball',
        scaleX: 0.12,
        scaleY: 0.12,
        alpha: 0.7,
        anchorX: 0.5,
        anchorY: 1,
        sway: false,
      });
    }
    Camera.centerOn(WORLD * 0.5, WORLD * 0.5);
    Camera.setZoom(0.45);
  }
}
