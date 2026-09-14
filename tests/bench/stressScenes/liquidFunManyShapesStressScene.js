// L2: water over ~180 static platforms. Oracle for OverlapAABB across sub-steps (H26).
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/camera.js';
import WEED from '/src/index.js';

const { LiquidFun, LIQUIDFUN_FLAGS } = WEED;

export class LiquidFunManyShapesStressScene extends WEED.Scene {
  static config = {
    worldWidth: 6000,
    worldHeight: 6000,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      maxEntitiesPerCell: 96,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    particle: { noLimitFPS: false, maxParticles: 0, decals: false },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 980 },
      sleeping: false,
      liquidFun: { enabled: true, radius: 8, maxCount: 12000, subSteps: 2, strictContactCheck: false },
    },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 20000 },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[Floor, 220]];

  create() {
    const floorY = 2800;
    this.spawnEntity(Floor, { x: 2500, y: floorY, width: 5000, height: 200, tint: 0x333344 });
    this.spawnEntity(Floor, { x: 200, y: 1500, width: 200, height: 2400, tint: 0x333344 });
    this.spawnEntity(Floor, { x: 4800, y: 1500, width: 200, height: 2400, tint: 0x333344 });

    for (let i = 0; i < 180; i++) {
      const col = i % 18;
      const row = (i / 18) | 0;
      this.spawnEntity(Floor, {
        x: 500 + col * 220,
        y: 500 + row * 160,
        width: 140,
        height: 50,
        tint: 0x556677,
      });
    }

    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE,
      tint: 0x3399ff,
      shape: 'box',
      posX: 2500,
      posY: 350,
      halfWidth: 1600,
      halfHeight: 220,
      texture: '_whiteCircle',
    });

    Camera.setWorldBounds(Infinity, Infinity);
    Camera.setZoom(0.22);
    Camera.centerOn(2500, 1400);
  }
}
