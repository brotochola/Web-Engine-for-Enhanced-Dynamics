/**
 * Big-world cull stress (E-127): many static sprites over a world much larger than the view, so pre-render's
 * collect tests every sprite each frame to draw a few. The regime a cull grid would pay in; Predator's view holds
 * its fight and cannot show it.
 *
 * `?sprites=<n>` (default 500 000, the engine's ceiling with 32-bit ids): static sprites on a grid that fills the world.
 * `?view=<share>` (default 0.05): the share of the world, and so of the sprites, the view covers at zoom 1 on a
 * 1920 x 1080 canvas. The spacing follows from the two (smaller sprites overlap; the cull is what is timed).
 * `?static=1`: the props' type declares `static isStatic = true` (static scenery: pre-render culls it by the cells in
 * view, E-127); default 0, the linear cull over every sprite.
 *
 * Primary: preRender STEP_MS. Load: VISIBLE_ENTITIES (about sprites x view).
 */
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

const param = (name, fallback, ok) => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(name);
    const n = raw ? parseFloat(raw) : NaN;
    return ok(n) ? n : fallback;
  } catch {
    return fallback;
  }
};

export const SPRITE_COUNT = Math.floor(param('sprites', 500000, (n) => Number.isFinite(n) && n >= 1));
export const VIEW_SHARE = param('view', 0.05, (n) => Number.isFinite(n) && n > 0 && n <= 1);
export const STATIC_PROPS = param('static', 0, (n) => n === 0 || n === 1) === 1;

const VIEW_W = 1920;
const VIEW_H = 1080;
/** The spacing that makes the world the view's area over the share. */
export const SPACING = Math.sqrt((VIEW_W * VIEW_H) / VIEW_SHARE / SPRITE_COUNT);
const COLS = Math.max(1, Math.ceil(Math.sqrt(SPRITE_COUNT * (VIEW_W / VIEW_H))));
const ROWS = Math.ceil(SPRITE_COUNT / COLS);
export const WORLD_W = Math.ceil(COLS * SPACING);
export const WORLD_H = Math.ceil(ROWS * SPACING);

export const stressSceneConfig = {
  requested: { sprites: SPRITE_COUNT, view: VIEW_SHARE, static: STATIC_PROPS ? 1 : 0 },
};

class WorldProp extends WEED.GameObject {
  static components = [WEED.SpriteRenderer];
  static isStatic = STATIC_PROPS;

  onSpawned({ x = 0, y = 0 } = {}) {
    this.setSprite('sprite');
    this.setAnchor(0.5, 0.5);
    this.x = x;
    this.y = y;
  }
}

export class BigWorldCullStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0xb16,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 4096, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 0 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      // Room for what the view holds and its cull margin, not for the world.
      maxVisibleRenderables: Math.min(SPRITE_COUNT, Math.ceil(SPRITE_COUNT * VIEW_SHARE * 3) + 1024),
      ySort: false,
    },
    lighting: { enabled: false },
  };

  static assets = { textures: { sprite: '/demos/img/bunny.png' } };

  static entities = [[WorldProp, SPRITE_COUNT]];

  create() {
    for (let i = 0; i < SPRITE_COUNT; i++) {
      WorldProp.spawn({
        x: SPACING * ((i % COLS) + 0.5),
        y: SPACING * (((i / COLS) | 0) + 0.5),
      });
    }
    Camera.setZoom(1);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  }
}
