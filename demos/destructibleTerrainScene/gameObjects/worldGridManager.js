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
const SHATTER_MAX = 24;
const SHATTER_MIN_AREA = CELL * CELL * 0.35;
const EXPLODE_IMPULSE = 1500;
const WORLD_H = ROWS * CELL;
const _scratchVerts = [];
const _scratchLocal = { x: 0, y: 0 };

function aabbOverlapCells(a, b) {
  const x0 = a.minX > b.minX ? a.minX : b.minX;
  const y0 = a.minY > b.minY ? a.minY : b.minY;
  const x1 = a.maxX < b.maxX ? a.maxX : b.maxX;
  const y1 = a.maxY < b.maxY ? a.maxY : b.maxY;
  if (x1 < x0 || y1 < y0) return 0;
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

export class WorldGridManager extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [];

  setup() {
    this.tool = 'draw';
    this.brushRadius = 13;
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
      if (WorldGrid.hasDirty()) {
        if (this.tool === 'shoot' || this.tool === 'shatter' || !Mouse.isButton0Down) {
          this.rebuild(false);
        }
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
    const pool = [];
    for (let i = 0; i < this.staticIslands.length; i++) {
      const rec = this.staticIslands[i];
      if (!full && !WorldGrid.aabbOverlaps(rec, dirty)) keep.push(rec);
      else pool.push(rec);
    }
    if (full) {
      for (let i = 0; i < pool.length; i++) this._despawnIndex(pool[i].index);
      pool.length = 0;
    }

    const jobs = [];
    const islands = full ? WorldGrid.extractIslands() : WorldGrid.extractIslands(dirty);
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
      if (isDynamic) {
        const spawned = TerrainIsland.spawn({
          x: cen.x,
          y: cen.y,
          isStatic: false,
          polys: local,
          tint,
          layer: 'terrain',
        });
        if (!spawned) continue;
        WorldGrid.clearIslandNodes(island);
        this.dynamicIslands.push(spawned.index);
        continue;
      }

      jobs.push({ island, islandBox, cen, local, tint });
    }

    jobs.sort((a, b) => b.island.areaCells - a.island.areaCells);
    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      let bestI = -1;
      let bestA = 0;
      for (let p = 0; p < pool.length; p++) {
        const a = aabbOverlapCells(pool[p], job.islandBox);
        if (a > bestA) {
          bestA = a;
          bestI = p;
        }
      }
      if (bestI >= 0 && this._retargetStatic(pool[bestI], job)) {
        const rec = pool[bestI];
        rec.minX = job.island.minX;
        rec.minY = job.island.minY;
        rec.maxX = job.island.maxX;
        rec.maxY = job.island.maxY;
        keep.push(rec);
        pool[bestI] = pool[pool.length - 1];
        pool.pop();
        continue;
      }
      const spawned = TerrainIsland.spawn({
        x: job.cen.x,
        y: job.cen.y,
        isStatic: true,
        polys: job.local,
        tint: job.tint,
        layer: 'terrain',
      });
      if (!spawned) continue;
      keep.push({
        index: spawned.index,
        minX: job.island.minX,
        minY: job.island.minY,
        maxX: job.island.maxX,
        maxY: job.island.maxY,
      });
    }

    for (let i = 0; i < pool.length; i++) this._despawnIndex(pool[i].index);
    this.staticIslands = keep;
  }

  _retargetStatic(rec, job) {
    const start = TerrainIsland.startIndex | 0;
    const inst = TerrainIsland.instances[rec.index - start];
    return !!(inst && inst.active && inst.retarget(job.cen.x, job.cen.y, job.local));
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
