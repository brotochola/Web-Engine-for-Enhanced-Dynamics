// Destructible terrain — marching squares + simplify + earcut compounds.
// Z draw · X erase · C laser · V shatter · [ ] brush · A/D thrusters · click uses tool.
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
  pointInConvex,
  subdivideConvex,
  MAT_NONE,
} from './terrainMesh.js';
import WEED from '/src/index.js';

const {
  Scene,
  Camera,
  Keyboard,
  Mouse,
  DebugDraw,
  Transform,
  RigidBody,
  Collider,
  ColliderFixture,
  MeshRenderer,
  Box2d,
  LAYER_KIND,
  BLEND_MODES,
} = WEED;

const CELL = 16;
const COLS = 140;
const ROWS = 80;
const WORLD_W = COLS * CELL;
const WORLD_H = ROWS * CELL;
const AREA_THRESHOLD = 80;
const SIMPLIFY_TOL = 4;
const BRUSH_STRENGTH = 0.35;
const SHOT_POWER = 0.4;
const SHOT_RADIUS = 2;
const SHOT_FALLOFF = 1;
const SHATTER_MAX = 24;
const SHATTER_MIN_AREA = CELL * CELL * 0.35;
const EXPLODE_IMPULSE = 1500;
const _scratchVerts = [];
const _scratchLocal = { x: 0, y: 0 };

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
      maxParticles: 4000,
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
    [TerrainIsland, 320],
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

  onMessageFromGameObject(data) {
    if (!data || data.type !== 'damageField' || !this.field) return;
    const gx = Math.floor(data.x / CELL);
    const gy = Math.floor(data.y / CELL);
    if (damageKernel(this.field, gx, gy, SHOT_RADIUS, SHOT_POWER, SHOT_FALLOFF)) {
      this._rebuildTerrain(false);
    }
  }

  update(dtRatio, deltaTime) {
    if (!this.field) return;

    if (Keyboard.isPressed('z')) this.tool = 'draw';
    if (Keyboard.isPressed('x')) this.tool = 'erase';
    if (Keyboard.isPressed('c')) this.tool = 'shoot';
    if (Keyboard.isPressed('v')) this.tool = 'shatter';
    if (Keyboard.isPressed('[')) this.brushRadius = Math.max(1, this.brushRadius - 1);
    if (Keyboard.isPressed(']')) this.brushRadius = Math.min(12, this.brushRadius + 1);

    if (!Mouse.isDebugToolActive) {
      if (this.tool === 'shatter') {
        if (Mouse.isButton0Pressed) this._tryShatter();
      } else if (this.tool !== 'shoot' && Mouse.isButton0Down) {
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
      if (Mouse.isButton0Released && this.field.dirty && this.tool !== 'shoot' && this.tool !== 'shatter') {
        this._rebuildTerrain(false);
      }
    }

    this._cullDynamics();
    this._drawHud();
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

  _tryShatter() {
    const picked = this._pickTerrainAt(Mouse.x, Mouse.y);
    if (!picked) return;
    const idx = picked.idx;
    const tint = MeshRenderer.tint ? MeshRenderer.tint[idx] : 0x88aa66;
    const vx = picked.dynamic && RigidBody.vx ? RigidBody.vx[idx] : 0;
    const vy = picked.dynamic && RigidBody.vy ? RigidBody.vy[idx] : 0;
    const cx = Transform.x[idx];
    const cy = Transform.y[idx];
    const vr = Collider.visualRange ? Collider.visualRange[idx] : 80;

    const world = [];
    ColliderFixture.forEach(idx, (fi) => {
      TerrainIsland.readLocalFixture(fi, _scratchVerts);
      world.push(TerrainIsland.localToWorldPoly(idx, _scratchVerts));
    });
    const shards = [];
    for (let i = 0; i < world.length && shards.length < SHATTER_MAX; i++) {
      subdivideConvex(world[i], SHATTER_MIN_AREA, SHATTER_MAX, shards);
    }

    if (!picked.dynamic && picked.rec) this._clearStaticField(picked.rec);
    this.despawnEntity(idx);
    this._removeDynamic(idx);
    this._removeStatic(idx);
    TerrainIsland.spawnShardsFromWorld(shards, tint, vx, vy);
    Box2d.explode({
      x: cx,
      y: cy,
      radius: Math.max(vr, 48),
      impulsePerLength: EXPLODE_IMPULSE,
    });
  }

  _pickTerrainAt(wx, wy) {
    let found = null;
    this._eachIsland((idx) => {
      if (!this._islandContains(idx, wx, wy)) return;
      const dynamic = !RigidBody.static[idx];
      found = { idx, dynamic, rec: dynamic ? null : this._staticRec(idx) };
    });
    return found;
  }

  _eachIsland(fn) {
    const start = TerrainIsland.startIndex | 0;
    const end = TerrainIsland.endIndex | 0;
    for (let idx = start; idx < end; idx++) {
      if (!Transform.active?.[idx]) continue;
      fn(idx);
    }
  }

  _staticRec(idx) {
    const arr = this.staticIslands;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].index === idx) return arr[i];
    }
    return null;
  }

  _islandContains(idx, wx, wy) {
    if (!Collider.active?.[idx]) return false;
    TerrainIsland.worldToLocal(idx, wx, wy, _scratchLocal);
    const lx = _scratchLocal.x;
    const ly = _scratchLocal.y;
    let inside = false;
    ColliderFixture.forEach(idx, (fi) => {
      if (inside) return;
      TerrainIsland.readLocalFixture(fi, _scratchVerts);
      if (pointInConvex(_scratchVerts, lx, ly)) inside = true;
    });
    return inside;
  }

  _clearStaticField(rec) {
    const field = this.field;
    if (!field || !rec) return;
    const x0 = Math.max(0, rec.minX);
    const y0 = Math.max(0, rec.minY);
    const x1 = Math.min(field.cols - 1, rec.maxX);
    const y1 = Math.min(field.rows - 1, rec.maxY);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * field.cols + x;
        field.amount[i] = 0;
        field.material[i] = MAT_NONE;
      }
    }
    field.markDirty(x0, y0);
    field.markDirty(x1, y1);
  }

  _removeDynamic(idx) {
    const arr = this.dynamicIslands;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== idx) arr[w++] = arr[i];
    }
    arr.length = w;
  }

  _removeStatic(idx) {
    const arr = this.staticIslands;
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].index !== idx) arr[w++] = arr[i];
    }
    arr.length = w;
  }

  _cullDynamics() {
    this._eachIsland((idx) => {
      if (RigidBody.static[idx]) return;
      if (Transform.y[idx] > WORLD_H + 240) this.despawnEntity(idx);
    });
  }

  _drawHud() {
    const x = Camera.x - 220 / (Camera.zoom || 1);
    const y = Camera.y - 180 / (Camera.zoom || 1);
    DebugDraw.drawText(x, y, `tool ${this.tool} r${this.brushRadius}`, 0xe8e8e8, 0);
    DebugDraw.drawText(x, y + 18 / (Camera.zoom || 1), 'Z draw X erase C laser V shatter', 0xa0aec0, 0);
  }
}
