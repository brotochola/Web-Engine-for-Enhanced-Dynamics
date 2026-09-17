import WEED from '/src/index.js';
import { DecoFixedAnchor } from './decorations/decoFixedAnchor.js';

const { Scene, Camera, Decoration } = WEED;

const SEED = 0xdec0f1;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MAX_DECORATIONS = 20000;
const PLANT = 12000;

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

function decoFixedConfig(numberOfLogicWorkers) {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
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
      numberOfLogicWorkers,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: MAX_DECORATIONS, swayDecimation: 1 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 20000,
    },
    lighting: { enabled: false },
  };
}

function plantFixedDecos(scene) {
  const rng = mulberry32(SEED);
  scene.spawnEntity(DecoFixedAnchor, { x: -10000, y: -10000 });
  for (let i = 0; i < PLANT; i++) {
    Decoration.spawn({
      x: 64 + rng() * (WORLD_W - 128),
      y: 64 + rng() * (WORLD_H - 128),
      texture: 'ball',
      scaleX: 0.18,
      scaleY: 0.18,
      alpha: 0.85,
      anchorX: 0.5,
      anchorY: 1,
      sway: true,
      swayAmplitude: 0.05 + rng() * 0.03,
      swayFrequency: 1 + rng() * 2,
    });
  }
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(0.18);
}

export class DecoFixedStressScene1W extends Scene {
  static config = decoFixedConfig(1);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoFixedAnchor, 1]];
  create() {
    plantFixedDecos(this);
  }
}

export class DecoFixedStressScene3W extends Scene {
  static config = decoFixedConfig(3);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoFixedAnchor, 1]];
  create() {
    plantFixedDecos(this);
  }
}
