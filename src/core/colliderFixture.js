// ColliderFixture.js — extra convex shapes on one entity's Box2D body.
// SharedAtomicPool + intrusive list per entity (same idea as Joint.head).
// Gameplay: Collider.replacePolygons / clearFixtures. Do not call WASM addShape.

import { SharedAtomicPool } from './sharedAtomicPool.js';
import { Collider } from '../components/collider.js';
import { RigidBody } from '../components/rigidBody.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';

const INV = 0xffff;
const V = MAX_POLYGON_VERTICES;

export class ColliderFixture extends SharedAtomicPool {
  static INVALID_INDEX = INV;
  static poolName = 'ColliderFixture';

  static active = null;
  static entity = null;
  static next = null;
  static vertCount = null;
  static vertexX = null;
  static vertexY = null;
  static normalX = null;
  static normalY = null;
  static head = null;
  static revision = null;
  static _entityCount = 0;
  static _acquireScratch = null;

  static getBufferSize(maxFixtures, entityCount = 0) {
    let offset = 0;
    const n = maxFixtures | 0;
    const e = entityCount | 0;
    const align4 = (o) => Math.ceil(o / 4) * 4;
    offset = align4(offset + n); // active
    offset += n * 2; // entity
    offset += n * 2; // next
    offset = align4(offset + n); // vertCount
    offset += n * V * 4; // vertexX
    offset += n * V * 4; // vertexY
    offset += n * V * 4; // normalX
    offset += n * V * 4; // normalY
    offset = align4(offset);
    offset += e * 2; // head
    offset = align4(offset);
    offset += 4; // revision
    return offset;
  }

  static initializeArrays(buffer, maxFixtures, entityCount = 0) {
    let offset = 0;
    const n = maxFixtures | 0;
    const align4 = (o) => Math.ceil(o / 4) * 4;

    this.active = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);

    this.entity = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    this.next = new Uint16Array(buffer, offset, n);
    offset += n * 2;

    this.vertCount = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);

    this.vertexX = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    this.vertexY = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    this.normalX = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    this.normalY = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;

    offset = align4(offset);
    this._entityCount = entityCount | 0;
    this.head =
      this._entityCount > 0 ? new Uint16Array(buffer, offset, this._entityCount) : null;
    offset += this._entityCount * 2;
    offset = align4(offset);
    this.revision = new Uint32Array(buffer, offset, 1);

    this.active.fill(0);
    this.entity.fill(0);
    this.next.fill(INV);
    this.vertCount.fill(0);
    if (this.head) this.head.fill(INV);
    this.revision[0] = 0;
    this._acquireScratch = new Uint16Array(Math.max(16, Math.min(n, 4096)));
  }

  static reset() {
    super.reset();
    this.active = null;
    this.entity = null;
    this.next = null;
    this.vertCount = null;
    this.vertexX = null;
    this.vertexY = null;
    this.normalX = null;
    this.normalY = null;
    this.head = null;
    this.revision = null;
    this._entityCount = 0;
    this._acquireScratch = null;
  }

  static bumpRevision() {
    if (this.revision) this.revision[0] = (this.revision[0] + 1) >>> 0;
  }

  static vertBase(idx) {
    return idx * V;
  }

  static headOf(entityIdx) {
    if (!this.head || entityIdx < 0 || entityIdx >= this._entityCount) return INV;
    return this.head[entityIdx];
  }

  /**
   * @param {number} entityIdx
   * @param {(idx: number) => void} fn
   */
  static forEach(entityIdx, fn) {
    if (!this.head || !this.active) return;
    let cur = this.headOf(entityIdx);
    let guard = 0;
    const max = this.maxCount | 0;
    while (cur !== INV && guard++ < max) {
      if (this.active[cur]) fn(cur);
      cur = this.next[cur];
    }
  }

  static areaOf(idx) {
    const count = this.vertCount[idx] | 0;
    if (count < 3) return 0;
    const base = this.vertBase(idx);
    const vx = this.vertexX;
    const vy = this.vertexY;
    let twice = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      twice += vx[base + i] * vy[base + j] - vx[base + j] * vy[base + i];
    }
    return twice * 0.5;
  }

  static areaSum(entityIdx) {
    let sum = 0;
    this.forEach(entityIdx, (idx) => {
      const a = this.areaOf(idx);
      if (a > 0) sum += a;
    });
    return sum;
  }

  /** Unit-density inertia about body origin (0,0), then scaled by mass/area. */
  static inertiaAboutOrigin(entityIdx, mass) {
    const area = this.areaSum(entityIdx);
    if (!(area > 1e-12) || !(mass > 0)) return 0;
    let I = 0;
    this.forEach(entityIdx, (idx) => {
      const count = this.vertCount[idx] | 0;
      if (count < 3) return;
      const base = this.vertBase(idx);
      const vx = this.vertexX;
      const vy = this.vertexY;
      for (let i = 0; i < count; i++) {
        const j = i + 1 < count ? i + 1 : 0;
        const ax = vx[base + i];
        const ay = vy[base + i];
        const bx = vx[base + j];
        const by = vy[base + j];
        const cross = ax * by - ay * bx;
        I += cross * (ax * ax + ay * ay + ax * bx + ay * by + bx * bx + by * by);
      }
    });
    const unitI = I / 12;
    return (mass / area) * unitI;
  }

  static _freeFixtureChain(headIdx) {
    if (!this.active) return 0;
    let cur = headIdx;
    let n = 0;
    const max = this.maxCount | 0;
    while (cur !== INV && n < max) {
      const nxt = this.next[cur];
      this.active[cur] = 0;
      this.next[cur] = INV;
      this.entity[cur] = 0;
      this.vertCount[cur] = 0;
      this.returnToPool(cur);
      cur = nxt;
      n++;
    }
    if (n) this.bumpRevision();
    return n;
  }

  static removeAllForEntity(entityIdx) {
    if (!this.head || !this.active || entityIdx < 0 || entityIdx >= this._entityCount) {
      if (Collider.fixtureCount) Collider.fixtureCount[entityIdx] = 0;
      return;
    }
    const old = this.head[entityIdx];
    this.head[entityIdx] = INV;
    if (Collider.fixtureCount) Collider.fixtureCount[entityIdx] = 0;
    this._freeFixtureChain(old);
  }

  /**
   * Parse one poly to flat verts. Returns null if invalid.
   * @param {ArrayLike<{x:number,y:number}|number>} poly
   * @returns {number[]|null}
   */
  static _flattenPoly(poly) {
    const flat = [];
    if (!poly || !poly.length) return null;
    if (typeof poly[0] === 'number') {
      for (let i = 0; i + 1 < poly.length; i += 2) flat.push(poly[i], poly[i + 1]);
    } else {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        flat.push(p.x, p.y);
      }
    }
    const count = (flat.length / 2) | 0;
    if (count < 3 || count > V) return null;
    let twice = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      twice += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
    }
    if (!(twice > 1e-8)) return null;
    return flat;
  }

  static _writePoly(idx, flat) {
    const count = (flat.length / 2) | 0;
    const base = this.vertBase(idx);
    const vx = this.vertexX;
    const vy = this.vertexY;
    const nx = this.normalX;
    const ny = this.normalY;
    for (let i = 0; i < count; i++) {
      vx[base + i] = flat[i * 2];
      vy[base + i] = flat[i * 2 + 1];
    }
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      const ex = vx[base + j] - vx[base + i];
      const ey = vy[base + j] - vy[base + i];
      let nnx = ey;
      let nny = -ex;
      const len = Math.sqrt(nnx * nnx + nny * nny);
      if (!(len > 1e-12)) return false;
      const inv = 1 / len;
      nx[base + i] = nnx * inv;
      ny[base + i] = nny * inv;
    }
    this.vertCount[idx] = count;
    return true;
  }

  /**
   * Replace all extra fixtures with convex local CCW polygons (3..8 verts).
   * @param {number} entityIdx
   * @param {Array<ArrayLike<{x:number,y:number}|number>>} polys
   * @returns {boolean}
   */
  static replaceForEntity(entityIdx, polys) {
    if (!this.initialized || !this.head || entityIdx < 0 || entityIdx >= this._entityCount) {
      return false;
    }
    if (!Array.isArray(polys) || !polys.length) {
      this.removeAllForEntity(entityIdx);
      Collider.polyCount[entityIdx] = 0;
      Collider.shapeType[entityIdx] = ShapeType.Polygon;
      RigidBody.syncMassFromCollider(entityIdx);
      markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
      return true;
    }

    const flats = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let p = 0; p < polys.length; p++) {
      const flat = this._flattenPoly(polys[p]);
      if (!flat) return false;
      flats.push(flat);
      const count = (flat.length / 2) | 0;
      for (let i = 0; i < count; i++) {
        const x = flat[i * 2];
        const y = flat[i * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const n = flats.length;
    let scratch = this._acquireScratch;
    if (!scratch || scratch.length < n) {
      scratch = new Uint16Array(n);
      this._acquireScratch = scratch;
    }
    const got = this.acquireIndices(n, scratch, 0);
    if (got < n) {
      for (let i = 0; i < got; i++) this.returnToPool(scratch[i]);
      return false;
    }

    for (let i = 0; i < n; i++) {
      const idx = scratch[i];
      if (!this._writePoly(idx, flats[i])) {
        for (let k = 0; k < n; k++) {
          this.active[scratch[k]] = 0;
          this.next[scratch[k]] = INV;
          this.entity[scratch[k]] = 0;
          this.vertCount[scratch[k]] = 0;
          this.returnToPool(scratch[k]);
        }
        return false;
      }
      this.entity[idx] = entityIdx;
      this.active[idx] = 1;
      this.next[idx] = i + 1 < n ? scratch[i + 1] : INV;
    }

    const oldHead = this.head[entityIdx];
    this.head[entityIdx] = scratch[0];

    Collider.fixtureCount[entityIdx] = n;
    Collider.polyCount[entityIdx] = 0;
    Collider.shapeType[entityIdx] = ShapeType.Polygon;
    Collider.width[entityIdx] = maxX - minX;
    Collider.height[entityIdx] = maxY - minY;
    Collider.polyCentroidX[entityIdx] = (minX + maxX) * 0.5;
    Collider.polyCentroidY[entityIdx] = (minY + maxY) * 0.5;
    this._freeFixtureChain(oldHead);
    this.bumpRevision();
    RigidBody.syncMassFromCollider(entityIdx);
    markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
    return true;
  }
}
