// Destructible terrain — WorldGrid SAB + WorldGridManager in logic.
// Loose dirt (not touching left/right/bottom) falls as one body. No welds.
// Z draw · X erase · C laser · V shatter · [ ] brush · A/D thrusters · click uses tool.

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from './gameObjects/terrainIsland.js';
import { WorldGridManager } from './gameObjects/worldGridManager.js';
import { Ship } from './gameObjects/ship.js';
import { WorldGrid, CELL, COLS, ROWS, TUNE } from './worldGrid.js';
import WEED from '/src/index.js';

const { Scene, Camera, DebugDraw, LAYER_KIND, BLEND_MODES } = WEED;

const PANEL_CSS =
  'position:fixed;right:12px;top:56px;width:280px;z-index:950;max-height:calc(100vh - 72px);' +
  'overflow:auto;pointer-events:auto;color:#e8e8e8;font:12px/1.35 system-ui,sans-serif;' +
  'background:rgba(12,14,20,0.92);border:1px solid #3a4254;border-radius:10px;' +
  'padding:10px 12px 16px;box-shadow:0 8px 28px rgba(0,0,0,0.45);';

const SLIDERS = [
  ['Brush radius', TUNE.BRUSH_RADIUS, 1, 12, 1, 'Radio del pincel Z/X, en celdas del grid.'],
  ['Brush hardness', TUNE.BRUSH_HARDNESS, 0, 1, 0.01, 'Borde del pincel. 0 = suave, 1 = disco duro (todo o nada).'],
  ['Brush strength', TUNE.BRUSH_STRENGTH, 0.05, 1, 0.01, 'Cuánto amount suma o resta por stroke. Más alto pinta o borra más rápido.'],
  ['Shot power', TUNE.SHOT_POWER, 0.05, 1.5, 0.05, 'Daño en el centro del impacto del láser. Resta amount en el grid.'],
  ['Shot radius', TUNE.SHOT_RADIUS, 0.5, 8, 0.5, 'Radio del cráter del láser, en celdas.'],
  ['Shot falloff', TUNE.SHOT_FALLOFF, 0.2, 4, 0.1, 'Cómo cae el daño hacia el borde. 1 = lineal. Más alto = solo el centro duele.'],
  ['Shot cooldown ms', TUNE.SHOT_COOLDOWN, 4, 200, 1, 'Milisegundos mínimos entre disparos del láser (C).'],
  ['Min tri area', TUNE.MIN_TRI_AREA, 1, 200, 1, 'Tira triángulos más chicos que esto (px²) al armar el mesh. Subí si hay basura chica.'],
  ['Simplify tol', TUNE.SIMPLIFY_TOL, 1, 12, 0.5, 'Tolerancia inicial al simplificar el contorno. Más alto = menos vértices, mesh más tosco, menos fixtures.'],
  ['Simplify max', TUNE.SIMPLIFY_MAX, 6, 24, 1, 'Tope de la escalera de simplify si Delaunay falla o se pasa el fixture cap.'],
  ['Fixture cap', TUNE.FIXTURE_CAP, 32, 2048, 16, 'Máximo de polígonos Box2D por cuerpo. Si se pasa: fallback por celda o split del chunk.'],
  ['Clip radius', TUNE.CLIP_RADIUS, 4, 80, 1, 'Radio del recorte circular cuando el láser pega una isla ya dinámica (no el grid estático).'],
  ['Min keep area', TUNE.MIN_KEEP_AREA, 10, 400, 5, 'Área mínima (px²) para no tirar un pedazo al recortar o shatter una isla dinámica.'],
  ['Chunk cells', TUNE.CHUNK, 8, 64, 8, 'Lado del tile de dirty/remesh, en celdas. No corta la isla real; solo marca qué remeshear.'],
  ['Area ratio min', TUNE.AREA_RATIO_MIN, 0.5, 0.9, 0.02, 'Delaunay se acepta solo si (área de tris / área de la isla) ≥ esto. Más alto = más estricto, más fallback.'],
];

const WORLD_W = COLS * CELL;
const WORLD_H = ROWS * CELL;

export class DestructibleTerrainScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,

    spatial: {
      cellSize: 80,
      maxNeighbors: 256,
      noLimitFPS: false,
    },

    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 2,
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 4000,
      decals: false,
    },

    physics: {
      box2dWorkerCount: 4,
      subStepCount: 4,
      noLimitFPS: false,
      gravity: { x: 0, y: 1800 },
      maxFixturePoolSize: 65535,
      sleeping: true,
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },

    lighting: {
      enabled: false,
    },

    layers: {
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2.9,
      },
      fx: {
        zIndex: 4.5,
        blendMode: BLEND_MODES.ADD,
        maxItems: 4000,
        ySorting: false,
      },
    },

    debug: {
      maxDebugDrawEntries: 128,
    },
  };

  static assets = {
    textures: {},
  };

  static entities = [
    [WorldGridManager, 1],
    [TerrainIsland, 2048],
    [Ship, 2],
    [Floor, 8],
  ];

  static sharedResources = [
    [WorldGrid, WorldGrid.schemaFor(COLS, ROWS)],
  ];

  constructor(game) {
    super(game);
    this._sliderRows = [];
  }

  create() {
    this._spawnWalls();
    Camera.setFree(false);
    Camera.setZoom(0.5);
    Camera.centerOn(WORLD_W * 0.5, Math.max(48, WORLD_H * 0.08));
    this._buildPanel();
  }

  async destroy() {
    this._removePanel();
    await super.destroy();
  }

  createNewGame() {
    this.spawnEntity(Ship, {
      x: WORLD_W * 0.5,
      y: Math.max(48, WORLD_H * 0.08),
    });
    this.spawnEntity(WorldGridManager, { forceProcessOnLogicWorker: 1 });
  }

  update() {
    this._drawHud();
    this._syncSliders();
  }

  _spawnWalls() {
    const t = 200;
    this.spawnEntity(Floor, {
      x: WORLD_W * 0.5,
      y: WORLD_H + t * 0.5 - 8,
      width: WORLD_W + t * 2,
      height: t,
      tint: 0x2d2d2d,
    });
    this.spawnEntity(Floor, {
      x: WORLD_W * 0.5,
      y: -t * 0.5 + 8,
      width: WORLD_W + t * 2,
      height: t,
      tint: 0x2d2d2d,
    });
    this.spawnEntity(Floor, {
      x: -t * 0.5 + 8,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H,
      tint: 0x2d2d2d,
    });
    this.spawnEntity(Floor, {
      x: WORLD_W + t * 0.5 - 8,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H,
      tint: 0x2d2d2d,
    });
  }

  _drawHud() {
    const x = Camera.x - 220 / (Camera.zoom || 1);
    const y = Camera.y - 180 / (Camera.zoom || 1);
    DebugDraw.drawText(x, y, 'Z draw X erase C laser V shatter · loose dirt falls', 0xe8e8e8, 0);
  }

  _buildPanel() {
    if (typeof document === 'undefined') return;
    this._removePanel();
    const panel = document.createElement('div');
    panel.id = 'destructible-terrain-panel';
    panel.style.cssText = PANEL_CSS;
    const block = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 1);
    const unblock = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
    panel.addEventListener('pointerenter', block);
    panel.addEventListener('pointerdown', block);
    panel.addEventListener('pointerleave', unblock);

    const title = document.createElement('div');
    title.style.cssText = 'font:600 14px/1.2 system-ui;margin:0 0 8px;color:#fff;';
    title.textContent = 'Terrain tunables';
    panel.appendChild(title);

    this._sliderRows = [];
    for (let i = 0; i < SLIDERS.length; i++) {
      const [label, idx, min, max, step, tip] = SLIDERS[i];
      panel.appendChild(this._sliderRow(label, idx, min, max, step, tip));
    }

    const tip = document.createElement('div');
    tip.style.cssText =
      'margin:10px 0 0;padding:8px 0 0;border-top:1px solid #3a4254;' +
      'color:#b8c0d0;font:11px/1.4 system-ui;min-height:3.2em;';
    tip.textContent = 'Pasá el mouse por un slider para ver qué hace.';
    panel.appendChild(tip);
    this._tipEl = tip;

    document.body.appendChild(panel);
    this._panel = panel;
  }

  _syncSliders() {
    const rows = this._sliderRows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const n = WorldGrid.tuneGet(row.idx);
      if (Math.abs(Number(row.input.value) - n) < 1e-6) continue;
      row.input.value = String(n);
      row.val.textContent = String(n);
    }
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

  _removePanel() {
    const leftover = typeof document !== 'undefined'
      ? document.getElementById('destructible-terrain-panel')
      : null;
    const panel = this._panel || leftover;
    if (panel?.parentNode) panel.parentNode.removeChild(panel);
    this._panel = null;
    this._tipEl = null;
    this._sliderRows = [];
    WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
  }
}
