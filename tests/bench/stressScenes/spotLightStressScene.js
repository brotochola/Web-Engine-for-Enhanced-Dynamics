import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { SpotCar, SpotTree } from './spotLight/spotLightEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Headlights at night (DX-SPOT): cars driving circles on an oblique floor (groundScaleY 0.7), each with one light ahead
 * of it, and trees casting shadows from them (basic lighting, sprite shadows). The load knob is `?cars=`; `?cone=1`
 * turns each headlight into a cone (`?aperture=` degrees, default 60; `?softness=`, default 0.3), `?cone=0` (the
 * default) leaves the same lights round: the arm to measure a cone's cost against.
 *
 * `?cars=` (default 48), `?trees=` (default 300), `?cone=`, `?aperture=`, `?softness=`, `?shadowRange=` (default 0: the
 * radius), `?backend=webgpu`, `?faces=1` (lighting.faces on, no face decorations: the faces branch's cost alone).
 */
const WORLD_W = 1280;
const WORLD_H = 720;
const SEED = 0x5b07;

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

export const CARS = Math.max(1, Math.floor(queryNumber('cars', 48)));
export const TREES = Math.max(0, Math.floor(queryNumber('trees', 300)));
export const CONE = queryNumber('cone', 0) === 1;
export const APERTURE = (queryNumber('aperture', 60) * Math.PI) / 180;
export const SOFTNESS = queryNumber('softness', 0.3);
export const SHADOW_RANGE = queryNumber('shadowRange', 0);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const FACES = queryNumber('faces', 0) === 1;

export const stressSceneConfig = {
  requested: { cars: CARS, trees: TREES, cone: CONE ? 1 : 0, aperture: APERTURE, softness: SOFTNESS, backend: BACKEND },
};

export class SpotLightStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, maxVisibleRenderables: 4000 },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.06,
      maxLights: CARS,
      shadowsEnabled: true,
      groundScaleY: 0.7,
      maxShadowCastingLights: Math.min(CARS, 48),
      maxShadowsPerLight: 64,
      ...(FACES ? { faces: { enabled: true } } : {}),
      sun: { enabled: false },
    },
  };
  static assets = {
    textures: {
      ground: '/demos/img/box_100_100.png',
      car: '/demos/img/zenithal_car.png',
      tree: '/demos/img/tree1.png',
    },
  };
  static entities = [
    [SpotCar, 256],
    [SpotTree, 2048],
  ];

  create() {
    const rng = mulberry32(SEED);
    for (let i = 0; i < TREES; i++) SpotTree.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H });
    for (let i = 0; i < CARS; i++) {
      SpotCar.spawn({
        cx: 120 + rng() * (WORLD_W - 240),
        cy: 100 + rng() * (WORLD_H - 200),
        r: 60 + rng() * 140,
        w: (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.6),
        p: rng() * Math.PI * 2,
        cone: CONE ? APERTURE : 0,
        softness: SOFTNESS,
        shadowRange: SHADOW_RANGE,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
