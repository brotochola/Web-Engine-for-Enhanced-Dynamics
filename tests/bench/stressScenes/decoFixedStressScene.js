import WEED from '/src/index.js';
import { DecoFixedAnchor } from './decorations/decoFixedAnchor.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, Decoration } = WEED;

const SEED = 0xdec0f1;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MAX_DECORATIONS = 65535;
const PLANT = 64000;

/** A number from the page's query, or `fallback`. */
function queryNumber(key, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `?pan=1` (N-112; default 0, the camera still): the camera orbits 600 px around the world's centre and its zoom
 * swings 10 % either way, every frame, as a player pans and zooms. The particle worker's screen test then writes a
 * new visible list each frame (a still camera holds it, E-179c) and pre-render collects a new one each frame.
 * `?zoom=` (default 1.5): the zoom it holds or swings around; 0.8 puts about 24 000 of the 64 000 in the culled view,
 * 0.55 about 41 000.
 */
export const PAN = queryNumber('pan', 0) === 1 ? 1 : 0;
export const ZOOM = queryNumber('zoom', 1.5);

/**
 * `?backpressure=0` (default 1): pre-render does not skip a frame while Pixi is behind (preRender.backpressure).
 * Where Pixi draws slowly (SwiftShader: a few frames a second) pre-render then still does every frame's work, so its
 * step is measured over every frame of the window, not over the few Pixi let through.
 */
export const BACKPRESSURE = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('backpressure') === '0' ? 0 : 1;
  } catch {
    return 1;
  }
})();

export const stressSceneConfig = { requested: { pan: PAN, zoom: ZOOM, backpressure: BACKPRESSURE } };

function decoFixedConfig(numberOfLogicWorkers) {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 255,
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
    ...(BACKPRESSURE ? {} : { preRender: { backpressure: false } }),
  };
}

function plantFixedDecos(scene) {
  const rng = mulberry32(SEED);
  DecoFixedAnchor.spawn({ x: -10000, y: -10000 });
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
      swayAmplitude: 0.22 + rng() * 0.18,
      swayFrequency: 1 + rng() * 2,
    });
  }
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(ZOOM);
  scene._orbT = 0;
}

/** One frame of `?pan=1`'s orbit (the scene's update, on the main thread): a turn every 140 frames. */
function panCamera(scene) {
  if (!PAN) return;
  const t = (scene._orbT += 0.045);
  Camera.setZoom(ZOOM * (1 + 0.1 * Math.sin(t * 0.7)));
  Camera.centerOn(WORLD_W * 0.5 + Math.cos(t) * 600, WORLD_H * 0.5 + Math.sin(t * 1.37) * 600);
}

export class DecoFixedStressScene1W extends Scene {
  static config = decoFixedConfig(1);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoFixedAnchor, 1]];
  create() {
    plantFixedDecos(this);
  }

  update() {
    panCamera(this);
  }
}

export class DecoFixedStressScene3W extends Scene {
  static config = decoFixedConfig(3);
  static assets = { textures: { ball: '/demos/img/bola.png' } };
  static entities = [[DecoFixedAnchor, 1]];
  create() {
    plantFixedDecos(this);
  }

  update() {
    panCamera(this);
  }
}
