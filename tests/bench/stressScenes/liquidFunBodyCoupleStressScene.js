// L2: water + many dynamic crates. Oracle for body-couple API (H24/H25/H27).
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Box } from '/demos/ballsAndRectanglesScene/gameObjects/box.js';
import { Camera } from '/src/core/camera.js';
import WEED from '/src/index.js';

const { LiquidFun, LIQUIDFUN_FLAGS } = WEED;

export class LiquidFunBodyCoupleStressScene extends WEED.Scene {
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
      sleeping: true,
      liquidFun: { enabled: true, radius: 8, maxCount: 12000, subSteps: 1, strictContactCheck: false },
    },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 20000 },
    lighting: { enabled: false },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
    },
  };

  static entities = [
    [Floor, 20],
    [Box, 140],
  ];

  create() {
    const floorY = 2600;
    const wallTop = 200;
    const wallH = floorY - wallTop;
    const wallY = (wallTop + floorY) / 2;

    this.spawnEntity(Floor, { x: 2500, y: floorY, width: 4800, height: 260, tint: 0x444455 });
    this.spawnEntity(Floor, { x: 200, y: wallY, width: 260, height: wallH, tint: 0x444455 });
    this.spawnEntity(Floor, { x: 4800, y: wallY, width: 260, height: wallH, tint: 0x444455 });

    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE,
      tint: 0x3399ff,
      shape: 'box',
      posX: 2500,
      posY: 900,
      halfWidth: 1400,
      halfHeight: 280,
      texture: '_whiteCircle',
    });

    for (let i = 0; i < 100; i++) {
      const col = i % 10;
      const row = (i / 10) | 0;
      this.spawnEntity(Box, { x: 900 + col * 160, y: 400 + row * 90 });
    }

    Camera.setWorldBounds(Infinity, Infinity);
    Camera.setZoom(0.25);
    Camera.centerOn(2500, 1600);
  }
}
