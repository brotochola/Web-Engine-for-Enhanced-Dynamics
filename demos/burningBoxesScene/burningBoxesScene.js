import { BurningBox } from './gameObjects/burningBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import { BLEND_MODES, LAYER_COMPUTE_SOURCE } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const { Layer } = WEED;

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

const FIRE_PANEL_CSS =
  'position:fixed;left:12px;top:48px;width:280px;max-height:calc(100vh - 60px);z-index:950;' +
  'overflow:auto;pointer-events:auto;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
  'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
  'padding:10px 12px 16px;box-shadow:0 8px 28px rgba(0,0,0,0.45);';

/** Kindling FIRE_PARAMS min/max/step, mapped onto this scene's uniforms. Rise slider is 0..40; GPU gets -value (Y-down). */
const FIRE_UI = [
  { uniform: 'uEmberOn', label: 'Ember', type: 'bool', tip: 'Hot fill inside burning bodies. Off = wood sprite, crust still burns.' },
  { uniform: 'uDiffusion', label: 'Diffusion', min: 0, max: 1, step: 0.01, tip: 'How fast heat blurs into neighboring cells.' },
  { uniform: 'uRise', label: 'Rise', min: 0, max: 4000, step: 0.5, negate: true, tip: 'Buoyancy. How hard hot air lifts. 0 = no plume.' },
  { uniform: 'uFireCool', label: 'Fire cool', min: 0, max: 10, step: 0.1, tip: 'How fast flame cells lose heat each step.' },
  { uniform: 'uSmokeCool', label: 'Smoke cool', min: 0, max: 5, step: 0.01, tip: 'How fast smoke cells fade. Lower = longer trails.' },
  { uniform: 'uSmokeSplit', label: 'Smoke split', min: 0, max: 1, step: 0.01, tip: 'Heat below this draws as smoke, above as fire.' },
  { uniform: 'uPressureIters', label: 'Pressure', min: 0, max: 20, step: 1, tip: 'Incompressibility iterations. More = less mushy flow, more cost.' },
  { uniform: 'uOverRelax', label: 'Relax', min: 1, max: 2, step: 0.05, tip: 'Pressure over-relaxation. 1 = stable. Higher = faster, noisier.' },
  { uniform: 'uSwirlChance', label: 'Swirl chance', min: 0, max: 1, step: 0.01, tip: 'How often a burning body spawns a swirl eddy.' },
  { uniform: 'uSwirlSpin', label: 'Swirl spin', min: 0, max: 80, step: 1, tip: 'How hard spawned swirls rotate.' },
  { uniform: 'uSwirlLife', label: 'Swirl life', min: 0, max: 5, step: 0.1, tip: 'Seconds a swirl lives before it dies.' },
  { uniform: 'uSwirlDamp', label: 'Swirl damp', min: 0, max: 40, step: 0.5, tip: 'How fast swirl spin fades. High = a quick kick, then gone.' },
  { uniform: 'uSwirlForce', label: 'Swirl force', min: 0, max: 1, step: 0.01, tip: 'How strongly swirls push the air.' },
  { uniform: 'uSwirlRadius', label: 'Swirl size', min: 0.5, max: 8, step: 0.1, tip: 'Radius of each swirl, in grid cells.' },
  { uniform: 'uMaxSwirls', label: 'Max swirls', min: 0, max: 200, step: 1, tip: 'Cap on live swirls. 0 = none.' },
  { uniform: 'uDrawCutoff', label: 'Draw cutoff', min: 0, max: 0.2, step: 0.005, tip: 'Hide heat below this. Cuts faint haze.' },
  { uniform: 'uBodyDrive', label: 'Body drive', min: -10, max: 10, step: 0.01, tip: 'How much a body drags the air. 1 = solid. 0 = ghost.' },
  { uniform: 'uSourcePad', label: 'Fire pad', min: -2, max: 0.4, step: 0.01, tip: 'Fire crust margin around the body.' },
  { uniform: 'uStampPad', label: 'Stamp pad', min: -4, max: 4, step: 0.25, tip: 'Solid stamp inset/outset, in grid cells.' },
];

function fireUiFmt(n, step) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  if (step < 1) return Number(n).toFixed(2);
  return String(Math.round(n));
}

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
            uRise: { value: -1000, type: 'f32' },
            uSmokeSplit: { value: 0.28, type: 'f32' },
            uPressureIters: { value: 6, type: 'f32' },
            uTime: { value: 0, type: 'f32' },
            uDrawCutoff: { value: 0, type: 'f32' },
            uFireCool: { value: 1.8, type: 'f32' },
            uSmokeCool: { value: 0.01, type: 'f32' },
            uDiffusion: { value: 0.03, type: 'f32' },
            uSwirlForce: { value: 0.66, type: 'f32' },
            uEmberOn: { value: 1, type: 'f32' },
            uOverRelax: { value: 1, type: 'f32' },
            uBodyDrive: { value: 10, type: 'f32' },
            uSourcePad: { value: 0, type: 'f32' },
            uSwirlDamp: { value: 15.5, type: 'f32' },
            uStampPad: { value: -1, type: 'f32' },
            uSwirlChance: { value: 0.8, type: 'f32' },
            uSwirlSpin: { value: 28, type: 'f32' },
            uSwirlLife: { value: 1.2, type: 'f32' },
            uSwirlRadius: { value: 2.5, type: 'f32' },
            uMaxSwirls: { value: 155, type: 'f32' },
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
    this._firePanel = null;
    this._pointerOnPanel = false;
  }

  create() {
    this.spawnFloorAndLedges();
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    Camera.setFree(true, { panSpeed: 10, zoomSensitivity: 0.001 });
    Camera.setFreeTarget(cx, cy - 200);
    Camera.centerOn(cx, cy - 200);
    this._buildFirePanel();
  }

  createNewGame() {
    this.spawnCrates();
  }

  update(dtRatio, deltaTime, time) {
    if (this._pointerOnPanel) Camera.pauseFreeZoom();
  }

  async destroy() {
    this._removeFirePanel();
    await super.destroy();
  }

  _fireUiRead(param) {
    let v = Layer.fire.getUniform(param.uniform);
    if (typeof v !== 'number' || Number.isNaN(v)) {
      v = BurningBoxesScene.config.layers.fire.shader.uniforms[param.uniform]?.value ?? 0;
    }
    if (param.type === 'bool') return v > 0.5;
    if (param.negate) v = -v;
    if (v < param.min) return param.min;
    if (v > param.max) return param.max;
    return v;
  }

  _fireUiWrite(param, n) {
    Layer.fire.setUniform(param.uniform, param.negate ? -n : n);
  }

  _buildFirePanel() {
    this._removeFirePanel();
    const panel = document.createElement('div');
    panel.id = 'burning-boxes-fire-panel';
    panel.style.cssText = FIRE_PANEL_CSS;
    const setOn = () => { this._pointerOnPanel = true; };
    const setOff = () => { this._pointerOnPanel = false; };
    panel.addEventListener('pointerenter', setOn);
    panel.addEventListener('pointerdown', setOn);
    panel.addEventListener('pointerleave', setOff);

    const title = document.createElement('div');
    title.style.cssText = 'font:600 15px/1.2 system-ui;margin:0 0 8px;color:#fff;';
    title.textContent = 'Fire';
    panel.appendChild(title);

    for (const param of FIRE_UI) {
      if (param.type === 'bool') this._addFireCheck(panel, param);
      else this._addFireSlider(panel, param);
    }

    document.body.appendChild(panel);
    this._firePanel = panel;
  }

  _addFireCheck(parent, param) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer;';
    if (param.tip) row.title = param.tip;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!this._fireUiRead(param);
    input.addEventListener('change', () => {
      this._fireUiWrite(param, input.checked ? 1 : 0);
    });
    const span = document.createElement('span');
    span.textContent = param.label;
    row.appendChild(input);
    row.appendChild(span);
    parent.appendChild(row);
  }

  _addFireSlider(parent, param) {
    const start = this._fireUiRead(param);
    const row = document.createElement('div');
    row.style.cssText =
      'display:grid;grid-template-columns:1fr 52px;gap:6px;align-items:center;margin:3px 0;';
    if (param.tip) row.title = param.tip;

    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const name = document.createElement('span');
    name.textContent = param.label;
    name.style.opacity = '0.85';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(param.min);
    input.max = String(param.max);
    input.step = String(param.step);
    input.value = String(start);
    input.style.width = '100%';
    wrap.appendChild(name);
    wrap.appendChild(input);

    const val = document.createElement('span');
    val.textContent = fireUiFmt(start, param.step);
    val.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;opacity:0.9;';

    input.addEventListener('input', () => {
      const n = Number(input.value);
      val.textContent = fireUiFmt(n, param.step);
      this._fireUiWrite(param, n);
    });

    row.appendChild(wrap);
    row.appendChild(val);
    parent.appendChild(row);
  }

  _removeFirePanel() {
    if (this._firePanel?.parentNode) this._firePanel.parentNode.removeChild(this._firePanel);
    this._firePanel = null;
    this._pointerOnPanel = false;
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
