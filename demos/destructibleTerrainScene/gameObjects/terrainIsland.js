import {
  centroidFromPolys,
  pointInConvex,
  polysToLocal,
  splitConvexAtPoint,
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
const SHATTER_MAX = 24;
const SHATTER_MIN_AREA = CELL * CELL * 0.35;
const EXPLODE_IMPULSE = 1500;
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
    this.collider.restitution = 0.05;
  }

  onSpawned(spawnConfig = {}) {
    this.isStatic = !!spawnConfig.isStatic;
    this.rigidBody.linearDamping = spawnConfig.isStatic ? 0 : 0.15;
    this.rigidBody.angularDamping = spawnConfig.isStatic ? 0 : 0.2;

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
   * Laser hit from Ship.tick. Dynamic: split the fixture (SoA). Static: SceneBridge to the field.
   * @param {{ hitX: number, hitY: number, fixtureIndex?: number }} hit
   */
  takeHit(hit) {
    if (!hit || !this.active) return;
    const hx = hit.hitX;
    const hy = hit.hitY;
    if (this.isStatic) {
      this.sendMessageToScene({ type: 'damageField', x: hx, y: hy });
      return;
    }

    const idx = this.index;
    const fiHit = hit.fixtureIndex >= 0 ? hit.fixtureIndex | 0 : -1;
    TerrainIsland.worldToLocal(idx, hx, hy, _scratchLocal);
    const lx = _scratchLocal.x;
    const ly = _scratchLocal.y;

    const keep = [];
    const drop = [];
    let hitLocal = null;

    ColliderFixture.forEach(idx, (fi) => {
      TerrainIsland.readLocalFixture(fi, _scratchVerts);
      const localCopy = [];
      for (let v = 0; v < _scratchVerts.length; v++) {
        localCopy.push({ x: _scratchVerts[v].x, y: _scratchVerts[v].y });
      }
      const named = fiHit >= 0 && fi === fiHit;
      const inside = !hitLocal && pointInConvex(localCopy, lx, ly);
      if (!hitLocal && (named || inside)) {
        hitLocal = localCopy;
        return;
      }
      keep.push(localCopy);
    });

    if (hitLocal) {
      const hitWorld = TerrainIsland.localToWorldPoly(idx, hitLocal);
      const split = splitConvexAtPoint(hitWorld, hx, hy, SHATTER_MIN_AREA, SHATTER_MAX);
      for (let i = 0; i < split.keep.length; i++) {
        keep.push(TerrainIsland.worldPolyToLocal(idx, split.keep[i]));
      }
      for (let i = 0; i < split.drop.length; i++) drop.push(split.drop[i]);
    }

    const tint = MeshRenderer.tint ? MeshRenderer.tint[idx] : 0x88aa66;
    const vx = RigidBody.vx ? RigidBody.vx[idx] : 0;
    const vy = RigidBody.vy ? RigidBody.vy[idx] : 0;

    if (!keep.length) {
      this.despawn();
    } else if (!this.collider.replacePolygons(keep)) {
      this.despawn();
    } else {
      this._refreshVisualRange();
    }
    TerrainIsland.spawnShardsFromWorld(drop, tint, vx, vy);
    Box2d.explode({
      x: hx,
      y: hy,
      radius: Math.max(CELL * 4, 48),
      impulsePerLength: EXPLODE_IMPULSE,
    });
  }

  static spawnShardsFromWorld(worldPolys, tint, vx, vy) {
    if (!worldPolys) return;
    for (let i = 0; i < worldPolys.length; i++) {
      const poly = worldPolys[i];
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

  tick() {}
}
