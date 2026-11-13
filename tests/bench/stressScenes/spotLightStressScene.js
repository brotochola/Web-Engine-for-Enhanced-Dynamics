import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { SpotCar, SpotProp } from './spotLight/spotLightEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Headlights at night, seen from straight above (DX-SPOT): cars driving circles over a top-down terrain tilemap, each
 * with one light at its front bumper, and rocks and parked cars casting shadows from them (basic lighting, sprite
 * shadows). The load knob is `?cars=`; `?cone=1` turns each headlight into a cone (`?aperture=` degrees, default 60;
 * `?softness=`, default 0.3), `?cone=0` (the default) leaves the same lights round: the arm to measure a cone's cost
 * against.
 *
 * `?cars=` (default 48), `?props=` (default 300), `?shadowLights=` (default 48: lighting.maxShadowCastingLights, at most
 * the cars; raise it with the cars to load the stamp), `?cone=`, `?aperture=`, `?softness=`, `?shadowRange=` (default 0: the
 * radius), `?groundScaleY=` (default 1: straight down), `?backend=webgpu`, `?faces=1` (lighting.faces on, no face
 * decorations: the faces branch's cost alone).
 */
const VIEW_W = 1280;
const VIEW_H = 720;
/** The tilemap's size (416 × 208 tiles of 24 px); the view sits on its grass and paths. */
const WORLD_W = 9984;
const WORLD_H = 4992;
const VX = 1800;
const VY = 1400;
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
export const PROPS = Math.max(0, Math.floor(queryNumber('props', 300)));
export const SHADOW_LIGHTS = Math.max(1, Math.floor(queryNumber('shadowLights', 48)));
export const CONE = queryNumber('cone', 0) === 1;
export const APERTURE = (queryNumber('aperture', 60) * Math.PI) / 180;
export const SOFTNESS = queryNumber('softness', 0.3);
export const SHADOW_RANGE = queryNumber('shadowRange', 0);
export const GROUND_SCALE_Y = queryNumber('groundScaleY', 1);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const FACES = queryNumber('faces', 0) === 1;

export const stressSceneConfig = {
  requested: {
    cars: CARS, props: PROPS, cone: CONE ? 1 : 0, aperture: APERTURE, softness: SOFTNESS, groundScaleY: GROUND_SCALE_Y,
    backend: BACKEND,
  },
};

const ROCKS = ['rock1', 'rock2', 'rock3', 'rock4'];

export class SpotLightStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, maxVisibleRenderables: 4000, ySort: false },
    layers: {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'terrain', scale: 1, zIndex: 0.5 },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.06,
      maxLights: CARS,
      shadowsEnabled: true,
      groundScaleY: GROUND_SCALE_Y,
      maxShadowCastingLights: Math.min(CARS, SHADOW_LIGHTS),
      maxShadowsPerLight: 64,
      ...(FACES ? { faces: { enabled: true } } : {}),
      sun: { enabled: false },
    },
  };
  static assets = {
    textures: {
      car: '/demos/img/zenithal_car.png',
      rock1: '/demos/img/rock1.png',
      rock2: '/demos/img/rock2.png',
      rock3: '/demos/img/rock3.png',
      rock4: '/demos/img/rock4.png',
    },
    tilemaps: {
      terrain: { json: '/demos/map_n_flowfield/tilemap.json', png: '/demos/img/tilemap/2.png' },
    },
  };
  static entities = [
    [SpotCar, 256],
    [SpotProp, 2048],
  ];

  create() {
    const rng = mulberry32(SEED);
    for (let i = 0; i < PROPS; i++) {
      const x = VX + rng() * VIEW_W;
      const y = VY + rng() * VIEW_H;
      // One in eight a parked car, the rest rocks.
      if (rng() < 0.125) {
        SpotProp.spawn({ x, y, texture: 'car', scale: 0.5, rotation: rng() * Math.PI * 2, height: 0.25 });
      } else {
        SpotProp.spawn({ x, y, texture: ROCKS[Math.floor(rng() * 4)], scale: 0.6 + rng() * 0.6, rotation: rng() * 6.283 });
      }
    }
    for (let i = 0; i < CARS; i++) {
      SpotCar.spawn({
        cx: VX + 120 + rng() * (VIEW_W - 240),
        cy: VY + 100 + rng() * (VIEW_H - 200),
        r: 60 + rng() * 140,
        w: (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.6),
        p: rng() * Math.PI * 2,
        cone: CONE ? APERTURE : 0,
        softness: SOFTNESS,
        shadowRange: SHADOW_RANGE,
      });
    }
    Camera.centerOn(VX + VIEW_W * 0.5, VY + VIEW_H * 0.5);
  }
}
