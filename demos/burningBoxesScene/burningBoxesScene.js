import { BurningBox } from './gameObjects/burningBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import { BLEND_MODES, LAYER_COMPUTE_SOURCE } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const FIRE_PASSES = [
  { entry: 'shift_fields', source: 'fireFluid', when: 'originShift', swap: ['u', 'v', 't', 'p'] },
  { entry: 'shift_swirls', source: 'fireFluid', when: 'originShift', workgroup: [64], dispatchFrom: 'swirls' },
  { entry: 'raster_stamp', source: 'fireStamp' },
  { entry: 'apply_stamp', source: 'fireFluid', swap: ['t'] },
  { entry: 'cool_rise', source: 'fireFluid', swap: ['t', 'v'] },
  { entry: 'step_swirls', source: 'fireFluid', workgroup: [64], dispatchFrom: 'swirls' },
  { entry: 'apply_swirls', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'clear_pressure', source: 'fireFluid', swap: ['p'] },
  { entry: 'jacobi_pressure', source: 'fireFluid', iterate: 'uPressureIters', swap: ['p'] },
  { entry: 'project_velocity', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'advect_velocity', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'advect_temperature', source: 'fireFluid', swap: ['t'] },
  { entry: 'diffuse_temperature', source: 'fireFluid', swap: ['t'] },
  { entry: 'pack_heat', source: 'firePack' },
];

const FIRE_TEXTURES = [
  { name: 'u', format: 'r32float', pingPong: true },
  { name: 'v', format: 'r32float', pingPong: true },
  { name: 't', format: 'r32float', pingPong: true },
  { name: 'p', format: 'r32float', pingPong: true },
  { name: 'stamp', format: 'rgba8unorm' },
  { name: 'vel', format: 'rgba32float' },
  { name: 'pack', format: 'rgba8unorm', look: true },
];

/**
 * Uniform hints (min/max/step/label/tip/widget/negate) drive the engine
 * LayersPanel sliders — expand the "fire" layer in the debug UI to tweak.
 * uTime/uDt/uZoom/uCameraPos/uCanvasSize/uWorldSize/uViewSize/uTexSize are
 * engine-reserved: fed every frame, never declared here.
 */
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
      backend: 'webgpu',
      noLimitFPS: false,
      ySorting: true,
      maxVisibleRenderables: 4000,
    },
    lighting: { enabled: false },

    layers: {
      fire: {
        zIndex: 6,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1.0,
        maxItems: 0,
        shader: {
          fragment: 'fireLook',
          compute: {
            source: 'fireFluid',
            size: { scale: 0.25 },
            passes: FIRE_PASSES,
            textures: FIRE_TEXTURES,
            buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
          },
          source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
          maxBodies: 512,
          uniforms: {
            uCellSize: { value: 4, type: 'f32', min: 1, max: 32, step: 0.5, label: 'Cell size', tip: 'World units per fluid cell. Fixed. Zoom and canvas size do not change this.' },
            uLatticePad: { value: 32, type: 'f32', min: 0, max: 128, step: 1, label: 'Lattice pad', tip: 'Off-screen cells only if compute.size.scale leaves leftover texels. Does not punch a hole in the view.' },
            uRise: { value: -1000, type: 'f32', min: 0, max: 4000, step: 0.5, label: 'Rise', negate: true, tip: 'Buoyancy. How hard hot air lifts. 0 = no plume.' },
            uSmokeSplit: { value: 0.28, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke split', tip: 'Heat below this draws as smoke, above as fire.' },
            uPressureIters: { value: 20, type: 'f32', min: 0, max: 20, step: 1, label: 'Pressure', tip: 'Incompressibility iterations. More = less mushy flow, more cost.' },
            uDrawCutoff: { value: 0, type: 'f32', min: 0, max: 0.2, step: 0.005, label: 'Draw cutoff', tip: 'Hide heat below this. Cuts faint haze.' },
            uFireCool: { value: 1.8, type: 'f32', min: 0, max: 10, step: 0.1, label: 'Fire cool', tip: 'How fast flame cells lose heat each step.' },
            uSmokeCool: { value: 0.01, type: 'f32', min: 0, max: 5, step: 0.01, label: 'Smoke cool', tip: 'How fast smoke cells fade. Lower = longer trails.' },
            uDiffusion: { value: 0.1, type: 'f32', min: 0, max: 100, step: 0.01, label: 'Diffusion', tip: 'How fast heat blurs into neighboring cells.' },
            uSwirlForce: { value: 0.66, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Swirl force', tip: 'How strongly swirls push the air.' },
            uEmberOn: { value: 1, type: 'f32', widget: 'check', label: 'Ember', tip: 'Hot fill inside burning bodies. Off = wood sprite, crust still burns.' },
            uOverRelax: { value: 1, type: 'f32', min: 1, max: 2, step: 0.05, label: 'Relax', tip: 'Pressure over-relaxation. 1 = stable. Higher = faster, noisier.' },
            uBodyDrive: { value: 1, type: 'f32', min: -5, max: 5, step: 0.01, label: 'Body drive', tip: 'How much a body drags the air. 1 = solid. 0 = ghost.' },
            uSourcePad: { value: 0, type: 'f32', min: -20, max: 20, step: 0.01, label: 'Fire pad', tip: 'Fire crust margin around the body.' },
            uSwirlDamp: { value: 15.5, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Swirl damp', tip: 'How fast swirl spin fades. High = a quick kick, then gone.' },
            uStampPad: { value: -1, type: 'f32', min: -30, max: 30, step: 0.25, label: 'Stamp pad', tip: 'Solid stamp inset/outset, in grid cells.' },
            uSwirlChance: { value: 0.8, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Swirl chance', tip: 'How often a burning body spawns a swirl eddy.' },
            uSwirlSpin: { value: 28, type: 'f32', min: 0, max: 80, step: 1, label: 'Swirl spin', tip: 'How hard spawned swirls rotate.' },
            uSwirlLife: { value: 2.5, type: 'f32', min: 0, max: 5, step: 0.1, label: 'Swirl life', tip: 'Seconds a swirl lives before it dies.' },
            uSwirlRadius: { value: 2.5, type: 'f32', min: 0.5, max: 8, step: 0.1, label: 'Swirl size', tip: 'Radius of each swirl, in grid cells.' },
            uMaxSwirls: { value: 155, type: 'f32', min: 0, max: 200, step: 1, label: 'Max swirls', tip: 'Cap on live swirls. 0 = none.' },
            uSmokeOn: { value: 1, type: 'f32', widget: 'check', label: 'Smoke', tip: 'Draw smoke (heat below the split). Off = flames only.' },
            uFireOn: { value: 1, type: 'f32', widget: 'check', label: 'Fire', tip: 'Draw flame pixels (heat at or above the split).' },
            uView: { value: 0, type: 'f32', min: 0, max: 3, step: 1, label: 'View', tip: 'Look = composite. Heat = raw t. FBM = overlay grain (not the fluid). Flow = velocity color.' },
            uSmokeAlpha: { value: 0.77, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke alpha', tip: 'Smoke opacity.' },
            uSmokePuff: { value: 1.55, type: 'f32', min: 0.4, max: 3, step: 0.05, label: 'Smoke puff', tip: 'Wisp shape. Higher = thinner, puffier edges.' },
            uSmokeNoise: { value: 0.55, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke noise', tip: 'How lumpy the smoke is. At 1, noise punches holes in the puff.' },
            uSmokeDens: { value: 1.3, type: 'f32', min: 0.4, max: 2.5, step: 0.05, label: 'Smoke density', tip: 'How thick and sooty the smoke is. Raise this for darker plumes.' },
            uSmokeScroll0: { value: 3.5, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n1', tip: 'Slow coarse smoke grain crawl. Negative = up with the plume (Y-down lattice).' },
            uSmokeScroll1: { value: 4.5, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n2', tip: 'Mid smoke octave crawl.' },
            uSmokeScroll2: { value: 0.55, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Smoke n3', tip: 'Fine smoke octave crawl. Faster = more boil.' },
            uFireScroll0: { value: 2.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n1', tip: 'Slow coarse fire grain crawl.' },
            uFireScroll1: { value: 0.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n2', tip: 'Mid fire octave crawl.' },
            uFireScroll2: { value: 18.0, type: 'f32', min: -20, max: 20, step: 0.05, label: 'Fire n3', tip: 'Fine fire octave crawl.' },
            uFireAlpha: { value: 1.0, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Fire alpha', tip: 'Flame opacity.' },
            uFireNoise: { value: 0.22, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Fire noise', tip: 'How hard FBM wriggles flame bands and punches dark patches. 0 = smooth fill.' },
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

  spawnFloorAndLedges() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72;
    this.spawnEntity(Floor, { x: w / 2, y: floorY, width: 1800, height: 80, sprite: '_white', tint: 0x3a322c, feedLayer: 'fire' });
    this.spawnEntity(Floor, { x: w / 2 - 420, y: floorY - 220, width: 380, height: 36, sprite: '_white', tint: 0x4a4034, feedLayer: 'fire' });
    this.spawnEntity(Floor, { x: w / 2 + 380, y: floorY - 340, width: 320, height: 36, sprite: '_white', tint: 0x4a4034, feedLayer: 'fire' });
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
        this.spawnEntity(BurningBox, {
          x,
          y,
          width: 88,
          height: 88,
          startIgnited: col < 3 && row === 3,
        });
      }
    }
    this.spawnEntity(BurningBox, { x: cx + 420, y: floorY - 40, width: 110, height: 70, startIgnited: true });
  }
}
