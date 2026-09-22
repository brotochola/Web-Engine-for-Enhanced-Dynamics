/**
 * Y-sort painter A/B. Copy of the render-queue stress row with a higher N.
 * Catalog scene stays at 16k. Physics off: Box2D caps bodies at 65535.
 * skipCull keeps every sprite in the queue so Pixi sees N.
 */
import WEED from '/src/index.js';
import { RenderQueueStressEntity } from './renderQueue/renderQueueStressEntity.js';

const { Scene, Camera } = WEED;

const N = 300000;
const COLS = 400;

export class PainterSortStressScene extends Scene {
  static config = {
    worldWidth: 12000,
    worldHeight: 14000,
    entityIdWidth: 32,
    seed: 616161,
    spatial: {
      numberOfSpatialWorkers: 0,
      cellSize: 256,
      maxNeighbors: 0,
      noLimitFPS: false,
    },
    logic: {
      numberOfLogicWorkers: 1,
      noLimitFPS: false,
      staggeredUpdates: true,
    },
    physics: {
      enabled: false,
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySorting: true,
      maxVisibleRenderables: N,
    },
    preRender: {
      noLimitFPS: false,
      skipCull: true,
      numberOfPreRenderWorkers: 1,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  static entities = [[RenderQueueStressEntity, N]];

  create() {
    const palette = [0xffffff, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f];
    for (let i = 0; i < N; i++) {
      const col = i % COLS;
      const row = (i / COLS) | 0;
      this.spawnEntity(RenderQueueStressEntity, {
        x: 40 + col * 24,
        y: 40 + row * 22,
        scale: 0.75 + (i % 5) * 0.06,
        tint: palette[i % palette.length],
      });
    }
    Camera.setZoom(0.5);
    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
  }
}
