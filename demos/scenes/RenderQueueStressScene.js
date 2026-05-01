import WEED from '/src/index.js';
import { RenderQueueStressEntity } from '../gameObjects/renderQueueStressEntity.js';

const { Scene, Camera } = WEED;

export class RenderQueueStressScene extends Scene {
  static config = {
    worldWidth: 4200,
    worldHeight: 2600,
    seed: 616161,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 256,
      maxNeighbors: 32,
      maxEntitiesPerCell: 128,
      noLimitFPS: true,
    },
    logic: {
      noLimitFPS: true,
      staggeredUpdates: true,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: true,
      maxCollisionPairs: 1,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      noLimitFPS: true,
      ySorting: true,
      maxVisibleRenderables: 18000,
    },
    preRender: {
      noLimitFPS: true,
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

  static entities = [[RenderQueueStressEntity, 16000]];

  create() {
    const cols = 160;
    const spacingX = 24;
    const spacingY = 22;
    const startX = 220;
    const startY = 220;
    const palette = [0xffffff, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f];

    for (let i = 0; i < 16000; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(RenderQueueStressEntity, {
        x: startX + col * spacingX,
        y: startY + row * spacingY,
        scale: 0.75 + (i % 5) * 0.06,
        tint: palette[i % palette.length],
      });
    }

    Camera.centerOn(this.config.worldWidth * 0.5, this.config.worldHeight * 0.5);
    Camera.setZoom(0.5);
  }
}
