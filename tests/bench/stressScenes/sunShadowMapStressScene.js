import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import {
  BENCH_CAMERA, BENCH_DIR, CAST_KINDS, benchSheets, benchSize, gridCells, param, paramBackend, paramCount, paramNumber,
} from './light3d/benchSheets.js';
import { MapCar, MapProp } from './sunShadowMap/sunShadowMapEntities.js';

const { Scene, Camera, Sun, LAYER_KIND } = WEED;

/**
 * The sun's shadow map and its cache (DX-SHADOW3D F6, plan §6.6 and §10): a farm town by day, seen by the light bench's
 * oblique camera. Blocks of still renders (tables, beds, shelves, tanks, coops, cows: static scenery) between roads where
 * cars drive east and west, every one of them casting into lighting.sunShadows 'map'. The still part is what a cache of the
 * map draws once; the cars are what it adds each frame. The whole world is in view (zoom 0.5 on the bench's 1920 × 1080
 * canvas), so the load is the knob and does not drift.
 *
 * Owner: pre-render (the sun rows, a caster each, and the frame the sun sees of each render) and Pixi (their upload and
 * the map's passes); the map's draws are the GPU's, read as the presented (drawn) frames: `runPredatorAbab --scene
 * /tests/bench/stressScenes/sunShadowMapStressScene.js --owner presented`. Load keys: GPU_CASTERS (the sun rows drawn:
 * 0 with `?kind=box`, whose volumes are meshes), VISIBLE_ENTITIES, RENDER_QUEUE_SIZE.
 *
 * - `?casters=` the still renders (default 3000): the load knob. Pre-render's 6 ms takes many more than the default
 *   (raise it with `?kind=sprite`, the cheapest on the GPU); the columns of `auto`/`height` load the GPU first.
 * - `?movers=` the cars (default an eighth of the casters).
 * - `?kind=auto|sprite|height|box` how every caster casts (light3d/benchSheets.js castAs): `auto` (default) each sheet's
 *   own way (the props their height map's columns, the cars and the cow their card), `sprite` the card, `height` the
 *   columns, `box` the sheet's box (a volume in the map).
 * - `?mapRes=` lighting.shadowResolution (default 1): the sun's map is the size of the shadows' layer, this share of the
 *   canvas; a texel a screen px at 1.
 * - `?cache=0|1` lighting.sunShadowCache (proposed: the still casters drawn once into a map of their own, the movers added
 *   each frame); `?cacheDeg=` lighting.sunShadowCacheDegrees (proposed: how far the sun moves before the still part is
 *   drawn again). Left out, neither key is written: the engine's default.
 * - `?dayCycle=` minutes a whole day lasts (lighting.sun.dayCycle.dayDurationMinutes; default 0, the sun still). With a
 *   cycle the run starts at 13 h: keep the day long enough for the warm-up and the window to end before the evening
 *   (24 / D game hours a real minute: D ≥ 2 for 10 s + 10 s, D ≥ 4 for a headed 25 s + 18 s).
 * - `?hour=` (default 16, as the light bench; 13 with a day cycle), `?backend=webgl|webgpu` (default webgl).
 */
const W = 3840;
const H = 2160;
const SEED = 0x5a3d;
/** Every fifth row of the grid is a road. */
const ROAD_EVERY = 5;
const PROP_SHEETS = ['mesa', 'cama', 'sillon', 'biblioteca', 'aljibe', 'gallinero', 'vaca'];
const CAR_SHEETS = ['hatch', 'pickup'];

export const CASTERS = paramCount('casters', 3000, 1, 60000);
export const MOVERS = paramCount('movers', Math.round(CASTERS / 8), 0, 20000);
export const KIND = CAST_KINDS.includes(param('kind')) ? param('kind') : 'auto';
export const MAP_RES = Math.min(2, Math.max(0.125, paramNumber('mapRes', 1)));
const CACHE_RAW = param('cache');
/** null: the knob was left out and the engine's default stands. */
export const CACHE = CACHE_RAW === '1' ? true : CACHE_RAW === '0' ? false : null;
export const CACHE_DEG = param('cacheDeg') === null ? null : Math.max(0, paramNumber('cacheDeg', 1));
export const DAY_CYCLE = Math.max(0, paramNumber('dayCycle', 0));
export const HOUR = paramNumber('hour', DAY_CYCLE > 0 ? 13 : 16);
export const BACKEND = paramBackend();

export const stressSceneConfig = {
  requested: {
    casters: CASTERS,
    movers: MOVERS,
    kind: KIND,
    mapRes: MAP_RES,
    cache: CACHE === null ? 'default' : CACHE ? 1 : 0,
    cacheDeg: CACHE_DEG === null ? 'default' : CACHE_DEG,
    dayCycle: DAY_CYCLE,
    hour: HOUR,
    backend: BACKEND,
  },
};

const lighting = {
  enabled: true,
  baseAmbient: 0.12,
  // The light pass at half the canvas; the map's own size is the knob.
  resolution: 0.5,
  shadowResolution: MAP_RES,
  shadowsEnabled: true,
  sunShadows: 'map',
  // Shadows as dark as the light bench's (the owner approved them): a strong alpha, long shadows not lightened.
  sun: {
    enabled: true,
    intensity: 1,
    startHour: HOUR,
    dayCycle: { enabled: DAY_CYCLE > 0, dayDurationMinutes: DAY_CYCLE > 0 ? DAY_CYCLE : 5 },
    shadowAlpha: 0.7,
    shadowStretchAlphaFactor: 0,
  },
};
if (CACHE !== null) lighting.sunShadowCache = CACHE;
if (CACHE_DEG !== null) lighting.sunShadowCacheDegrees = CACHE_DEG;

export class SunShadowMapStressScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, maxVisibleRenderables: CASTERS + MOVERS + 64 },
    preRender: { noLimitFPS: false },
    camera: { ...BENCH_CAMERA },
    // The grass under the shadows (the light pass multiplies it), as in the light bench.
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'pasto', tileScale: 1, parallax: 1, zIndex: 0 } },
    lighting,
  };

  static assets = {
    spritesheets: benchSheets([...PROP_SHEETS, ...CAR_SHEETS]),
    textures: { pasto: `${BENCH_DIR}pasto.png` },
  };

  static entities = [
    [MapProp, CASTERS],
    [MapCar, Math.max(1, MOVERS)],
  ];

  create() {
    Sun.setTimeOfDay(HOUR);
    // The whole world in view: the zoom that fits it to the canvas (0.5 on the bench's).
    Camera.setZoom(Camera.minZoom);
    Camera.centerOn(W / 2, H / 2);
    const rng = mulberry32(SEED);
    const isRoad = (r) => r % ROAD_EVERY === ROAD_EVERY - 1;
    const grid = gridCells(CASTERS, W, H, rng, { skipRow: isRoad });
    for (const [x, y] of grid.cells) {
      const sheet = PROP_SHEETS[Math.floor(rng() * PROP_SHEETS.length)];
      // Each fills about its cell, a little more or less.
      const scale = Math.min(1.2, Math.max(0.25, ((1.15 * grid.side) / benchSize(sheet)) * (0.9 + rng() * 0.2)));
      MapProp.spawn({ x, y, sheet, facing: rng() * Math.PI * 2, scale, kind: KIND });
    }
    // The roads are the rows the props left empty: two lanes each, east below, west above.
    const roads = [];
    for (let r = 0; r < grid.rows; r++) if (isRoad(r)) roads.push((r + 0.5) * grid.cellH);
    if (roads.length === 0) roads.push(H / 2);
    const carScale = Math.min(1, Math.max(0.3, grid.cellH / 90));
    for (let k = 0; k < MOVERS; k++) {
      const east = (Math.floor(k / roads.length) & 1) === 0;
      MapCar.spawn({
        x: rng() * W,
        y: roads[k % roads.length] + (east ? 0.22 : -0.22) * grid.cellH,
        sheet: CAR_SHEETS[k % CAR_SHEETS.length],
        vx: (east ? 1 : -1) * (60 + rng() * 90),
        wrapW: W,
        scale: carScale,
        kind: KIND,
      });
    }
  }
}
