// Box2D planet — same terrain engine as destructibleTerrainScene (WorldGrid
// density SAB, chunked marching squares, simplify, Delaunay, Martinez, body
// retarget, Ship with laser) seeded as a filled disk. The only differences are
// the planet shape and radial gravity: world gravity is zero and loose chunks,
// the ship, lamps and water are pulled toward the core.
// Z draw · X erase · C laser · V shatter · [ ] brush · W/A/D thrusters · click uses tool.

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from '/demos/destructibleTerrainScene/gameObjects/terrainIsland.js';
import { WorldGrid, TUNE } from '/demos/destructibleTerrainScene/worldGrid.js';
import { PlanetWorldGridManager } from './gameObjects/planetWorldGridManager.js';
import { PlanetShip } from './gameObjects/planetShip.js';
import { PlanetPull } from './gameObjects/planetPull.js';
import { PlanetLamp } from './gameObjects/planetLamp.js';
import { N, CELL, RADIUS, CX, CY, PARTICLE_R } from './planetGravity.js';
import WEED from '/src/index.js';

const {
  Scene,
  Camera,
  Mouse,
  DebugDraw,
  LAYER_KIND,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} = WEED;

/** Headed benches: ship lasers straight down so the MESH remesh path actually runs. */
function planetBenchRemesh() {
  const search = globalThis.location && globalThis.location.search;
  const q = typeof search === 'string' ? new URLSearchParams(search).get('benchRemesh') : null;
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

const WORLD = N * CELL;
const SURFACE_Y = CY - RADIUS * CELL;

// The manager runs in the logic workers and every worker imports this scene
// module, so the disk must be configured at module scope — a create()-only
// assignment only reaches the main thread and the workers would seed the flat
// destructible landscape instead. Workers are created per scene load
// (Scene.killWorkers), so this cannot leak into other demos' workers; the
// main-thread copy is cleared in destroy().
//
// cols/rows/cellSize are plain statics, not shared memory: each realm has its
// own copy. The manager sets them in its onSpawned(), but it is forced onto
// logic worker 1 while the ship (and islands) tick on worker 0. Without the
// module-scope assignment the ship's WorldGrid.castRay() kept the destructible
// ROWS=200 bound, so laser rays fired from the lower two thirds of the disk
// started outside the grid and never hit static terrain.
WorldGrid.cols = N;
WorldGrid.rows = N;
WorldGrid.cellSize = CELL;
WorldGrid.disk = {
  cols: N,
  rows: N,
  cell: CELL,
  cx: N >> 1,
  cy: N >> 1,
  radius: RADIUS,
  bedrock: 4,
};

export class PlanetPhysicsScene extends Scene {
  static config = {
    worldWidth: WORLD,
    worldHeight: WORLD,
    seed: 3,

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
      numberOfPhysicsWorkers: 4,
      subStepCount: 4,
      noLimitFPS: false,
      // Radial gravity is applied per body; the world well stays off.
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: 65535,
      // ax/ay are written every tick for loose chunks; keep them awake.
      sleeping: false,
      liquidFun: {
        enabled: true,
        radius: PARTICLE_R,
        maxCount: 4000,
        subSteps: 2,
      },
    },

    // planetWater.frag is WebGL-only.
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
    },

    lighting: {
      enabled: true,
      raycasted: true,
      shadowsEnabled: false,
      baseAmbient: 0,
      maxLights: 40,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: 1024,
      particleLights: {
        enabled: true,
        max: 256,
      },
      sun: { enabled: false },
    },

    layers: {
      terrain: {
        kind: LAYER_KIND.MESH,
        zIndex: 2,
        blendMode: BLEND_MODES.NORMAL,
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
      water: {
        zIndex: 3.9,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        scaleMode: LAYER_SCALE_MODE.LINEAR,
        maxItems: 0,
        ySorting: false,
        shader: {
          fragment: 'planetWater',
          containerBlend: BLEND_MODES.ADD,
          densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
          splat: {
            radius: 18,
            falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
            useParticleTint: true,
            intensity: 0.22,
          },
          uniforms: {
            uCutoff: { value: 0.18, type: 'f32' },
            uRim: { value: 0.32, type: 'f32' },
            uDepth: { value: 0.45, type: 'f32' },
            uBodyAlpha: { value: 0.88, type: 'f32' },
            uEdgeAlpha: { value: 0.55, type: 'f32' },
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
      square: '/demos/img/10_10_square.png',
      rocky: '/demos/img/rocky.jpg',
    },
    shaders: {
      planetWater: '/demos/planetPhysicsScene/shaders/planetWater.frag',
      rockContour: {
        webgl: '/demos/shaders/rockContour.frag',
        webgpu: '/demos/shaders/rockContour.wgsl',
      },
    },
  };

  static entities = [
    [PlanetWorldGridManager, 1],
    [TerrainIsland, 2048],
    [PlanetShip, 2],
    [Floor, 8],
    [PlanetLamp, 64],
    [PlanetPull, 1],
  ];

  static sharedResources = [
    [WorldGrid, WorldGrid.schemaFor(N, N)],
  ];

  constructor(game) {
    super(game);
    this._sliderRows = [];
  }

  create() {
    this._spawnWalls();
    Camera.setFree(false);
    Camera.setZoom(1);
    Camera.setAngle(0);
    Camera.centerOn(CX, SURFACE_Y - 120);
    this._buildPanel();
  }

  async destroy() {
    this._removePanel();
    WorldGrid.disk = null;
    Camera.setAngle(0);
    await super.destroy();
  }

  createNewGame() {
    // The manager seeds + meshes the disk in onSpawned, then spawns the ship,
    // lamp and water emitter itself. Spawning them here would create their
    // bodies before the static terrain fixtures exist and the ship would fall
    // through the disk while the mesh is built.
    this.spawnEntity(PlanetWorldGridManager, {
      forceProcessOnLogicWorker: 1,
      benchRemesh: planetBenchRemesh(),
    });
  }

  // A save restores the WorldGrid bytes, the lamp and the LiquidFun water. The manager
  // meshes the restored grid instead of seeding, then spawns the ship (and the water
  // pull, marked as already poured). Broken-off chunks are not saved yet (REVIEW_PLAN N-5).
  onLoadGame() {
    this.spawnEntity(PlanetWorldGridManager, {
      forceProcessOnLogicWorker: 1,
      benchRemesh: planetBenchRemesh(),
      resume: true,
    });
  }

  update() {
    this._drawHud();
    this._syncSliders();
  }

  _spawnWalls() {
    const t = 200;
    this.spawnEntity(Floor, {
      x: WORLD * 0.5,
      y: WORLD + t * 0.5 - 8,
      width: WORLD + t * 2,
      height: t,
      tint: 0x2d2d2d,
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: WORLD * 0.5,
      y: -t * 0.5 + 8,
      width: WORLD + t * 2,
      height: t,
      tint: 0x2d2d2d,
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: -t * 0.5 + 8,
      y: WORLD * 0.5,
      width: t,
      height: WORLD,
      tint: 0x2d2d2d,
      visualRange: t,
    });
    this.spawnEntity(Floor, {
      x: WORLD + t * 0.5 - 8,
      y: WORLD * 0.5,
      width: t,
      height: WORLD,
      tint: 0x2d2d2d,
      visualRange: t,
    });
  }

  _drawHud() {
    const x = Camera.x - 240 / (Camera.zoom || 1);
    const y = Camera.y - 180 / (Camera.zoom || 1);
    DebugDraw.drawText(x, y, 'Z draw  X erase  C laser  V shatter  W/A/D fly', 0xe8e8e8, 0);
  }

  _buildPanel() {
    if (typeof document === 'undefined') return;
    this._removePanel();
    const panel = document.createElement('div');
    panel.id = 'planet-terrain-panel';
    panel.style.cssText = PANEL_CSS;
    const block = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 1);
    const unblock = () => WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
    panel.addEventListener('pointerenter', block);
    panel.addEventListener('pointerdown', block);
    panel.addEventListener('pointerleave', unblock);

    const title = document.createElement('div');
    title.style.cssText = 'font:600 14px/1.2 system-ui;margin:0 0 8px;color:#fff;';
    title.textContent = 'Planet terrain';
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
    tip.textContent = 'Suelto (sin tocar el núcleo) cae hacia el centro. Q tira agua.';
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
      ? document.getElementById('planet-terrain-panel')
      : null;
    const panel = this._panel || leftover;
    if (panel?.parentNode) panel.parentNode.removeChild(panel);
    this._panel = null;
    this._tipEl = null;
    this._sliderRows = [];
    WorldGrid.tuneSet(TUNE.UI_BLOCK, 0);
  }
}
