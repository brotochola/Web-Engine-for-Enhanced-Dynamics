import WEED from '/src/index.js';
import { Branch } from './gameObjects/branch.js';
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

const { Scene, Camera } = WEED;

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
      gravity: { x: 0, y: 0 },
      sleeping: false,
      subStepCount: 4,
      maxJoints: 4096,
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
      maxVisibleRenderables: 4096,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    textures: {
      leaf: '/demos/proceduralTreeScene/leaf.png',
    },
  };

  static entities = [
    [ProceduralTree, 10],
    [Branch, 4000],
  ];

  static sharedResources = [[TreeClock, tuneSchema()]];

  create() {
    writeTimeScale(1);
    writeTuneDefaults();
    this._buildHud();
    this._buildPanel();
    this._setClock(1, 'Spring', readTimeScale());

    Camera.setZoom(1.2);
    Camera.centerOn(800, 780);
    Camera.setFree(true, { panSpeed: 8 });
    ProceduralTree.spawn({ x: 800, y: 1000 });
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
  }
}
