import { BurningBox } from './gameObjects/burningBox.js';
import { Blower } from './gameObjects/blower.js';
import { RocketBox } from './gameObjects/rocketBox.js';
import { OccludingFloor } from './gameObjects/occludingFloor.js';
import WEED from '/src/index.js';
import { fireAssets, fireLayer } from './fireLayer.js';

const { Mouse, Keyboard, LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS, Camera, BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_KIND, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } = WEED;

const OIL_LAYER = 'oil';

// The fire: fireLayer.js (shared with the landing page), over the whole world at FIRE_CELL_SIZE.
const FIRE_WORLD_WIDTH = 4000;
const FIRE_WORLD_HEIGHT = 3000;
const FIRE_CELL_SIZE = 4;
const FIRE_LF_RADIUS = 6;
const FIRE_LF_MAX = 16000;
const OIL_DRIP_MS = 220;

export class BurningBoxesScene extends WEED.Scene {
  static config = {
    worldWidth: FIRE_WORLD_WIDTH,
    worldHeight: FIRE_WORLD_HEIGHT,

    spatial: {
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
      numberOfSpatialWorkers: 2,
      maxEntitiesPerCell: 255,
    },

    debug: { collectDetailedStats: true },

    logic: { noLimitFPS: false },
    particle: { noLimitFPS: false, maxParticles: 100, decals: false },
    physics: {
      subStepCount: 2,
      noLimitFPS: false,
      gravity: { x: 0, y: 2400 },
      sleeping: false,
      liquidFun: {
        enabled: true,
        radius: FIRE_LF_RADIUS,
        maxCount: FIRE_LF_MAX,
        subSteps: 2,
      },
    },
    preRender: { noLimitFPS: false },
    renderer: {
      backend: 'webgpu',
      noLimitFPS: false,
      ySort: false,
      // maxVisibleRenderables: 4000,
    },
    lighting: {
      enabled: true,
      baseAmbient: 0,
      maxLights: 256,
      shadowsEnabled: false,
      raycasted: true,
      maxPolygonVertices: 512,
      maxOccluderSelfLit: 512,
      resolution: 0.5,
      sun: { enabled: false },
    },

    layers: {
      sky: {
        kind: LAYER_KIND.COVER,
        texture: 'landscape',
        parallax: 0.15,
        zoomParallax: 0.35,
        margin: 0.2,
        zIndex: 0,
      },
      oil: {
        zIndex: 3.4,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        scaleMode: LAYER_SCALE_MODE.LINEAR,
        maxItems: 0,
        ySorting: false,
        shader: {
          fragment: 'dulceDeLeche',
          containerBlend: BLEND_MODES.ADD,
          densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
          splat: {
            radius: 40,
            falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
            useParticleTint: true,
            intensity: 0.166,
          },
          uniforms: {
            uCutoff: { value: 0.53, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Cutoff', tip: 'Hide density below this. Higher = thinner looking fluid.' },
            uRim: { value: 0.0, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Rim', tip: 'Density where the cream rim ends and the body starts. Keep above cutoff.' },
            uDepth: { value: 2.0, type: 'f32', min: 0.01, max: 2, step: 0.01, label: 'Depth', tip: 'How quickly the body darkens from rim to burnt core.' },
            uBodyAlpha: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Body alpha', tip: 'Opacity of thick fluid.' },
            uEdgeAlpha: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Edge alpha', tip: 'Opacity of the thin rim.' },
          },
        },
      },
      fire: fireLayer({
        worldWidth: FIRE_WORLD_WIDTH,
        worldHeight: FIRE_WORLD_HEIGHT,
        cellSize: FIRE_CELL_SIZE,
        lfRadius: FIRE_LF_RADIUS,
        maxBodies: 512,
        maxParticles: FIRE_LF_MAX,
      }),
    },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
      landscape: '/demos/img/background_lanscape.jpg',
    },
    shaders: {
      dulceDeLeche: '/demos/shaders/dulceDeLeche.wgsl',
      ...fireAssets.shaders,
    },
  };

  static entities = [
    [BurningBox, 256],
    [OccludingFloor, 32],
    [Blower, 8],
    [RocketBox, 16],
  ];

  create() {
    this.spawnFloorAndLedges();
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    this._oilX = cx - 80;
    this._oilY = cy + 80;
    this._oilAcc = 0;
    Camera.setFree(true, { panSpeed: 10, zoomSensitivity: 0.001 });
    Camera.setFreeTarget(cx, cy - 200);
    Camera.centerOn(cx, cy - 200);
  }

  createNewGame() {
    this.spawnCrates();
    this.spawnGadgets();
    // this.spawnIce();
  }

  spawnIceAt(posX, posY, halfWidth, halfHeight) {
    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.VISCOUS,
      groupFlags: LIQUIDFUN_GROUP_FLAGS.SOLID | LIQUIDFUN_GROUP_FLAGS.RIGID,
      trackGroup: true,
      viscousScale: 1,
      userData: 0,
      tint: 0xaadfff,
      shape: 'box',
      posX,
      posY,
      halfWidth,
      halfHeight,
      layers: ['oil', 'fire'],
    });
  }

  spawnIce() {
    this.spawnIceAt(Mouse.x, Mouse.y, 200, 20);
  }

  /** Ice over the crate stack so melt heat writes stay live for headed A/B. */
  spawnBenchIce() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72 - 80;
    const cx = w / 2;
    this.spawnIceAt(cx - 50, floorY - 160, 340, 220);
    this.spawnIceAt(cx - 50, floorY - 40, 340, 50);
  }

  spawnFloorAndLedges() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72;
    OccludingFloor.spawn({ x: w / 2, y: floorY, width: 6800, height: 80, sprite: '_white', tint: 0x3a322c, layers: ['entities', 'fire'] });
    OccludingFloor.spawn({ x: w / 2 - 420, y: floorY - 220, width: 380, height: 36, sprite: '_white', tint: 0x4a4034, layers: ['entities', 'fire'] });
    OccludingFloor.spawn({ x: w / 2 + 380, y: floorY - 340, width: 320, height: 36, sprite: '_white', tint: 0x4a4034, layers: ['entities', 'fire'] });
    // OccludingFloor.spawn({ x: this.config.worldWidth / 2 - 80, y: floorY - 480, width: 36, height: 70, sprite: '_white', tint: 0x2c2622, layers: ['entities', 'fire'] });
  }

  spawnCrates() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72 - 80;
    const cx = w / 2;
    for (let col = 0; col < 6; col++) {
      for (let row = 0; row < 4; row++) {
        const x = cx - 280 + col * 92;
        const y = floorY - row * 92;
        BurningBox.spawn({
          x,
          y,
          width: 88,
          height: 88,
          startIgnited: col < 3 && row === 3,
        });
      }
    }
    // BurningBox.spawn({ x: cx + 420, y: floorY - 40, width: 110, height: 70, startIgnited: true });
  }

  spawnGadgets() {
    // const w = this.config.worldWidth;
    // const h = this.config.worldHeight;
    // const floorY = h * 0.72 - 80;
    // const cx = w / 2;
    // Blower.spawn({ x: cx - 520, y: floorY - 40, width: 64, height: 40, rotation: 0 });
    // RocketBox.spawn({ x: cx + 200, y: floorY - 360, width: 96, height: 44, rotation: 0 });
  }

  emitOil(x, y, radius, burning) {
    const views = LiquidFun.getViews();
    const n = views && views.count ? views.count[0] | 0 : 0;
    if (n > FIRE_LF_MAX - 80) return;
    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.VISCOUS,
      viscousScale: 9,
      tint: 0x6b3a1f,
      userData: burning ? 255 : 0,
      lightIntensity: burning ? 100 : 0,
      shape: 'circle',
      posX: x,
      posY: y,
      radius,
      layers: burning ? ['fire'] : ['oil', 'fire'],
    });
  }

  update(_dtRatio, deltaTime) {
    // this._oilAcc = (this._oilAcc || 0) + (deltaTime || 0);
    // if (this._oilAcc >= OIL_DRIP_MS) {
    //   this._oilAcc = 0;
    //   this.emitOil(this._oilX, this._oilY, 22);
    // }
    this._oilAcc = (this._oilAcc || 0) + (deltaTime || 0);
    const hold = Keyboard.q || Keyboard.e;
    const tap = Keyboard.isPressed('q') || Keyboard.isPressed('e');
    if (hold && (tap || this._oilAcc >= OIL_DRIP_MS)) {
      this._oilAcc = 0;
      this.emitOil(Mouse.x, Mouse.y, 28, !!Keyboard.q);
    }
    if (!hold) this._oilAcc = OIL_DRIP_MS;

    if (Keyboard.isPressed('i')) {
      this.spawnIce();
    }
  }
}

/** Headed bench: ice + list opcode (42). `meltBench` rides scene.config into logic. */
export class BurningBoxesMeltListScene extends BurningBoxesScene {
  static config = Object.assign({}, BurningBoxesScene.config, {
    meltBench: { list: true, keepWriting: true },
  });

  createNewGame() {
    super.createNewGame();
    this.spawnBenchIce();
  }
}

/** Headed bench: ice + N× setUserData (opcode 28). */
export class BurningBoxesMeltPerParticleScene extends BurningBoxesScene {
  static config = Object.assign({}, BurningBoxesScene.config, {
    meltBench: { list: false, keepWriting: true },
  });

  createNewGame() {
    super.createNewGame();
    this.spawnBenchIce();
  }
}
