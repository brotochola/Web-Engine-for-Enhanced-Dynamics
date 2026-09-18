import {
  WorldGrid,
  CELL,
  COLS,
  ROWS,
  MAT_DIRT,
  MAT_TINT,
} from '../worldGrid.js';
import { TerrainIsland } from './terrainIsland.js';
import WEED from '/src/index.js';

const {
  GameObject,
  Keyboard,
  Mouse,
  Transform,
  RigidBody,
  Collider,
  ColliderFixture,
  MeshRenderer,
  Box2d,
} = WEED;

const AREA_THRESHOLD = 80;
const SIMPLIFY_TOL = 4;
const BRUSH_STRENGTH = 0.35;
const SHOT_POWER = 0.4;
const SHOT_RADIUS = 2;
const SHOT_FALLOFF = 1;
const SHATTER_MAX = 24;
const SHATTER_MIN_AREA = CELL * CELL * 0.35;
const EXPLODE_IMPULSE = 1500;
const WORLD_H = ROWS * CELL;
const _scratchVerts = [];
const _scratchLocal = { x: 0, y: 0 };

export class WorldGridManager extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [];

  setup() {
    this.tool = 'draw';
    this.brushRadius = 3;
    this.brushHardness = 0.35;
    this.staticIslands = [];
    this.dynamicIslands = [];
  }

  onSpawned() {
    this.tool = 'draw';
    this.brushRadius = 3;
    this.brushHardness = 0.35;
    this.staticIslands = [];
    this.dynamicIslands = [];
    WorldGrid.cols = COLS;
    WorldGrid.rows = ROWS;
    WorldGrid.cellSize = CELL;
    WorldGrid.seedPlatforms();
    this.rebuild(true);
  }

  applyDamage(wx, wy) {
    if (WorldGrid.damage(wx, wy, SHOT_RADIUS, SHOT_POWER, SHOT_FALLOFF)) {
      this.rebuild(false);
    }
  }

  tick() {
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
        WorldGrid.paint(
          Mouse.x,
          Mouse.y,
          this.brushRadius,
          this.brushHardness,
          BRUSH_STRENGTH,
          this.tool === 'erase',
          MAT_DIRT,
        );
      }
      if (
        Mouse.isButton0Released &&
        WorldGrid.dirty &&
        this.tool !== 'shoot' &&
        this.tool !== 'shatter'
      ) {
        this.rebuild(false);
      }
    }

    this._cullDynamics();
  }

  rebuild(full) {
    const dirty = full
      ? { minX: 0, minY: 0, maxX: COLS - 1, maxY: ROWS - 1 }
      : WorldGrid.consumeDirty(1);
    if (!dirty) return;
    if (full) WorldGrid.consumeDirty(0);

    const keep = [];
    for (let i = 0; i < this.staticIslands.length; i++) {
      const rec = this.staticIslands[i];
      if (!full && !WorldGrid.aabbOverlaps(rec, dirty)) {
        keep.push(rec);
        continue;
      }
      this._despawnIndex(rec.index);
    }
    this.staticIslands = keep;

    const islands = WorldGrid.extractIslands();
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      const islandBox = {
        minX: island.minX,
        minY: island.minY,
        maxX: island.maxX,
        maxY: island.maxY,
      };
      const isDynamic = island.areaCells < AREA_THRESHOLD;
      if (!isDynamic && !full && !WorldGrid.aabbOverlaps(islandBox, dirty)) continue;

      const built = WorldGrid.buildContourFixtures(island, SIMPLIFY_TOL);
      const polys = built.polys;
      if (!polys || !polys.length) continue;
      const cen = WorldGrid.centroidFromPolys(polys);
      if (!cen) continue;
      const local = WorldGrid.polysToLocal(polys, cen.x, cen.y);
      if (!local.length) continue;

      const tint = MAT_TINT[island.material] || 0x88aa66;
      const spawned = TerrainIsland.spawn({
        x: cen.x,
        y: cen.y,
        isStatic: !isDynamic,
        polys: local,
        tint,
        layer: 'terrain',
      });
      if (!spawned) continue;

      if (isDynamic) {
        WorldGrid.clearIslandNodes(island.nodes);
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
      WorldGrid.subdivideConvex(world[i], SHATTER_MIN_AREA, SHATTER_MAX, shards);
    }

    if (!picked.dynamic && picked.rec) this._clearStaticField(picked.rec);
    this._despawnIndex(idx);
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
      if (WorldGrid.pointInConvex(_scratchVerts, lx, ly)) inside = true;
    });
    return inside;
  }

  _clearStaticField(rec) {
    if (!rec) return;
    WorldGrid.clearRect(rec.minX, rec.minY, rec.maxX, rec.maxY);
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

  _despawnIndex(idx) {
    const start = TerrainIsland.startIndex | 0;
    const inst = TerrainIsland.instances[idx - start];
    if (inst && inst.active) inst.despawn();
  }

  _cullDynamics() {
    this._eachIsland((idx) => {
      if (RigidBody.static[idx]) return;
      if (Transform.y[idx] > WORLD_H + 240) this._despawnIndex(idx);
    });
  }
}
