import WEED from '/src/index.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { LiquidFunQueryProbe } from './gameObjects/liquidFunQueryProbe.js';

const { Scene, Camera, LiquidFun, LIQUIDFUN_FLAGS } = WEED;

/**
 * Minimal scene: blob + probe that runs sync LiquidFun.queryAABB / rayCast once.
 */
export class LiquidFunQueryScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    seed: 1,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 980 },
      sleeping: false,
      liquidFun: { enabled: true, radius: 10, maxCount: 2000, subSteps: 1 },
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [
    [Floor, 4],
    [LiquidFunQueryProbe, 1],
  ];

  create() {
    this.spawnEntity(Floor, { x: 1000, y: 1600, width: 1800, height: 80, tint: 0x444455 });
    this.spawnEntity(LiquidFunQueryProbe, { x: 1000, y: 900, expectedMin: 10 });
    Camera.centerOn(1000, 1100);
    Camera.setZoom(0.6);
  }

  createNewGame() {
    LiquidFun.emit({
      shape: 'box',
      posX: 1000,
      posY: 900,
      halfWidth: 160,
      halfHeight: 120,
      flags: LIQUIDFUN_FLAGS.WATER,
      tint: 0x3399ff,
      texture: '_whiteCircle',
    });
  }

  onMessageFromGameObject(data) {
    if (data?.type === 'liquidFunQuerySelfCheck') {
      console.log('[LiquidFunQueryScene] self-check', data);
      this._liquidFunQuerySelfCheck = data;
    }
  }
}
