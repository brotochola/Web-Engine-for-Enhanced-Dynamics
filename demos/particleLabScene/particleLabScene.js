// particleLabScene.js — ParticleEmitter playground: presets + sliders + click/spray

import WEED from '/src/index.js';
import { PARTICLE_EASE } from '/src/core/ConfigDefaults.js';
import {
  PARTICLE_LAB_PRESETS,
  PARTICLE_LAB_PRESET_ORDER,
} from './particleLabPresets.js';
import { ParticleLabStub } from './gameObjects/particleLabStub.js';

const { Scene, Camera, Mouse, ParticleEmitter } = WEED;

const EASE_KEYS = Object.keys(PARTICLE_EASE);
const TEXTURES = ['_whiteCircle', 'blood', 'cloud', 'smoke'];
const MODES = [
  { value: 'emit', label: 'Topdown (emit)' },
  { value: 'emitZenithal', label: 'Zenithal' },
  { value: 'emitFlat', label: 'Flat' },
];

const PANEL_CSS =
  'position:fixed;right:12px;top:56px;bottom:12px;width:310px;z-index:950;' +
  'overflow:auto;pointer-events:auto;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
  'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
  'padding:10px 12px 16px;box-shadow:0 8px 28px rgba(0,0,0,0.45);';

const HINT_CSS =
  'position:fixed;left:12px;bottom:12px;z-index:940;pointer-events:none;' +
  'color:#ddd;font:13px/1.4 system-ui,sans-serif;background:rgba(0,0,0,0.55);' +
  'padding:8px 12px;border-radius:6px;';

function cloneUi(ui) {
  return { ...ui };
}

export class ParticleLabScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,

    particle: {
      maxParticles: 8000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
      zenithalMaxHeight: 120,
      zenithalScaleFactor: 1.2,
      zenithalAlphaFade: 0.25,
    },

    logic: { noLimitFPS: false },
    physics: { gravity: { x: 0, y: 0 }, noLimitFPS: false },
    spatial: { noLimitFPS: false, cellSize: 128, maxNeighbors: 64 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySorting: false,
      maxVisibleRenderables: 10000,
    },
    lighting: { enabled: false },
  };

  static assets = {
    textures: {
      blood: '/demos/img/blood.png',
      cloud: '/demos/img/cloud.png',
      smoke: '/demos/img/smoke.png',
    },
  };

  // Pool of 1 (never spawned): physics host needs Transform/RigidBody/Collider SABs.
  static entities = [[ParticleLabStub, 1]];

  create() {
    Camera.centerOn(this.config.worldWidth / 2, this.config.worldHeight / 2);
    Camera.setZoom(1);

    this.mode = 'emitZenithal';
    this.presetName = 'blood';
    this.ui = cloneUi(PARTICLE_LAB_PRESETS.blood.ui);
    // Default ease if preset omitted it
    if (this.ui.ease == null) this.ui.ease = 'LERP';

    this.emitCfg = {};
    this._pointerOnPanel = false;
    this._sprayFrame = 0;
    this._bindings = [];

    this.rebuildEmitCfg();
    this._buildPanel();
    this._buildHint();
    this._highlightPreset('blood');
  }

  update() {
    if (Mouse.wheel) {
      Camera.setZoom(Math.max(0.25, Math.min(4, Camera.zoom * (1 - Mouse.wheel * 0.001))));
    }

    if (this._pointerOnPanel) return;

    const spray = !!this.ui.spray;
    let fire = false;
    if (spray) {
      if (Mouse.isButton0Down) {
        this._sprayFrame++;
        fire = (this._sprayFrame & 1) === 1;
      } else {
        this._sprayFrame = 0;
      }
    } else {
      fire = Mouse.isButton0Pressed;
    }
    if (!fire) return;

    const fn = ParticleEmitter[this.mode];
    if (typeof fn !== 'function') return;
    fn.call(ParticleEmitter, { ...this.emitCfg, x: Mouse.x, y: Mouse.y });
  }

  async destroy() {
    this._removePanel();
    this._removeHint();
    await super.destroy();
  }

  // ── rebuild ParticleEmitter config from flat ui ───────────────────────────

  rebuildEmitCfg() {
    const u = this.ui;
    const ease = PARTICLE_EASE[u.ease] ?? PARTICLE_EASE.LERP;

    /** @type {Record<string, unknown>} */
    const cfg = {
      texture: u.texture,
      count: { min: u.countMin, max: Math.max(u.countMin, u.countMax) },
      lifespan: u.lifespan,
      angleXY: { min: u.angleMin, max: u.angleMax },
      speed: { min: u.speedMin, max: Math.max(u.speedMin, u.speedMax) },
      gravity: u.gravity,
    };

    if (this.mode !== 'emitFlat') {
      cfg.z = { min: u.zMin, max: u.zMax };
      cfg.vz = { min: u.vzMin, max: u.vzMax };
      cfg.stayOnTheFloor = !!u.stayOnTheFloor;
      cfg.despawnOnGroundContact = !!u.despawnOnGroundContact;
      if (u.fadeOnTheFloor > 0) cfg.fadeOnTheFloor = u.fadeOnTheFloor;
    }

    cfg.alpha = u.alphaTween
      ? { from: { min: u.alphaMin, max: u.alphaMax }, to: u.alphaTo, ease }
      : { min: u.alphaMin, max: u.alphaMax };

    cfg.scale = u.scaleTween
      ? { from: { min: u.scaleMin, max: u.scaleMax }, to: u.scaleTo, ease }
      : { min: u.scaleMin, max: u.scaleMax };

    cfg.tint = u.tintTween
      ? { from: u.tintFrom >>> 0, to: u.tintTo >>> 0, ease }
      : { min: u.tintMin >>> 0, max: u.tintMax >>> 0 };

    if (u.rotationTween) {
      cfg.rotation = {
        from: { min: u.rotationMin, max: u.rotationMax },
        to: u.rotationTo,
        ease,
      };
    } else if (u.rotationMin !== 0 || u.rotationMax !== 0) {
      cfg.rotation = { min: u.rotationMin, max: u.rotationMax };
    }

    if (u.angularTween) {
      cfg.angularVelocity = { from: u.angularFrom, to: u.angularTo, ease };
    } else if (u.angularMin !== 0 || u.angularMax !== 0) {
      cfg.angularVelocity = { min: u.angularMin, max: u.angularMax };
    }

    this.emitCfg = cfg;
    this._refreshStatus();
  }

  applyPreset(name) {
    const p = PARTICLE_LAB_PRESETS[name];
    if (!p) return;
    this.presetName = name;
    this.mode = p.mode;
    this.ui = cloneUi(p.ui);
    if (this.ui.ease == null) this.ui.ease = 'LERP';
    this.rebuildEmitCfg();
    this._syncPanelFromUi();
    this._highlightPreset(name);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _buildHint() {
    const el = document.createElement('div');
    el.id = 'particle-lab-hint';
    el.style.cssText = HINT_CSS;
    el.textContent = 'LMB emit · Spray=hold · wheel zoom · presets →';
    document.body.appendChild(el);
    this._hint = el;
  }

  _removeHint() {
    if (this._hint?.parentNode) this._hint.parentNode.removeChild(this._hint);
    this._hint = null;
  }

  _buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'particle-lab-panel';
    panel.style.cssText = PANEL_CSS;
    const setOn = () => {
      this._pointerOnPanel = true;
    };
    const setOff = () => {
      this._pointerOnPanel = false;
    };
    panel.addEventListener('pointerenter', setOn);
    panel.addEventListener('pointerdown', setOn);
    panel.addEventListener('pointerleave', setOff);

    const title = document.createElement('div');
    title.style.cssText = 'font:600 15px/1.2 system-ui;margin:0 0 6px;color:#fff;';
    title.textContent = '✨ Particle Lab';
    panel.appendChild(title);

    this._statusEl = document.createElement('div');
    this._statusEl.style.cssText = 'opacity:0.75;margin-bottom:10px;font-size:11px;';
    panel.appendChild(this._statusEl);

    panel.appendChild(this._section('Presets'));
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;';
    for (const key of PARTICLE_LAB_PRESET_ORDER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = PARTICLE_LAB_PRESETS[key].label;
      btn.dataset.preset = key;
      btn.style.cssText =
        'padding:5px 8px;border-radius:5px;border:1px solid #556;background:#1c2230;' +
        'color:#eee;cursor:pointer;font:11px system-ui;';
      btn.addEventListener('click', () => this.applyPreset(key));
      presetRow.appendChild(btn);
    }
    panel.appendChild(presetRow);
    this._presetButtons = presetRow.querySelectorAll('button');

    panel.appendChild(this._section('Emit'));
    this._addSelect(panel, 'Mode', MODES, 'mode');
    this._addSelect(
      panel,
      'Texture',
      TEXTURES.map((t) => ({ value: t, label: t })),
      'texture'
    );
    this._addCheck(panel, 'Spray (hold LMB)', 'spray');

    panel.appendChild(this._section('Burst'));
    this._addSlider(panel, 'Count min', 'countMin', 1, 120, 1);
    this._addSlider(panel, 'Count max', 'countMax', 1, 120, 1);
    this._addSlider(panel, 'Lifespan ms', 'lifespan', 50, 8000, 50);

    panel.appendChild(this._section('Motion'));
    this._addSlider(panel, 'Angle min °', 'angleMin', -180, 360, 1);
    this._addSlider(panel, 'Angle max °', 'angleMax', -180, 360, 1);
    this._addSlider(panel, 'Speed min', 'speedMin', 0, 30, 0.1);
    this._addSlider(panel, 'Speed max', 'speedMax', 0, 30, 0.1);

    this._zBlock = document.createElement('div');
    panel.appendChild(this._zBlock);
    this._addSlider(this._zBlock, 'Z min (air < 0)', 'zMin', -300, 0, 1);
    this._addSlider(this._zBlock, 'Z max', 'zMax', -300, 0, 1);
    this._addSlider(this._zBlock, 'VZ min', 'vzMin', -30, 30, 0.1);
    this._addSlider(this._zBlock, 'VZ max', 'vzMax', -30, 30, 0.1);
    this._addSlider(panel, 'Gravity', 'gravity', -1, 2, 0.01);

    panel.appendChild(this._section('Alpha'));
    this._addCheck(panel, 'Tween alpha → to', 'alphaTween');
    this._addSlider(panel, 'Alpha min / from-lo', 'alphaMin', 0, 1, 0.01);
    this._addSlider(panel, 'Alpha max / from-hi', 'alphaMax', 0, 1, 0.01);
    this._addSlider(panel, 'Alpha to', 'alphaTo', 0, 1, 0.01);

    panel.appendChild(this._section('Scale'));
    this._addCheck(panel, 'Tween scale → to', 'scaleTween');
    this._addSlider(panel, 'Scale min / from-lo', 'scaleMin', 0.05, 5, 0.05);
    this._addSlider(panel, 'Scale max / from-hi', 'scaleMax', 0.05, 5, 0.05);
    this._addSlider(panel, 'Scale to', 'scaleTo', 0, 5, 0.05);

    panel.appendChild(this._section('Tint'));
    this._addCheck(panel, 'Tween tint → to', 'tintTween');
    this._addColor(panel, 'Tint min', 'tintMin');
    this._addColor(panel, 'Tint max', 'tintMax');
    this._addColor(panel, 'Tint from', 'tintFrom');
    this._addColor(panel, 'Tint to', 'tintTo');

    panel.appendChild(this._section('Spin'));
    this._addSlider(panel, 'Rotation min °', 'rotationMin', 0, 360, 1);
    this._addSlider(panel, 'Rotation max °', 'rotationMax', 0, 360, 1);
    this._addCheck(panel, 'Tween rotation', 'rotationTween');
    this._addSlider(panel, 'Rotation to °', 'rotationTo', 0, 720, 1);
    this._addCheck(panel, 'Tween angularVel', 'angularTween');
    this._addSlider(panel, 'AngVel min', 'angularMin', -3, 3, 0.05);
    this._addSlider(panel, 'AngVel max', 'angularMax', -3, 3, 0.05);
    this._addSlider(panel, 'AngVel from', 'angularFrom', -3, 3, 0.05);
    this._addSlider(panel, 'AngVel to', 'angularTo', -3, 3, 0.05);

    panel.appendChild(this._section('Ease'));
    this._addSelect(
      panel,
      'Ease (tween ops)',
      EASE_KEYS.map((k) => ({ value: k, label: k })),
      'ease'
    );

    this._floorBlock = document.createElement('div');
    panel.appendChild(this._floorBlock);
    this._floorBlock.appendChild(this._section('Floor (heighted)'));
    this._addCheck(this._floorBlock, 'Stay on floor (decal)', 'stayOnTheFloor');
    this._addCheck(this._floorBlock, 'Despawn on ground', 'despawnOnGroundContact');
    this._addSlider(this._floorBlock, 'Fade on floor ms', 'fadeOnTheFloor', 0, 3000, 50);

    document.body.appendChild(panel);
    this._panel = panel;
    this._updateFloorDisabled();
    this._refreshStatus();
  }

  _removePanel() {
    if (this._panel?.parentNode) this._panel.parentNode.removeChild(this._panel);
    this._panel = null;
    this._bindings = [];
    this._pointerOnPanel = false;
  }

  _section(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'margin:10px 0 6px;padding-top:8px;border-top:1px solid #2a3142;' +
      'font:600 11px/1 system-ui;text-transform:uppercase;letter-spacing:0.04em;color:#9ab;';
    return el;
  }

  _markCustom() {
    this.presetName = 'custom';
    this._highlightPreset(null);
  }

  _onUiChange() {
    this._markCustom();
    this.rebuildEmitCfg();
    this._updateFloorDisabled();
  }

  _addSlider(parent, label, key, min, max, step) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:grid;grid-template-columns:1fr 52px;gap:6px;align-items:center;margin:3px 0;';

    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.opacity = '0.85';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.ui[key] ?? min);
    input.style.width = '100%';
    wrap.appendChild(name);
    wrap.appendChild(input);

    const val = document.createElement('span');
    val.textContent = this._fmt(this.ui[key], step);
    val.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;opacity:0.9;';

    input.addEventListener('input', () => {
      const n = Number(input.value);
      this.ui[key] = n;
      val.textContent = this._fmt(n, step);
      this._onUiChange();
    });

    row.appendChild(wrap);
    row.appendChild(val);
    parent.appendChild(row);
    this._bindings.push({ kind: 'range', key, input, val, step });
  }

  _addCheck(parent, label, key) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0;cursor:pointer;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!this.ui[key];
    input.addEventListener('change', () => {
      this.ui[key] = input.checked;
      this._onUiChange();
    });
    const span = document.createElement('span');
    span.textContent = label;
    row.appendChild(input);
    row.appendChild(span);
    parent.appendChild(row);
    this._bindings.push({ kind: 'check', key, input });
  }

  _addColor(parent, label, key) {
    const row = document.createElement('label');
    row.style.cssText =
      'display:grid;grid-template-columns:1fr 42px;gap:6px;align-items:center;margin:3px 0;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.opacity = '0.85';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = this._toHex(this.ui[key] ?? 0xffffff);
    input.style.cssText = 'width:42px;height:24px;border:none;background:transparent;cursor:pointer;';
    input.addEventListener('input', () => {
      this.ui[key] = parseInt(input.value.slice(1), 16);
      this._onUiChange();
    });
    row.appendChild(name);
    row.appendChild(input);
    parent.appendChild(row);
    this._bindings.push({ kind: 'color', key, input });
  }

  /**
   * @param {'mode'|'texture'|'ease'} field
   */
  _addSelect(parent, label, options, field) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin:4px 0;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.opacity = '0.85';
    const select = document.createElement('select');
    select.style.cssText =
      'background:#151a24;color:#eee;border:1px solid #445;border-radius:5px;padding:5px 6px;';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    if (field === 'mode') select.value = this.mode;
    else select.value = String(this.ui[field]);

    select.addEventListener('change', () => {
      if (field === 'mode') {
        this.mode = select.value;
      } else {
        this.ui[field] = select.value;
      }
      this._onUiChange();
    });
    row.appendChild(name);
    row.appendChild(select);
    parent.appendChild(row);
    this._bindings.push({ kind: 'select', field, select });
  }

  _syncPanelFromUi() {
    for (const b of this._bindings) {
      if (b.kind === 'range') {
        b.input.value = String(this.ui[b.key] ?? 0);
        b.val.textContent = this._fmt(this.ui[b.key], b.step);
      } else if (b.kind === 'check') {
        b.input.checked = !!this.ui[b.key];
      } else if (b.kind === 'color') {
        b.input.value = this._toHex(this.ui[b.key] ?? 0xffffff);
      } else if (b.kind === 'select') {
        if (b.field === 'mode') b.select.value = this.mode;
        else b.select.value = String(this.ui[b.field]);
      }
    }
    this._updateFloorDisabled();
    this._refreshStatus();
  }

  _updateFloorDisabled() {
    const flat = this.mode === 'emitFlat';
    for (const block of [this._zBlock, this._floorBlock]) {
      if (!block) continue;
      block.style.opacity = flat ? '0.35' : '1';
      block.style.pointerEvents = flat ? 'none' : 'auto';
    }
  }

  _highlightPreset(name) {
    if (!this._presetButtons) return;
    for (const btn of this._presetButtons) {
      const on = !!(name && btn.dataset.preset === name);
      btn.style.background = on ? '#3d5a9e' : '#1c2230';
      btn.style.borderColor = on ? '#8ab4ff' : '#556';
    }
  }

  _refreshStatus() {
    if (!this._statusEl) return;
    this._statusEl.textContent = `${this.mode} · ${this.presetName} · pool ${this.config.particle.maxParticles}`;
  }

  _fmt(n, step) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    if (step < 1) return n.toFixed(2);
    return String(Math.round(n));
  }

  _toHex(num) {
    const n = (num >>> 0) & 0xffffff;
    return `#${n.toString(16).padStart(6, '0')}`;
  }
}
