import {
  WorldGrid,
  CELL,
  TUNE,
  BLUR_R,
  DROP_MIN_CELLS,
  SHOT_KIND_GRID,
  SHOT_KIND_BODY,
} from '../worldGrid.js';
import { TerrainIsland } from './terrainIsland.js';
import { PlanetWalker } from './planetWalker.js';
import { PlanetLamp } from './planetLamp.js';
import { PlanetPull } from './planetPull.js';
import { CX, CY, RADIUS, CELL as SURFACE_CELL } from '../planetGravity.js';
import WEED from '/src/index.js';

const {
  GameObject,
  Keyboard,
  Mouse,
  Camera,
  Transform,
  RigidBody,
  Collider,
  ColliderFixture,
  MeshRenderer,
  Box2d,
} = WEED;

const SHATTER_MAX = 24;
const EXPLODE_IMPULSE = 1500;
const ROCK_TINT = 0x88aa66;
const _scratchVerts = [];
const _scratchLocal = { x: 0, y: 0 };

function Islands() {
  return WorldGridManager.islandClass || TerrainIsland;
}

function chunkHitsDisk(rec) {
  const disk = WorldGrid.disk;
  if (!disk) return false;
  const r = (disk.radius | 0) + 1;
  const ox = disk.cx | 0;
  const oy = disk.cy | 0;
  let x = ox;
  let y = oy;
  if (x < rec.minX) x = rec.minX;
  else if (x > rec.maxX) x = rec.maxX;
  if (y < rec.minY) y = rec.minY;
  else if (y > rec.maxY) y = rec.maxY;
  const dx = x - ox;
  const dy = y - oy;
  return dx * dx + dy * dy <= r * r;
}

export class WorldGridManager extends GameObject {
  static serializable = false;
  static instances = [];
  static components = [];
  static forceProcessOnLogicWorker = 1;
  static islandClass = TerrainIsland;

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
    this._viewBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this._viewPt = { x: 0, y: 0 };
    this._meshed = null;
    this._chunkCols = 0;
    this._actorsSpawned = false;
    const disk = WorldGrid.disk;
    if (disk) {
      WorldGrid.cols = disk.cols;
      WorldGrid.rows = disk.rows;
      WorldGrid.cellSize = disk.cell || CELL;
      WorldGrid.anchorX = disk.cx;
      WorldGrid.anchorY = disk.cy;
      WorldGrid.bedrock = disk.bedrock || 4;
      WorldGrid.seedDisk(disk.cx, disk.cy, disk.radius);
      WorldGrid.consumeDirty(0);
      const ch = WorldGrid.chunkCells();
      this._chunkCols = Math.ceil(WorldGrid.cols / ch);
      const n = this._chunkCols * Math.ceil(WorldGrid.rows / ch);
      this._meshed = new Uint8Array(n);
    } else {
      this.rebuild(true);
    }
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
          this.tool === 'erase',
        );
      }
    }
    if (!Mouse.isDebugToolActive && WorldGrid.hasDirty()) {
      if (this.tool === 'draw') this._unionPaintDirty();
      this.rebuild(false);
    }

    this._streamVisibleChunk();
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
      const island = Islands().get(hit.entityIndex);
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
      box.maxX = WorldGrid.cols - 1;
      box.maxY = WorldGrid.rows - 1;
      dirty = box;
    } else {
      dirty = WorldGrid.consumeDirty(BLUR_R);
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

    this._commitSnap(snap, full);
    this._markSnapMeshed(snap);
  }

  _commitSnap(snap, despawnOutside) {
    const keep = this._keepIslands;
    keep.length = 0;
    const live = this.staticIslands;
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      if (this._recInShards(rec, snap)) continue;
      if (despawnOutside) this._despawnIndex(rec.index);
      else keep.push(rec);
    }

    for (let s = 0; s < snap.length; s++) this._remeshShard(snap[s], keep);
    this.staticIslands = keep;
    this._keepIslands = live;
  }

  _markSnapMeshed(snap) {
    const meshed = this._meshed;
    if (!meshed) return;
    const nx = this._chunkCols;
    for (let i = 0; i < snap.length; i++) {
      const s = snap[i];
      const idx = s.chunkY * nx + s.chunkX;
      if (idx >= 0 && idx < meshed.length) meshed[idx] = 1;
    }
  }

  _clampCellBox(box) {
    const cols = WorldGrid.cols;
    const rows = WorldGrid.rows;
    if (box.minX < 0) box.minX = 0;
    if (box.minY < 0) box.minY = 0;
    if (box.maxX >= cols) box.maxX = cols - 1;
    if (box.maxY >= rows) box.maxY = rows - 1;
    if (box.maxX < box.minX) box.maxX = box.minX;
    if (box.maxY < box.minY) box.maxY = box.minY;
  }

  _viewCellBox() {
    const cs = WorldGrid.cellSize || CELL;
    const pad = WorldGrid.chunkCells();
    const box = this._viewBox;
    const cw = Camera.canvasWidth;
    const ch = Camera.canvasHeight;
    if (!(cw > 0 && ch > 0)) {
      const disk = WorldGrid.disk;
      const x = disk ? disk.cx : 0;
      const y = disk ? disk.cy - disk.radius : 0;
      box.minX = x - pad;
      box.minY = y - pad;
      box.maxX = x + pad;
      box.maxY = y + pad;
      this._clampCellBox(box);
      return box;
    }
    const margin = pad * cs;
    const p = this._viewPt;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      Camera.screenToWorld(i & 1 ? cw : 0, i & 2 ? ch : 0, p);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    box.minX = Math.floor((minX - margin) / cs);
    box.minY = Math.floor((minY - margin) / cs);
    box.maxX = Math.floor((maxX + margin) / cs);
    box.maxY = Math.floor((maxY + margin) / cs);
    this._clampCellBox(box);
    return box;
  }

  _streamVisibleChunk() {
    if (!this._meshed) return;
    const box = this._viewCellBox();
    const src = WorldGrid.chunksOverlapping(box);
    const cs = WorldGrid.cellSize || CELL;
    let viewCx;
    let viewCy;
    if (Camera.canvasWidth > 0 && Camera.canvasHeight > 0) {
      viewCx = Camera.centerX / cs;
      viewCy = Camera.centerY / cs;
    } else {
      const disk = WorldGrid.disk;
      viewCx = disk ? disk.cx : 0;
      viewCy = disk ? disk.cy - disk.radius : 0;
    }
    const nx = this._chunkCols;
    const meshed = this._meshed;
    let bestX = -1;
    let bestY = -1;
    let bestD = Infinity;
    for (let i = 0; i < src.length; i++) {
      const s = src[i];
      const idx = s.chunkY * nx + s.chunkX;
      if (idx < 0 || idx >= meshed.length || meshed[idx]) continue;
      if (!chunkHitsDisk(s)) {
        meshed[idx] = 1;
        continue;
      }
      const dx = (s.minX + s.maxX) * 0.5 - viewCx;
      const dy = (s.minY + s.maxY) * 0.5 - viewCy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestX = s.chunkX;
        bestY = s.chunkY;
      }
    }
    if (bestX >= 0) {
      this._meshChunk(bestX, bestY);
      return;
    }
    if (this._actorsSpawned) return;
    const foot = this._spawnChunk();
    if (!this._isMeshed(foot.cx, foot.cy)) {
      this._meshChunk(foot.cx, foot.cy);
      return;
    }
    this._spawnActors();
  }

  _isMeshed(cx, cy) {
    const meshed = this._meshed;
    if (!meshed) return false;
    const idx = cy * this._chunkCols + cx;
    return idx >= 0 && idx < meshed.length && meshed[idx] === 1;
  }

  _spawnChunk() {
    const ch = WorldGrid.chunkCells();
    const cs = WorldGrid.cellSize || SURFACE_CELL;
    let x = Math.floor(CX / cs);
    let y = Math.floor((CY - RADIUS * SURFACE_CELL) / cs);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    let cx = (x / ch) | 0;
    let cy = (y / ch) | 0;
    const maxCx = this._chunkCols - 1;
    const maxCy = Math.ceil(WorldGrid.rows / ch) - 1;
    if (cx > maxCx) cx = maxCx;
    if (cy > maxCy) cy = maxCy;
    return { cx, cy };
  }

  _meshChunk(cx, cy) {
    const ch = WorldGrid.chunkCells();
    const snap = this._shardSnap;
    let rec = snap[0];
    if (!rec) rec = snap[0] = {};
    rec.chunkX = cx;
    rec.chunkY = cy;
    rec.minX = cx * ch;
    rec.minY = cy * ch;
    rec.maxX = Math.min(WorldGrid.cols - 1, rec.minX + ch - 1);
    rec.maxY = Math.min(WorldGrid.rows - 1, rec.minY + ch - 1);
    snap.length = 1;
    this._commitSnap(snap, false);
    this._markSnapMeshed(snap);
  }

  _spawnActors() {
    if (this._actorsSpawned) return;
    this._actorsSpawned = true;
    const surface = CY - RADIUS * SURFACE_CELL;
    PlanetWalker.spawn({
      x: CX,
      y: surface - 40,
      forceProcessOnLogicWorker: 0,
    });
    PlanetLamp.spawn({
      x: CX + 90,
      y: surface - 30,
      forceProcessOnLogicWorker: 0,
    });
    PlanetPull.spawn({ forceProcessOnLogicWorker: 0 });
  }

  _unionPaintDirty() {
    const d = WorldGrid.peekDirty(BLUR_R);
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
    const extra = WorldGrid.chunksOverlapping({
      minX: box.minX - BLUR_R,
      minY: box.minY - BLUR_R,
      maxX: box.maxX + BLUR_R,
      maxY: box.maxY + BLUR_R,
    });
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
          this._spawnLooseIsland(nodes);
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
      this._spawnLooseIsland(nodes);
      this._addShardsOverlapping(box, snap);
    }
  }

  _spawnLooseIsland(nodes) {
    const islands = WorldGrid.meshNodes(nodes);
    const tint = ROCK_TINT;
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
    const spawned = Islands().spawn({
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

    for (let f = 0; f < failed.length; f++) this._tryQuadSplit(failed[f], shard, jobs, pool, keep);

    jobs.sort((a, b) => b.areaCells - a.areaCells);
    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j];
      // New body, then the pool despawn below destroys the previous Box2D body.
      // Retarget only rewrote the fixture list the debug view reads; the old
      // shapes stayed in the world and held up every cut after the first.
      const spawned = Islands().spawn({
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
      tint: ROCK_TINT,
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
          continue;
        }
        if (this._tryQuadSplit(islandBox, shard, jobs, pool, keep, depth + 1)) any = true;
      }
    }
    return any;
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
    Islands().spawnShardsFromWorld(shards, tint, vx, vy);
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
    const Island = Islands();
    const start = Island.startIndex | 0;
    const end = Island.endIndex | 0;
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
    const Island = Islands();
    const start = Island.startIndex | 0;
    const inst = Island.instances[idx - start];
    if (inst && inst.active) inst.despawn();
  }

  _cullDynamics() {
    this._eachIsland((idx) => {
      if (RigidBody.static[idx]) return;
      if (Transform.y[idx] > WorldGrid.rows * WorldGrid.cellSize + 240) this._despawnIndex(idx);
    });
  }
}
