// MamushkaDigScene — Noise2D-packed static mamushka; jetpack digger; LMB laser.

import { Digger } from './gameObjects/digger.js';
import { Lamp } from './gameObjects/lamp.js';
import { MamushkaBox, ORDER1_CELL, weldTouchingMamushkas } from './gameObjects/mamushkaBox.js';
import { buildOccupancy, packMamushkaRoots } from './mamushkaPack.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import {
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const { Transform, LiquidFun } = WEED;

const MAX_PACK_ORDER = 6;
const GRID_COLS = 120;
const GRID_ROWS = 48;
const BOX_POOL = 16384;
const LAMP_STASH = 8;

export class MamushkaDigScene extends WEED.Scene {
  static config = {
    worldWidth: 10000,
    worldHeight: 5000,

    spatial: {
      cellSize: 128,
      maxNeighbors: 1024,
      noLimitFPS: false,
    },

    logic: {
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 8000,
      decals: false,
    },

    physics: {
      subStepCount: 4,
      noLimitFPS: false,
      maxJoints: 32768,
      gravity: { x: 0, y: 1800 },
      sleeping: true,
      liquidFun: {
        enabled: true,
        radius: 7,
        maxCount: 32767,
        subSteps: 1,
        powderStrength: 0.7,
      },
    },

    renderer: {
      noLimitFPS: false,
      maxVisibleRenderables: 40000,
    },

    lighting: {
      enabled: true,
      raycasted: true,
      shadowsEnabled: false,
      baseAmbient: 0.12,
      maxLights: 40,
      maxPolygonVertices: 5000,
      maxOccluderSelfLit: 1024,
      sun: { enabled: false },
    },

    layers: {
      terrain: {
        zIndex: 2.5,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        maxItems: BOX_POOL,
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
      sand: {
        zIndex: 3.4,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        scaleMode: LAYER_SCALE_MODE.LINEAR,
        maxItems: 0,
        ySorting: false,
        // shader: {
        //   fragment: 'dulceDeLeche',
        //   containerBlend: BLEND_MODES.ADD,
        //   densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
        //   splat: {
        //     radius: 14,
        //     falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
        //     useParticleTint: true,
        //     intensity: 0.35,
        //   },
        //   uniforms: {
        //     uCutoff: { value: 0.42, type: 'f32' },
        //     uRim: { value: 0.55, type: 'f32' },
        //     uDepth: { value: 0.28, type: 'f32' },
        //     uBodyAlpha: { value: 0.95, type: 'f32' },
        //     uEdgeAlpha: { value: 0.8, type: 'f32' },
        //   },
        // },
      },
      fx: {
        zIndex: 4.5,
        blendMode: BLEND_MODES.ADD,
        maxItems: 4000,
        ySorting: false,
      },
    },
  };

  static assets = {
    textures: {
      rocky: '/demos/img/rocky.jpg',
    },
    shaders: {
      rockContour: '/demos/shaders/rockContour.wgsl',
      dulceDeLeche: '/demos/shaders/dulceDeLeche.wgsl',
    },
    AdobeAnimateAnimations: {
      blue_character: {
        atlas: '/demos/img/adobe_blue_character/spritemap1.json',
        animation: '/demos/img/adobe_blue_character/Animation.json',
        png: '/demos/img/adobe_blue_character/spritemap1.png',
      },
    },
  };

  static entities = [
    [MamushkaBox, BOX_POOL],
    [Floor, 16],
    [Digger, 1],
    [Lamp, 32],
  ];

  create() {
    this.spawnFloorAndWalls();
    this.playerIndex = -1;
    Camera.setZoom(0.7);
    this._createHud();
  }

  createNewGame() {
    LiquidFun.clear();
    MamushkaBox.despawnAll();
    Lamp.despawnAll();
    Digger.despawnAll();
    this._spawnTerrain();
    this._spawnDigger();
    this._spawnLampStash();
    this._refreshHud();
  }

  update() {
    const i = this.playerIndex;
    if (i >= 0 && Transform.active[i]) {
      Camera.follow(Transform.x[i], Transform.y[i], 0.15);
    }
    this._refreshHud();
  }

  _spawnDigger() {
    const cols = GRID_COLS;
    const gridOriginX = (this.config.worldWidth - cols * ORDER1_CELL) * 0.5;
    const gridOriginY = this.config.worldHeight * 0.22;
    const x = gridOriginX + ORDER1_CELL * 3;
    const y = gridOriginY + ORDER1_CELL * 2;
    const spawned = Digger.spawn({ x, y });
    this.playerIndex = spawned ? spawned.index : -1;
    if (this.playerIndex >= 0) Camera.centerOn(x, y);
  }

  _spawnLampStash() {
    const i = this.playerIndex;
    const px = i >= 0 ? Transform.x[i] : 200;
    const py = i >= 0 ? Transform.y[i] : 200;
    for (let n = 0; n < LAMP_STASH; n++) {
      Lamp.spawn({
        x: px + 70 + n * 36,
        y: py + 24,
      });
    }
  }

  _createHud() {
    if (typeof document === 'undefined') return;
    if (this._hud) return;
    const el = document.createElement('div');
    el.id = 'mamushka-dig-hud';
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:900;color:#fff;font:13px/1.4 sans-serif;' +
      'background:rgba(0,0,0,0.65);padding:10px 12px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
    this._hud = el;
    this._refreshHud();
  }

  _refreshHud() {
    if (!this._hud) return;
    const start = Lamp.startIndex | 0;
    const end = start + (Lamp.poolSize | 0);
    const active = Transform.active;
    let worldLamps = 0;
    for (let i = start; i < end; i++) {
      if (active[i]) worldLamps++;
    }
    const carried = LAMP_STASH - worldLamps;
    this._hud.textContent =
      'Mamushka Dig — A/D move  |  W/up jetpack  |  hold LMB laser  |  F place lamp\n' +
      `lamps: ${carried < 0 ? 0 : carried}  |  walk over lamp to pick`;
  }

  _spawnTerrain() {
    const { solid, materials, cols, rows } = buildOccupancy({
      cols: GRID_COLS,
      rows: GRID_ROWS,
      seed: 9193191,
      scale: 0.06,
      threshold: 0.15,
      yBias: 0.5,
      stoneDepthFrac: 0.45,
    });

    const roots = packMamushkaRoots(solid, materials, cols, rows, MAX_PACK_ORDER);
    const gridOriginX = (this.config.worldWidth - cols * ORDER1_CELL) * 0.5;
    const gridOriginY = this.config.worldHeight * 0.22;
    const cell = ORDER1_CELL;

    let spawned = 0;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      const size = r.sideCells * cell;
      const x = gridOriginX + (r.gx + r.sideCells * 0.5) * cell;
      const y = gridOriginY + (r.gy + r.sideCells * 0.5) * cell;
      const box = MamushkaBox.spawn({
        x,
        y,
        level: r.level,
        size,
        material: r.material,
      });
      if (box) spawned++;
      else {
        console.warn('[MamushkaDigScene] MamushkaBox pool exhausted at', spawned);
        break;
      }
    }
    console.log(
      `[MamushkaDigScene] packed ${roots.length} roots, spawned ${spawned}`,
    );
    weldTouchingMamushkas();
  }

  spawnFloorAndWalls() {
    const t = 120;
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;

    Floor.spawn({
      x: w / 2,
      y: t / 2,
      width: w + t * 2,
      height: t,
      tint: 0x445566,
    });
    Floor.spawn({
      x: w / 2,
      y: h - t / 2,
      width: w + t * 2,
      height: t,
      tint: 0x445566,
    });
    Floor.spawn({
      x: t / 2,
      y: h / 2,
      width: t,
      height: h,
      tint: 0x445566,
    });
    Floor.spawn({
      x: w - t / 2,
      y: h / 2,
      width: t,
      height: h,
      tint: 0x445566,
    });
  }
}
