import WEED from '/src/index.js';
import { RayStressEntity } from './ray/rayStressEntity.js';
import { KeyedStaticsBulletDriver, KeyedStaticsWalker } from './keyedStatics/keyedStaticsEntities.js';

const { Scene, Camera, Decoration, DecorationComponent } = WEED;

/**
 * N-202's probe: does a decoration ever draw another row's statics (texture, scale, anchor)? A grid of still decorations
 * fills a still view (zoom 1, centred), eight grass textures in turn; walkers cross a vertical band of it and bullets with
 * trails a horizontal one, so the y-sorted rows shift and trail rows come and go every frame. Outside the two bands the
 * picture never changes: a capture that differs there shows the bug (n202probe.mjs reads them).
 *
 * `?walkers=N` (200), `?perTick=N` (3 bullets a tick), `?indexedSprites=0` (split frames, no keyed ones),
 * `?posesByRow=0`, `?sway=1` (the grass sways and skews as Predator's does), `?alphaChurn=1` (every decoration's alpha
 * changes every frame, 0.86 or 1, as a zoom in the fading range changes them all: each is marked every frame),
 * `?particles=1` (Predator's particle worker: 10 000 particles, decals, the sway in 100 frequency buckets), `?fill=N` (N more
 * swaying grass decorations outside the view, Predator's 20 000 with the grid's).
 */
function q(key, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(key);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export const WALKERS = q('walkers', 200) | 0;
export const PER_TICK = q('perTick', 3) | 0;
export const INDEXED = q('indexedSprites', 1) !== 0;
export const POSES_BY_ROW = q('posesByRow', 1) !== 0;
export const SWAY = q('sway', 0) === 1;
export const ALPHA_CHURN = q('alphaChurn', 0) === 1;
export const PARTICLES = q('particles', 0) === 1;
export const FILL = Math.max(0, q('fill', 0) | 0);
export const GRID = { x0: 1064, y0: 1000, step: 48, cols: 39, rows: 22 };

export const stressSceneConfig = {
  requested: { walkers: WALKERS, perTick: PER_TICK, indexedSprites: INDEXED ? 1 : 0, posesByRow: POSES_BY_ROW ? 1 : 0, sway: SWAY ? 1 : 0, alphaChurn: ALPHA_CHURN ? 1 : 0, particles: PARTICLES ? 1 : 0, fill: FILL },
};

KeyedStaticsBulletDriver.perTick = PER_TICK;

export class KeyedStaticsProbeScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: 0x202,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 96, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 2, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: PARTICLES
      ? { maxParticles: 10000, decals: true, decalsTileSize: 256, decalsResolution: 0.5, swayFrequencyBuckets: 100 }
      : { maxParticles: 0, decals: false },
    // Predator's pool: the decorations keyed by pool slot (E-188).
    decoration: { maxDecorations: 20000 },
    bullet: { maxBullets: 2048, maxImpactsPerFrame: 256 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySort: true,
      interpolation: false,
      autoGenerateMipmaps: false,
      ...(INDEXED ? {} : { indexedSprites: false }),
      ...(POSES_BY_ROW ? {} : { keyedPosesByRow: false }),
    },
    preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi', backpressure: true },
    lighting: { enabled: false },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
      bunny: '/demos/img/bunny.png',
      bullet: '/demos/img/bullet.png',
      grass1: '/demos/img/g1.png',
      grass2: '/demos/img/g2.png',
      grass3: '/demos/img/g3.png',
      grass4: '/demos/img/g4.png',
      grass5: '/demos/img/g5.png',
      grass6: '/demos/img/g6.png',
      grass7: '/demos/img/g7.png',
      grass8: '/demos/img/g8.png',
    },
  };

  static entities = [
    [RayStressEntity, 4],
    [KeyedStaticsWalker, Math.max(1, WALKERS)],
    [KeyedStaticsBulletDriver, 1],
  ];

  create() {
    // The grid: a decoration a cell, its texture by cell, about 32 px tall.
    const sizes = [141, 54, 78, 230, 209, 199, 207, 203];
    this._decos = [];
    this._frame = 0;
    for (let r = 0; r < GRID.rows; r++) {
      for (let c = 0; c < GRID.cols; c++) {
        const t = (r * 3 + c) % 8;
        const s = 32 / sizes[t];
        const d = Decoration.spawn({
          x: GRID.x0 + c * GRID.step,
          y: GRID.y0 + r * GRID.step + 40,
          texture: `grass${t + 1}`,
          scaleX: s,
          scaleY: s,
          alpha: 1,
          anchorX: 0.5,
          anchorY: 1,
          ...(SWAY
            ? {
              sway: true,
              swaySkew: true,
              swayAmplitude: 0.05 + (((r * 131 + c * 71) % 97) / 97) * 0.03,
              swayFrequency: 1 + (((r * 59 + c * 113) % 89) / 89) * 2,
            }
            : {}),
        });
        if (d >= 0) this._decos.push(d);
      }
    }
    // ?fill=N: more grass outside the view (the world's left and right thirds), swaying as Predator's.
    let a = 0x202 >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < FILL; i++) {
      const t = Math.floor(rng() * 8);
      const s = 0.2 + rng() * 0.1;
      Decoration.spawn({
        x: rng() < 0.5 ? 40 + rng() * 900 : 3060 + rng() * 900,
        y: 40 + rng() * 2920,
        texture: `grass${t + 1}`,
        scaleX: s,
        scaleY: s,
        alpha: 0.7 + rng() * 0.3,
        anchorX: 0.5,
        anchorY: 1,
        sway: true,
        swaySkew: true,
        swayAmplitude: 0.05 + rng() * 0.03,
        swayFrequency: 1 + rng() * 2,
      });
    }
    // The bullets' wall at the band's right end.
    RayStressEntity.spawn({ x: 2930, y: 1500, shape: 'box', width: 24, height: 200 });
    for (let i = 0; i < WALKERS; i++) KeyedStaticsWalker.spawn({});
    KeyedStaticsBulletDriver.spawn({});
    Camera.centerOn(2000, 1500);
    Camera.setZoom(1);
  }

  update() {
    if (!ALPHA_CHURN) return;
    const f = this._frame++;
    const a = DecorationComponent.alpha;
    const ds = this._decos;
    for (let i = 0; i < ds.length; i++) a[ds[i]] = ((f + i) & 1) === 0 ? 1 : 0.86;
  }
}
