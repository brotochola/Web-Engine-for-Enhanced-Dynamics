import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import {
  BENCH_CAMERA, BENCH_DIR, VIEW_H, VIEW_W, benchSheets, benchSize, gridCells, param, paramBackend, paramCount, paramNumber,
} from './light3d/benchSheets.js';
import { ReliefLamp, ReliefProp } from './selfShadow/selfShadowEntities.js';

const { Scene, Camera, Sun, LAYER_KIND } = WEED;

/**
 * What self-shadow costs (DX-SELFSHADOW F8, plan §6.8 and §10): the light bench's renders with their height maps (beds,
 * tables, shelves, cars: the bench's checkerboard cases) packed over the whole view by day, each pixel of them stepping
 * towards the sun in the light pass (lighting.selfShadow), and towards each lamp with a tile in the lamps' map when there
 * are lamps. The cost is per lit pixel with height, per light, per ray and per step: the light pass is the GPU's, so the
 * owner is the presented (drawn) frames (`runPredatorAbab --scene /tests/bench/stressScenes/selfShadowStressScene.js
 * --scene-export SelfShadowStressScene --owner presented`, the same build with `--query-a rays=1 --query-b rays=4`);
 * Pixi's step is the guard. Load keys: VISIBLE_ENTITIES, RENDER_QUEUE_SIZE (and GPU_SHADOW_LIGHTS with lamps). The whole
 * world is in view and nothing but the lamps moves: the load does not drift.
 *
 * - `?n=` renders (default 600): how much of the view has height; past covering it, more only overlaps.
 * - `?rays=1|2|4` lighting.selfShadowRays (proposed: rays a pixel, from its corners, plan §6.8), `?steps=`
 *   lighting.selfShadowSteps (proposed: steps a ray, today 6 in the shader, at most 8 in its loop). Left out, neither key
 *   is written: the engine's default.
 * - `?res=` lighting.resolution (default 1, as the light bench: a light texel a screen px), the pixels the steps run for.
 * - `?lamps=` lamps that cast shadows (default 0); with `?shadows=1` each gets a tile in the lamps' map
 *   (lighting.lampShadows 'map') and the steps run towards it too.
 * - `?shadows=0` lighting.shadowsEnabled off: no shadow maps, the sun's self-shadow alone (default 1: the sun's map and
 *   the lamps', as the light bench).
 * - `?hour=` (default 16), `?backend=webgl|webgpu` (default webgl), `?still=1` the lamps hold still (captures to compare).
 *
 * The 6 ms floor is a STEP_MS rule; here the knobs (`?n=` until the view is covered, then `?res=`, `?lamps=`, `?rays=`,
 * `?steps=`) take the frames under the display's rate, the regime where the presented frames can show a cost.
 */
const W = VIEW_W;
const H = VIEW_H;
const SEED = 0x5e1f;
const SHEETS = ['cama', 'mesa', 'sillon', 'biblioteca', 'aljibe', 'gallinero', 'vaca', 'hatch_rojo', 'pickup_blanco'];

export const N = paramCount('n', 600, 1, 20000);
const RAYS_RAW = paramNumber('rays', 0);
/** null: the knob was left out (or is not 1, 2 or 4) and the engine's default stands. */
export const RAYS = RAYS_RAW === 1 || RAYS_RAW === 2 || RAYS_RAW === 4 ? RAYS_RAW : null;
export const STEPS = param('steps') === null ? null : paramCount('steps', 6, 1, 32);
export const RES = Math.min(1, Math.max(0.125, paramNumber('res', 1)));
export const LAMPS = paramCount('lamps', 0, 0, 256);
export const SHADOWS = param('shadows') !== '0';
export const HOUR = paramNumber('hour', 16);
export const BACKEND = paramBackend();
export const STILL = param('still') === '1';

export const stressSceneConfig = {
  requested: {
    n: N,
    rays: RAYS === null ? 'default' : RAYS,
    steps: STEPS === null ? 'default' : STEPS,
    res: RES,
    lamps: LAMPS,
    shadows: SHADOWS ? 1 : 0,
    hour: HOUR,
    backend: BACKEND,
    still: STILL ? 1 : 0,
  },
};

const lighting = {
  enabled: true,
  baseAmbient: 0.12,
  maxLights: Math.max(8, LAMPS + 4),
  resolution: RES,
  shadowsEnabled: SHADOWS,
  sunShadows: 'map',
  lampShadows: 'map',
  maxShadowCastingLights: Math.max(1, LAMPS),
  selfShadow: true,
  sun: {
    enabled: true,
    intensity: 1,
    startHour: HOUR,
    dayCycle: { enabled: false },
    shadowAlpha: 0.7,
    shadowStretchAlphaFactor: 0,
  },
};
if (RAYS !== null) lighting.selfShadowRays = RAYS;
if (STEPS !== null) lighting.selfShadowSteps = STEPS;

export class SelfShadowStressScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, maxVisibleRenderables: N + 64 },
    preRender: { noLimitFPS: false },
    camera: { ...BENCH_CAMERA },
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'pasto', tileScale: 1, parallax: 1, zIndex: 0 } },
    lighting,
  };

  static assets = {
    spritesheets: benchSheets(SHEETS),
    textures: { pasto: `${BENCH_DIR}pasto.png` },
  };

  static entities = [
    [ReliefProp, N],
    [ReliefLamp, Math.max(1, LAMPS)],
  ];

  create() {
    Sun.setTimeOfDay(HOUR);
    // The whole world in view: the zoom that fits it to the canvas (1 on the bench's).
    Camera.setZoom(Camera.minZoom);
    Camera.centerOn(W / 2, H / 2);
    const rng = mulberry32(SEED);
    const grid = gridCells(N, W, H, rng);
    for (const [x, y] of grid.cells) {
      const sheet = SHEETS[Math.floor(rng() * SHEETS.length)];
      const scale = Math.min(1.2, Math.max(0.3, ((1.25 * grid.side) / benchSize(sheet)) * (0.9 + rng() * 0.2)));
      ReliefProp.spawn({ x, y, sheet, facing: rng() * Math.PI * 2, scale });
    }
    if (LAMPS === 0) return;
    const lamps = gridCells(LAMPS, W, H, rng, { jitter: 0.6 });
    const colors = [0xffd08a, 0xffe0b0, 0xb0d0ff, 0xffc0a0];
    for (let k = 0; k < lamps.cells.length; k++) {
      const [x, y] = lamps.cells[k];
      ReliefLamp.spawn({ x, y, radius: 260 + rng() * 120, color: colors[k % colors.length], elevation: 60 + rng() * 40, phase: rng() * 6.283, sway: STILL ? 0 : 10 });
    }
  }
}
