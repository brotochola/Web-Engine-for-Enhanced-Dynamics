// lightPanel.js — DBG-8: the Light tab, kept short so it covers little of the scene: one line, a grid, two folds.
// - The line: the status, "Show lights" (each lamp's floor pool or cone on the debug canvas, DebugFlags.showLights) and
//   the render views (DBG-5, renderViewSection.js: every view is a buffer of the light pass or what feeds it).
// - The sun: sliders over Sun's own setters (they work at run time from the main thread's staged copy, published once
//   a frame), the hour (Sun.setTimeOfDay), the day cycle (config.lighting.sun.dayCycle, which the scene reads each
//   frame), the night light, and a dial with the sun's direction and the shadows'.
// - Folded: the lamps (every LightEmitter, each a link that inspects its entity), and the scene's lighting options as
//   the scene resolved them, read-only (DEBUG_UI_PLAN section 6, decision 2), with the GPU, the backend and the opaque
//   pass.

import { createPanel, createStat, createButton, elem } from '../ui/debugDom.js';
import { DEBUG_FLAGS } from '../debugFlags.js';
import { RenderViewSection } from './renderViewSection.js';
import { Sun } from '../../sun.js';
import { LightEmitter } from '../../../components/lightEmitter.js';
import { LIGHTING_DEFAULTS } from '../../../util/configDefaults.js';
import { gpuRowTitle } from './performancePanel.js';
import { DebugPanel } from '../ui/debugPanel.js';

const DEG = 180 / Math.PI;
/** How many lamps the list names (it counts them all). */
const LAMPS_SHOWN = 32;
const LIGHTS_TIP = 'Each lamp on the debug canvas: its reach as a pool on the floor, a cone light\'s wedge, and with '
  + 'lighting.walls what it sees past them';

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
    this.lightsBtn = null;
    this.views = new RenderViewSection(debugUI);
    this.options = null;
    this.gpu = null;
    this.lampsHead = null;
    this.lampsList = null;
    this._lamps = [];
    this._lampsKey = '';
    this._lampRows = [];
  }

  /**
   * One line (the status, the lamps' marks on the canvas, the render view), the sun's controls in a grid beside the
   * dial, then the lamps and the options folded: the tab covers as little of the scene as it can.
   */
  create() {
    this.panel = createPanel();
    this.panel.className = 'debug-ui-panel debug-ui-light';

    const head = elem('div', 'debug-ui-light-head');
    this.status = createStat('', 'debug-ui-light-status');
    head.appendChild(this.status);
    this.lightsBtn = createButton('Show lights', '', () => this._toggleLights());
    this.lightsBtn.title = LIGHTS_TIP;
    head.appendChild(this.lightsBtn);
    head.appendChild(this.views.create());
    this.panel.appendChild(head);
    this.panel.appendChild(this.views.tileReadout);

    const body = elem('div', 'debug-ui-light-body');
    const grid = elem('div', 'debug-ui-light-grid');
    for (const spec of SUN_SLIDERS) grid.appendChild(this._slider(spec));
    grid.appendChild(this._hourRow());
    grid.appendChild(this._colorsRow());
    grid.appendChild(this._dayCycleRow());
    body.appendChild(grid);
    this.dial = document.createElement('canvas');
    this.dial.width = 44;
    this.dial.height = 44;
    this.dial.title = 'The sun (yellow, where its light comes from) and the shadows (grey, where they fall), seen from above';
    body.appendChild(this.dial);
    this.panel.appendChild(body);

    const foot = elem('div', 'debug-ui-light-foot');
    const lamps = document.createElement('details');
    this.lampsHead = document.createElement('summary');
    this.lampsHead.textContent = 'Lamps';
    lamps.appendChild(this.lampsHead);
    this.lampsList = elem('div', 'debug-ui-light-lamps');
    lamps.appendChild(this.lampsList);
    foot.appendChild(lamps);

    const options = document.createElement('details');
    const optionsHead = document.createElement('summary');
    optionsHead.textContent = 'Options and GPU';
    optionsHead.title = 'config.lighting as the scene resolved it: read-only (fixed when the renderer builds its programs)';
    options.appendChild(optionsHead);
    this.gpu = createStat('', 'debug-ui-light-gpu');
    options.appendChild(this.gpu);
    this.options = elem('div', 'debug-ui-light-options');
    options.appendChild(this.options);
    foot.appendChild(options);
    this.panel.appendChild(foot);
    return this.panel;
  }

  /** A grid cell: its label, its control, its value. */
  _cell(labelText, control, valueEl) {
    const cell = elem('div', 'debug-ui-light-cell');
    cell.appendChild(createStat(labelText));
    cell.appendChild(control);
    if (valueEl) cell.appendChild(valueEl);
    return cell;
  }

  _range(min, max, step, title) {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'debug-ui-range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.title = title;
    return input;
  }

  _slider(spec) {
    const input = this._range(spec.min, spec.max, spec.step, `Sun.${spec.key}`);
    const val = createStat('—', 'debug-ui-light-value');
    input.oninput = () => {
      Sun[spec.key] = Number(input.value);
      val.textContent = sliderText(Number(input.value), spec.step);
    };
    this.sliders.push({ spec, input, val });
    return this._cell(spec.label, input, val);
  }

  _hourRow() {
    this.hour = this._range(0, 24, 0.05, 'Sun.setTimeOfDay: angle, elevation, intensity and colour from the hour');
    this.hourVal = createStat('—', 'debug-ui-light-value');
    this.hour.oninput = () => {
      Sun.setTimeOfDay(Number(this.hour.value));
      this.hourVal.textContent = Number(this.hour.value).toFixed(2);
    };
    return this._cell('Hour', this.hour, this.hourVal);
  }

  _colorsRow() {
    const cell = elem('div', 'debug-ui-light-inline');
    cell.appendChild(createStat('Colour'));
    this.color = document.createElement('input');
    this.color.type = 'color';
    this.color.title = 'Sun.color';
    this.color.oninput = () => {
      Sun.color = parseInt(this.color.value.slice(1), 16);
    };
    cell.appendChild(this.color);
    cell.appendChild(createStat('Night'));
    this.nightColor = document.createElement('input');
    this.nightColor.type = 'color';
    this.nightColor.title = 'Sun.nightColor';
    this.nightColor.oninput = () => {
      Sun.nightColor = parseInt(this.nightColor.value.slice(1), 16);
    };
    cell.appendChild(this.nightColor);
    return cell;
  }

  _dayCycleRow() {
    const cell = elem('div', 'debug-ui-light-inline');
    const label = document.createElement('label');
    label.className = 'debug-ui-light-check';
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
    cell.appendChild(label);
    cell.appendChild(createStat('speed'));
    this.daySpeed = document.createElement('input');
    this.daySpeed.type = 'number';
    this.daySpeed.step = '0.5';
    this.daySpeed.min = '0';
    this.daySpeed.className = 'debug-ui-light-number';
    this.daySpeed.title = 'config.lighting.sun.dayCycle.speed';
    this.daySpeed.onchange = () => {
      const cycle = this._dayCycleConfig();
      const v = Number(this.daySpeed.value);
      if (cycle && Number.isFinite(v) && v >= 0) cycle.speed = v;
    };
    cell.appendChild(this.daySpeed);
    return cell;
  }

  _dayCycleConfig() {
    return this.debugUI.scene?.config?.lighting?.sun?.dayCycle ?? null;
  }

  /** The lamps' marks on the debug canvas (DebugFlags.showLights): each lamp's floor pool or cone. */
  _toggleLights() {
    const flags = this.debugUI.debugFlags;
    if (!flags || !this.debugUI.caps?.lighting) return;
    flags.setFlag(DEBUG_FLAGS.SHOW_LIGHTS, !flags.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS));
    this.debugUI.canvas?.syncLoop();
    this._syncLightsButton();
  }

  _syncLightsButton() {
    const can = !!this.debugUI.caps?.lighting;
    const on = can && !!this.debugUI.debugFlags?.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS);
    if (this.lightsBtn.disabled !== !can) {
      this.lightsBtn.disabled = !can;
      this.lightsBtn.title = can ? LIGHTS_TIP : 'Requires config.lighting.enabled';
    }
    this.lightsBtn.classList.toggle('active', on);
  }

  attach() {
    const lighting = this.debugUI.scene?.config?.lighting;
    this.options.innerHTML = '';
    for (const [key, value] of lightingOptionRows(lighting)) {
      const cell = elem('span', '', `${key}: ${value}`);
      this.options.appendChild(cell);
    }
    this._lampsKey = '';
    this.views.attach();
    this._syncLightsButton();
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
    this._syncLightsButton();
    this.views.update();
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
      this.lampsHead.textContent = count > this._lamps.length ? `Lamps (${count}, the first ${this._lamps.length})` : `Lamps (${count})`;
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
