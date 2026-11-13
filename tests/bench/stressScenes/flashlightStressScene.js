import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { FlashlightCrate, FlashlightWalker } from './flashlight/flashlightEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Flashlights in a side view (DX-SPOT): walkers pacing on ledges, turning round with flipX, each aiming a light ahead of
 * it, among crates that block light (raycasted lighting). The load knob is `?lights=`; `?cone=1` turns each flashlight
 * into a cone (`?aperture=` degrees, default 50; `?softness=`, default 0.25) that follows the flip, `?cone=0` (the
 * default) leaves the same lights round: the arm to measure a cone's cost (and its sweep's saving) against.
 *
 * `?lights=` (default 120), `?crates=` (default 160), `?cone=`, `?aperture=`, `?softness=`, `?backend=webgpu`.
 */
const WORLD_W = 1280;
const WORLD_H = 720;
const SEED = 0xf1a5;

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

export const LIGHTS = Math.max(1, Math.floor(queryNumber('lights', 120)));
export const CRATES = Math.max(0, Math.floor(queryNumber('crates', 160)));
export const CONE = queryNumber('cone', 0) === 1;
export const APERTURE = (queryNumber('aperture', 50) * Math.PI) / 180;
export const SOFTNESS = queryNumber('softness', 0.25);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';

export const stressSceneConfig = {
  requested: { lights: LIGHTS, crates: CRATES, cone: CONE ? 1 : 0, aperture: APERTURE, softness: SOFTNESS, backend: BACKEND },
};

export class FlashlightStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 128, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, maxVisibleRenderables: 4000 },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.05,
      raycasted: true,
      shadowsEnabled: false,
      maxLights: LIGHTS,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: 1024,
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
    [FlashlightWalker, 512],
    [FlashlightCrate, 1024],
  ];

  create() {
    const rng = mulberry32(SEED);
    // Ledges: rows of walkers, crates scattered between them.
    const rows = 6;
    for (let i = 0; i < LIGHTS; i++) {
      const row = i % rows;
      const y = 80 + row * ((WORLD_H - 140) / (rows - 1));
      const x0 = 40 + rng() * (WORLD_W * 0.5);
      FlashlightWalker.spawn({
        x: x0 + rng() * 200,
        y,
        x0,
        x1: x0 + 200 + rng() * 400,
        speed: 40 + rng() * 60,
        p: rng() * 6.283,
        cone: CONE ? APERTURE : 0,
        softness: SOFTNESS,
      });
    }
    for (let i = 0; i < CRATES; i++) {
      FlashlightCrate.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H, w: 20 + rng() * 40, h: 20 + rng() * 40 });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
