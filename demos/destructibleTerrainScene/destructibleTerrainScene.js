// Destructible terrain — marching squares + simplify + earcut compounds.
// Z draw · X erase · C laser · [ ] brush · A/D thrusters · click uses tool.
// No harpoon.

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from './gameObjects/terrainIsland.js';
import { Ship } from './gameObjects/ship.js';
import {
  TerrainField,
  MAT_DIRT,
  MAT_TINT,
  extractIslands,
  buildContourFixtures,
  centroidFromPolys,
  polysToLocal,
  aabbOverlaps,
  paintBrush,
  damageKernel,
  castRayGrid,
} from './terrainMesh.js';
import WEED from '/src/index.js';

const { Scene, Camera, Keyboard, Mouse, DebugDraw, Transform, LAYER_KIND } = WEED;

const CELL = 16;
const COLS = 140;
const ROWS = 80;
const WORLD_W = COLS * CELL;
const WORLD_H = ROWS * CELL;
const AREA_THRESHOLD = 80;
const SIMPLIFY_TOL = 4;
const BRUSH_STRENGTH = 0.35;
const SHOT_COOLDOWN_MS = 120;
const SHOT_POWER = 0.4;
const SHOT_RADIUS = 2;
const SHOT_FALLOFF = 1;

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
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
    },

    physics: {
      box2dWorkerCount: 4,
      subStepCount: 4,
      noLimitFPS: false,
      gravity: { x: 0, y: 1800 },
      maxFixtures: 8192,
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
    },

    debug: {
      maxDebugDrawEntries: 128,
    },
  };

  static assets = {
    textures: {},
  };

  static entities = [
    [TerrainIsland, 160],
    [Ship, 2],
    [Floor, 8],
  ];

  constructor(game) {
    super(game);
    this.field = null;
    this.tool = 'draw';
    this.brushRadius = 3;
    this.brushHardness = 0.35;
    this.staticIslands = [];
    this.dynamicIslands = [];
    this.shipIndex = -1;
    this.shotCooldownMs = 0;
    this.shotFx = null;
  }

  create() {
    this.field = new TerrainField(COLS, ROWS, CELL);
    this._spawnWalls();
    Camera.setFree(false);
    Camera.setZoom(0.9);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.55);
  }

  createNewGame() {
    this.field.seedPlatforms();
    this.staticIslands.length = 0;
    this.dynamicIslands.length = 0;
    this._rebuildTerrain(true);
    const spawned = this.spawnEntity(Ship, {
      x: WORLD_W * 0.5,
      y: WORLD_H * 0.72,
    });
    this.shipIndex = spawned ? spawned.index : -1;
  }

  update(dtRatio, deltaTime) {
    if (!this.field) return;

    if (Keyboard.isPressed('z')) this.tool = 'draw';
    if (Keyboard.isPressed('x')) this.tool = 'erase';
    if (Keyboard.isPressed('c')) this.tool = 'shoot';
    if (Keyboard.isPressed('[')) this.brushRadius = Math.max(1, this.brushRadius - 1);
    if (Keyboard.isPressed(']')) this.brushRadius = Math.min(12, this.brushRadius + 1);

    if (!Mouse.isDebugToolActive) {
      if (this.tool === 'shoot') {
        this.shotCooldownMs -= deltaTime;
        if (Mouse.isButton0Down && this.shotCooldownMs <= 0) this._tryShoot();
      } else if (Mouse.isButton0Down) {
        paintBrush(
          this.field,
          Mouse.x,
          Mouse.y,
          this.brushRadius,
          this.brushHardness,
          BRUSH_STRENGTH,
          this.tool === 'erase',
          MAT_DIRT,
        );
      }
      if (Mouse.isButton0Released && this.field.dirty && this.tool !== 'shoot') {
        this._rebuildTerrain(false);
      }
    }

    this._cullDynamics();
    this._drawHud();
    this._drawShotFx();
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

  _rebuildTerrain(full) {
    const dirty = full ? { minX: 0, minY: 0, maxX: COLS - 1, maxY: ROWS - 1 } : this.field.consumeDirty(1);
    if (!dirty) return;
    if (full) this.field.consumeDirty(0);

    const keep = [];
    for (let i = 0; i < this.staticIslands.length; i++) {
      const rec = this.staticIslands[i];
      if (!full && !aabbOverlaps(rec, dirty)) {
        keep.push(rec);
        continue;
      }
      this.despawnEntity(rec.index);
    }
    this.staticIslands = keep;

    const islands = extractIslands(this.field);
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      const islandBox = {
        minX: island.minX,
        minY: island.minY,
        maxX: island.maxX,
        maxY: island.maxY,
      };
      const isDynamic = island.areaCells < AREA_THRESHOLD;
      if (!isDynamic && !full && !aabbOverlaps(islandBox, dirty)) continue;

      const built = buildContourFixtures(island, this.field, SIMPLIFY_TOL);
      const polys = built.polys;
      if (!polys || !polys.length) continue;
      const cen = centroidFromPolys(polys);
      if (!cen) continue;
      const local = polysToLocal(polys, cen.x, cen.y);
      if (!local.length) continue;

      const tint = MAT_TINT[island.material] || 0x88aa66;
      const spawned = this.spawnEntity(TerrainIsland, {
        x: cen.x,
        y: cen.y,
        isStatic: !isDynamic,
        polys: local,
        tint,
        layer: 'terrain',
      });
      if (!spawned) continue;

      if (isDynamic) {
        this.field.clearIslandNodes(island.nodes);
        this.dynamicIslands.push(spawned.index);
      } else {
        this.staticIslands.push({
          index: spawned.index,
          minX: island.minX,
          minY: island.minY,
          maxX: island.maxX,
          maxY: island.maxY,
        });
      }
    }
  }

  _tryShoot() {
    if (this.shipIndex < 0 || !Transform.active || !Transform.active[this.shipIndex]) return;
    const ox0 = Transform.x[this.shipIndex];
    const oy0 = Transform.y[this.shipIndex];
    let dx = Mouse.x - ox0;
    let dy = Mouse.y - oy0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;
    const ux = dx / dist;
    const uy = dy / dist;
    const pad = 16;
    const ox = ox0 + ux * pad;
    const oy = oy0 + uy * pad;
    const rayLen = Math.max(WORLD_W, WORLD_H) * 1.5;
    const cast = castRayGrid(this.field, ox, oy, ux, uy, rayLen);
    this.shotFx = {
      ox,
      oy,
      hx: cast.point.x,
      hy: cast.point.y,
      hit: cast.hit,
      until: performance.now() + 140,
    };
    this.shotCooldownMs = SHOT_COOLDOWN_MS;
    if (!cast.hit) return;
    if (damageKernel(this.field, cast.gx, cast.gy, SHOT_RADIUS, SHOT_POWER, SHOT_FALLOFF)) {
      this._rebuildTerrain(false);
    }
  }

  _cullDynamics() {
    let w = 0;
    for (let i = 0; i < this.dynamicIslands.length; i++) {
      const idx = this.dynamicIslands[i];
      if (!Transform.active || !Transform.active[idx]) continue;
      if (Transform.y[idx] > WORLD_H + 240) {
        this.despawnEntity(idx);
        continue;
      }
      this.dynamicIslands[w++] = idx;
    }
    this.dynamicIslands.length = w;
  }

  _drawHud() {
    const x = Camera.x - 220 / (Camera.zoom || 1);
    const y = Camera.y - 180 / (Camera.zoom || 1);
    DebugDraw.drawText(x, y, `tool ${this.tool} r${this.brushRadius}`, 0xe8e8e8, 0);
    DebugDraw.drawText(x, y + 18 / (Camera.zoom || 1), 'Z draw X erase C laser', 0xa0aec0, 0);
  }

  _drawShotFx() {
    if (!this.shotFx) return;
    if (performance.now() > this.shotFx.until) {
      this.shotFx = null;
      return;
    }
    const c = this.shotFx.hit ? 0xffdc50 : 0xa0b4c8;
    DebugDraw.drawLine(this.shotFx.ox, this.shotFx.oy, this.shotFx.hx, this.shotFx.hy, c, 0);
    if (this.shotFx.hit) {
      DebugDraw.drawCircle(this.shotFx.hx, this.shotFx.hy, 5, 0xff6b6b, 0);
    }
  }
}
