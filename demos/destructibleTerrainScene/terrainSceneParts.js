// What both terrain scenes share: the tuning panel, the four walls and the
// bench query. The planet scene imports it from this folder. Every worker
// imports the scene modules, so nothing here touches the DOM at import time.

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { WorldGrid, TUNE } from './worldGrid.js';

/** Headed benches: ship lasers straight down so the MESH remesh path actually runs. */
export function terrainBenchRemesh() {
  const search = globalThis.location && globalThis.location.search;
  const q = typeof search === 'string' ? new URLSearchParams(search).get('benchRemesh') : null;
  if (q === '1') return true;
  if (q === '0') return false;
  const path = globalThis.location && globalThis.location.pathname;
  return typeof path === 'string' && path.includes('integratedWorkerBenchmark');
}

/** Four static walls just outside a width × height world. */
export function spawnTerrainWalls(scene, width, height) {
  const t = 200;
  scene.spawnEntity(Floor, {
    x: width * 0.5,
    y: height + t * 0.5 - 8,
    width: width + t * 2,
    height: t,
    tint: 0x2d2d2d,
    visualRange: t,
  });
  scene.spawnEntity(Floor, {
    x: width * 0.5,
    y: -t * 0.5 + 8,
    width: width + t * 2,
    height: t,
    tint: 0x2d2d2d,
    visualRange: t,
  });
  scene.spawnEntity(Floor, {
    x: -t * 0.5 + 8,
    y: height * 0.5,
    width: t,
    height,
    tint: 0x2d2d2d,
    visualRange: t,
  });
  scene.spawnEntity(Floor, {
    x: width + t * 0.5 - 8,
    y: height * 0.5,
    width: t,
    height,
    tint: 0x2d2d2d,
    visualRange: t,
  });
}

const PANEL_CSS =
  'position:fixed;right:12px;top:56px;width:280px;z-index:950;max-height:calc(100vh - 72px);' +
  'overflow:auto;pointer-events:auto;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
  'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
  'padding:10px 12px 16px;box-shadow:0 8px 28px rgba(0,0,0,0.45);';

const SLIDERS = [
  ['Brush radius', TUNE.BRUSH_RADIUS, 1, 12, 1, 'Radio del pincel Z/X, en celdas.'],
  ['Brush hardness', TUNE.BRUSH_HARDNESS, 0, 1, 0.01, 'Borde. 0 = suave, 1 = disco duro.'],
  ['Brush strength', TUNE.BRUSH_STRENGTH, 0.05, 1, 0.01, 'Cuánto pinta o borra por stroke.'],
  ['Shot power', TUNE.SHOT_POWER, 0.05, 1.5, 0.05, 'Daño en el centro del láser.'],
  ['Shot radius', TUNE.SHOT_RADIUS, 0.5, 8, 0.5, 'Radio del cráter, en celdas. Igual en grid y en islas dinámicas.'],
  ['Shot cooldown ms', TUNE.SHOT_COOLDOWN, 4, 200, 1, 'Mínimo entre disparos (C).'],
];

/** Brush and laser sliders on WorldGrid's TUNE slots. Main thread only. */
export class TerrainPanel {
  /**
   * @param {{ id: string, title: string, keys: string, tip: string }} text
   */
  constructor({ id, title, keys, tip }) {
    this.id = id;
    this.title = title;
    this.keys = keys;
    this.tip = tip;
    this._panel = null;
    this._tipEl = null;
    this._sliderRows = [];
  }

  build() {
    if (typeof document === 'undefined') return;
    this.remove();
    const panel = document.createElement('div');
    panel.id = this.id;
    panel.style.cssText = PANEL_CSS;
    const block = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 1);
    const unblock = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
    panel.addEventListener('pointerenter', block);
    panel.addEventListener('pointerdown', block);
    panel.addEventListener('pointerleave', unblock);

    const title = document.createElement('div');
    title.style.cssText = 'font:600 14px/1.2 system-ui;margin:0 0 8px;color:#fff;';
    title.textContent = this.title;
    panel.appendChild(title);
    panel.appendChild(this._keysRow(this.keys));

    this._sliderRows = [];
    for (let i = 0; i < SLIDERS.length; i++) {
      const [label, idx, min, max, step, tip] = SLIDERS[i];
      panel.appendChild(this._sliderRow(label, idx, min, max, step, tip));
    }

    const tip = document.createElement('div');
    tip.style.cssText =
      'margin:10px 0 0;padding:8px 0 0;border-top:1px solid #3a4254;' +
      'color:#b8c0d0;font:11px/1.4 system-ui;min-height:3.2em;';
    tip.textContent = this.tip;
    panel.appendChild(tip);
    this._tipEl = tip;

    document.body.appendChild(panel);
    this._panel = panel;
  }

  /** Per frame: a slider follows a value the keys changed ([ ] brush). */
  sync() {
    const rows = this._sliderRows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const n = WorldGrid.tuneGet(row.idx);
      if (Math.abs(Number(row.input.value) - n) < 1e-6) continue;
      row.input.value = String(n);
      row.val.textContent = String(n);
    }
  }

  remove() {
    const leftover = typeof document !== 'undefined'
      ? document.getElementById(this.id)
      : null;
    const panel = this._panel || leftover;
    if (panel?.parentNode) panel.parentNode.removeChild(panel);
    this._panel = null;
    this._tipEl = null;
    this._sliderRows = [];
    WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
  }

  // A screen-space line: world-space DebugDraw text moves (and on the planet,
  // turns) with the camera.
  _keysRow(text) {
    const keys = document.createElement('div');
    keys.style.cssText = 'margin:0 0 8px;color:#b8c0d0;font:11px/1.4 system-ui;';
    keys.textContent = text;
    return keys;
  }

  _sliderRow(label, idx, min, max, step, tip) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 48px;gap:6px;align-items:center;margin:4px 0;';
    if (tip) {
      row.title = tip;
      row.addEventListener('pointerenter', () => {
        if (this._tipEl) this._tipEl.textContent = tip;
      });
    }
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'opacity:0.85;cursor:help;border-bottom:1px dotted #6a7388;width:fit-content;';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(WorldGrid.tuneGet(idx));
    input.style.width = '100%';
    const val = document.createElement('span');
    val.textContent = input.value;
    val.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;opacity:0.9;';
    input.addEventListener('input', () => {
      const n = Number(input.value);
      WorldGrid.tuneSet(idx, n);
      val.textContent = String(n);
    });
    wrap.appendChild(name);
    wrap.appendChild(input);
    row.appendChild(wrap);
    row.appendChild(val);
    this._sliderRows.push({ idx, input, val });
    return row;
  }
}
