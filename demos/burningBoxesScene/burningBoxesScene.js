import { BurningBox } from './gameObjects/burningBox.js';
import { Blower } from './gameObjects/blower.js';
import { RocketBox } from './gameObjects/rocketBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import {
  BLEND_MODES,
  LAYER_COMPUTE_SOURCE,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const { Mouse, Keyboard, LiquidFun, LIQUIDFUN_FLAGS } = WEED;

const OIL_LAYER = 'oil';

// World-fixed fire lattice (this demo's own concept, not an engine feature):
// the compute texture covers the whole world at FIRE_CELL_SIZE world-units
// per texel, so texel (i,j) is always the same world position — no origin
// shift/wipe on pan or zoom. uLatticePad (in cells) bounds which cells the
// fluid passes actually simulate (camera view + margin); the rest stay at
// rest (see cell_active() in fireFluid.wgsl / fireStamp.wgsl / fireParticles.wgsl).
const FIRE_WORLD_WIDTH = 4000;
const FIRE_WORLD_HEIGHT = 3000;
const FIRE_CELL_SIZE = 4;
const FIRE_LF_RADIUS = 10;
const FIRE_LF_MAX = 4096;
const OIL_DRIP_MS = 220;

const FIRE_PASSES = [
  { entry: 'raster_stamp', source: 'fireStamp' },
  { entry: 'raster_particles', source: 'fireParticles', workgroup: [64], dispatchFrom: 'particles' },
  { entry: 'apply_stamp', source: 'fireFluid', swap: ['t'] },
  { entry: 'cool_rise', source: 'fireFluid', swap: ['t', 'v'] },
  { entry: 'step_swirls', source: 'fireFluid', workgroup: [64], dispatchFrom: 'swirls' },
  { entry: 'apply_swirls', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'apply_body_vel', source: 'fireFluid', swap: ['u', 'v'] },
  { entry: 'push_from_solid', source: 'fireFluid', swap: ['u', 'v'] },
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
  { name: 'fuel', format: 'rgba32float' },
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
    worldWidth: FIRE_WORLD_WIDTH,
    worldHeight: FIRE_WORLD_HEIGHT,

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
      liquidFun: {
        enabled: true,
        radius: FIRE_LF_RADIUS,
        maxCount: FIRE_LF_MAX,
        subSteps: 1,
      },
    },
    preRender: { noLimitFPS: false },
    renderer: {
      backend: 'webgpu',
      noLimitFPS: false,
      ySorting: true,
      maxVisibleRenderables: 4000,
    },
    lighting: {
      enabled: true,
      baseAmbient: 0,
      maxLights: 256,
      shadowsEnabled: false,
      sun: { enabled: false },
    },

    layers: {
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
      fire: {
        zIndex: 3.5,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1.0,
        maxItems: 0,
        shader: {
          fragment: 'fireLook',
          compute: {
            source: 'fireFluid',
            // Explicit pixels via the engine's plain {width,height} mode —
            // computed here from world dims / FIRE_CELL_SIZE (demo math, not
            // an engine sizing concept). Whole world, allocated once.
            size: {
              width: Math.ceil(FIRE_WORLD_WIDTH / FIRE_CELL_SIZE),
              height: Math.ceil(FIRE_WORLD_HEIGHT / FIRE_CELL_SIZE),
            },
            passes: FIRE_PASSES,
            textures: FIRE_TEXTURES,
            buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
          },
          source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
          maxBodies: 512,
          maxParticles: FIRE_LF_MAX,
          uniforms: {
            uCellSize: { value: FIRE_CELL_SIZE, type: 'f32', min: 1, max: 32, step: 0.5, label: 'Cell size', tip: 'World units per fluid cell. Grid covers the whole world at this size (compute.size above). Dragging this live does not resize the grid — reload to apply.' },
            uLatticePad: { value: 32, type: 'f32', min: 0, max: 256, step: 1, label: 'Lattice pad', tip: 'Cells outside camera view + this margin (in cells) do not simulate — they stay at rest (no heat/velocity).' },
            uRise: { value: -1000, type: 'f32', min: 0, max: 4000, step: 0.5, label: 'Rise', negate: true, tip: 'Buoyancy. How hard hot air lifts. 0 = no plume.' },
            uSmokeSplit: { value: 0.28, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Smoke split', tip: 'Heat below this draws as smoke, above as fire.' },
            uPressureIters: { value: 20, type: 'f32', min: 0, max: 20, step: 1, label: 'Pressure', tip: 'Incompressibility iterations. More = less mushy flow, more cost.' },
            uDrawCutoff: { value: 0, type: 'f32', min: 0, max: 0.2, step: 0.005, label: 'Draw cutoff', tip: 'Hide heat below this. Cuts faint haze.' },
            uFireCool: { value: 1.8, type: 'f32', min: 0, max: 10, step: 0.1, label: 'Fire cool', tip: 'How fast flame cells lose heat each step.' },
            uSmokeCool: { value: 0.01, type: 'f32', min: 0, max: 5, step: 0.01, label: 'Smoke cool', tip: 'How fast smoke cells fade. Lower = longer trails.' },
            uDiffusion: { value: 0.66, type: 'f32', min: 0, max: 100, step: 0.01, label: 'Diffusion', tip: 'How fast heat blurs into neighboring cells.' },
            uSwirlForce: { value: 0.66, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Swirl force', tip: 'How strongly swirls push the air.' },
            uEmberOn: { value: 1, type: 'f32', widget: 'check', label: 'Ember', tip: 'Glowing fill drawn on top of the flames, sized to the collider (Ember pad 0).' },
            uEmberAlpha: { value: 0.85, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember alpha', tip: 'How opaque the ember overlay is on top of live fire.' },
            uEmberBright: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember bright', tip: 'Ember heat. Higher = hotter fill.' },
            uEmberFlick: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Ember flick', tip: 'How much the ember twinkles. 0 = steady glow.' },
            uEmberPad: { value: 0, type: 'f32', min: -8, max: 8, step: 0.25, label: 'Ember pad', tip: 'Ember inset/outset in grid cells. 0 = collider size.' },
            uStampInner: { value: 16, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Stamp inner', tip: 'Burning boxes only. Live-fire depth into the crate, in cells. 0 = full solid (ring of fire). High = fills the crate. Floors and unlit boxes ignore this.' },
            uStampOuter: { value: 0.5, type: 'f32', min: -8, max: 20, step: 0.25, label: 'Stamp outer', tip: 'Burning boxes only. How far outside the collider air ignites, in cells. 1 = one-cell ring. Floors and unlit boxes ignore this.' },
            uOverRelax: { value: 1, type: 'f32', min: 1, max: 2, step: 0.05, label: 'Relax', tip: 'Pressure over-relaxation. 1 = stable. Higher = faster, noisier.' },
            uBodyDrive: { value: 0, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Body drive', tip: 'Extra air drag near crates. 0 = walls still push (MAC faces). 1 = glue nearby air to the crate (shrinks fire on still crates).' },
            uSwirlDamp: { value: 15.5, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Swirl damp', tip: 'How fast swirl spin fades. High = a quick kick, then gone.' },
            uStampPad: { value: -1.1, type: 'f32', min: -30, max: 30, step: 0.25, label: 'Stamp pad', tip: 'Solid stamp inset/outset for floors and unlit boxes, in grid cells. 0 = collider edge. Burning boxes use Stamp inner/outer instead.' },
            uSolidPush: { value: 4000, type: 'f32', min: 0, max: 100000, step: 10, label: 'Solid push', tip: 'Outward kick from floors (static). Flying crates skip this. Burning bodies skip this so they do not blow their own flames away. 0 = off.' },
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
            uLfRadius: { value: FIRE_LF_RADIUS, type: 'f32', min: 1, max: 40, step: 0.5, label: 'LF radius', tip: 'LiquidFun fuel splat radius in world units.' },
            uLfHeat: { value: 1, type: 'f32', min: 0, max: 1, step: 0.01, label: 'LF heat', tip: 'Heat stamped at each LiquidFun particle. 0 = particles do not fuel the fire.' },
            uLfDrive: { value: 0.65, type: 'f32', min: 0, max: 1, step: 0.01, label: 'LF drive', tip: 'How much particle velocity is mixed into the Eulerian air.' },
            uBlowForce: { value: 900, type: 'f32', min: 0, max: 4000, step: 10, label: 'Blow force', tip: 'Wind speed written in front of blower bodies (local +X).' },
            uBlowReach: { value: 14, type: 'f32', min: 0, max: 40, step: 0.5, label: 'Blow reach', tip: 'Blower wind slab length, in grid cells.' },
            uJetForce: { value: 1200, type: 'f32', min: 0, max: 4000, step: 10, label: 'Jet force', tip: 'Exhaust speed on the nozzle face of jet crates.' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
      landscape: '/demos/img/background_lanscape.jpg',
    },
    shaders: {
      dulceDeLeche: '/demos/shaders/dulceDeLeche.wgsl',
      fireLook: '/demos/burningBoxesScene/shaders/fireLook.wgsl',
      fireFluid: '/demos/burningBoxesScene/shaders/fireFluid.wgsl',
      fireStamp: '/demos/burningBoxesScene/shaders/fireStamp.wgsl',
      firePack: '/demos/burningBoxesScene/shaders/firePack.wgsl',
      fireParticles: '/demos/burningBoxesScene/shaders/fireParticles.wgsl',
    },
  };

  static entities = [
    [BurningBox, 256],
    [Floor, 32],
    [Blower, 8],
    [RocketBox, 16],
  ];

  preload() {
    this.setBackground({ texture: 'landscape', parallax: 0.15, zoomParallax: 0.35, margin: 0.2 });
  }

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
  }

  spawnFloorAndLedges() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    const floorY = h * 0.72;
    this.spawnEntity(Floor, { x: w / 2, y: floorY, width: 1800, height: 80, sprite: '_white', tint: 0x3a322c, layers: ['ENTITIES', 'fire'] });
    this.spawnEntity(Floor, { x: w / 2 - 420, y: floorY - 220, width: 380, height: 36, sprite: '_white', tint: 0x4a4034, layers: ['ENTITIES', 'fire'] });
    this.spawnEntity(Floor, { x: w / 2 + 380, y: floorY - 340, width: 320, height: 36, sprite: '_white', tint: 0x4a4034, layers: ['ENTITIES', 'fire'] });
    // this.spawnEntity(Floor, { x: this.config.worldWidth / 2 - 80, y: floorY - 480, width: 36, height: 70, sprite: '_white', tint: 0x2c2622, layers: ['ENTITIES', 'fire'] });
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
    // this.spawnEntity(BurningBox, { x: cx + 420, y: floorY - 40, width: 110, height: 70, startIgnited: true });
  }

  spawnGadgets() {
    // const w = this.config.worldWidth;
    // const h = this.config.worldHeight;
    // const floorY = h * 0.72 - 80;
    // const cx = w / 2;
    // this.spawnEntity(Blower, { x: cx - 520, y: floorY - 40, width: 64, height: 40, rotation: 0 });
    // this.spawnEntity(RocketBox, { x: cx + 200, y: floorY - 360, width: 96, height: 44, rotation: 0 });
  }

  emitOil(x, y, radius, burning) {
    const views = LiquidFun.getViews();
    const n = views && views.count ? views.count[0] | 0 : 0;
    if (n > FIRE_LF_MAX - 80) return;
    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.VISCOUS,
      viscousScale: 9,
      tint: 0x6b3a1f,
      lightIntensity: burning ? 50 : 0,
      shape: 'circle',
      posX: x,
      posY: y,
      radius,
      layers: burning ? ['fire'] : ['oil'],
    });
  }

  update(_dtRatio, deltaTime) {
    // this._oilAcc = (this._oilAcc || 0) + (deltaTime || 0);
    // if (this._oilAcc >= OIL_DRIP_MS) {
    //   this._oilAcc = 0;
    //   this.emitOil(this._oilX, this._oilY, 22);
    // }
    if (Keyboard.isPressed('q')) {
      this.emitOil(Mouse.x, Mouse.y, 28, true);
    }

    if (Keyboard.isPressed('e')) {
      this.emitOil(Mouse.x, Mouse.y, 28, false);
    }
  }
}
