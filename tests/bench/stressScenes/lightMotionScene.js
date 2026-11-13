import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { MotionBlock, MotionFlasher, MotionLamp, MotionProp } from './lightMotion/lightMotionEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Lights in motion, to film (DX-LIGHTAPI): lamps that circle across the screen's edges (does a glow pop in? does a
 * pool's tail vanish when the light is culled?), flashes fired in turn (how they fade; half of them asked to cast no
 * shadow), barrels that cast shadows, and with `?raycast=1` boxes that block the light. The view is fixed on the middle
 * of a world twice its size.
 *
 * `?raycast=1`, `?groundScaleY=` (default 1), `?backend=webgpu`, `?ambient=` (default 0.04).
 */
const VIEW_W = 1280;
const VIEW_H = 720;
const WORLD_W = 2560;
const WORLD_H = 1440;
const SEED = 0x30710;

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

export const RAYCAST = queryNumber('raycast', 0) === 1;
export const GROUND_SCALE_Y = queryNumber('groundScaleY', 1);
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const AMBIENT = queryNumber('ambient', 0.04);

/** The view's left and top edges in world px. */
const VX = (WORLD_W - VIEW_W) / 2;
const VY = (WORLD_H - VIEW_H) / 2;

/**
 * Lamps circling points on or near the view's edges. A big glow on a lamp with no sprite is the case N-150 is about.
 */
const LAMPS = [
  { radius: 1414, color: 0xffcc88, glow: 0.8, cx: VX, cy: VY + 200, r: 260, w: 0.6, p: 0 },
  { radius: 949, color: 0x88ccff, glow: 0.18, cx: VX + VIEW_W, cy: VY + 360, r: 300, w: -0.5, p: 1 },
  { radius: 2000, color: 0xff8866, glow: 1.28, cx: VX + 640, cy: VY, r: 240, w: 0.4, p: 2 },
  { radius: 707, color: 0xccffcc, glow: 0.1, cx: VX + 400, cy: VY + VIEW_H, r: 200, w: 0.8, p: 3 },
  { radius: 1183, color: 0xffeecc, glow: 0.336, glowOffsetY: -60, elevation: 60, cx: VX + 900, cy: VY + 420, r: 180, w: 0.7, p: 4 },
  { radius: 548, color: 0xffffff, cx: VX + 300, cy: VY + 300, r: 120, w: -1.1, p: 5 },
];

export const stressSceneConfig = {
  requested: { raycast: RAYCAST ? 1 : 0, groundScaleY: GROUND_SCALE_Y, backend: BACKEND, ambient: AMBIENT },
};

export class LightMotionScene extends Scene {
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
      baseAmbient: AMBIENT,
      maxLights: 32,
      maxFlashes: 16,
      shadowsEnabled: true,
      raycasted: RAYCAST,
      groundScaleY: GROUND_SCALE_Y,
      maxShadowCastingLights: 16,
      maxShadowsPerLight: 32,
      maxPolygonVertices: 2048,
      sun: { enabled: false },
    },
  };
  static assets = {
    textures: {
      ground: '/demos/img/box_100_100.png',
      barrel1: '/demos/img/bola.png',
    },
  };
  static entities = [
    [MotionLamp, 16],
    [MotionProp, 64],
    [MotionBlock, 32],
    [MotionFlasher, 1],
  ];

  create() {
    const rng = mulberry32(SEED);
    for (const spec of LAMPS) MotionLamp.spawn(spec);
    for (let i = 0; i < 40; i++) {
      MotionProp.spawn({ x: VX - 100 + rng() * (VIEW_W + 200), y: VY - 100 + rng() * (VIEW_H + 200) });
    }
    if (RAYCAST) {
      for (let i = 0; i < 18; i++) MotionBlock.spawn({ x: VX + rng() * VIEW_W, y: VY + rng() * VIEW_H });
    }
    // [x, y, z, castShadows]: every other one asks for no shadow, every third one is raised 30 px.
    const spots = [];
    for (let i = 0; i < 12; i++) {
      spots.push([VX + 120 + rng() * (VIEW_W - 240), VY + 100 + rng() * (VIEW_H - 200), i % 3 === 0 ? 30 : 0, i % 2]);
    }
    MotionFlasher.spawn({ spots, every: 400 });
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
