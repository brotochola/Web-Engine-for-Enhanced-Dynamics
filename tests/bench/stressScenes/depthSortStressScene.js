import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';
import {
  BENCH_CAMERA, BENCH_DIR, VIEW_H, VIEW_W, benchSheets, benchSize, gridCells, param, paramBackend, paramCount,
} from './light3d/benchSheets.js';
import { Stroller } from './light3d/stroller.js';
import { Table } from './depthSort/depthSortEntities.js';

const { Scene, Camera, LAYER_KIND } = WEED;

/**
 * The depth that corrects the painter (DX-DEPTH F5, plan §6.5 and §10): a hall of the light bench's tables, turned every
 * way, and a crowd of its LPC people strolling among them, seen by its oblique camera. Both sheets have height maps, so
 * with renderer.pixelDepth each pixel of the entity pass writes its place on the floor and tests it: a person in front of
 * a long table's far end shows, one behind its near end does not, whatever their feet say to the painter. No lighting:
 * the entity pass is the cost, and nothing else draws over it.
 *
 * Owner: the presented (drawn) frames, since writing the depth from the shader is fill the GPU pays (and it turns off the
 * early depth test): `runPredatorAbab --scene /tests/bench/stressScenes/depthSortStressScene.js --scene-export
 * DepthSortStressScene --owner presented`, the same build with `--query-a depth=0 --query-b depth=1`. Pixi's step is the
 * guard (its batch's state and splits), pre-render the painter's. Load keys: VISIBLE_ENTITIES, RENDER_QUEUE_SIZE. The
 * whole world is in view and the crowd stays in it.
 *
 * - `?tables=` (default 900), `?people=` (default 2400): the load knobs (the frames fall as the overdraw grows).
 * - `?depth=0|1` renderer.pixelDepth false or true; left out, the engine's default (on with an oblique camera and a sheet
 *   with height maps, which this scene is).
 * - `?backend=webgl|webgpu` (default webgl).
 */
const W = VIEW_W;
const H = VIEW_H;
const SEED = 0xd3e7;

export const TABLES = paramCount('tables', 900, 0, 30000);
export const PEOPLE = paramCount('people', 2400, 0, 60000);
const DEPTH_RAW = param('depth');
/** null: the knob was left out and the engine decides. */
export const DEPTH = DEPTH_RAW === '1' ? true : DEPTH_RAW === '0' ? false : null;
export const BACKEND = paramBackend();

export const stressSceneConfig = {
  requested: {
    tables: TABLES,
    people: PEOPLE,
    depth: DEPTH === null ? 'auto' : DEPTH ? 1 : 0,
    backend: BACKEND,
  },
};

const renderer = { backend: BACKEND, ySort: true, noLimitFPS: false, maxVisibleRenderables: TABLES + PEOPLE + 64 };
if (DEPTH !== null) renderer.pixelDepth = DEPTH;

export class DepthSortStressScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer,
    preRender: { noLimitFPS: false },
    camera: { ...BENCH_CAMERA },
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'pasto', tileScale: 1, parallax: 1, zIndex: 0 } },
    lighting: { enabled: false },
  };

  static assets = {
    spritesheets: benchSheets(['mesa', 'civil7']),
    textures: { pasto: `${BENCH_DIR}pasto.png` },
  };

  static entities = [
    [Table, Math.max(1, TABLES)],
    [Stroller, Math.max(1, PEOPLE)],
  ];

  create() {
    // The whole world in view: the zoom that fits it to the canvas (1 on the bench's).
    Camera.setZoom(Camera.minZoom);
    Camera.centerOn(W / 2, H / 2);
    const rng = mulberry32(SEED);
    // The tables fill about their cells; the people take the same scale, so the hall keeps the bench's proportions.
    const grid = gridCells(Math.max(1, TABLES), W, H, rng, { jitter: 0.5 });
    const scale = Math.min(1, Math.max(0.35, (1.3 * grid.side) / benchSize('mesa')));
    for (let k = 0; k < TABLES; k++) {
      const [x, y] = grid.cells[k];
      Table.spawn({ x, y, facing: rng() * Math.PI * 2, scale: scale * (0.9 + rng() * 0.2) });
    }
    for (let k = 0; k < PEOPLE; k++) {
      Stroller.spawn({
        x: rng() * W,
        y: rng() * H,
        heading: rng() * Math.PI * 2,
        turn: (rng() * 2 - 1) * 0.35,
        speed: (22 + rng() * 26) * scale,
        scale: scale * (0.95 + rng() * 0.1),
      });
    }
  }
}
