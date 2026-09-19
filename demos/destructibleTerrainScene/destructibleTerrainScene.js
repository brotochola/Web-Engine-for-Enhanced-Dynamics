// Destructible terrain — WorldGrid SAB. Ship on logic0 (rays). Manager on logic1 (grid write).
// Loose dirt (not touching left/right/bottom) falls as one body. No welds.
// Ship followEntity: LOOK_AHEAD=0. Drawn cam is renderQueueCamera (PHYSICS.md).
// Z draw · X erase · C laser · V shatter · [ ] brush · A/D thrusters · click uses tool.
// Headed bench: ?benchRemesh=1 holds laser straight down (no C+mouse).

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from './gameObjects/terrainIsland.js';
import { WorldGridManager } from './gameObjects/worldGridManager.js';
import { Ship } from './gameObjects/ship.js';
import { WorldGrid, CELL, COLS, ROWS, TUNE } from './worldGrid.js';
import WEED from '/src/index.js';

const { Scene, Camera, DebugDraw, LAYER_KIND, BLEND_MODES } = WEED;

/** Dual-map look: query `?backend=webgl|webgpu` overrides. Missing GPUDevice stays a hard error. */
function terrainSearchParam(name) {
  const search = globalThis.location && globalThis.location.search;
  if (typeof search !== 'string') return null;
  return new URLSearchParams(search).get(name);
}

function terrainRendererBackend() {
  const q = terrainSearchParam('backend');
  if (q === 'webgl' || q === 'webgpu') return q;
  return 'webgpu';
}

/** Headed benches: ship lasers straight down so the MESH remesh path actually runs. */
function terrainBenchRemesh() {
  const q = terrainSearchParam('benchRemesh');
  if (q === '1') return true;
  if (q === '0') return false;
  const path = globalThis.location && globalThis.location.pathname;
  return typeof path === 'string' && path.includes('integratedWorkerBenchmark');
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
      backend: terrainRendererBackend(),
      noLimitFPS: false,
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
    textures: {
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
    Camera.setZoom(0.9);
    Camera.centerOn(WORLD_W * 0.5, Math.max(48, WORLD_H * 0.08));
    this._buildPanel();
  }

  async destroy() {
    this._removePanel();
    await super.destroy();
  }

  createNewGame() {
    const bench = terrainBenchRemesh();
    this.spawnEntity(Ship, {
      x: WORLD_W * 0.5,
      // In-solid spawn makes castRay skip the local rock and hit the far wall.
      y: bench ? WORLD_H * 0.26 : Math.max(48, WORLD_H * 0.08),
      forceProcessOnLogicWorker: 0,
      benchRemesh: bench,
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
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: WORLD_W * 0.5,
      y: -t * 0.5 + 8,
      width: WORLD_W + t * 2,
      height: t,
      tint: 0x2d2d2d,
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: -t * 0.5 + 8,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H,
      tint: 0x2d2d2d,
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: WORLD_W + t * 0.5 - 8,
      y: WORLD_H * 0.5,
      width: t,
      height: WORLD_H,
      tint: 0x2d2d2d,
      visualRange: t,
    });
  }

  _drawHud() {
    const x = Camera.x - 220 / (Camera.zoom || 1);
    const y = Camera.y - 180 / (Camera.zoom || 1);
    DebugDraw.drawText(x, y, 'Z draw  X erase  C laser  V shatter', 0xe8e8e8, 0);
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
    title.textContent = 'Terrain';
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
    tip.textContent = 'Suelto (sin tocar pared o piso) cae entero. Z no tira hasta X/C/V.';
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
