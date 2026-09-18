import {
  centroidFromPolys,
  clipIslandAtPoint,
  polygonArea,
  polysToLocal,
} from '../terrainMesh.js';
import WEED from '/src/index.js';

const {
  GameObject,
  RigidBody,
  Collider,
  ColliderFixture,
  MeshRenderer,
  Transform,
  Box2d,
} = WEED;

const CELL = 16;
const CLIP_RADIUS = CELL * 2;
const MIN_KEEP_AREA = CELL * CELL;
const _scratchVerts = [];
const _scratchCS = { c: 1, s: 0 };
const _scratchLocal = { x: 0, y: 0 };

export class TerrainIsland extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [RigidBody, Collider, MeshRenderer];

  setup() {
    this.collider.visualRange = 0;
    this.collider.friction = 0.5;
    this.collider.restitution = 0;
  }

  onSpawned(spawnConfig = {}) {
    this.isStatic = !!spawnConfig.isStatic;
    this.rigidBody.linearDamping = spawnConfig.isStatic ? 0 : 0.4;
    this.rigidBody.angularDamping = spawnConfig.isStatic ? 0 : 0.8;
    if (!spawnConfig.isStatic) this.rigidBody.sleepThreshold = 25;

    const polys = spawnConfig.polys;
    if (!polys || !polys.length || !this.collider.replacePolygons(polys)) {
      this.despawn();
      return;
    }

    this.meshRenderer.tint = spawnConfig.tint ?? 0x88aa66;
    this.setLayer('terrain');
    this._refreshVisualRange();
  }

  _refreshVisualRange() {
    const hw = (this.collider.width || 0) * 0.5;
    const hh = (this.collider.height || 0) * 0.5;
    this.collider.visualRange = Math.hypot(hw, hh) + 80;
  }

  /**
   * Laser hit from Ship.tick. Dynamic: circle-diff the whole island. Static: SceneBridge to the field.
   * @param {{ hitX: number, hitY: number, fixtureIndex?: number }} hit
   */
  takeHit(hit) {
    if (!hit || !this.active) return;
    const hx = hit.hitX;
    const hy = hit.hitY;
    // if (this.isStatic) {
    //   this.sendMessageToScene({ type: 'damageField', x: hx, y: hy });
    //   return;
    // }

    const idx = this.index;
    TerrainIsland.worldToLocal(idx, hx, hy, _scratchLocal);
    const lx = _scratchLocal.x;
    const ly = _scratchLocal.y;

    const fixtures = [];
    ColliderFixture.forEach(idx, (fi) => {
      TerrainIsland.readLocalFixture(fi, _scratchVerts);
      const localCopy = [];
      for (let v = 0; v < _scratchVerts.length; v++) {
        localCopy.push({ x: _scratchVerts[v].x, y: _scratchVerts[v].y });
      }
      if (localCopy.length >= 3) fixtures.push(localCopy);
    });

    const { islands } = clipIslandAtPoint(fixtures, lx, ly, CLIP_RADIUS, MIN_KEEP_AREA);
    if (!islands.length) {
      this.despawn();
      return;
    }

    let best = 0;
    let bestA = 0;
    for (let i = 0; i < islands.length; i++) {
      let a = 0;
      for (let t = 0; t < islands[i].length; t++) a += polygonArea(islands[i][t]);
      if (a > bestA) {
        bestA = a;
        best = i;
      }
    }

    const tint = MeshRenderer.tint ? MeshRenderer.tint[idx] : 0x88aa66;
    const vx0 = RigidBody.vx ? RigidBody.vx[idx] : 0;
    const vy0 = RigidBody.vy ? RigidBody.vy[idx] : 0;
    const w0 = RigidBody.angularVelocity ? RigidBody.angularVelocity[idx] : 0;
    const resting = vx0 * vx0 + vy0 * vy0 < 60 * 60 && Math.abs(w0) < 0.5;

    for (let i = 0; i < islands.length; i++) {
      if (i === best) continue;
      const world = [];
      for (let t = 0; t < islands[i].length; t++) {
        world.push(TerrainIsland.localToWorldPoly(idx, islands[i][t]));
      }
      TerrainIsland.spawnIslandFromWorldPolys(world, tint, vx0, vy0);
    }

    if (!this.collider.replacePolygons(islands[best])) {
      this.despawn();
      return;
    }
    if (MeshRenderer.renderDirty) MeshRenderer.renderDirty[idx] = 1;
    this._refreshVisualRange();
    if (resting) {
      this.setVelocity(0, 0);
      this.angularVelocity = 0;
    }
    // Box2d.explode({
    //   x: hx,
    //   y: hy,
    //   radius: Math.max(CELL * 4, 48),
    //   impulsePerLength: EXPLODE_IMPULSE,
    // });
  }

  static spawnIslandFromWorldPolys(worldPolys, tint, vx, vy) {
    if (!worldPolys || !worldPolys.length) return;
    const cen = centroidFromPolys(worldPolys);
    if (!cen) return;
    const local = polysToLocal(worldPolys, cen.x, cen.y);
    if (!local.length) return;
    const spawned = TerrainIsland.spawn({
      x: cen.x,
      y: cen.y,
      isStatic: false,
      polys: local,
      tint,
    });
    if (!spawned) return;
    const si = spawned.index;
    if (RigidBody.vx) RigidBody.vx[si] = vx || 0;
    if (RigidBody.vy) RigidBody.vy[si] = vy || 0;
  }

  static spawnShardsFromWorld(worldPolys, tint, vx, vy) {
    if (!worldPolys) return;
    for (let i = 0; i < worldPolys.length; i++) {
      const poly = worldPolys[i];
      if (polygonArea(poly) < MIN_KEEP_AREA) continue;
      const cen = centroidFromPolys([poly]);
      if (!cen) continue;
      const local = polysToLocal([poly], cen.x, cen.y);
      if (!local.length) continue;
      const spawned = TerrainIsland.spawn({
        x: cen.x,
        y: cen.y,
        isStatic: false,
        polys: local,
        tint,
      });
      if (!spawned) continue;
      const si = spawned.index;
      if (RigidBody.vx) RigidBody.vx[si] = vx || 0;
      if (RigidBody.vy) RigidBody.vy[si] = vy || 0;
    }
  }

  static bodyCS(idx) {
    let c = Transform.rotC ? Transform.rotC[idx] : 1;
    let s = Transform.rotS ? Transform.rotS[idx] : 0;
    if (c * c + s * s < 0.25) {
      c = 1;
      s = 0;
    }
    _scratchCS.c = c;
    _scratchCS.s = s;
    return _scratchCS;
  }

  static worldToLocal(idx, wx, wy, out) {
    const dest = out || _scratchLocal;
    const cs = TerrainIsland.bodyCS(idx);
    const dx = wx - Transform.x[idx];
    const dy = wy - Transform.y[idx];
    dest.x = cs.c * dx + cs.s * dy;
    dest.y = -cs.s * dx + cs.c * dy;
    return dest;
  }

  static worldPolyToLocal(idx, world) {
    const cs = TerrainIsland.bodyCS(idx);
    const tx = Transform.x[idx];
    const ty = Transform.y[idx];
    const out = [];
    for (let i = 0; i < world.length; i++) {
      const dx = world[i].x - tx;
      const dy = world[i].y - ty;
      out.push({
        x: cs.c * dx + cs.s * dy,
        y: -cs.s * dx + cs.c * dy,
      });
    }
    return out;
  }

  static readLocalFixture(fi, dest) {
    dest.length = 0;
    const n = ColliderFixture.vertCount[fi] | 0;
    const base = ColliderFixture.vertBase(fi);
    for (let v = 0; v < n; v++) {
      dest.push({ x: ColliderFixture.vertexX[base + v], y: ColliderFixture.vertexY[base + v] });
    }
    return dest;
  }

  static localToWorldPoly(idx, local) {
    const tx = Transform.x[idx];
    const ty = Transform.y[idx];
    const cs = TerrainIsland.bodyCS(idx);
    const out = [];
    for (let i = 0; i < local.length; i++) {
      const lx = local[i].x;
      const ly = local[i].y;
      out.push({
        x: tx + cs.c * lx - cs.s * ly,
        y: ty + cs.s * lx + cs.c * ly,
      });
    }
    return out;
  }

  tick() { }
}
