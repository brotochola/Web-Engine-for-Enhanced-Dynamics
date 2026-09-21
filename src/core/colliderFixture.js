// ColliderFixture — extra convex shapes on one entity's Box2D body.
// SharedAtomicPool + intrusive list per entity (same idea as Joint.head).
// Gameplay: Collider.replacePolygons / clearFixtures. Do not call WASM addShape.
// Pool size is scene physics.maxFixturePoolSize (global slots, not per body).

import { SharedAtomicPool } from './sharedAtomicPool.js';
import { EntityIdArray, entityIdBytes } from '../util/entityIdWidth.js';
import { Collider } from '../components/collider.js';
import { RigidBody } from '../components/rigidBody.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';
import { debugWorkerLog } from '../util/debugLog.js';

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
  /** Grown when replacePolygons packs a {x,y} graph into replaceForEntityFlat. */
  static _polygonUnpackScratch = null;
  static _polygonCountScratch = null;
  /** Reused; success path does not allocate. code: cw-or-degenerate | vert-count | pool-exhausted | not-initialized */
  static lastReplaceError = { code: '', entityIndex: -1, polyIndex: -1 };

  static _setReplaceError(code, entityIndex, polyIndex) {
    const err = this.lastReplaceError;
    err.code = code;
    err.entityIndex = entityIndex | 0;
    err.polyIndex = polyIndex | 0;
    debugWorkerLog(
      `Collider.replacePolygons failed entity=${err.entityIndex} poly=${err.polyIndex} reason=${err.code}`,
    );
  }

  static getBufferSize(maxFixtures, entityCount = 0) {
    let offset = 0;
    const n = maxFixtures | 0;
    const e = entityCount | 0;
    const align4 = (o) => Math.ceil(o / 4) * 4;
    offset = align4(offset + n); // active
    offset += n * entityIdBytes(); // entity
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

    this.entity = new (EntityIdArray())(buffer, offset, n);
    offset += n * entityIdBytes();
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
    this._polygonUnpackScratch = null;
    this._polygonCountScratch = null;
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
   * Gameplay walk. Spatial / ray / point queries inline head/next instead
   * (they cannot afford the visitor call). Return false from fn to stop.
   * @param {number} entityIdx
   * @param {(idx: number) => boolean|void} fn
   */
  static forEach(entityIdx, fn) {
    if (!this.head || !this.active) return;
    let cur = this.headOf(entityIdx);
    let guard = 0;
    const max = this.maxCount | 0;
    while (cur !== INV && guard++ < max) {
      if (this.active[cur] && fn(cur) === false) return;
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

  /**
   * Compound I about body origin (0,0), not polygon centroid. One walk for area and I.
   * Then scaled by mass/area.
   */
  static inertiaAboutOrigin(entityIdx, mass) {
    if (!(mass > 0) || !this.head || !this.active) return 0;
    let areaTwice = 0;
    let I = 0;
    let cur = this.headOf(entityIdx);
    let guard = 0;
    const max = this.maxCount | 0;
    const vx = this.vertexX;
    const vy = this.vertexY;
    while (cur !== INV && guard++ < max) {
      if (this.active[cur]) {
        const count = this.vertCount[cur] | 0;
        if (count >= 3) {
          const base = this.vertBase(cur);
          for (let i = 0; i < count; i++) {
            const j = i + 1 < count ? i + 1 : 0;
            const ax = vx[base + i];
            const ay = vy[base + i];
            const bx = vx[base + j];
            const by = vy[base + j];
            const cross = ax * by - ay * bx;
            areaTwice += cross;
            I += cross * (ax * ax + ay * ay + ax * bx + ay * by + bx * bx + by * by);
          }
        }
      }
      cur = this.next[cur];
    }
    const area = areaTwice * 0.5;
    if (!(area > 1e-12)) return 0;
    return (mass / area) * (I / 12);
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

  static _areaTwiceXY(xy, offset, count) {
    let twice = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      const ix = offset + i * 2;
      const jx = offset + j * 2;
      twice += xy[ix] * xy[jx + 1] - xy[jx] * xy[ix + 1];
    }
    return twice;
  }

  static _writePolyFromXY(idx, xy, offset, count) {
    const base = this.vertBase(idx);
    const vx = this.vertexX;
    const vy = this.vertexY;
    const nx = this.normalX;
    const ny = this.normalY;
    for (let i = 0; i < count; i++) {
      vx[base + i] = xy[offset + i * 2];
      vy[base + i] = xy[offset + i * 2 + 1];
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
   * Replace extras from packed SoA. vertexXY is caller-owned (no slice).
   * vertexCounts[i] is 3..8. Same fail-closed rules as replaceForEntity.
   * @param {number} entityIdx
   * @param {Float32Array|ArrayLike<number>} vertexXY
   * @param {Uint8Array|ArrayLike<number>} vertexCounts
   * @param {number} polygonCount
   * @returns {boolean}
   */
  static replaceForEntityFlat(entityIdx, vertexXY, vertexCounts, polygonCount) {
    if (!this.initialized || !this.head || entityIdx < 0 || entityIdx >= this._entityCount) {
      this._setReplaceError('not-initialized', entityIdx, -1);
      return false;
    }
    const n = polygonCount | 0;
    if (!vertexXY || !vertexCounts || n <= 0) {
      this.removeAllForEntity(entityIdx);
      Collider.polyCount[entityIdx] = 0;
      Collider.shapeType[entityIdx] = ShapeType.Polygon;
      RigidBody.syncMassFromCollider(entityIdx);
      markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
      return true;
    }

    let needed = 0;
    for (let p = 0; p < n; p++) {
      const count = vertexCounts[p] | 0;
      if (count < 3 || count > V) {
        this._setReplaceError('vert-count', entityIdx, p);
        return false;
      }
      needed += count * 2;
    }
    if (vertexXY.length < needed) {
      this._setReplaceError('vert-count', entityIdx, 0);
      return false;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let offset = 0;
    for (let p = 0; p < n; p++) {
      const count = vertexCounts[p] | 0;
      if (!(this._areaTwiceXY(vertexXY, offset, count) > 1e-8)) {
        this._setReplaceError('cw-or-degenerate', entityIdx, p);
        return false;
      }
      for (let i = 0; i < count; i++) {
        const x = vertexXY[offset + i * 2];
        const y = vertexXY[offset + i * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      offset += count * 2;
    }

    let scratch = this._acquireScratch;
    if (!scratch || scratch.length < n) {
      scratch = new Uint16Array(n);
      this._acquireScratch = scratch;
    }
    const got = this.acquireIndices(n, scratch, 0);
    if (got < n) {
      for (let i = 0; i < got; i++) this.returnToPool(scratch[i]);
      this._setReplaceError('pool-exhausted', entityIdx, n);
      return false;
    }

    offset = 0;
    for (let i = 0; i < n; i++) {
      const idx = scratch[i];
      const count = vertexCounts[i] | 0;
      if (!this._writePolyFromXY(idx, vertexXY, offset, count)) {
        for (let k = 0; k < n; k++) {
          this.active[scratch[k]] = 0;
          this.next[scratch[k]] = INV;
          this.entity[scratch[k]] = 0;
          this.vertCount[scratch[k]] = 0;
          this.returnToPool(scratch[k]);
        }
        this._setReplaceError('cw-or-degenerate', entityIdx, i);
        return false;
      }
      this.entity[idx] = entityIdx;
      this.active[idx] = 1;
      this.next[idx] = i + 1 < n ? scratch[i + 1] : INV;
      offset += count * 2;
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

  /**
   * Replace all extra fixtures with convex local CCW polygons (3..8 verts).
   * @param {number} entityIdx
   * @param {Array<ArrayLike<{x:number,y:number}|number>>} polys
   * @returns {boolean}
   */
  static replaceForEntity(entityIdx, polys) {
    if (!this.initialized || !this.head || entityIdx < 0 || entityIdx >= this._entityCount) {
      this._setReplaceError('not-initialized', entityIdx, -1);
      return false;
    }
    if (!Array.isArray(polys) || !polys.length) {
      return this.replaceForEntityFlat(entityIdx, null, null, 0);
    }

    const n = polys.length;
    if (!this._polygonCountScratch || this._polygonCountScratch.length < n) {
      this._polygonCountScratch = new Uint8Array(n);
    }
    const counts = this._polygonCountScratch;
    let floats = 0;
    for (let p = 0; p < n; p++) {
      const raw = polys[p];
      if (!raw || !raw.length) {
        this._setReplaceError('vert-count', entityIdx, p);
        return false;
      }
      const isNum = typeof raw[0] === 'number';
      const countGuess = isNum ? (raw.length / 2) | 0 : raw.length | 0;
      if (countGuess < 3 || countGuess > V) {
        this._setReplaceError('vert-count', entityIdx, p);
        return false;
      }
      counts[p] = countGuess;
      floats += countGuess * 2;
    }
    if (!this._polygonUnpackScratch || this._polygonUnpackScratch.length < floats) {
      this._polygonUnpackScratch = new Float32Array(floats);
    }
    const xy = this._polygonUnpackScratch;
    let o = 0;
    for (let p = 0; p < n; p++) {
      const raw = polys[p];
      const isNum = typeof raw[0] === 'number';
      const count = counts[p];
      if (isNum) {
        for (let i = 0; i < count; i++) {
          xy[o++] = raw[i * 2];
          xy[o++] = raw[i * 2 + 1];
        }
      } else {
        for (let i = 0; i < count; i++) {
          xy[o++] = raw[i].x;
          xy[o++] = raw[i].y;
        }
      }
    }
    return this.replaceForEntityFlat(entityIdx, xy, counts, n);
  }
}
