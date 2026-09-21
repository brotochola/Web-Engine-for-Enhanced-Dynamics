import {
  WorldGrid,
  CELL,
  COLS,
  ROWS,
  ISO,
  MAT_DIRT,
  MAT_TINT,
  TUNE,
  DROP_MIN_CELLS,
  SHOT_KIND_GRID,
  SHOT_KIND_BODY,
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

const SHATTER_MAX = 24;
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
  static serializable = false;
  static instances = [];
  static components = [];
  static forceProcessOnLogicWorker = 1;

  setup() {
    this.tool = 'draw';
    this.staticIslands = [];
    this.dynamicIslands = [];
    this._shardSnap = [];
    this._shardPool = [];
    this._shardJobs = [];
    this._crumbSeen = Object.create(null);
    this._crumbSeeds = [];
    this._paintBox = null;
    this._keepIslands = [];
    this._fullDirtyBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this._extraShardBag = [];
    this._hitScratch = { kind: 0, x: 0, y: 0, entityIndex: -1, fixtureIndex: -1 };
    this._bodyHit = { hitX: 0, hitY: 0, fixtureIndex: -1, entityIndex: -1 };
  }

  onSpawned() {
    this.tool = 'draw';
    this.staticIslands = [];
    this.dynamicIslands = [];
    this._shardSnap = [];
    this._shardPool = [];
    this._shardJobs = [];
    this._crumbSeen = Object.create(null);
    this._crumbSeeds = [];
    this._paintBox = null;
    this._keepIslands = [];
    this._fullDirtyBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this._extraShardBag = [];
    this._hitScratch = { kind: 0, x: 0, y: 0, entityIndex: -1, fixtureIndex: -1 };
    this._bodyHit = { hitX: 0, hitY: 0, fixtureIndex: -1, entityIndex: -1 };
    WorldGrid.cols = COLS;
    WorldGrid.rows = ROWS;
    WorldGrid.cellSize = CELL;
    WorldGrid.seedWorld(this.config?.seed ?? 7);
    // this._placeShip();
    this.rebuild(true);
  }

  tick() {
    this._drainHits();
    const prevTool = this.tool;
    if (Keyboard.isPressed('z')) this.tool = 'draw';
    if (Keyboard.isPressed('x')) this.tool = 'erase';
    if (Keyboard.isPressed('c')) this.tool = 'shoot';
    if (Keyboard.isPressed('v')) this.tool = 'shatter';
    if (Keyboard.isPressed('[')) {
      WorldGrid.tuneSet(TUNE.BRUSH_RADIUS, Math.max(1, WorldGrid.tuneGet(TUNE.BRUSH_RADIUS) - 1));
    }
    if (Keyboard.isPressed(']')) {
      WorldGrid.tuneSet(TUNE.BRUSH_RADIUS, Math.min(12, WorldGrid.tuneGet(TUNE.BRUSH_RADIUS) + 1));
    }
    if (prevTool === 'draw' && this.tool !== 'draw') this._settlePaint();

    const uiBlock = WorldGrid.tuneGet(TUNE.UI_BLOCK) > 0.5;
    if (!Mouse.isDebugToolActive && !uiBlock) {
      if (this.tool === 'shatter') {
        if (Mouse.isButton0Pressed) this._tryShatter();
      } else if (this.tool !== 'shoot' && Mouse.isButton0Down) {
        WorldGrid.paint(
          Mouse.x,
          Mouse.y,
          WorldGrid.tuneGet(TUNE.BRUSH_RADIUS),
          WorldGrid.tuneGet(TUNE.BRUSH_HARDNESS),
          WorldGrid.tuneGet(TUNE.BRUSH_STRENGTH),
          this.tool === 'erase',
          MAT_DIRT,
        );
      }
    }
    if (!Mouse.isDebugToolActive && WorldGrid.hasDirty()) {
      if (this.tool === 'draw') this._unionPaintDirty();
      this.rebuild(false);
    }

    this._cullDynamics();
  }

  _drainHits() {
    const hit = this._hitScratch;
    while (WorldGrid.shiftHit(hit)) {
      if (hit.kind === SHOT_KIND_GRID) {
        WorldGrid.damage(
          hit.x,
          hit.y,
          WorldGrid.tuneGet(TUNE.SHOT_RADIUS),
          WorldGrid.tuneGet(TUNE.SHOT_POWER),
          WorldGrid.tuneGet(TUNE.SHOT_FALLOFF),
        );
        continue;
      }
      if (hit.kind !== SHOT_KIND_BODY) continue;
      const island = TerrainIsland.get(hit.entityIndex);
      if (!island) continue;
      const body = this._bodyHit;
      body.hitX = hit.x;
      body.hitY = hit.y;
      body.fixtureIndex = hit.fixtureIndex;
      body.entityIndex = hit.entityIndex;
      island.takeHit(body);
    }
  }

  // _placeShip() {
  //   const sky = WorldGrid.findSkySpawn();
  //   const start = Ship.startIndex | 0;
  //   const end = Ship.endIndex | 0;
  //   for (let i = start; i < end; i++) {
  //     const inst = Ship.instances[i - start];
  //     if (inst && inst.active) {
  //       inst.setPosition(sky.x, sky.y);
  //       inst.setVelocity(0, 0);
  //       return;
  //     }
  //   }
  //   Ship.spawn({ x: sky.x, y: sky.y });
  // }

  rebuild(full, allowPromote) {
    let dirty;
    if (full) {
      const box = this._fullDirtyBox;
      box.minX = 0;
      box.minY = 0;
      box.maxX = COLS - 1;
      box.maxY = ROWS - 1;
      dirty = box;
    } else {
      dirty = WorldGrid.consumeDirty(1);
    }
    if (!dirty) return;
    if (full) WorldGrid.consumeDirty(0);

    const src = WorldGrid.chunksOverlapping(dirty);
    const snap = this._shardSnap;
    snap.length = src.length;
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      let rec = snap[i];
      if (!rec) rec = snap[i] = {};
      rec.chunkX = s.chunkX;
      rec.chunkY = s.chunkY;
      rec.minX = s.minX;
      rec.minY = s.minY;
      rec.maxX = s.maxX;
      rec.maxY = s.maxY;
    }

    if (allowPromote !== false && (full || this.tool !== 'draw')) this._promoteDirty(snap);

    const keep = this._keepIslands;
    keep.length = 0;
    const live = this.staticIslands;
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      if (this._recInShards(rec, snap)) continue;
      if (full) this._despawnIndex(rec.index);
      else keep.push(rec);
    }

    for (let s = 0; s < snap.length; s++) this._remeshShard(snap[s], keep);
    this.staticIslands = keep;
    this._keepIslands = live;
  }

  _unionPaintDirty() {
    const d = WorldGrid.peekDirty(1);
    if (!d) return;
    let box = this._paintBox;
    if (!box) box = this._paintBox = { minX: d.minX, minY: d.minY, maxX: d.maxX, maxY: d.maxY };
    if (d.minX < box.minX) box.minX = d.minX;
    if (d.minY < box.minY) box.minY = d.minY;
    if (d.maxX > box.maxX) box.maxX = d.maxX;
    if (d.maxY > box.maxY) box.maxY = d.maxY;
  }

  _settlePaint() {
    const box = this._paintBox;
    this._paintBox = null;
    if (!box || box.maxX < box.minX) return;
    WorldGrid.markDirty(box.minX, box.minY);
    WorldGrid.markDirty(box.maxX, box.maxY);
    this.rebuild(false, false);
  }

  _recInShards(rec, shards) {
    for (let i = 0; i < shards.length; i++) {
      if (rec.chunkX === shards[i].chunkX && rec.chunkY === shards[i].chunkY) return true;
    }
    return false;
  }

  _addShardsOverlapping(box, snap) {
    const extra = WorldGrid.chunksOverlapping(box);
    const n = extra.length;
    for (let i = 0; i < n; i++) {
      const s = extra[i];
      let found = false;
      for (let j = 0; j < snap.length; j++) {
        if (snap[j].chunkX === s.chunkX && snap[j].chunkY === s.chunkY) {
          found = true;
          break;
        }
      }
      if (found) continue;
      const bag = this._extraShardBag;
      let rec = bag[snap.length];
      if (!rec) rec = bag[snap.length] = {};
      rec.chunkX = s.chunkX;
      rec.chunkY = s.chunkY;
      rec.minX = s.minX;
      rec.minY = s.minY;
      rec.maxX = s.maxX;
      rec.maxY = s.maxY;
      snap.push(rec);
    }
  }

  _promoteDirty(snap) {
    const seen = this._crumbSeen;
    for (const k in seen) delete seen[k];
    const seeds = this._crumbSeeds;
    seeds.length = 0;
    const cols = WorldGrid.cols;
    const n0 = snap.length;
    for (let s = 0; s < n0; s++) {
      const shard = snap[s];
      const clipped = WorldGrid.extractIslands(shard, { clip: true });
      for (let i = 0; i < clipped.length; i++) {
        const island = clipped[i];
        if (!island.nodeCount) continue;
        if (WorldGrid.isGrounded(island)) continue;
        if (!WorldGrid.touchesChunkEdge(island, shard)) {
          const key = WorldGrid.islandKey(island);
          if (key < 0 || seen[key]) continue;
          seen[key] = 1;
          const nodes = WorldGrid.copyIslandNodes(island);
          const box = WorldGrid.packedBox(nodes);
          this._spawnLooseIsland(nodes, island.material);
          this._addShardsOverlapping(box, snap);
          continue;
        }
        const packed = island.nodeIdx[island.nodeStart];
        seeds.push(packed % cols, (packed / cols) | 0);
      }
    }
    for (let i = 0; i < seeds.length; i += 2) {
      const real = WorldGrid.extractIslandAt(seeds[i], seeds[i + 1], {
        mesh: false,
        stopIfGrounded: true,
      });
      if (!real || real.grounded) continue;
      const key = WorldGrid.islandKey(real);
      if (key < 0 || seen[key]) continue;
      seen[key] = 1;
      if (WorldGrid.isGrounded(real)) continue;
      const nodes = WorldGrid.copyIslandNodes(real);
      const box = WorldGrid.packedBox(nodes);
      this._spawnLooseIsland(nodes, real.material);
      this._addShardsOverlapping(box, snap);
    }
  }

  _spawnLooseIsland(nodes, material) {
    const islands = WorldGrid.meshNodes(nodes);
    const tint = MAT_TINT[material] || 0x88aa66;
    if (!islands.length) {
      WorldGrid.clearPackedNodes(nodes);
      return;
    }
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      if ((island.nodeCount || 0) < DROP_MIN_CELLS) continue;
      if (this._spawnLooseMesh(island, tint)) continue;
      this._spawnLooseSplit({
        minX: island.minX,
        minY: island.minY,
        maxX: island.maxX,
        maxY: island.maxY,
      }, tint, 0);
    }
    WorldGrid.clearPackedNodes(nodes);
  }

  _spawnLooseMesh(island, tint) {
    const built = WorldGrid.buildContourFixtures(island, WorldGrid.tuneGet(TUNE.SIMPLIFY_TOL));
    if (!built.polys || !built.polys.length) return false;
    const cen = WorldGrid.centroidFromPolys(built.polys);
    if (!cen) return false;
    const local = WorldGrid.polysToLocal(built.polys, cen.x, cen.y);
    if (!local.length) return false;
    const spawned = TerrainIsland.spawn({
      x: cen.x,
      y: cen.y,
      isStatic: false,
      polys: local,
      tint,
      layer: 'terrain',
    });
    if (!spawned) return false;
    this.dynamicIslands.push(spawned.index);
    return true;
  }

  _spawnLooseSplit(box, tint, depth) {
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    if (depth > 10 || (w <= 1 && h <= 1)) return;
    const quads = WorldGrid.splitBoxQuads(box);
    if (quads.length <= 1) return;
    for (let q = 0; q < quads.length; q++) {
      const parts = WorldGrid.extractIslands(quads[q], { clip: true });
      for (let i = 0; i < parts.length; i++) {
        const island = parts[i];
        if ((island.nodeCount || 0) < DROP_MIN_CELLS) continue;
        if (this._spawnLooseMesh(island, tint)) continue;
        this._spawnLooseSplit({
          minX: island.minX,
          minY: island.minY,
          maxX: island.maxX,
          maxY: island.maxY,
        }, tint, depth + 1);
      }
    }
  }

  _remeshShard(shard, keep) {
    const pool = this._shardPool;
    pool.length = 0;
    const live = this.staticIslands;
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      if (rec.chunkX === shard.chunkX && rec.chunkY === shard.chunkY) pool.push(rec);
    }

    const jobs = this._shardJobs;
    jobs.length = 0;
    const islands = WorldGrid.extractIslands(shard, { clip: true });
    const failed = [];
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      const islandBox = {
        minX: island.minX,
        minY: island.minY,
        maxX: island.maxX,
        maxY: island.maxY,
      };
      const built = WorldGrid.buildContourFixtures(island, WorldGrid.tuneGet(TUNE.SIMPLIFY_TOL));
      if (!built.polys || !built.polys.length) {
        failed.push({
          minX: islandBox.minX,
          minY: islandBox.minY,
          maxX: islandBox.maxX,
          maxY: islandBox.maxY,
          areaCells: island.areaCells,
        });
        continue;
      }
      this._pushStaticJob(jobs, island, islandBox, built.polys, shard, -1);
    }

    for (let f = 0; f < failed.length; f++) {
      if (!this._tryQuadSplit(failed[f], shard, jobs, pool, keep)) {
        this._keepOverlapping(pool, keep, failed[f]);
      }
    }

    if (!jobs.length && this._shardHasSolid(shard)) {
      for (let i = 0; i < pool.length; i++) keep.push(pool[i]);
      return;
    }

    jobs.sort((a, b) => b.areaCells - a.areaCells);
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
      if (bestI >= 0) {
        const rec = pool[bestI];
        this._retargetStatic(rec, job);
        rec.minX = job.islandBox.minX;
        rec.minY = job.islandBox.minY;
        rec.maxX = job.islandBox.maxX;
        rec.maxY = job.islandBox.maxY;
        rec.chunkX = job.chunkX;
        rec.chunkY = job.chunkY;
        rec.quad = job.quad;
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
      if (!spawned) {
        this._keepOverlapping(pool, keep, job.islandBox);
        continue;
      }
      keep.push({
        index: spawned.index,
        minX: job.islandBox.minX,
        minY: job.islandBox.minY,
        maxX: job.islandBox.maxX,
        maxY: job.islandBox.maxY,
        chunkX: job.chunkX,
        chunkY: job.chunkY,
        quad: job.quad,
      });
    }

    for (let i = 0; i < pool.length; i++) this._despawnIndex(pool[i].index);
  }

  _shardHasSolid(shard) {
    const amount = WorldGrid.amount;
    if (!amount) return false;
    const cols = WorldGrid.cols;
    const x1 = shard.maxX;
    const y1 = shard.maxY;
    for (let y = shard.minY; y <= y1; y++) {
      const row = y * cols;
      for (let x = shard.minX; x <= x1; x++) {
        if (amount[row + x] >= ISO) return true;
      }
    }
    return false;
  }

  _pushStaticJob(jobs, island, islandBox, polys, shard, quad) {
    const cen = WorldGrid.centroidFromPolys(polys);
    if (!cen) return false;
    const local = WorldGrid.polysToLocal(polys, cen.x, cen.y);
    if (!local.length) return false;
    jobs.push({
      areaCells: island.areaCells,
      islandBox,
      cen,
      local,
      tint: MAT_TINT[island.material] || 0x88aa66,
      chunkX: shard.chunkX,
      chunkY: shard.chunkY,
      quad,
    });
    return true;
  }

  _tryQuadSplit(failed, shard, jobs, pool, keep, depth = 0) {
    const w = failed.maxX - failed.minX + 1;
    const h = failed.maxY - failed.minY + 1;
    if (depth > 12 || (w <= 1 && h <= 1)) return false;
    const quads = WorldGrid.splitBoxQuads(failed);
    if (quads.length <= 1) return false;
    let any = false;
    for (let q = 0; q < quads.length; q++) {
      const quad = quads[q];
      const parts = WorldGrid.extractIslands(quad, { clip: true });
      let quadHit = false;
      for (let i = 0; i < parts.length; i++) {
        const island = parts[i];
        const islandBox = {
          minX: island.minX,
          minY: island.minY,
          maxX: island.maxX,
          maxY: island.maxY,
          areaCells: island.areaCells,
        };
        const built = WorldGrid.buildContourFixtures(island, WorldGrid.tuneGet(TUNE.SIMPLIFY_TOL));
        if (built.polys && built.polys.length && this._pushStaticJob(jobs, island, islandBox, built.polys, shard, quad.quad)) {
          any = true;
          quadHit = true;
          continue;
        }
        if (this._tryQuadSplit(islandBox, shard, jobs, pool, keep, depth + 1)) {
          any = true;
          quadHit = true;
        }
      }
      if (!quadHit && parts.length) this._keepOverlapping(pool, keep, quad);
    }
    return any;
  }

  _keepOverlapping(pool, keep, islandBox) {
    let bestI = -1;
    let bestA = 0;
    for (let p = 0; p < pool.length; p++) {
      const a = aabbOverlapCells(pool[p], islandBox);
      if (a > bestA) {
        bestA = a;
        bestI = p;
      }
    }
    if (bestI < 0) return;
    keep.push(pool[bestI]);
    pool[bestI] = pool[pool.length - 1];
    pool.pop();
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
      WorldGrid.subdivideConvex(world[i], WorldGrid.tuneGet(TUNE.MIN_KEEP_AREA) * 0.35, SHATTER_MAX, shards);
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
