import WEED from '/src/index.js';
import { PackChurner, PackMover, PackStill, VIEW } from './keyedPack/keyedPackEntities.js';

const { Scene, Camera } = WEED;

function queryNumber(key, fallback) {
  const raw = WEED.params?.get(key) ?? null;
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** `?n=`: sprites (default 150 000), all in view: the load of Pixi's keyed pack (one row each, every frame). */
export const N = Math.min(400000, Math.max(1, Math.floor(queryNumber('n', 150000))));
/** `?moving=`: the share that moves every frame (default 0.25): poses change, statics do not. */
export const MOVING = Math.min(1, Math.max(0, queryNumber('moving', 0.25)));
/** `?churn=`: the share whose tint flips every frame (default 0.01): their keys are marked, their statics go up again. */
export const CHURN = Math.min(1, Math.max(0, queryNumber('churn', 0.01)));
/** `?gbuf=1`: lighting with emissive on, so the batch writes each instance's G-buffer words (E-387's keyed forms). */
export const GBUF = queryNumber('gbuf', 0) === 1;
/** `?bands=1`: four zIndex values, so the painter orders by zIndex and the words carry their bands. */
export const BANDS = queryNumber('bands', 0) === 1;
/** `?scale=`: each bunny's scale (default 0.25: about 7 x 9 px, so the GPU's fill stays small). */
export const SCALE = queryNumber('scale', 0.25);

const MOVERS = Math.floor(N * MOVING);
const CHURNERS = Math.floor(N * CHURN);
const STILLS = Math.max(0, N - MOVERS - CHURNERS);

export const stressSceneConfig = {
  requested: { n: N, moving: MOVING, churn: CHURN, gbuf: GBUF ? 1 : 0, bands: BANDS ? 1 : 0, scale: SCALE },
};

/**
 * The keyed pack's owner scene (E-177, E-201, E-387): N small sprites fill the view, a share drifting and a share
 * changing tint every frame, so Pixi's keyed pack (pack_sprites_keyed_rows: a row per drawn sprite, the marked keys'
 * statics, with ?gbuf=1 the G-buffer words) and the pose rows' upload carry its CPU. The primary is Pixi (STEP_MS -
 * WAIT_MS); `?n=` raises it over the 6 ms floor. No physics, no spatial, no particles, no shadows.
 */
export class KeyedPackStressScene extends Scene {
  static config = {
    worldWidth: VIEW.w,
    worldHeight: VIEW.h,
    seed: 0x4b5e,
    entityIdWidth: 32,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl',
      noLimitFPS: false,
      ySort: false,
      maxVisibleRenderables: N,
    },
    preRender: { skipCull: true, noLimitFPS: false },
    lighting: GBUF ? { enabled: true, emissive: true, ambient: 0.8 } : { enabled: false },
  };

  static assets = {
    textures: { bunny: '/demos/img/bunny.png' },
  };

  static entities = [
    [PackStill, Math.max(1, STILLS)],
    [PackMover, Math.max(1, MOVERS)],
    [PackChurner, Math.max(1, CHURNERS)],
  ];

  create() {
    Camera.setZoom(1);
    Camera.centerOn(VIEW.w / 2, VIEW.h / 2);
    const rng = globalThis.rng;
    const spawn = (Type, count) => {
      for (let i = 0; i < count; i++) {
        Type.spawn({ x: VIEW.w * rng(), y: VIEW.h * rng(), scale: SCALE, z: BANDS ? (i & 3) : 0 });
      }
    };
    spawn(PackStill, STILLS);
    spawn(PackMover, MOVERS);
    spawn(PackChurner, CHURNERS);
  }
}
