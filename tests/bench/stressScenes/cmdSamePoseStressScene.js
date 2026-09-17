import WEED from '/src/index.js';
import { CmdSamePoseBody } from './cmdRing/cmdSamePoseBody.js';

const { Scene, Camera } = WEED;

export const BODY_COUNT = 12400;

export class CmdSamePoseStressScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,
    seed: 0xc0d1,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 32,
      maxEntitiesPerCell: 255,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 64 },
    lighting: { enabled: false },
  };

  static entities = [[CmdSamePoseBody, BODY_COUNT]];

  create() {
    const cols = 100;
    for (let i = 0; i < BODY_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(CmdSamePoseBody, {
        x: 40 + col * 16,
        y: 40 + row * 16,
      });
    }
    Camera.centerOn(400, 320);
    Camera.setZoom(0.4);
  }
}
