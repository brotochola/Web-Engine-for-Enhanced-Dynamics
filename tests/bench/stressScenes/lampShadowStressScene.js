import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { StressLamp, StressWalker } from './lampShadow/lampShadowEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * The lamps' shadows at night (DX-SHADOW3D F7): raised lamps that cast shadows over a crowd of walkers, seen by an
 * oblique camera. The owner scene of lighting.lampShadows: `?lampShadows=map` (the lamps' shadow map, a tile a lamp) or
 * `sprite` (the stamps on the shadows' layer, the default) is the arm to measure; the load knobs are `?lamps=` and
 * `?walkers=`.
 *
 * `?lamps=` (default 48), `?walkers=` (default 2000), `?lampShadows=map|sprite`, `?tile=` (lighting.lampShadowTile,
 * default 256), `?sway=0` (the lamps still), `?elevation=` (px, default 70), `?backend=webgpu`. `?still=1`: nothing moves
 * (the walkers stand where their loops start, the lamps do not sway), for byte-for-byte captures (compareCaptures.mjs).
 */
const WORLD_W = 2400;
const WORLD_H = 1400;
const SEED = 0x1a3b;

function query(key) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(key);
  } catch {
    return null;
  }
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const LAMPS = Math.max(1, Math.floor(queryNumber('lamps', 48)));
export const WALKERS = Math.max(0, Math.floor(queryNumber('walkers', 2000)));
export const LAMP_SHADOWS = query('lampShadows') === 'map' ? 'map' : 'sprite';
export const TILE = Math.max(32, Math.floor(queryNumber('tile', 256)));
export const STILL = queryNumber('still', 0) === 1;
export const SWAY = queryNumber('sway', 1) !== 0 && !STILL;
export const ELEVATION = queryNumber('elevation', 70);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';

export const stressSceneConfig = {
  requested: {
    lamps: LAMPS, walkers: WALKERS, lampShadows: LAMP_SHADOWS, tile: TILE, sway: SWAY ? 1 : 0, elevation: ELEVATION, backend: BACKEND,
    still: STILL ? 1 : 0,
  },
};

export class LampShadowStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, maxVisibleRenderables: Math.max(4000, WALKERS + 512) },
    camera: { pitch: 47 },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.08,
      shadowsEnabled: true,
      maxLights: Math.max(64, LAMPS),
      maxShadowCastingLights: LAMPS,
      lampShadows: LAMP_SHADOWS,
      lampShadowTile: TILE,
      sun: { enabled: false },
    },
  };
  static assets = {
    textures: {
      ground: '/demos/img/box_100_100.png',
      walker: '/demos/img/bola.png',
    },
  };
  static entities = [
    [StressLamp, 256],
    [StressWalker, 20000],
  ];

  create() {
    const rng = mulberry32(SEED);
    // The lamps on a grid with some jitter; the walkers anywhere, each pacing its own small loop.
    const cols = Math.ceil(Math.sqrt(LAMPS * (WORLD_W / WORLD_H)));
    const rows = Math.ceil(LAMPS / cols);
    for (let i = 0; i < LAMPS; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      StressLamp.spawn({
        x: ((c + 0.5) / cols) * WORLD_W + (rng() - 0.5) * 60,
        y: ((r + 0.5) / rows) * WORLD_H + (rng() - 0.5) * 60,
        elevation: ELEVATION,
        radius: 300 + rng() * 80,
        sway: SWAY ? 12 : 0,
        phase: rng() * 6.283,
      });
    }
    for (let i = 0; i < WALKERS; i++) {
      StressWalker.spawn({
        x: rng() * WORLD_W,
        y: rng() * WORLD_H,
        r: 20 + rng() * 60,
        speed: 0.4 + rng() * 0.8,
        phase: rng() * 6.283,
        scale: 0.35 + rng() * 0.3,
        still: STILL,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
