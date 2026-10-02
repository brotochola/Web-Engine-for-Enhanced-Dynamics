import WEED from '/src/index.js';
import { Branch } from './gameObjects/branch.js';
import { DeadBranch } from './gameObjects/deadBranch.js';
import { Ground, groundSurfaceY } from './gameObjects/ground.js';
import { PRESETS, TreeComponent } from './components/treeComponent.js';
import {
  ProceduralTree,
  TreeClock,
  TUNE,
  clampTimeScale,
  readTimeScale,
  writeTimeScale,
  writeTune,
  writeTuneDefaults,
} from './gameObjects/proceduralTree.js';

const { Scene, Camera, LAYER_KIND, BLEND_MODES } = WEED;

const HUD_CSS =
  'position:fixed;left:12px;bottom:12px;z-index:940;pointer-events:none;' +
  'color:#eee;font:14px/1.45 system-ui,sans-serif;background:rgba(0,0,0,0.55);' +
  'padding:8px 12px;border-radius:6px;';

const PANEL_CSS =
  'position:fixed;top:12px;left:12px;z-index:940;width:240px;max-height:calc(100vh - 24px);' +
  'overflow:auto;color:#eee;font:13px/1.3 system-ui,sans-serif;background:rgba(0,0,0,0.62);' +
  'padding:10px 12px;border-radius:8px;';

function tuneSchema() {
  const schema = {
    speedBits: { type: Int32Array, length: 1, mailbox: true },
  };
  for (const key in TUNE) schema[key] = { type: Float32Array, length: 1 };
  return schema;
}

function formatValue(value, step) {
  if (step >= 1) return String(Math.round(value));
  return value.toFixed(step < 0.1 ? 2 : 1);
}

const PLANT_SLIDERS = [
  ['rootShoots', 'Root shoots', 1, 6, 1],
  ['maxChildren', 'Children', 1, 5, 1],
  ['maxGeneration', 'Generations', 2, 8, 1],
  ['segmentLength', 'Length', 16, 220, 1],
  ['spreadDeg', 'Spread (°)', 8, 140, 1],
  ['leavesPerSegment', 'Leaves', 0, 8, 1],
  ['leafScale', 'Leaf size', 0.4, 2.5, 0.05],
  ['growth', 'Growth', 0, 3, 0.05],
  ['matureGrowth', 'Mature growth', 0, 1, 0.01],
  ['maxAgeYears', 'Max age (years)', 0, 12, 1],
  ['dieFromGeneration', 'Die from gen', 1, 8, 1],
  ['dieChance', 'Die chance', 0, 0.4, 0.01],
  ['flexDeg', 'Bend (°)', 0, 40, 1],
];

export class ProceduralTreeScene extends Scene {
  static config = {
    worldWidth: 3600,
    worldHeight: 3200,
    seed: 7,
    spatial: {
      numberOfSpatialWorkers: 0,
      cellSize: 256,
      maxNeighbors: 0,
    },
    logic: {
      numberOfLogicWorkers: 1,
    },
    physics: {
      gravity: { x: 0, y: 1000 },
      sleeping: false,
      subStepCount: 4,
      maxJoints: 4096,
      maxFixturePoolSize: 64,
      liquidFun: {
        enabled: true,
        radius: 4,
        density: 0.05,
        maxCount: 4000,
        subSteps: 1,
      },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    decoration: {
      maxDecorations: 65048,
      maxAttachedDecorationsPerEntity: 64,
    },
    renderer: {
      backend: 'webgl',
      ySort: false,
      maxVisibleRenderables: 8192,
    },
    lighting: {
      enabled: false,
    },
    layers: {
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2.9,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        ySorting: false,
        shader: {
          fragment: 'rockContour',
          containerBlend: BLEND_MODES.NORMAL,
          uniforms: {
            uCutoff: { value: 0.08, type: 'f32' },
            uRimWidth: { value: 0.0018, type: 'f32' },
            uRimColor: { value: [1, 1, 1], type: 'vec3<f32>' },
            uRimAlpha: { value: 0.85, type: 'f32' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      leaf: '/demos/proceduralTreeScene/leaf.png',
      rocky: '/demos/img/rocky.jpg',
    },
    shaders: {
      rockContour: {
        webgl: '/demos/shaders/rockContour.frag',
        webgpu: '/demos/shaders/rockContour.wgsl',
      },
    },
  };

  static entities = [
    [Ground, 1],
    [ProceduralTree, 10],
    [Branch, 4000],
    [DeadBranch, 800],
  ];

  static sharedResources = [[TreeClock, tuneSchema()]];

  create() {
    writeTimeScale(1);
    writeTuneDefaults();
    this._activeIndex = -1;
    this._plantInputs = {};
    this._buildHud();
    this._buildPanel();
    this._setClock(1, 'Spring', readTimeScale());

    Ground.spawn({ x: 0, y: 0 });
    const tree = this._spawnPlant('tree', 780, 11);
    this._spawnPlant('fern', 1320, 29);
    this._activeIndex = tree;
    this._loadPlantSliders(PRESETS.tree);

    Camera.setZoom(0.85);
    Camera.centerOn(1050, groundSurfaceY(1050) - 320);
    Camera.setFree(true, { panSpeed: 8 });
  }

  _spawnPlant(preset, x, seed) {
    const spawned = ProceduralTree.spawn({
      x,
      y: groundSurfaceY(x),
      preset,
      seed,
    });
    return spawned ? spawned.index : -1;
  }

  onKeyDown(key) {
    super.onKeyDown(key);
    if (key !== '+' && key !== '_') return;
    const speed = writeTimeScale(readTimeScale() * (key === '+' ? 2 : 0.5));
    if (this._clock) this._setClock(this._clock.year, this._clock.season, speed);
  }

  onMessageFromGameObject(data) {
    if (data?.msg === 'clock') this._setClock(data.year, data.season, data.timeScale);
  }

  async destroy() {
    this._removeHud();
    await super.destroy();
  }

  _buildHud() {
    const el = document.createElement('div');
    el.id = 'procedural-tree-hud';
    el.style.cssText = HUD_CSS;
    const clock = document.createElement('div');
    this._hudClock = clock;
    el.appendChild(clock);
    document.body.appendChild(el);
    this._hud = el;
  }

  _buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'procedural-tree-panel';
    panel.style.cssText = PANEL_CSS;
    const title = document.createElement('div');
    title.textContent = 'Tree';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;';
    panel.appendChild(title);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    for (const name of ['tree', 'fern', 'bush']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name[0].toUpperCase() + name.slice(1);
      button.style.cssText =
        'flex:1;background:#1c1c1c;color:#eee;border:1px solid #666;border-radius:4px;padding:4px 0;cursor:pointer;';
      button.addEventListener('click', () => {
        const seed = (Math.random() * 0x7fffffff) | 0;
        const x = 500 + ((seed >>> 4) % 8) * 220;
        this._activeIndex = this._spawnPlant(name, x, seed);
        this._loadPlantSliders(PRESETS[name]);
      });
      buttons.appendChild(button);
    }
    panel.appendChild(buttons);

    this._timeSlider = this._addSlider(panel, 'Time', 0.25, 8, 0.25, readTimeScale(), (n) => {
      writeTimeScale(n);
      if (this._clock) this._setClock(this._clock.year, this._clock.season, n);
    });

    for (const key in TUNE) {
      const spec = TUNE[key];
      this._addSlider(panel, spec.label, spec.min, spec.max, spec.step, spec.value, (n) => {
        writeTune(key, n);
      });
    }

    for (let i = 0; i < PLANT_SLIDERS.length; i++) {
      const row = PLANT_SLIDERS[i];
      const key = row[0];
      const spec = PRESETS.tree;
      this._plantInputs[key] = this._addSlider(panel, row[1], row[2], row[3], row[4], spec[key], (n) => {
        const index = this._activeIndex;
        if (index == null || index < 0 || !TreeComponent[key]) return;
        TreeComponent[key][index] = n;
      });
    }

    document.body.appendChild(panel);
    this._panel = panel;
  }

  _addSlider(parent, label, min, max, step, value, onInput) {
    const row = document.createElement('label');
    row.style.cssText = 'display:block;margin:8px 0;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('span');
    val.textContent = formatValue(value, step);
    val.style.fontVariantNumeric = 'tabular-nums';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.width = '100%';
    input.addEventListener('input', () => {
      const n = Number(input.value);
      val.textContent = formatValue(n, step);
      onInput(n);
    });
    head.appendChild(name);
    head.appendChild(val);
    row.appendChild(head);
    row.appendChild(input);
    parent.appendChild(row);
    return { input, val, step };
  }

  _setClock(year, season, timeScale) {
    const speed = clampTimeScale(timeScale == null ? 1 : timeScale);
    this._clock = { year, season, timeScale: speed };
    if (this._hudClock) this._hudClock.textContent = `Year ${year} · ${season} · ${speed}×`;
    const slider = this._timeSlider;
    if (slider && document.activeElement !== slider.input) {
      slider.input.value = String(speed);
      slider.val.textContent = formatValue(speed, slider.step);
    }
  }

  _removeHud() {
    if (this._hud?.parentNode) this._hud.parentNode.removeChild(this._hud);
    if (this._panel?.parentNode) this._panel.parentNode.removeChild(this._panel);
    this._hud = null;
    this._hudClock = null;
    this._panel = null;
    this._timeSlider = null;
    this._plantInputs = null;
  }

  _loadPlantSliders(spec) {
    const inputs = this._plantInputs;
    if (!inputs || !spec) return;
    for (let i = 0; i < PLANT_SLIDERS.length; i++) {
      const row = PLANT_SLIDERS[i];
      const ui = inputs[row[0]];
      if (!ui) continue;
      const value = spec[row[0]];
      ui.input.value = String(value);
      ui.val.textContent = formatValue(value, row[4]);
    }
  }
}
