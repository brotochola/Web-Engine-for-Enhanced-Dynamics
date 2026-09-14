// LiquidFunStressScene.js - L2 stress scene for the liquidfun-c particle step.
// ~10.2k water (plain fluid) + ~2k SPRING|STATIC_PRESSURE (group creation and
// Poisson pressure loop that plain water skips). Bumped from ~5k/~1k after H7:
// BOX2D_MS was down to ~2.8ms, too close to run-to-run noise (~0.1-0.3ms) for
// reliable before/after reads on further optimizations. No interactivity:
// spawn once, let it settle. strictContactCheck is false here (the config
// default since H1) - flip to true for a round that needs to exercise
// RemoveSpuriousBodyContacts (see H5 in docs/LIQUIDFUN_HYPOTHESES.md).
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/camera.js';
import WEED from '/src/index.js';

const { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } = WEED;

export class LiquidFunStressScene extends WEED.Scene {
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
      liquidFun: { enabled: true, radius: 8, maxCount: 15000, subSteps: 1, strictContactCheck: false },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 20000,
    },

    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {},
  };

  static entities = [[Floor, 10]];

  create() {
    const floorY = 2600;
    const wallTop = 200;
    const wallH = floorY - wallTop;
    const wallY = (wallTop + floorY) / 2;

    this.spawnEntity(Floor, { x: 2500, y: floorY, width: 4800, height: 260, tint: 0x444455 });
    this.spawnEntity(Floor, { x: 200, y: wallY, width: 260, height: wallH, tint: 0x444455 });
    this.spawnEntity(Floor, { x: 4800, y: wallY, width: 260, height: wallH, tint: 0x444455 });

    // ~10.2k water: radius 8 -> diameter 16 -> default spacing 12 (0.75x). 201x51 grid.
    // Left edge (400) clears the left wall's right face (330) with margin;
    // right edge (2800) leaves an 860px gap before the second group.
    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE,
      tint: 0x3399ff,
      shape: 'box',
      posX: 1600,
      posY: 800,
      halfWidth: 1200,
      halfHeight: 300,
      texture: '_whiteCircle',
    });

    // ~2k SPRING|STATIC_PRESSURE: exercises CapturePairs (create-time) and
    // SolveStaticPressure's 8-iteration Poisson loop (steady-state), neither
    // of which plain water touches. No named material preset uses these flags.
    // Right edge (4600) clears the right wall's left face (4670) with margin.
    LiquidFun.emit({
      shape: 'box',
      posX: 4130,
      posY: 800,
      halfWidth: 470,
      halfHeight: 145,
      flags: LIQUIDFUN_FLAGS.SPRING | LIQUIDFUN_FLAGS.STATIC_PRESSURE,
      tint: 0xff33aa,
      texture: '_whiteCircle',
    });

    // Rigid+solid ice slab: exercises SolveRigid / ComputeDepth / SolveSolid on the
    // steady-state path (plain water stress alone never touches these).
    LiquidFun.emit({
      shape: 'box',
      posX: 3200,
      posY: 400,
      halfWidth: 180,
      halfHeight: 100,
      flags: LIQUIDFUN_FLAGS.WATER,
      groupFlags: LIQUIDFUN_GROUP_FLAGS.SOLID | LIQUIDFUN_GROUP_FLAGS.RIGID,
      tint: 0xaadfff,
      texture: '_whiteCircle',
    });

    // Lift the world-fit zoom-out floor first so setZoom below isn't clamped
    // back up to a "cover" fit that crops the world (see LiquidFunDemoScene).
    Camera.setWorldBounds(Infinity, Infinity);

    Camera.setZoom(0.25);
    Camera.centerOn(2000, 1750);
    // Camera.zoom = 0.25
  }
}
