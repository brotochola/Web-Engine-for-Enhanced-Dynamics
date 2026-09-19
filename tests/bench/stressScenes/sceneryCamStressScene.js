/**
 * Scenery camera stress. Engine ceiling is Layer.MAX_LAYERS 16 (4 built-in).
 * 12 cover/static/tiling layers + pan/zoom every tick.
 * Primary: pixi_STEP_MS. Load: SCENERY_COUNT.
 */
import WEED from '/src/index.js';
import { CameraOrbitDriver, stepCameraOrbit } from './pixiPeel/cameraOrbitDriver.js';

const { Scene, Camera, LAYER_KIND } = WEED;

export const SCENERY_CUSTOM = 12;
export const WORLD_W = 8000;
export const WORLD_H = 8000;

function sceneryLayers() {
  const kinds = [LAYER_KIND.COVER, LAYER_KIND.STATIC, LAYER_KIND.TILING];
  const layers = {};
  for (let i = 0; i < SCENERY_CUSTOM; i++) {
    const kind = kinds[i % 3];
    layers[`scenery${i}`] = {
      kind,
      zIndex: 0.05 + i * 0.01,
      texture: 'rocky',
      parallax: 0.08 + (i % 5) * 0.04,
      margin: 0.2,
      zoomParallax: 0.35,
      tileScale: 1 + (i % 3) * 0.25,
    };
  }
  return layers;
}

export class SceneryCamStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x5ce11e,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
    layers: sceneryLayers(),
  };

  static assets = {
    textures: {
      rocky: '/demos/img/rocky.jpg',
    },
  };

  static entities = [[CameraOrbitDriver, 1]];

  create() {
    this.spawnEntity(CameraOrbitDriver, {
      cx: WORLD_W * 0.5,
      cy: WORLD_H * 0.5,
      radius: 640,
      zoom0: 0.7,
      zoomAmp: 0.18,
      seed: 0x5ce11e,
    });
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.7);
    this._orbT = 0;
  }

  update() {
    this._orbT += 0.045;
    stepCameraOrbit(this._orbT, WORLD_W * 0.5, WORLD_H * 0.5, 640, 0.7, 0.18);
  }
}
