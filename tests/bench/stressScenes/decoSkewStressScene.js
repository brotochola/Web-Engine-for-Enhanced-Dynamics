import WEED from '/src/index.js';
import { DecoFixedAnchor } from './decorations/decoFixedAnchor.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, Decoration } = WEED;

/**
 * DX-DECOSKEW: walls drawn from flat pieces, as Conurbano-weed's houses: rows of six 40 px pieces chained along a
 * slope, each sheared (skewY) so its top and bottom follow the row, every fifth row leaning too (skewX). A patch of
 * shear-swaying blades (swaySkew, the marker skewY extends) sits at the world's centre.
 *
 * `?skew=` (default 1): 1 shears the pieces, 0 draws the same pieces unsheared (the baseline on any revision; a
 * revision without the shear ignores the keys and draws them unsheared too). `?n=` (default 40000) pieces;
 * `?zoom=` (default 1) the camera's zoom on the world's centre; `?backend=webgpu` the WGSL path. Work for pre-render (the collect) and Pixi (the
 * sprite shader's shear), not for the particle worker beyond the screen test (the pieces are still).
 */
const SEED = 0x5ce3;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MAX_DECORATIONS = 65535;
const PIECE = 40;
const ROW = 6;
const SLOPES = [-1.2, -0.6, -0.3, 0, 0.3, 0.6, 1.2];

function queryNumber(key, fallback) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(key);
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export const SKEW = queryNumber('skew', 1) === 0 ? 0 : 1;
export const N = Math.max(ROW, Math.min(60000, Math.floor(queryNumber('n', 40000))));
export const ZOOM = queryNumber('zoom', 1);
/** `?backend=webgpu` (default webgl): the WGSL sprite shader instead of the GLSL one. */
export const BACKEND = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
  } catch {
    return 'webgl';
  }
})();
export const stressSceneConfig = { requested: { skew: SKEW, n: N, zoom: ZOOM, backend: BACKEND } };

function decoSkewConfig() {
  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 64, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: MAX_DECORATIONS, swayDecimation: 1 },
    renderer: { backend: BACKEND, noLimitFPS: false, maxVisibleRenderables: 60000 },
    lighting: { enabled: false },
  };
}

/** The rows of pieces, in one spawnMany call (one value per piece), and the swaying patch. */
function plantWalls() {
  const rng = mulberry32(SEED);
  DecoFixedAnchor.spawn({ x: -10000, y: -10000 });
  const rows = Math.floor(N / ROW);
  const n = rows * ROW;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const skewX = new Float32Array(n);
  const skewY = new Float32Array(n);
  const tint = new Uint32Array(n);
  const s = PIECE / 100;
  for (let r = 0; r < rows; r++) {
    const slope = SLOPES[r % SLOPES.length];
    const lean = r % 5 === 0 ? 0.4 : 0;
    const x0 = 64 + rng() * (WORLD_W - 128 - ROW * PIECE);
    const y0 = 160 + rng() * (WORLD_H - 320);
    const c = 0x808080 + Math.floor(rng() * 0x7f) * 0x10101;
    for (let k = 0; k < ROW; k++) {
      const i = r * ROW + k;
      // Each piece's centre on the row's slope; sheared, its edges meet its neighbours'.
      x[i] = x0 + (k + 0.5) * PIECE;
      y[i] = y0 + (k + 0.5) * PIECE * slope;
      skewX[i] = SKEW ? lean : 0;
      skewY[i] = SKEW ? slope : 0;
      tint[i] = c;
    }
  }
  Decoration.spawnMany({ x, y, skewX, skewY, tint, texture: 'box', scaleX: s, scaleY: s, anchorX: 0.5, anchorY: 0.5 });
  for (let i = 0; i < 400; i++) {
    Decoration.spawn({
      x: WORLD_W * 0.5 - 200 + rng() * 400,
      y: WORLD_H * 0.5 - 100 + rng() * 200,
      texture: 'ball',
      scaleX: 0.5,
      scaleY: 1.6,
      anchorY: 1,
      swaySkew: true,
      swayAmplitude: 0.3,
      swayFrequency: 1 + rng(),
    });
  }
  Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
  Camera.setZoom(ZOOM);
}

export class DecoSkewStressScene extends Scene {
  static config = decoSkewConfig();
  static assets = { textures: { box: '/demos/img/box_100_100.png', ball: '/demos/img/bola.png' } };
  static entities = [[DecoFixedAnchor, 1]];
  create() {
    plantWalls();
  }
}
