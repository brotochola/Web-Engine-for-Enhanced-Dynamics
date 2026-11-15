import WEED from '/src/index.js';
import { DirectionalWanderer, HandWanderer, TICK_INTERVAL, WORLD } from './directional/wanderer.js';

const { Scene, Camera } = WEED;

function queryNumber(key, fallback) {
  const raw = WEED.params?.get(key) ?? null;
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** `?n=`: wanderers (default 20 000), the load. */
export const N = Math.min(200000, Math.max(1, Math.floor(queryNumber('n', 20000))));
/** `?mode=ds` (default): DirectionalSprite picks the frames; `?mode=hand`: each tick picks its own, as Predator did. */
export const MODE = WEED.params?.get('mode') === 'hand' ? 'hand' : 'ds';
/** `?turnRate=`: radians a wanderer turns a frame, at most (default 0.02): how often directions change. */
export const TURN = queryNumber('turnRate', 0.02);
/** `?margin=`: DirectionalSprite.turnMargin in radians (default: the component's, a tenth of a step). */
/** `?tickInterval=`: both arms tick every N frames (default 1), as Predator's civilians (4) and soldiers (6) do (E-364). */
export const MARGIN = queryNumber('margin', -1);

export const stressSceneConfig = {
  requested: { n: N, mode: MODE, turnRate: TURN, margin: MARGIN, tickInterval: TICK_INTERVAL },
};

/**
 * DX-DIRSPRITE's owner scene: N civilians walk slow curves (no physics) and show the walk of the direction they move in.
 * With `?mode=ds` DirectionalSprite resolves them after the ticks; with `?mode=hand` each tick computes its octant and
 * calls setAnimation when it changes. The primary is logic (the pass runs there). Pre-render and Pixi draw the same
 * either way.
 */
export class DirectionalSpriteStressScene extends Scene {
  static config = {
    worldWidth: WORLD.w,
    worldHeight: WORLD.h,
    seed: 0xd1e5,
    entityIdWidth: 32,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    // ?tickInterval= (wanderer.js): past 1 the types tick every N frames, which needs staggered updates.
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false, staggeredUpdates: TICK_INTERVAL > 1 },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl', noLimitFPS: false, ySort: false, maxVisibleRenderables: N },
    preRender: { skipCull: true, noLimitFPS: false },
    lighting: { enabled: false },
  };

  static assets = {
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png' },
    },
  };

  static entities = [[MODE === 'hand' ? HandWanderer : DirectionalWanderer, N]];

  create() {
    Camera.setZoom(1);
    Camera.centerOn(WORLD.w / 2, WORLD.h / 2);
    const rng = globalThis.rng;
    const Type = MODE === 'hand' ? HandWanderer : DirectionalWanderer;
    for (let i = 0; i < N; i++) {
      Type.spawn({
        x: WORLD.w * rng(),
        y: WORLD.h * rng(),
        heading: rng() * Math.PI * 2,
        turn: (rng() * 2 - 1) * TURN,
        pace: 0.5 + rng(),
        margin: MARGIN,
      });
    }
  }
}
