// LiquidFunQueryStressScene — dense fluid + per-frame sync QueryAABB/RayCast churn.
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/camera.js';
import WEED from '/src/index.js';
import { LiquidFunQueryChurn } from './liquidFunQuery/liquidFunQueryChurn.js';

const { LiquidFun, LIQUIDFUN_FLAGS } = WEED;

/**
 * `?lf=<n>`: LiquidFun's maximum and the queue's rows (default 24 000 each; the box makes 19 656 particles); the box
 * then spans the basin between the walls, as tall as n particles need from y 2400 up (about 147 px² a particle), so it
 * stays inside the world up to about 70 000 (E-194: the renderer at the defaults is about 1 ms, under the 3 ms floor).
 */
const LF_COUNT = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('lf');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
})();
const LF_MAX = LF_COUNT > 0 ? LF_COUNT : 24000;
// Every particle LiquidFun may hold: at 16 000 the box's last 3 656 were not drawn (00b1448f).
const LF_ROWS = LF_COUNT > 0 ? LF_COUNT : 24000;
const LF_HALF_W = LF_COUNT > 0 ? 2150 : 1400;
const LF_HALF_H = LF_COUNT > 0 ? (LF_COUNT * 147) / (4 * LF_HALF_W) : 500;
const LF_X = LF_COUNT > 0 ? 2500 : 2000;
const LF_Y = LF_COUNT > 0 ? 2400 - LF_HALF_H : 900;

export class LiquidFunQueryStressScene extends WEED.Scene {
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
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
    },
    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 980 },
      sleeping: false,
      liquidFun: { enabled: true, radius: 8, maxCount: LF_MAX, subSteps: 1, strictContactCheck: false },
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: LF_ROWS,
    },
    preRender: {
      packGpuSprites: 'pixi',
      sortSprites: 'pixi',
    },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [
    [Floor, 8],
    [LiquidFunQueryChurn, 1],
  ];

  create() {
    const floorY = 2600;
    const wallTop = 200;
    const wallH = floorY - wallTop;
    const wallY = (wallTop + floorY) / 2;

    Floor.spawn({ x: 2500, y: floorY, width: 4800, height: 260, tint: 0x444455 });
    Floor.spawn({ x: 200, y: wallY, width: 260, height: wallH, tint: 0x444455 });
    Floor.spawn({ x: 4800, y: wallY, width: 260, height: wallH, tint: 0x444455 });

    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE,
      tint: 0x3399ff,
      shape: 'box',
      posX: LF_X,
      posY: LF_Y,
      halfWidth: LF_HALF_W,
      halfHeight: LF_HALF_H,
      texture: '_whiteCircle',
    });

    LiquidFunQueryChurn.spawn({ x: 2000, y: 900 });

    Camera.setWorldBounds(Infinity, Infinity);
    Camera.setZoom(0.25);
    Camera.centerOn(2000, 1750);
  }
}
