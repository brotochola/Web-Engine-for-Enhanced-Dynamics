/**
 * 60k entities with a minimal instance tick: this.spriteRenderer.alpha = rng().
 * Primary: logic0_STEP_MS. Load: ENTITIES_PROCESSED.
 * `?props=<n>` sets the prop count (one worker's logic passes 3 ms near 120000); past 60000 the grid gets
 * denser, not larger, so the props stay inside the world. Past 65535 physics is off: Box2D holds no more bodies,
 * and the props never use it.
 */
import WEED from '/src/index.js';
import { MinimalTickProp } from './minimalTick/minimalTickProp.js';

const { Scene, Camera } = WEED;

function queryProps() {
  try {
    const n = parseInt(new URLSearchParams(globalThis.location?.search || '').get('props'), 10);
    return n > 0 ? n : 60000;
  } catch {
    return 60000;
  }
}

export const PROP_COUNT = queryProps();
// 1 up to 60000 props (the grid as it always was), then the factor that keeps its footprint.
const DENSITY = PROP_COUNT > 60000 ? Math.sqrt(PROP_COUNT / 60000) : 1;
const PHYSICS =
  PROP_COUNT > 65535
    ? { enabled: false }
    : { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 }, sleeping: true };
export const WORLD_W = 22000;
export const WORLD_H = 22000;

export class MinimalTickScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x71c7,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxEntitiesPerCell: 32,
      maxNeighbors: 8,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: PHYSICS,
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 256 },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[MinimalTickProp, PROP_COUNT]];

  create() {
    const cols = Math.ceil(256 * DENSITY);
    const spacing = 80 / DENSITY;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < PROP_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      MinimalTickProp.spawn({
        x: startX + col * spacing,
        y: startY + row * spacing,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.15);
  }
}
