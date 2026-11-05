import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import { SunWatcher } from './sunOverride/sunWatcher.js';
import { MOON_COLOR, MOON_INTENSITY } from './sunOverride/sunOverrideValues.js';

const { Scene, Sun, Camera, Decoration } = WEED;

/**
 * DX-SUNPUBLISH: a scene whose update overrides the day cycle's sun, as a night scene does with its moon. The cycle
 * writes the sun at the start of the main thread's frame and update writes it again, so a worker reading between the
 * two sees the cycle's value: the page's lights flash. `SunWatcher` counts those reads on a logic worker and prints
 * `[bench] sunOverride reads N torn M`.
 *
 * `?busyMs=` (default 2): main-thread work inside update before the override, the width of that window. `?hour=`
 * (default 22): the day cycle's start, slow enough to stay at night for the run. Tiles cover the screen, so the
 * flashing shows on the page too.
 */
const SEED = 0x50a1;
const WORLD_W = 2000;
const WORLD_H = 1200;
const TILES = 2000;

function queryNumber(key, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(key);
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export const BUSY_MS = Math.max(0, queryNumber('busyMs', 2));
export const HOUR = queryNumber('hour', 22);
export const stressSceneConfig = { requested: { busyMs: BUSY_MS, hour: HOUR } };

export class SunOverrideScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 16, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: TILES + 8 },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 4000 },
    lighting: {
      enabled: true,
      baseAmbient: 0.05,
      sun: {
        enabled: true,
        startHour: HOUR,
        dayCycle: { enabled: true, speed: 1, dayDurationMinutes: 1440 },
      },
    },
  };
  static assets = { textures: { box: '/demos/img/box_100_100.png' } };
  static entities = [[SunWatcher, 1]];

  create() {
    const rng = mulberry32(SEED);
    SunWatcher.spawn({ x: -10000, y: -10000 });
    for (let i = 0; i < TILES; i++) {
      Decoration.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H, texture: 'box', scaleX: 1, scaleY: 1 });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }

  update() {
    if (BUSY_MS > 0) {
      const end = performance.now() + BUSY_MS;
      while (performance.now() < end);
    }
    Sun.intensity = MOON_INTENSITY;
    Sun.color = MOON_COLOR;
  }
}
