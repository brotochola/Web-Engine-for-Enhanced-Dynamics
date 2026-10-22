// Full-picture upload every logic tick, or one row. Primary: renderer STEP_MS.
// 8192×8192 r8 is the load knob. The trace of the 4096 picture was texSubImage2D.

import WEED from '/src/index.js';

const { Scene, Camera, GameObject, Layer, SharedResource } = WEED;

export const TEX = 8192;

export class UploadGrid extends SharedResource {}

export class UploadDriver extends GameObject {
  static forceProcessOnLogicWorker = 0;

  onSpawned() {
    this.row = 0;
  }

  tick() {
    const cells = UploadGrid.cells;
    const y = this.row;
    const start = y * TEX;
    for (let i = 0; i < TEX; i++) cells[start + i] = (cells[start + i] + 1) & 255;
    this.row = y + 1 < TEX ? y + 1 : 0;
    Layer.get('grid').updateTexture('cells', cells);
  }
}

export class UploadRowDriver extends GameObject {
  static forceProcessOnLogicWorker = 0;

  onSpawned() {
    this.row = 0;
  }

  tick() {
    const cells = UploadGrid.cells;
    const y = this.row;
    const start = y * TEX;
    for (let i = 0; i < TEX; i++) cells[start + i] = (cells[start + i] + 1) & 255;
    this.row = y + 1 < TEX ? y + 1 : 0;
    Layer.get('grid').updateTexture('cells', cells, 0, y, TEX, 1);
  }
}

export class TextureUploadStressScene extends Scene {
  static config = {
    worldWidth: TEX,
    worldHeight: TEX,
    seed: 1,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 256,
      maxEntitiesPerCell: 4,
      maxNeighbors: 1,
      noLimitFPS: false,
    },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    physics: { enabled: false },
    lighting: { enabled: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    layers: {
      grid: {
        zIndex: 1,
        shader: {
          fragment: {
            webgl: '/tests/bench/stressScenes/shaders/uploadGrid.frag',
            webgpu: '/tests/bench/stressScenes/shaders/uploadGrid.wgsl',
          },
          worldRect: { width: TEX, height: TEX },
          textures: [
            { name: 'cells', format: 'r8unorm', size: { width: TEX, height: TEX } },
          ],
        },
      },
    },
  };

  static assets = { textures: {} };

  static entities = [[UploadDriver, 1]];

  static sharedResources = [[
    UploadGrid,
    { cells: { type: Uint8Array, length: TEX * TEX } },
  ]];

  create() {
    UploadDriver.spawn({ x: 0, y: 0, forceProcessOnLogicWorker: 0 });
    Camera.setFree(false);
    Camera.centerOn(200, 200);
    Camera.setZoom(1);
  }
}

export class TextureUploadRowScene extends TextureUploadStressScene {
  static entities = [[UploadRowDriver, 1]];

  create() {
    UploadRowDriver.spawn({ x: 0, y: 0, forceProcessOnLogicWorker: 0 });
    Camera.setFree(false);
    Camera.centerOn(200, 200);
    Camera.setZoom(1);
  }
}
