import WEED from '/src/index.js';
import { mulberry32 } from '../benchMath.js';

const { Scene, Camera, GameObject, MeshRenderer, Sun, LAYER_KIND } = WEED;

/**
 * DX-SUNMESH: N boxes as meshes with a height per vertex on a sunProjected layer, the sun moving. The GPU moves the
 * vertices, so the cost is one RT draw of the layer a frame, whatever the number of boxes; nothing is packed or uploaded
 * after the first frame.
 *
 * `?n=` (default 20000) boxes, `?verts=` (default 8) corners on each box's outline (8: a house's plan, 4: a plain box),
 * `?on=0` draws them as a plain MESH layer with no sun, the baseline, `?backend=webgpu`.
 * Primary: the renderer's STEP_MS. Load: MESH_RT_DRAWS.
 */
const SEED = 0x5a4e;
const WORLD_W = 6000;
const WORLD_H = 4000;

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

export const N = Math.max(1, Math.floor(queryNumber('n', 20000)));
export const VERTS = Math.max(3, Math.floor(queryNumber('verts', 8)));
export const ON = queryNumber('on', 1) === 1;
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const stressSceneConfig = { requested: { n: N, verts: VERTS, on: ON ? 1 : 0, backend: BACKEND } };

/** A prism: floor outline at height 0, roof outline at `h`, a quad up each side. */
function prism(radius, h) {
  const xy = [];
  const heights = [];
  const indices = [];
  for (let level = 0; level < 2; level++) {
    for (let i = 0; i < VERTS; i++) {
      const a = (i / VERTS) * Math.PI * 2;
      xy.push(Math.cos(a) * radius, Math.sin(a) * radius * 0.6);
      heights.push(level === 0 ? 0 : h);
    }
  }
  for (let i = 1; i < VERTS - 1; i++) indices.push(0, i, i + 1, VERTS, VERTS + i, VERTS + i + 1);
  for (let i = 0; i < VERTS; i++) {
    const j = (i + 1) % VERTS;
    indices.push(i, j, VERTS + j, i, VERTS + j, VERTS + i);
  }
  return { xy, heights, indices };
}

class SunBox extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.x = config.x;
    this.y = config.y;
    this.setLayer('shadows');
    this.meshRenderer.tint = 0x000000;
    const { xy, heights, indices } = prism(config.radius, config.h);
    this.meshRenderer.setMesh(xy, indices);
    if (ON) this.meshRenderer.setHeights(heights);
  }
}

export class SunMeshStressScene extends Scene {
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
      maxMeshVerts: N * VERTS * 2 + 64,
      maxMeshIndices: N * ((VERTS - 2) * 6 + VERTS * 6) + 64,
    },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', tileScale: 1, parallax: 1, zIndex: 0 },
      shadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, ...(ON ? { sunProjected: true } : {}) },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.3,
      sun: { enabled: true, startHour: 8, shadowAlpha: 0.6, dayCycle: { enabled: true, speed: 1, dayDurationMinutes: 1 } },
    },
  };
  static assets = { textures: { ground: '/demos/img/box_100_100.png' } };
  static entities = [[SunBox, N]];

  create() {
    const rng = mulberry32(SEED);
    for (let i = 0; i < N; i++) {
      SunBox.spawn({ x: rng() * WORLD_W, y: rng() * WORLD_H, radius: 12 + rng() * 24, h: 20 + rng() * 80 });
    }
    Sun.setTimeOfDay(8);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.5);
  }
}
