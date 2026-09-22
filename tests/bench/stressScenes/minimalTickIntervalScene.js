/**
 * tickInterval 4 with staggeredUpdates.
 * Countdown scene sets tickBuckets false. Bucket scene leaves the default on.
 * N=160000 and entityIdWidth 32 so the fast side can clear the 3 ms floor.
 * Physics off: Box2D caps bodies at 65535.
 */
import WEED from '/src/index.js';
import { MinimalTickIntervalProp } from './minimalTick/minimalTickProp.js';

const { Scene, Camera } = WEED;

const N = 160000;
const WORLD = 28000;

export class MinimalTickIntervalScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    entityIdWidth: 32,
    seed: 0x71c7,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxEntitiesPerCell: 32,
      maxNeighbors: 8,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: true,
      tickBuckets: false,
    },
    physics: {
      enabled: false,
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

  static entities = [[MinimalTickIntervalProp, N]];

  create() {
    const cols = 400;
    const spacing = 64;
    const startX = 280;
    const startY = 280;
    for (let i = 0; i < N; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(MinimalTickIntervalProp, {
        x: startX + col * spacing,
        y: startY + row * spacing,
      });
    }
    Camera.centerOn(WORLD * 0.5, WORLD * 0.5);
    Camera.setZoom(0.15);
  }
}

export class MinimalTickIntervalBucketScene extends MinimalTickIntervalScene {
  static config = {
    ...MinimalTickIntervalScene.config,
    logic: {
      ...MinimalTickIntervalScene.config.logic,
      tickBuckets: true,
    },
  };
}
