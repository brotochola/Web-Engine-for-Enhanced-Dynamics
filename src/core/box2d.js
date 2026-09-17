// Box2d.js — static gameplay facade over Box2D SAB queries, command ring, movers.
// Not PhysicsWorld (that lives only on the physics worker).

import { enqueueExplode } from '../box2d/box2dCommandRing.js';
import { box2dQueryAABB, box2dQueryAABBAsync } from '../box2d/box2dQueryAabb.js';
import { box2dOverlapCircle, box2dOverlapCircleAsync } from '../box2d/box2dOverlapCircle.js';
import { box2dCastRayClosest, box2dCastRayClosestAsync } from '../box2d/box2dRayCast.js';
import { box2dCastRayAll, box2dCastRayAllAsync } from '../box2d/box2dCastRayAll.js';
import { getMovedBodiesViews } from '../box2d/box2dMovedBodies.js';

const EMPTY_MOVED = Object.freeze({
  list: new Uint32Array(0),
  count: 0,
  bits: null,
  generation: 0,
  fellAsleep: null,
});

const box2dRayStatsOut = { ms: 0, count: 0 };

export class Box2d {
  static collectDetailedStats = false;
  static _rayStatsMs = 0;
  static _rayStatsCount = 0;

  static beginFrame() {
    this._rayStatsMs = 0;
    this._rayStatsCount = 0;
  }

  /** @returns {{ ms: number, count: number }} borrowed — consume before next consumeStats */
  static consumeStats() {
    box2dRayStatsOut.ms = this._rayStatsMs;
    box2dRayStatsOut.count = this._rayStatsCount;
    this._rayStatsMs = 0;
    this._rayStatsCount = 0;
    return box2dRayStatsOut;
  }

  /** Sync QueryAABB (logic workers). Fills `out` with entity ids. */
  static queryAABB(x0, y0, x1, y1, out, filter) {
    return box2dQueryAABB(x0, y0, x1, y1, out, filter);
  }

  /** Async QueryAABB (Scene / main). */
  static queryAABBAsync(x0, y0, x1, y1, out, filter) {
    return box2dQueryAABBAsync(x0, y0, x1, y1, out, filter);
  }

  /** Sync overlapCircle (logic). Fills `out` with entity ids. */
  static overlapCircle(cx, cy, radius, out, filter) {
    return box2dOverlapCircle(cx, cy, radius, out, filter);
  }

  /** Async overlapCircle (Scene / main). */
  static overlapCircleAsync(cx, cy, radius, out, filter) {
    return box2dOverlapCircleAsync(cx, cy, radius, out, filter);
  }

  /** Sync castRayClosest (logic workers). `dx,dy` is displacement, not a point. */
  static castRayClosest(ox, oy, dx, dy, out, filter) {
    if (!this.collectDetailedStats) {
      return box2dCastRayClosest(ox, oy, dx, dy, out, filter);
    }
    const t0 = performance.now();
    const hit = box2dCastRayClosest(ox, oy, dx, dy, out, filter);
    this._rayStatsMs += performance.now() - t0;
    this._rayStatsCount++;
    return hit;
  }

  /** Async castRayClosest (Scene / main). */
  static castRayClosestAsync(ox, oy, dx, dy, out, filter) {
    return box2dCastRayClosestAsync(ox, oy, dx, dy, out, filter);
  }

  /** Sync castRayAll (logic). Fills borrowed `out` with `{ entityIndex, fraction, hitX, hitY }`. */
  static castRayAll(ox, oy, dx, dy, out, filter) {
    return box2dCastRayAll(ox, oy, dx, dy, out, filter);
  }

  /** Async castRayAll (Scene / main). */
  static castRayAllAsync(ox, oy, dx, dy, out, filter) {
    return box2dCastRayAllAsync(ox, oy, dx, dy, out, filter);
  }

  /**
   * Radial impulse. Physics worker applies falloff = 0.5 * radius.
   * @param {{x:number, y:number, radius:number, impulsePerLength:number, maskBits?:number}} opts
   */
  static explode({ x, y, radius, impulsePerLength, maskBits = 0xffffffff }) {
    enqueueExplode(maskBits >>> 0, x, y, radius, impulsePerLength);
  }

  /**
   * Entity indices that moved in the last physics step (live SAB views).
   * @returns {{ list: Uint32Array, count: number, bits: Uint8Array|null, generation: number, fellAsleep: Uint8Array|null }}
   */
  static getMovedBodies() {
    const v = getMovedBodiesViews();
    if (!v || !v.movedList) {
      return {
        list: EMPTY_MOVED.list,
        count: 0,
        bits: null,
        generation: 0,
        fellAsleep: null,
      };
    }
    const count = v.count | 0;
    return {
      list: count > 0 ? v.movedList.subarray(0, count) : EMPTY_MOVED.list,
      count,
      bits: v.movedBits,
      generation: v.generation | 0,
      fellAsleep: v.fellAsleep,
    };
  }
}
