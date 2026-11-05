import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, GameObject, MeshRenderer, LAYER_KIND } = WEED;

/**
 * DX-MESHUPLOAD: a big MESH layer that never changes beside a small one that moves. `MeshGeometry.vertEpoch` is one
 * counter for every mesh, so a mover's setVertices makes every MESH layer look at its rows; main uploaded each layer
 * whole after that, the big one included.
 *
 * `?bigTris=` (default 400000) triangles on the still layer, `?moving=` (default 8) small meshes rewritten each frame on
 * the other, `?movers=one` puts the movers on the big layer instead, so the rows they touch are a small range of it.
 * `?backend=webgpu`. Primary: the renderer's STEP_MS. Load: MESH_FILL_INSTANCES.
 */
const SEED = 0x3e5a;
const WORLD_W = 4000;
const WORLD_H = 3000;
const SEG = 20;
const TRIS_PER_PLANE = SEG * SEG * 2;
const VERTS_PER_PLANE = (SEG + 1) * (SEG + 1);
const MOVER_SEG = 4;
const MOVER_VERTS = (MOVER_SEG + 1) * (MOVER_SEG + 1);

function query(key) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(key);
  } catch {
    return null;
  }
}

function queryNumber(key, fallback) {
  const raw = query(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const BIG_TRIS = Math.max(TRIS_PER_PLANE, Math.floor(queryNumber('bigTris', 400000)));
export const MOVING = Math.max(1, Math.floor(queryNumber('moving', 8)));
export const MOVERS_ON_BIG = query('movers') === 'one';
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const stressSceneConfig = {
  requested: { bigTris: BIG_TRIS, moving: MOVING, movers: MOVERS_ON_BIG ? 'one' : 'other', backend: BACKEND },
};

const PLANES = Math.ceil(BIG_TRIS / TRIS_PER_PLANE);

class UploadStill extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.setLayer('big');
    this.meshRenderer.tint = config.tint;
    this.meshRenderer.setPlane(60, 60, SEG, SEG);
  }
}

const MOVER_LAYER = MOVERS_ON_BIG ? 'big' : 'small';

class UploadMover extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.setLayer(MOVER_LAYER);
    this.meshRenderer.tint = 0xffcc33;
    this.meshRenderer.setPlane(80, 80, MOVER_SEG, MOVER_SEG);
    this._xy = new Float32Array(MOVER_VERTS * 2);
    this._t = config.phase;
  }

  tick() {
    this._t += 0.05;
    const xy = this._xy;
    const row = MOVER_SEG + 1;
    for (let j = 0; j < row; j++) {
      for (let i = 0; i < row; i++) {
        const k = (j * row + i) * 2;
        xy[k] = (i / MOVER_SEG - 0.5) * 80 + Math.sin(this._t + j) * 6;
        xy[k + 1] = (j / MOVER_SEG - 0.5) * 80 + Math.cos(this._t + i) * 6;
      }
    }
    this.meshRenderer.setVertices(xy);
  }
}

export class MeshUploadStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: BACKEND,
      noLimitFPS: false,
      maxMeshVerts: PLANES * VERTS_PER_PLANE + MOVING * MOVER_VERTS + 64,
      maxMeshIndices: (PLANES * TRIS_PER_PLANE + MOVING * MOVER_SEG * MOVER_SEG * 2) * 3 + 64,
    },
    lighting: { enabled: false },
    layers: {
      big: { kind: LAYER_KIND.MESH, zIndex: 1 },
      small: { kind: LAYER_KIND.MESH, zIndex: 2 },
    },
  };
  static entities = [
    [UploadStill, PLANES],
    [UploadMover, MOVING],
  ];

  create() {
    const rng = mulberry32(SEED);
    for (let i = 0; i < PLANES; i++) {
      UploadStill.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H, tint: 0x404040 + Math.floor(rng() * 0x7f) * 0x10101 });
    }
    for (let i = 0; i < MOVING; i++) {
      UploadMover.spawn({ x: 200 + i * 120, y: 200, phase: i * 0.7 });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.4);
  }
}
