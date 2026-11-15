import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import {
  BENCH_CAMERA, VIEW_H, VIEW_W, benchSheets, gridCells, param, paramBackend, paramCount,
} from './light3d/benchSheets.js';
import { Stroller } from './light3d/stroller.js';
import { ENTITY_EMISSIVE, Fire, FireLight } from './emissive/emissiveEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Two colours a pixel (DX-EMISSIVE F10, plan §6.9 and §10): a night field of fires and a crowd of the light bench's LPC
 * people (with their height and normal maps) strolling among them, in front of some fires and behind others. A fire glows
 * on its own: the night does not darken it and a person passing in front covers it, glow and all, in the proportion of
 * their alpha. Some fires carry a light, which shows the people's normals. No shadows.
 *
 * Owner: the presented (drawn) frames: the emissive colour is written by every sprite pixel of the entity pass (a second
 * target, or a pass more) and composed with the light (`runPredatorAbab --scene
 * /tests/bench/stressScenes/emissiveStressScene.js --scene-export EmissiveStressScene --owner presented`, the same build
 * with `--query-a emissive=0 --query-b emissive=entity`). Pixi's step is the guard. Load keys: VISIBLE_ENTITIES,
 * RENDER_QUEUE_SIZE. The whole world is in view and the crowd stays in it.
 *
 * - `?fires=` (default 600), `?people=` (default 2400): the load knobs (the frames fall as the overdraw grows).
 * - `?lights=` fires that carry a light (default 24, at most the fires).
 * - `?emissive=entity|sheet|0`: `entity` each fire's spriteRenderer.emissive (DX-EMISSIVE v2); `sheet` the fire sheet's
 *   assets.spritesheets.fire.emissive (v1, the fallback); `0` nothing glows (the reference). Left out: `entity` where the
 *   engine has spriteRenderer.emissive, `sheet` where it does not. `entity` on an engine without it draws nothing
 *   emissive, and says so on the console (`[bench]`).
 * - `?backend=webgl|webgpu` (default webgl).
 */
const W = VIEW_W;
const H = VIEW_H;
const SEED = 0xe715;
const EMISSIVE_MODES = ['entity', 'sheet', '0'];

export const FIRES = paramCount('fires', 600, 1, 30000);
export const PEOPLE = paramCount('people', 2400, 0, 60000);
export const LIGHTS = paramCount('lights', 24, 0, Math.min(256, FIRES));
export const EMISSIVE = EMISSIVE_MODES.includes(param('emissive')) ? param('emissive') : ENTITY_EMISSIVE ? 'entity' : 'sheet';
export const BACKEND = paramBackend();

if (EMISSIVE === 'entity' && !ENTITY_EMISSIVE && typeof document !== 'undefined') {
  console.warn('[bench] emissiveStressScene: this engine has no spriteRenderer.emissive, so ?emissive=entity draws nothing emissive (?emissive=sheet is the per-sheet one)');
}

export const stressSceneConfig = {
  requested: {
    fires: FIRES,
    people: PEOPLE,
    lights: LIGHTS,
    emissive: EMISSIVE,
    backend: BACKEND,
  },
};

const fireSheet = { json: '/demos/img/fuego/fuego.json', png: '/demos/img/fuego/fuego.png' };
if (EMISSIVE === 'sheet') fireSheet.emissive = true;

export class EmissiveStressScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, maxVisibleRenderables: FIRES + PEOPLE + 64 },
    preRender: { noLimitFPS: false },
    camera: { ...BENCH_CAMERA },
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 } },
    // Night: no sun, a little ambient; the fires' lights and their glow are what shows.
    lighting: {
      enabled: true,
      baseAmbient: 0.07,
      maxLights: Math.max(8, LIGHTS + 4),
      resolution: 0.5,
      shadowsEnabled: false,
      sun: { enabled: false },
    },
  };

  static assets = {
    spritesheets: { fire: fireSheet, ...benchSheets(['civil7']) },
    textures: { ground: '/demos/img/box_100_100.png' },
  };

  static entities = [
    [Fire, FIRES],
    [FireLight, Math.max(1, LIGHTS)],
    [Stroller, Math.max(1, PEOPLE)],
  ];

  create() {
    // The whole world in view: the zoom that fits it to the canvas (1 on the bench's).
    Camera.setZoom(Camera.minZoom);
    Camera.centerOn(W / 2, H / 2);
    const rng = mulberry32(SEED);
    const grid = gridCells(FIRES, W, H, rng, { jitter: 0.6 });
    // A flame about a cell wide (its frames are 150 px square, the fire in them about 95 px wide).
    const fireScale = Math.min(0.6, Math.max(0.15, (0.9 * grid.side) / 95));
    for (const [x, y] of grid.cells) {
      Fire.spawn({ x, y, scale: fireScale * (0.85 + rng() * 0.3), rate: 0.22 + rng() * 0.16, flip: rng() < 0.5, emissive: EMISSIVE === 'entity' });
    }
    // The lights on fires spread over the field.
    for (let j = 0; j < LIGHTS; j++) {
      const [x, y] = grid.cells[Math.floor(((j + 0.5) * grid.cells.length) / LIGHTS)];
      FireLight.spawn({ x, y: y - 8, radius: 200 + rng() * 100, color: rng() < 0.5 ? 0xff9a40 : 0xffb060, phase: rng() * 6.283 });
    }
    for (let k = 0; k < PEOPLE; k++) {
      Stroller.spawn({
        x: rng() * W,
        y: rng() * H,
        heading: rng() * Math.PI * 2,
        turn: (rng() * 2 - 1) * 0.35,
        pace: 22 + rng() * 26,
      });
    }
  }
}
