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
const _local = { begin: 0, count: 0, loop: 0, c: 1, s: 0, x: 0, y: 0 };

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
  static lastError = { code: '' };

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

  static _fail(code) {
    this.lastError.code = code;
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
      return this._fail('not-initialized');
    }
    const n = count | 0;
    const isLoop = loop ? 1 : 0;
    if (!xy || (isLoop ? n < 3 : n < 4) || n * 2 > xy.length) {
      return this._fail('count');
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
      if (x !== x || y !== y) return this._fail('nan');
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let i = 0; i < pairs; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      if (!this._edgeOk(xy[i * 2], xy[i * 2 + 1], xy[j * 2], xy[j * 2 + 1], slopSqr)) {
        return this._fail('short-edge');
      }
    }
    const begin = this._alloc(entityIdx, n);
    if (begin < 0) return this._fail('pool-exhausted');
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
    markBodyDirty(entityIdx, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS | BODY_DIRTY.BODY_TYPE);
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

  /**
   * rayDistance and pointNear: the entity's chain, and a world point in its
   * body's frame (pose plus the rotated collider offset). Null when there is
   * no usable chain: a loop needs 3 points, an open chain 4 (two ghosts, one edge).
   * The result is a shared scratch object; read it before the next call.
   */
  static _toLocal(entityIdx, x, y) {
    const count = this.count ? (this.count[entityIdx] | 0) : 0;
    const begin = this.begin ? (this.begin[entityIdx] | 0) : -1;
    if (!this.xy || begin < 0) return null;
    const loop = this.loop[entityIdx] | 0;
    if (loop ? count < 3 : count < 4) return null;
    const c = Transform.rotC ? Transform.rotC[entityIdx] : 1;
    const s = Transform.rotS ? Transform.rotS[entityIdx] : 0;
    const offX = Collider.offsetX[entityIdx] || 0;
    const offY = Collider.offsetY[entityIdx] || 0;
    const relX = x - (Transform.x[entityIdx] + c * offX - s * offY);
    const relY = y - (Transform.y[entityIdx] + s * offX + c * offY);
    const f = _local;
    f.begin = begin;
    f.count = count;
    f.loop = loop;
    f.c = c;
    f.s = s;
    f.x = c * relX + s * relY;
    f.y = -s * relX + c * relY;
    return f;
  }

  static rayDistance(entityIdx, rayX, rayY, dirX, dirY, rayLength) {
    const f = this._toLocal(entityIdx, rayX, rayY);
    if (!f) return -1;
    const begin = f.begin;
    const count = f.count;
    const loop = f.loop;
    const c = f.c;
    const s = f.s;
    const localX = f.x;
    const localY = f.y;
    const localDirX = c * dirX + s * dirY;
    const localDirY = -s * dirX + c * dirY;

    const xy = this.xy;
    const start = loop ? 0 : 1;
    const edgeCount = loop ? count : count - 3;
    let best = -1;
    for (let e = 0; e < edgeCount; e++) {
      const i0 = start + e;
      const i1 = loop ? (i0 + 1) % count : i0 + 1;
      const ax = xy[(begin + i0) * 2];
      const ay = xy[(begin + i0) * 2 + 1];
      const bx = xy[(begin + i1) * 2];
      const by = xy[(begin + i1) * 2 + 1];
      const ex = bx - ax;
      const ey = by - ay;
      const ox = localX - ax;
      const oy = localY - ay;
      // One-sided: only from the edge's outer (right-hand) side.
      const side = ox * ey - oy * ex;
      if (side <= 0) continue;
      // origin + t*dir = a + u*e with w = origin - a: t = (w x e)/(e x dir), u = (w x dir)/(e x dir).
      const denom = ex * localDirY - ey * localDirX;
      if (denom === 0) continue;
      const t = side / denom;
      const u = (ox * localDirY - oy * localDirX) / denom;
      if (t < 0 || t > rayLength || u < 0 || u > 1) continue;
      if (best < 0 || t < best) best = t;
    }
    return best;
  }

  static pointNear(entityIdx, x, y) {
    const f = this._toLocal(entityIdx, x, y);
    if (!f) return false;
    const begin = f.begin;
    const count = f.count;
    const loop = f.loop;
    const localX = f.x;
    const localY = f.y;

    const xy = this.xy;
    const start = loop ? 0 : 1;
    const edgeCount = loop ? count : count - 3;
    const slopSqr = PICK_SLOP * PICK_SLOP;
    for (let e = 0; e < edgeCount; e++) {
      const i0 = start + e;
      const i1 = loop ? (i0 + 1) % count : i0 + 1;
      const ax = xy[(begin + i0) * 2];
      const ay = xy[(begin + i0) * 2 + 1];
      const bx = xy[(begin + i1) * 2];
      const by = xy[(begin + i1) * 2 + 1];
      const ex = bx - ax;
      const ey = by - ay;
      const lenSqr = ex * ex + ey * ey;
      if (!(lenSqr > 0)) continue;
      let u = ((localX - ax) * ex + (localY - ay) * ey) / lenSqr;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const dx = localX - (ax + ex * u);
      const dy = localY - (ay + ey * u);
      if (dx * dx + dy * dy <= slopSqr) return true;
    }
    return false;
  }
}
