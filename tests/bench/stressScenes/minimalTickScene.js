/**
 * 60k entities with a minimal instance tick: this.spriteRenderer.alpha = rng().
 * Primary: logic0_STEP_MS. Load: ENTITIES_PROCESSED.
 */
import WEED from '/src/index.js';
import { MinimalTickProp } from './minimalTick/minimalTickProp.js';

const { Scene, Camera } = WEED;

export const PROP_COUNT = 60000;
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
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: true,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 256 },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[MinimalTickProp, PROP_COUNT]];

  create() {
    const cols = 256;
    const spacing = 80;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < PROP_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(MinimalTickProp, {
        x: startX + col * spacing,
        y: startY + row * spacing,
      });
    }
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.15);
  }
}
