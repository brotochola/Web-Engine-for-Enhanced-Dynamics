import { BurningBox } from './gameObjects/burningBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import { BLEND_MODES, LAYER_COMPUTE_SOURCE } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const { Layer } = WEED;

const FIRE_PASSES = [
  { entry: 'raster_stamp', source: 'fireStamp', layout: 'stamp' },
  { entry: 'apply_stamp', source: 'fireFluid', layout: 'fluid', swap: ['t'] },
  { entry: 'cool_rise', source: 'fireFluid', layout: 'fluid', swap: ['t', 'v'] },
  { entry: 'step_swirls', source: 'fireFluid', layout: 'fluid' },
  { entry: 'apply_swirls', source: 'fireFluid', layout: 'fluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', layout: 'fluid', swap: ['u', 'v'] },
  { entry: 'clear_pressure', source: 'fireFluid', layout: 'fluid', swap: ['p'] },
  { entry: 'jacobi_pressure', source: 'fireFluid', layout: 'fluid', iterate: 'uPressureIters', swap: ['p'] },
  { entry: 'project_velocity', source: 'fireFluid', layout: 'fluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', layout: 'fluid', swap: ['u', 'v'] },
  { entry: 'advect_velocity', source: 'fireFluid', layout: 'fluid', swap: ['u', 'v'] },
  { entry: 'advect_temperature', source: 'fireFluid', layout: 'fluid', swap: ['t'] },
  { entry: 'diffuse_temperature', source: 'fireFluid', layout: 'fluid', swap: ['t'] },
  { entry: 'pack_heat', source: 'firePack', layout: 'pack' },
];

export class BurningBoxesScene extends WEED.Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 3000,

    spatial: {
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
      numberOfSpatialWorkers: 2,
      maxEntitiesPerCell: 255,
    },

    logic: { noLimitFPS: false },
    particle: { noLimitFPS: false, maxParticles: 100, decals: false },
    physics: {
      subStepCount: 4,
      noLimitFPS: false,
      gravity: { x: 0, y: 2400 },
      sleeping: true,
    },
    preRender: { noLimitFPS: false },
    renderer: {
      noLimitFPS: false,
      ySorting: true,
      maxVisibleRenderables: 4000,
    },
    lighting: { enabled: false },

    layers: {
      fire: {
        zIndex: 6,
        blendMode: BLEND_MODES.ADD,
        resolution: 1.0,
        maxItems: 0,
        shader: {
          fragment: 'fireLook',
          compute: {
            source: 'fireFluid',
            passes: FIRE_PASSES,
          },
          source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
          grid: { cellSize: 8 },
          maxBodies: 512,
          uniforms: {
            uRise: { value: 1.2, type: 'f32' },
            uSmokeSplit: { value: 0.06, type: 'f32' },
            uPressureIters: { value: 6, type: 'f32' },
            uTime: { value: 0, type: 'f32' },
            uDrawCutoff: { value: 0, type: 'f32' },
            uFireCool: { value: 0.55, type: 'f32' },
            uSmokeCool: { value: 0.12, type: 'f32' },
            uDiffusion: { value: 0.03, type: 'f32' },
            uSwirlForce: { value: 0.45, type: 'f32' },
            uEmberOn: { value: 1, type: 'f32' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
    },
    shaders: {
      fireLook: '/demos/burningBoxesScene/shaders/fireLook.wgsl',
      fireFluid: '/demos/burningBoxesScene/shaders/fireFluid.wgsl',
      fireStamp: '/demos/burningBoxesScene/shaders/fireStamp.wgsl',
      firePack: '/demos/burningBoxesScene/shaders/firePack.wgsl',
    },
  };

  static entities = [
    [BurningBox, 256],
    [Floor, 32],
  ];

  constructor(game) {
    super(game);
  }

  create() {
    this.spawnFloorAndLedges();
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10, zoomSensitivity: 0.001 });
    Camera.setFreeTarget(cx, cy - 200);
    Camera.centerOn(cx, cy - 200);
  }

  createNewGame() {
    this.spawnCrates();
  }

  update(dtRatio, deltaTime, time) {
    Layer.fire.setUniform('uTime', time * 0.001);
  }

  spawnFloorAndLedges() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72;
    this.spawnEntity(Floor, { x: w / 2, y: floorY, width: 1800, height: 80, sprite: '_white', tint: 0x3a322c });
    this.spawnEntity(Floor, { x: w / 2 - 420, y: floorY - 220, width: 380, height: 36, sprite: '_white', tint: 0x4a4034 });
    this.spawnEntity(Floor, { x: w / 2 + 380, y: floorY - 340, width: 320, height: 36, sprite: '_white', tint: 0x4a4034 });
    const floors = Floor.instances;
    for (let i = 0; i < floors.length; i++) {
      if (floors[i] && floors[i].active) floors[i].feedLayer('fire');
    }
  }

  spawnCrates() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72 - 80;
    const cx = w / 2;
    let n = 0;
    for (let col = 0; col < 6; col++) {
      for (let row = 0; row < 4; row++) {
        const x = cx - 280 + col * 92;
        const y = floorY - row * 92;
        this.spawnEntity(BurningBox, {
          x,
          y,
          width: 88,
          height: 88,
          startIgnited: n < 3 && row === 3,
        });
        n++;
      }
    }
    this.spawnEntity(BurningBox, { x: cx + 420, y: floorY - 40, width: 110, height: 70, startIgnited: true });
  }
}
