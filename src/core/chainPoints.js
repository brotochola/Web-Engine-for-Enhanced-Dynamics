// One Box2D chain per collider. Points live in one scene SAB.
// setChain overwrites a reserved span in place. Growth uses a free-span stack
// then a bump cursor. No coalescing: the ceiling is physics.maxChainPoints.
// ponytail: free spans are not merged; raise maxChainPoints if a growing chain exhausts the pool.

import { Collider } from '../components/collider.js';
import { ColliderFixture } from './colliderFixture.js';
import { RigidBody } from '../components/rigidBody.js';
import { ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';
import { Transform } from '../components/transform.js';

const PICK_SLOP = 4;

export class ChainPoints {
  static xy = null;
  static begin = null;
  static count = null;
  static cap = null;
  static loop = null;
  static freeBegin = null;
  static freeCap = null;
  static freeTop = null;
  static bump = null;
  static maxPoints = 0;
  static entityCount = 0;
  static lengthUnitsPerMeter = 100;
  static lastError = { code: '', entityIndex: -1 };

  static getBufferSize(maxPoints, entityCount) {
    const n = maxPoints | 0;
    const e = entityCount | 0;
    const align4 = (o) => (o + 3) & ~3;
    let offset = n * 2 * 4;
    offset += e * 4;
    offset = align4(offset + e * 2);
    offset = align4(offset + e * 2);
    offset = align4(offset + e);
    offset += e * 4;
    offset = align4(offset + e * 2);
    offset += 8;
    return offset;
  }

  static initializeArrays(buffer, maxPoints, entityCount) {
    const n = maxPoints | 0;
    const e = entityCount | 0;
    const align4 = (o) => (o + 3) & ~3;
    let offset = 0;
    this.maxPoints = n;
    this.entityCount = e;
    this.xy = new Float32Array(buffer, offset, n * 2);
    offset += n * 2 * 4;
    this.begin = new Int32Array(buffer, offset, e);
    offset += e * 4;
    this.count = new Uint16Array(buffer, offset, e);
    offset = align4(offset + e * 2);
    this.cap = new Uint16Array(buffer, offset, e);
    offset = align4(offset + e * 2);
    this.loop = new Uint8Array(buffer, offset, e);
    offset = align4(offset + e);
    this.freeBegin = new Int32Array(buffer, offset, e);
    offset += e * 4;
    this.freeCap = new Uint16Array(buffer, offset, e);
    offset = align4(offset + e * 2);
    this.freeTop = new Int32Array(buffer, offset, 1);
    offset += 4;
    this.bump = new Int32Array(buffer, offset, 1);
    this.begin.fill(-1);
    this.count.fill(0);
    this.cap.fill(0);
    this.loop.fill(0);
    this.freeTop[0] = 0;
    this.bump[0] = 0;
  }

  static reset() {
    this.xy = null;
    this.begin = null;
    this.count = null;
    this.cap = null;
    this.loop = null;
    this.freeBegin = null;
    this.freeCap = null;
    this.freeTop = null;
    this.bump = null;
    this.maxPoints = 0;
    this.entityCount = 0;
  }

  static _fail(code, entityIndex) {
    this.lastError.code = code;
    this.lastError.entityIndex = entityIndex | 0;
    return false;
  }

  static _edgeOk(x0, y0, x1, y1, slopSqr) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return dx * dx + dy * dy > slopSqr;
  }

  static _free(begin, cap) {
    const top = this.freeTop[0] | 0;
    if (top >= this.entityCount) return;
    this.freeBegin[top] = begin;
    this.freeCap[top] = cap;
    this.freeTop[0] = top + 1;
  }

  static _alloc(entityIdx, count) {
    const oldBegin = this.begin[entityIdx];
    const oldCap = this.cap[entityIdx] | 0;
    if (oldBegin >= 0 && oldCap >= count) {
      this.count[entityIdx] = count;
      return oldBegin;
    }
    if (oldBegin >= 0) {
      this._free(oldBegin, oldCap);
      this.begin[entityIdx] = -1;
      this.cap[entityIdx] = 0;
    }
    const top = this.freeTop[0] | 0;
    for (let i = 0; i < top; i++) {
      const cap = this.freeCap[i] | 0;
      if (cap < count) continue;
      const begin = this.freeBegin[i];
      const last = top - 1;
      this.freeBegin[i] = this.freeBegin[last];
      this.freeCap[i] = this.freeCap[last];
      this.freeTop[0] = last;
      this.begin[entityIdx] = begin;
      this.cap[entityIdx] = cap;
      this.count[entityIdx] = count;
      return begin;
    }
    const bump = this.bump[0] | 0;
    if (bump + count > this.maxPoints) return -1;
    this.bump[0] = bump + count;
    this.begin[entityIdx] = bump;
    this.cap[entityIdx] = count;
    this.count[entityIdx] = count;
    return bump;
  }

  /**
   * Local interleaved x,y. Open chains use the first and last points as ghosts
   * (no collision on those edges). Loops need 3 points; open chains need 4.
   */
  static setForEntity(entityIdx, xy, count, loop) {
    if (!this.xy || entityIdx < 0 || entityIdx >= this.entityCount) {
      return this._fail('not-initialized', entityIdx);
    }
    const n = count | 0;
    const isLoop = loop ? 1 : 0;
    if (!xy || (isLoop ? n < 3 : n < 4) || n * 2 > xy.length) {
      return this._fail('count', entityIdx);
    }
    const slop = 0.005 * (this.lengthUnitsPerMeter || 100);
    const slopSqr = slop * slop;
    const pairs = isLoop ? n : n - 1;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      if (x !== x || y !== y) return this._fail('nan', entityIdx);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let i = 0; i < pairs; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      if (!this._edgeOk(xy[i * 2], xy[i * 2 + 1], xy[j * 2], xy[j * 2 + 1], slopSqr)) {
        return this._fail('short-edge', entityIdx);
      }
    }
    const begin = this._alloc(entityIdx, n);
    if (begin < 0) return this._fail('pool-exhausted', entityIdx);
    const dst = begin * 2;
    for (let i = 0; i < n * 2; i++) this.xy[dst + i] = xy[i];
    this.loop[entityIdx] = isLoop;
    ColliderFixture.removeAllForEntity(entityIdx);
    Collider.polyCount[entityIdx] = 0;
    Collider.fixtureCount[entityIdx] = 0;
    Collider.width[entityIdx] = maxX - minX;
    Collider.height[entityIdx] = maxY - minY;
    Collider.polyCentroidX[entityIdx] = (minX + maxX) * 0.5;
    Collider.polyCentroidY[entityIdx] = (minY + maxY) * 0.5;
    Collider.shapeType[entityIdx] = ShapeType.Chain;
    RigidBody.syncMassFromCollider(entityIdx);
    markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
    this.lastError.code = '';
    return true;
  }

  static clearForEntity(entityIdx) {
    if (!this.begin || entityIdx < 0 || entityIdx >= this.entityCount) return;
    const begin = this.begin[entityIdx];
    const cap = this.cap[entityIdx] | 0;
    if (begin >= 0 && cap > 0) this._free(begin, cap);
    this.begin[entityIdx] = -1;
    this.count[entityIdx] = 0;
    this.cap[entityIdx] = 0;
    this.loop[entityIdx] = 0;
    markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY);
  }

  static _origin(entityIdx) {
    const tx = Transform.x[entityIdx];
    const ty = Transform.y[entityIdx];
    const c = Transform.rotC ? Transform.rotC[entityIdx] : 1;
    const s = Transform.rotS ? Transform.rotS[entityIdx] : 0;
    const ox = Collider.offsetX[entityIdx] || 0;
    const oy = Collider.offsetY[entityIdx] || 0;
    return {
      x: tx + c * ox - s * oy,
      y: ty + s * ox + c * oy,
      c,
      s,
    };
  }

  static _world(origin, lx, ly) {
    return {
      x: origin.x + origin.c * lx - origin.s * ly,
      y: origin.y + origin.s * lx + origin.c * ly,
    };
  }

  static _solidRange(entityIdx) {
    const count = this.count[entityIdx] | 0;
    const loop = this.loop[entityIdx] | 0;
    if (!this.xy || this.begin[entityIdx] < 0) return null;
    if (loop) {
      if (count < 3) return null;
      return { begin: this.begin[entityIdx], count, loop: 1, edges: count };
    }
    if (count < 4) return null;
    return { begin: this.begin[entityIdx], count, loop: 0, edges: count - 3 };
  }

  static rayDistance(entityIdx, rayX, rayY, dirX, dirY, rayLength) {
    const span = this._solidRange(entityIdx);
    if (!span) return -1;
    const origin = this._origin(entityIdx);
    const xy = this.xy;
    const base = span.begin;
    let best = -1;
    const n = span.count;
    const start = span.loop ? 0 : 1;
    const edgeCount = span.edges;
    for (let e = 0; e < edgeCount; e++) {
      const i0 = start + e;
      const i1 = span.loop ? (i0 + 1) % n : i0 + 1;
      const a = this._world(origin, xy[(base + i0) * 2], xy[(base + i0) * 2 + 1]);
      const b = this._world(origin, xy[(base + i1) * 2], xy[(base + i1) * 2 + 1]);
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const ox = rayX - a.x;
      const oy = rayY - a.y;
      if (ox * ey - oy * ex <= 0) continue;
      const denom = dirX * ey - dirY * ex;
      if (denom === 0) continue;
      const t = (ox * ey - oy * ex) / denom;
      const u = (ox * dirY - oy * dirX) / denom;
      if (t < 0 || t > rayLength || u < 0 || u > 1) continue;
      if (best < 0 || t < best) best = t;
    }
    return best;
  }

  static pointNear(entityIdx, x, y) {
    const span = this._solidRange(entityIdx);
    if (!span) return false;
    const origin = this._origin(entityIdx);
    const xy = this.xy;
    const base = span.begin;
    const n = span.count;
    const start = span.loop ? 0 : 1;
    const slop = PICK_SLOP;
    const slopSqr = slop * slop;
    for (let e = 0; e < span.edges; e++) {
      const i0 = start + e;
      const i1 = span.loop ? (i0 + 1) % n : i0 + 1;
      const a = this._world(origin, xy[(base + i0) * 2], xy[(base + i0) * 2 + 1]);
      const b = this._world(origin, xy[(base + i1) * 2], xy[(base + i1) * 2 + 1]);
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const lenSqr = ex * ex + ey * ey;
      if (!(lenSqr > 0)) continue;
      let u = ((x - a.x) * ex + (y - a.y) * ey) / lenSqr;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const dx = x - (a.x + ex * u);
      const dy = y - (a.y + ey * u);
      if (dx * dx + dy * dy <= slopSqr) return true;
    }
    return false;
  }
}
