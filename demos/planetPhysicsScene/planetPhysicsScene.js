// Box2D planet — same terrain engine as destructibleTerrainScene (WorldGrid
// density SAB, chunked marching squares, simplify, Delaunay, Martinez, body
// retarget, Ship with laser) seeded as a filled disk. The only differences are
// the planet shape and radial gravity: world gravity is zero and loose chunks,
// the ship, lamps and water are pulled toward the core.
// Z draw · X erase · C laser · V shatter · [ ] brush · W/A/D thrusters · click uses tool.

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from '/demos/destructibleTerrainScene/gameObjects/terrainIsland.js';
import { WorldGrid } from '/demos/destructibleTerrainScene/worldGrid.js';
import {
  TerrainPanel,
  spawnTerrainWalls,
  terrainBenchRemesh,
} from '/demos/destructibleTerrainScene/terrainSceneParts.js';
import { PlanetWorldGridManager } from './gameObjects/planetWorldGridManager.js';
import { PlanetShip } from './gameObjects/planetShip.js';
import { PlanetPull } from './gameObjects/planetPull.js';
import { PlanetLamp } from './gameObjects/planetLamp.js';
import { N, CELL, RADIUS, PARTICLE_R, SHIP_SPAWN_X, SHIP_SPAWN_Y, radialCameraAngle } from './planetGravity.js';
import WEED from '/src/index.js';

const {
  Scene,
  Camera,
  LAYER_KIND,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} = WEED;

const WORLD = N * CELL;

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
      // No particleLights: raycasted lighting does not draw them.
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
      planetWater: '/demos/shaders/planetWater.frag',
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
    this._panel = new TerrainPanel({
      id: 'planet-terrain-panel',
      title: 'Planet terrain',
      keys: 'Z draw · X erase · C laser · V shatter · [ ] brush · W/A/D fly · Q water',
      tip: 'Suelto (sin tocar el núcleo) cae hacia el centro. Q tira agua.',
    });
  }

  create() {
    spawnTerrainWalls(this, WORLD, WORLD);
    Camera.setFree(false);
    Camera.setZoom(1);
    // Start where the manager spawns the ship, rolled to its local up, so the
    // first follow neither crosses a quarter of the planet nor turns 90 degrees.
    Camera.setAngle(radialCameraAngle(SHIP_SPAWN_X, SHIP_SPAWN_Y));
    Camera.centerOn(SHIP_SPAWN_X, SHIP_SPAWN_Y);
    this._panel.build();
  }

  async destroy() {
    this._panel.remove();
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
      benchRemesh: terrainBenchRemesh(),
    });
  }

  // A save restores the WorldGrid bytes, the lamp and the LiquidFun water. The manager
  // meshes the restored grid instead of seeding, then spawns the ship (and the water
  // pull, marked as already poured). Broken-off chunks are saved and come back as they
  // were (TerrainIsland.shouldSaveEntity, N-5).
  onLoadGame() {
    this.spawnEntity(PlanetWorldGridManager, {
      forceProcessOnLogicWorker: 1,
      benchRemesh: terrainBenchRemesh(),
      resume: true,
    });
  }

  update() {
    this._panel.sync();
  }
}
