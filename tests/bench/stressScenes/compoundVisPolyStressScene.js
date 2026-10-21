/**
 * Moving compound occluders and moving raycasted lights.
 * Not a scoreboard row. Primary: preRender STEP_MS.
 */
import WEED from '/src/index.js';
import { VisPolyAlbedo } from './visPoly/visPolyAlbedo.js';
import { CompoundVisIsland } from './compoundVisPoly/compoundVisIsland.js';
import { CompoundVisLight } from './compoundVisPoly/compoundVisLight.js';
import { VisPolyOccluder } from './visPoly/visPolyOccluder.js';

const { Scene, Camera } = WEED;

const SEED = 0xc0ffee;
export const ISLANDS = 40;
export const LIGHTS = 24;

/**
 * `?remeshEvery=N`: island 0 re-applies its own polygons every N ticks. That
 * bumps the pool-wide fixture revision, so every lit compound rebuilds its
 * outline the next frame, as when the terrain laser remeshes one island
 * (review G1, E-58). 0 (default) never remeshes.
 */
export const REMESH_EVERY = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('remeshEvery');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
})();

/**
 * `?ringSegments=N`: each island is a ring of N segments, 2N triangles. 18
 * (default, 36 triangles) is the plain scene; terrain islands run to hundreds
 * of triangles, which is where an outline rebuild costs (E-58).
 */
export const RING_SEGMENTS = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('ringSegments');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 3 ? n : 18;
  } catch {
    return 18;
  }
})();

/**
 * `?boxes=N`: N plain box occluders among the islands, so lights see simple and
 * compound occluders together and merge the sweep into the polar bins (E-43).
 * 0 (default) is the compound-only scene.
 */
export const BOXES = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('boxes');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
})();

export const stressSceneConfig = {
  requested: { remeshEvery: REMESH_EVERY, ringSegments: RING_SEGMENTS, boxes: BOXES },
};
const TRIS = RING_SEGMENTS * 2;
const WORLD_W = 2400;
const WORLD_H = 2400;

export class CompoundVisPolyStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: SEED,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 128,
      maxEntitiesPerCell: 255,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: ISLANDS * TRIS + 64,
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 4000 },
    preRender: { noLimitFPS: false },
    lighting: {
      enabled: true,
      baseAmbient: 0.15,
      maxLights: 32,
      shadowsEnabled: false,
      raycasted: true,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: 2048,
    },
  };

  static entities = [
    [VisPolyAlbedo, 1],
    [CompoundVisLight, LIGHTS],
    [CompoundVisIsland, ISLANDS],
    // Always listed: a worker reads no query, so a conditional entry would leave
    // it unbound there. The page's count is the one that sizes the pool.
    [VisPolyOccluder, BOXES],
  ];

  create() {
    let a = SEED >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    this.spawnEntity(VisPolyAlbedo, {
      x: WORLD_W * 0.5,
      y: WORLD_H * 0.5,
      width: WORLD_W,
      height: WORLD_H,
    });

    const cols = 8;
    const spacing = 220;
    const originX = 360;
    const originY = 360;
    for (let i = 0; i < ISLANDS; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      const dir = rng() * Math.PI * 2;
      const speed = 30 + rng() * 50;
      this.spawnEntity(CompoundVisIsland, {
        x: originX + col * spacing,
        y: originY + row * spacing,
        rotation: rng() * Math.PI * 2,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        spin: (rng() - 0.5) * 1.2,
        remeshEvery: i === 0 ? REMESH_EVERY : 0,
        segments: RING_SEGMENTS,
      });
    }
    for (let i = 0; i < LIGHTS; i++) {
      const dir = rng() * Math.PI * 2;
      const speed = 40 + rng() * 70;
      this.spawnEntity(CompoundVisLight, {
        x: 300 + rng() * (WORLD_W - 600),
        y: 300 + rng() * (WORLD_H - 600),
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
      });
    }
    // After the lights, so the default scene draws the same random numbers.
    for (let i = 0; i < BOXES; i++) {
      this.spawnEntity(VisPolyOccluder, {
        x: 160 + rng() * (WORLD_W - 320),
        y: 160 + rng() * (WORLD_H - 320),
        width: 24 + rng() * 40,
        height: 24 + rng() * 40,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.45);
  }
}
