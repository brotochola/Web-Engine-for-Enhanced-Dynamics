// Destructible terrain — WorldGrid SAB. Ship on logic0 (rays). Manager on logic1 (grid write).
// Loose dirt (not touching left/right/bottom) falls as one body. No welds.
// Ship followEntity: LOOK_AHEAD=0. Drawn cam is renderQueueCamera (PHYSICS.md).
// Z draw · X erase · C laser · V shatter · [ ] brush · W/A/D thrusters · click uses tool.
// Headed bench: ?benchRemesh=1 holds laser straight down (no C+mouse).

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from './gameObjects/terrainIsland.js';
import { WorldGridManager } from './gameObjects/worldGridManager.js';
import { Ship } from './gameObjects/ship.js';
import { WorldGrid, CELL, COLS, ROWS } from './worldGrid.js';
import { TerrainPanel, spawnTerrainWalls, terrainBenchRemesh } from './terrainSceneParts.js';
import WEED from '/src/index.js';

const { Scene, Camera, LAYER_KIND, BLEND_MODES } = WEED;

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
      numberOfPhysicsWorkers: 4,
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
      enabled: true,
      baseAmbient: 0.05,
      particleLights: {
        enabled: true,
        max: 256,
      },
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
    this._panel = new TerrainPanel({
      id: 'destructible-terrain-panel',
      title: 'Terrain',
      keys: 'Z draw · X erase · C laser · V shatter · [ ] brush · W/A/D thrusters',
      tip: 'Suelto (sin tocar pared o piso) cae entero. Z no tira hasta X/C/V.',
    });
  }

  create() {
    spawnTerrainWalls(this, WORLD_W, WORLD_H);
    Camera.setFree(false);
    Camera.setZoom(0.9);
    Camera.centerOn(WORLD_W * 0.5, Math.max(48, WORLD_H * 0.08));
    this._panel.build();
  }

  async destroy() {
    this._panel.remove();
    await super.destroy();
  }

  createNewGame() {
    this._spawnShip();
    this.spawnEntity(WorldGridManager, { forceProcessOnLogicWorker: 1 });
  }

  // The save holds the WorldGrid bytes and the loose (dynamic) islands; the ship,
  // the manager and the static rock are not saved: mesh the restored grid and put
  // a fresh ship in (N-5). A hot reload brought them back already.
  onLoadGame(payload) {
    if (payload?.hotReload) return;
    this._spawnShip();
    this.spawnEntity(WorldGridManager, { forceProcessOnLogicWorker: 1, resume: true });
  }

  _spawnShip() {
    const bench = terrainBenchRemesh();
    this.spawnEntity(Ship, {
      x: WORLD_W * 0.5,
      // In-solid spawn makes castRay skip the local rock and hit the far wall.
      y: bench ? WORLD_H * 0.26 : Math.max(48, WORLD_H * 0.08),
      forceProcessOnLogicWorker: 0,
      benchRemesh: bench,
    });
  }

  update() {
    this._panel.sync();
  }
}
