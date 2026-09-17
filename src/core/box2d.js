// Box2d.js — static gameplay facade over Box2D SAB queries, command ring, movers.
// Not PhysicsWorld (that lives only on the physics worker).

import { enqueueExplode } from '../box2d/box2dCommandRing.js';
import { box2dQueryAABB, box2dQueryAABBAsync } from '../box2d/box2dQueryAabb.js';
import { box2dCastRayClosest, box2dCastRayClosestAsync } from '../box2d/box2dRayCast.js';
import { getMovedBodiesViews } from '../box2d/box2dMovedBodies.js';

const EMPTY_MOVED = Object.freeze({
  list: new Uint32Array(0),
  count: 0,
  bits: null,
  generation: 0,
  fellAsleep: null,
});

export class Box2d {
  /** Sync QueryAABB (logic workers). Fills `out` with entity ids. */
  static queryAABB(x0, y0, x1, y1, out, filter) {
    return box2dQueryAABB(x0, y0, x1, y1, out, filter);
  }

  /** Async QueryAABB (Scene / main). */
  static queryAABBAsync(x0, y0, x1, y1, out, filter) {
    return box2dQueryAABBAsync(x0, y0, x1, y1, out, filter);
  }

  /** Sync castRayClosest (logic workers). `dx,dy` is displacement, not a point. */
  static castRayClosest(ox, oy, dx, dy, out, filter) {
    return box2dCastRayClosest(ox, oy, dx, dy, out, filter);
  }

  /** Async castRayClosest (Scene / main). */
  static castRayClosestAsync(ox, oy, dx, dy, out, filter) {
    return box2dCastRayClosestAsync(ox, oy, dx, dy, out, filter);
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
