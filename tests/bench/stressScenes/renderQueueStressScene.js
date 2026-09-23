import WEED from '/src/index.js';
import { RenderQueueStressEntity } from './renderQueue/renderQueueStressEntity.js';

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
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      staggeredUpdates: true,
    },
    physics: {
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
      ySortingInCPU: true,
      maxVisibleRenderables: 18000,
    },
    preRender: {
      noLimitFPS: false,
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
    spawnRenderQueueGrid(this);
    Camera.setZoom(0.5);
  }
}

const HIGH_REJECT_ZOOM = 3;

function spawnRenderQueueGrid(scene) {
  const cols = 160;
  const spacingX = 24;
  const spacingY = 22;
  const startX = 220;
  const startY = 220;
  const palette = [0xffffff, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f];

  for (let i = 0; i < 16000; i++) {
    const col = i % cols;
    const row = (i / cols) | 0;
    scene.spawnEntity(RenderQueueStressEntity, {
      x: startX + col * spacingX,
      y: startY + row * spacingY,
      scale: 0.75 + (i % 5) * 0.06,
      tint: palette[i % palette.length],
    });
  }

  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
}

/** Control 2: same 16k grid, zoom in so cull rejects. Catalog scene stays at zoom 0.5. */
export class RenderQueueHighRejectStressScene extends Scene {
  static config = {
    ...RenderQueueStressScene.config,
    preRender: {
      noLimitFPS: false,
      skipCull: false,
    },
  };
  static assets = RenderQueueStressScene.assets;
  static entities = [[RenderQueueStressEntity, 16000]];

  create() {
    spawnRenderQueueGrid(this);
    Camera.setZoom(HIGH_REJECT_ZOOM);
  }
}

export class RenderQueueHighRejectSkipCullScene extends Scene {
  static config = {
    ...RenderQueueStressScene.config,
    preRender: {
      noLimitFPS: false,
      skipCull: true,
    },
  };
  static assets = RenderQueueStressScene.assets;
  static entities = [[RenderQueueStressEntity, 16000]];

  create() {
    spawnRenderQueueGrid(this);
    Camera.setZoom(HIGH_REJECT_ZOOM);
  }
}
