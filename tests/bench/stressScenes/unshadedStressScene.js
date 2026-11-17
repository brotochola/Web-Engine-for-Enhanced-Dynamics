import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import {
  BENCH_CAMERA, VIEW_H, VIEW_W, benchSheets, gridCells, param, paramBackend, paramCount,
} from './light3d/benchSheets.js';
import { Stroller } from './light3d/stroller.js';
import { ENTITY_UNSHADED, Fire, FireLight } from './unshaded/unshadedEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * Two colours a pixel (DX-UNSHADED, was DX-UNSHADED F10, plan §6.9 and §10): a night field of fires and a crowd of the
 * light bench's LPC people (with their height and normal maps) strolling among them, in front of some fires and behind
 * others. No light touches a fire: the night does not darken it and a person passing in front covers it in the proportion
 * of their alpha. Some fires carry a light, which shows the people's normals. No shadows.
 *
 * Owner: the presented (drawn) frames: the unshaded colour is written by every sprite pixel of the entity pass (a second
 * target, or a pass more) and composed with the light (`runPredatorAbab --scene
 * /tests/bench/stressScenes/unshadedStressScene.js --scene-export UnshadedStressScene --owner presented`, the same build
 * with `--query-a unshaded=0 --query-b unshaded=entity`). Pixi's step is the guard. Load keys: VISIBLE_ENTITIES,
 * RENDER_QUEUE_SIZE. The whole world is in view and the crowd stays in it.
 *
 * - `?fires=` (default 600), `?people=` (default 2400): the load knobs (the frames fall as the overdraw grows).
 * - `?lights=` fires that carry a light (default 24, at most the fires).
 * - `?unshaded=entity|sheet|0`: `entity` each fire's spriteRenderer.unshaded; `sheet` the fire sheet's
 *   assets.spritesheets.fire.unshaded (the maps table's mark); `0` nothing is unshaded (the reference). Left out: `entity`
 *   where the engine has spriteRenderer.unshaded, `sheet` where it does not. `entity` on an engine without it draws
 *   nothing unshaded, and says so on the console (`[bench]`).
 * - `?backend=webgl|webgpu` (default webgl).
 * - `?still=1`: nothing moves (the people stand, the flames hold their first frame, the lights do not flicker), for
 *   byte-for-byte captures (compareCaptures.mjs). The same places as without it.
 */
const W = VIEW_W;
const H = VIEW_H;
const SEED = 0xe715;
const UNSHADED_MODES = ['entity', 'sheet', '0'];

export const FIRES = paramCount('fires', 600, 1, 30000);
export const PEOPLE = paramCount('people', 2400, 0, 60000);
export const LIGHTS = paramCount('lights', 24, 0, Math.min(256, FIRES));
export const UNSHADED = UNSHADED_MODES.includes(param('unshaded')) ? param('unshaded') : ENTITY_UNSHADED ? 'entity' : 'sheet';
export const BACKEND = paramBackend();
export const STILL = param('still') === '1';

if (UNSHADED === 'entity' && !ENTITY_UNSHADED && typeof document !== 'undefined') {
  console.warn('[bench] unshadedStressScene: this engine has no spriteRenderer.unshaded, so ?unshaded=entity draws nothing unshaded (?unshaded=sheet is the per-sheet one)');
}

export const stressSceneConfig = {
  requested: {
    fires: FIRES,
    people: PEOPLE,
    lights: LIGHTS,
    unshaded: UNSHADED,
    backend: BACKEND,
    still: STILL ? 1 : 0,
  },
};

const fireSheet = { json: '/demos/img/fuego/fuego.json', png: '/demos/img/fuego/fuego.png' };
if (UNSHADED === 'sheet') fireSheet.unshaded = true;

export class UnshadedStressScene extends Scene {
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
    // Night: no sun, a little ambient; the fires' lights and their own colour are what shows.
    lighting: {
      enabled: true,
      // ?unshaded=entity: spriteRenderer.unshaded needs the sprites' G-buffer words (the people's maps bring them too).
      unshaded: UNSHADED === 'entity',
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
      const scale = fireScale * (0.85 + rng() * 0.3);
      const rate = 0.22 + rng() * 0.16;
      Fire.spawn({ x, y, scale, rate: STILL ? 0 : rate, flip: rng() < 0.5, unshaded: UNSHADED === 'entity' });
    }
    // The lights on fires spread over the field.
    for (let j = 0; j < LIGHTS; j++) {
      const [x, y] = grid.cells[Math.floor(((j + 0.5) * grid.cells.length) / LIGHTS)];
      FireLight.spawn({ x, y: y - 8, radius: 200 + rng() * 100, color: rng() < 0.5 ? 0xff9a40 : 0xffb060, phase: rng() * 6.283, flicker: !STILL });
    }
    for (let k = 0; k < PEOPLE; k++) {
      const x = rng() * W;
      const y = rng() * H;
      const heading = rng() * Math.PI * 2;
      const turn = (rng() * 2 - 1) * 0.35;
      const pace = 22 + rng() * 26;
      const person = Stroller.spawn({ x, y, heading, turn: STILL ? 0 : turn, pace: STILL ? 0 : pace });
      if (STILL && person) {
        // Facing where it would walk, set (from its velocity it would be the first frame's, whichever that was).
        person.setAnimationSpeed(0);
        person.directionalSprite.facingFrom = 'manual';
        person.directionalSprite.facing = heading;
      }
    }
  }
}
