import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, ParticleEmitter, Camera } = WEED;

/**
 * E-492's picture: CPU particles that hold still among y-sorted sprites, so the keyed frames' particle rows (keyless
 * slots, or E-492's keys by particle index) can be compared byte for byte (compareCaptures.mjs). A grid of flat particles
 * (ParticleEmitter.emitFlat: no gravity, no speed, a life longer than any run), each with its own scale, alpha, tint and
 * texture from its place in the grid, every one emitted on the logic worker's first tick; and a row of posts every few
 * particle rows, so the painter puts particles between sprites. Nothing moves after the first ticks. Pixi packs the
 * entities, so the frames go keyed.
 *
 * `?count=` particles (default 600, a 30-wide grid); `?backend=webgpu`.
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const COUNT = Math.max(1, Math.min(4000, num('count', 600) | 0));
const W = 800;
const H = 600;
const COLS = 30;
const STEP_X = (W - 80) / COLS;
const ROWS = Math.ceil(COUNT / COLS);
const STEP_Y = (H - 80) / Math.max(1, ROWS);
/** A life no run reaches (ms). */
const FOREVER = 3.6e6;
const TEXTURES = ['_whiteCircle_64x64', '_white'];
const TINTS = [0xffd060, 0x60c0ff, 0xff6080, 0x80ff90, 0xffffff];

export const stressSceneConfig = { requested: { count: COUNT, backend: BACKEND } };

/** A dark post standing on its feet, y-sorted among the particles. */
class Post extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setDisplaySize(10, 40);
    this.setTint(0x3a3028);
  }
}

/** Emits the grid once, on its first tick (the logic worker's). */
class GridEmitter extends GameObject {
  static components = [];

  onSpawned() {
    this.emitted = 0;
  }

  tick() {
    if (this.emitted !== 0) return;
    this.emitted = 1;
    for (let i = 0; i < COUNT; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      ParticleEmitter.emitFlat({
        count: 1,
        x: 40 + (col + 0.5) * STEP_X,
        y: 40 + (row + 0.5) * STEP_Y,
        speed: 0,
        lifespan: FOREVER,
        scale: 0.08 + 0.04 * (i % 5),
        alpha: 0.4 + 0.15 * (i % 4),
        tint: TINTS[i % TINTS.length],
        texture: TEXTURES[(i >> 2) % TEXTURES.length],
      });
    }
  }
}

export class ParticleCaptureScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x492,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 64 },
    logic: { numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 4096, decals: false },
    decoration: { maxDecorations: 4 },
    renderer: { backend: BACKEND, ySort: true },
    // Pixi packs the entities, so its frames go keyed (keyedSpritesEnabled), as Predator's.
    preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' },
    lighting: { enabled: false },
  };

  static entities = [[Post, 64], [GridEmitter, 1]];

  create() {
    for (let k = 0; k < 64; k++) Post.spawn({ x: 40 + (k % 16) * 46 + 23, y: 40 + ((k / 16) | 0) * 140 + 70 });
    GridEmitter.spawn({ x: 0, y: 0 });
    Camera.setZoom(1);
    Camera.centerOn(W / 2, H / 2);
  }
}
