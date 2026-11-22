// lightPanel.js — DBG-8: the Light tab.
// - The sun: sliders over Sun's own setters (they work at run time from the main thread's staged copy, published once
//   a frame), the hour (Sun.setTimeOfDay), the day cycle (config.lighting.sun.dayCycle, which the scene reads each
//   frame), the night light, and a dial with the sun's direction and the shadows'.
// - The light pass: the scene's lighting options as the scene resolved them, read-only (DEBUG_UI_PLAN section 6,
//   decision 2), with the GPU, the backend and the opaque pass.
// - The lamps: every LightEmitter, each a link that inspects its entity.

import { createPanel, createRow, createStat, elem } from '../ui/debugDom.js';
import { Sun } from '../../sun.js';
import { LightEmitter } from '../../../components/lightEmitter.js';
import { LIGHTING_DEFAULTS } from '../../../util/configDefaults.js';
import { gpuRowTitle } from './performancePanel.js';
import { DebugPanel } from '../ui/debugPanel.js';

const DEG = 180 / Math.PI;
/** How many lamps the list names (it counts them all). */
const LAMPS_SHOWN = 32;

/** The sun's sliders: each a Sun property with a setter. */
export const SUN_SLIDERS = Object.freeze([
  { key: 'angle', label: 'Angle°', min: 0, max: 360, step: 1 },
  { key: 'elevation', label: 'Elevation°', min: 0, max: 90, step: 0.5 },
  { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01 },
  { key: 'shadowAlpha', label: 'Shadow alpha', min: 0, max: 1, step: 0.01 },
  { key: 'skyLight', label: 'Sky light', min: 0, max: 1, step: 0.01 },
  { key: 'nightIntensity', label: 'Night light', min: 0, max: 1, step: 0.01 },
  { key: 'nightFrom', label: 'Night from', min: 0, max: 1, step: 0.01 },
  { key: 'nightTo', label: 'Night to', min: 0, max: 1, step: 0.01 },
]);

/** Keys of config.lighting the options table leaves out, and why (DBG-12 reads it). */
export const LIGHT_OPTIONS_NOT_SHOWN = Object.freeze({
  sun: 'the Sun section shows it, live',
});

function optionText(v) {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The lighting options, read-only: every LIGHTING_DEFAULTS key (the scene's value, else the default) but the sun. */
export function lightingOptionRows(lighting) {
  const rows = [];
  for (const key of Object.keys(LIGHTING_DEFAULTS)) {
    if (key in LIGHT_OPTIONS_NOT_SHOWN) continue;
    const value = lighting && lighting[key] !== undefined ? lighting[key] : LIGHTING_DEFAULTS[key];
    rows.push([key, optionText(value)]);
  }
  return rows;
}

/** One lamp's line: radius, brightness, elevation, cone, shadows. */
export function lampText(i) {
  const cone = LightEmitter.coneHalf[i] >= Math.PI - 1e-4 ? 'no cone' : `cone ${(2 * LightEmitter.coneHalf[i] * DEG).toFixed(0)}°`;
  return `#${i} · r ${Math.round(LightEmitter.radius[i])} · bright ${LightEmitter.brightness[i].toFixed(2)} · `
    + `elev ${Math.round(LightEmitter.elevation[i])} px · ${cone}${LightEmitter.castShadows[i] ? ' · shadows' : ''}`;
}

/** The active lamps' entity ids (up to `max` in `out`) and how many there are. */
export function activeLamps(max, out) {
  out.length = 0;
  const active = LightEmitter.active;
  if (!active) return 0;
  let count = 0;
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    if (count < max) out.push(i);
    count++;
  }
  return count;
}

/** A slider's number at its step's precision. */
export function sliderText(v, step) {
  if (step >= 1) return String(Math.round(v));
  return v.toFixed(step >= 0.5 ? 1 : 2);
}

function hex(v) {
  return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

export class LightPanel extends DebugPanel {
  constructor(debugUI) {
    super(debugUI);
    this.sliders = [];
    this.hour = null;
    this.hourVal = null;
    this.color = null;
    this.nightColor = null;
    this.dayCycle = null;
    this.daySpeed = null;
    this.dial = null;
    this.status = null;
    this.options = null;
    this.gpu = null;
    this.lampsHead = null;
    this.lampsList = null;
    this._lamps = [];
    this._lampsKey = '';
    this._lampRows = [];
  }

  create() {
    this.panel = createPanel();

    this.status = createStat('');
    this.status.style.cssText = 'display:block;margin-bottom:6px;color:rgba(255,255,255,0.5)';
    this.panel.appendChild(this.status);

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:12px;align-items:flex-start';
    const sliders = document.createElement('div');
    sliders.style.cssText = 'flex:1;min-width:0';
    for (const spec of SUN_SLIDERS) sliders.appendChild(this._slider(spec));
    sliders.appendChild(this._hourRow());
    sliders.appendChild(this._colorsRow());
    sliders.appendChild(this._dayCycleRow());
    top.appendChild(sliders);

    this.dial = document.createElement('canvas');
    this.dial.width = 72;
    this.dial.height = 72;
    this.dial.title = 'The sun (yellow, where its light comes from) and the shadows (grey, where they fall), seen from above';
    top.appendChild(this.dial);
    this.panel.appendChild(top);

    this.gpu = createStat('');
    this.gpu.style.cssText = 'display:block;margin-top:8px;font-size:10px;color:rgba(255,255,255,0.6)';
    this.panel.appendChild(this.gpu);

    this.options = document.createElement('div');
    this.options.style.cssText = 'margin-top:4px;font-size:9px;color:rgba(255,255,255,0.45);'
      + 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));column-gap:10px';
    this.options.title = 'config.lighting as the scene resolved it: read-only (fixed when the renderer builds its programs)';
    this.panel.appendChild(this.options);

    this.lampsHead = createStat('Lamps');
    this.lampsHead.style.cssText = 'display:block;margin-top:8px';
    this.panel.appendChild(this.lampsHead);
    this.lampsList = document.createElement('div');
    this.lampsList.style.cssText = 'font-size:10px;max-height:160px;overflow:auto';
    this.panel.appendChild(this.lampsList);
    return this.panel;
  }

  _slider(spec) {
    const row = createRow('gap:6px;align-items:center;margin:1px 0');
    const label = createStat(spec.label);
    label.style.cssText = 'min-width:84px';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'debug-ui-range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.title = `Sun.${spec.key}`;
    const val = createStat('—');
    val.style.cssText = 'min-width:40px;text-align:right';
    input.oninput = () => {
      Sun[spec.key] = Number(input.value);
      val.textContent = sliderText(Number(input.value), spec.step);
    };
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(val);
    this.sliders.push({ spec, input, val });
    return row;
  }

  _hourRow() {
    const row = createRow('gap:6px;align-items:center;margin:1px 0');
    const label = createStat('Hour');
    label.style.cssText = 'min-width:84px';
    this.hour = document.createElement('input');
    this.hour.type = 'range';
    this.hour.className = 'debug-ui-range';
    this.hour.min = '0';
    this.hour.max = '24';
    this.hour.step = '0.05';
    this.hour.title = 'Sun.setTimeOfDay: angle, elevation, intensity and colour from the hour';
    this.hourVal = createStat('—');
    this.hourVal.style.cssText = 'min-width:40px;text-align:right';
    this.hour.oninput = () => {
      Sun.setTimeOfDay(Number(this.hour.value));
      this.hourVal.textContent = Number(this.hour.value).toFixed(2);
    };
    row.appendChild(label);
    row.appendChild(this.hour);
    row.appendChild(this.hourVal);
    return row;
  }

  _colorsRow() {
    const row = createRow('gap:6px;align-items:center;margin:3px 0');
    row.appendChild(createStat('Colour'));
    this.color = document.createElement('input');
    this.color.type = 'color';
    this.color.title = 'Sun.color';
    this.color.oninput = () => {
      Sun.color = parseInt(this.color.value.slice(1), 16);
    };
    row.appendChild(this.color);
    row.appendChild(createStat('Night colour'));
    this.nightColor = document.createElement('input');
    this.nightColor.type = 'color';
    this.nightColor.title = 'Sun.nightColor';
    this.nightColor.oninput = () => {
      Sun.nightColor = parseInt(this.nightColor.value.slice(1), 16);
    };
    row.appendChild(this.nightColor);
    return row;
  }

  _dayCycleRow() {
    const row = createRow('gap:6px;align-items:center;margin:3px 0');
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer';
    label.title = 'config.lighting.sun.dayCycle.enabled: the scene advances the hour each frame (and overrides the sliders)';
    this.dayCycle = document.createElement('input');
    this.dayCycle.type = 'checkbox';
    this.dayCycle.className = 'debug-ui-checkbox';
    this.dayCycle.onchange = () => {
      const cycle = this._dayCycleConfig();
      if (cycle) cycle.enabled = this.dayCycle.checked;
    };
    label.appendChild(this.dayCycle);
    label.appendChild(createStat('Day cycle'));
    row.appendChild(label);
    row.appendChild(createStat('speed'));
    this.daySpeed = document.createElement('input');
    this.daySpeed.type = 'number';
    this.daySpeed.step = '0.5';
    this.daySpeed.min = '0';
    this.daySpeed.style.cssText = 'width:56px;font-size:10px;padding:1px 4px;background:rgba(0,0,0,0.5);color:white;'
      + 'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    this.daySpeed.title = 'config.lighting.sun.dayCycle.speed';
    this.daySpeed.onchange = () => {
      const cycle = this._dayCycleConfig();
      const v = Number(this.daySpeed.value);
      if (cycle && Number.isFinite(v) && v >= 0) cycle.speed = v;
    };
    row.appendChild(this.daySpeed);
    return row;
  }

  _dayCycleConfig() {
    return this.debugUI.scene?.config?.lighting?.sun?.dayCycle ?? null;
  }

  attach() {
    const lighting = this.debugUI.scene?.config?.lighting;
    this.options.innerHTML = '';
    for (const [key, value] of lightingOptionRows(lighting)) {
      const cell = elem('span', '', `${key}: ${value}`);
      this.options.appendChild(cell);
    }
    this._lampsKey = '';
  }

  update() {
    const scene = this.debugUI.scene;
    const on = scene?.config?.lighting?.enabled === true;
    const status = !on ? 'lighting.enabled is false: this scene draws no light'
      : Sun.isInitialized && Sun.enabled ? 'Sun on' : 'Sun off (lighting.sun.enabled)';
    if (this.status.textContent !== status) this.status.textContent = status;
    const gpu = gpuRowTitle(scene);
    if (this.gpu.textContent !== gpu) this.gpu.textContent = gpu;
    if (Sun.isInitialized) this._syncSun();
    this._syncLamps();
  }

  _syncSun() {
    for (const s of this.sliders) {
      if (document.activeElement === s.input) continue;
      const v = Sun[s.spec.key];
      const text = sliderText(v, s.spec.step);
      if (s.input.value !== String(v)) s.input.value = String(v);
      if (s.val.textContent !== text) s.val.textContent = text;
    }
    if (document.activeElement !== this.hour) {
      const h = String(Sun.hour);
      if (this.hour.value !== h) this.hour.value = h;
      const text = Sun.hour.toFixed(2);
      if (this.hourVal.textContent !== text) this.hourVal.textContent = text;
    }
    if (document.activeElement !== this.color) this.color.value = hex(Sun.color);
    if (document.activeElement !== this.nightColor) this.nightColor.value = hex(Sun.nightColor);
    const cycle = this._dayCycleConfig();
    if (cycle) {
      if (this.dayCycle.checked !== !!cycle.enabled) this.dayCycle.checked = !!cycle.enabled;
      if (document.activeElement !== this.daySpeed && this.daySpeed.value !== String(cycle.speed)) this.daySpeed.value = String(cycle.speed);
    }
    this._drawDial();
  }

  _drawDial() {
    const ctx = this.dial.getContext ? this.dial.getContext('2d') : null;
    if (!ctx) return;
    const w = this.dial.width;
    const c = w / 2;
    const r = c - 6;
    ctx.clearRect(0, 0, w, w);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    // The sun's angle: 0 East, 90 South (down the screen); the line is as long as the sun is low.
    const a = Sun.angle / DEG;
    const low = 1 - Math.min(90, Math.max(0, Sun.elevation)) / 90;
    ctx.strokeStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * r * (0.3 + 0.7 * low), c + Math.sin(a) * r * (0.3 + 0.7 * low));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(160,160,160,0.9)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Sun.shadowDirX * r * 0.8, c + Sun.shadowDirY * r * 0.8);
    ctx.stroke();
  }

  _syncLamps() {
    const count = activeLamps(LAMPS_SHOWN, this._lamps);
    const key = `${count}:${this._lamps.join(',')}`;
    if (key !== this._lampsKey) {
      this._lampsKey = key;
      this.lampsHead.textContent = count > this._lamps.length ? `Lamps: ${count} (the first ${this._lamps.length})` : `Lamps: ${count}`;
      this.lampsList.innerHTML = '';
      this._lampRows.length = 0;
      for (let k = 0; k < this._lamps.length; k++) {
        const i = this._lamps[k];
        const row = document.createElement('div');
        row.style.cssText = 'cursor:pointer;margin:1px 0';
        row.title = 'Inspect this lamp\'s entity';
        row.onclick = () => this.debugUI.tools?._selectEntity?.(i);
        this.lampsList.appendChild(row);
        this._lampRows.push(row);
      }
    }
    for (let k = 0; k < this._lampRows.length; k++) {
      const text = lampText(this._lamps[k]);
      if (this._lampRows[k].textContent !== text) this._lampRows[k].textContent = text;
    }
  }
}
