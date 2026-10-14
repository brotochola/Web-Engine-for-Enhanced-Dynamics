// Box2d.js — static gameplay facade over Box2D SAB queries, command ring, movers.
// Not PhysicsWorld (that lives only on the physics worker).

import { enqueueExplode } from '../box2d/box2dCommandRing.js';
import { box2dQueryAABB, box2dQueryAABBAsync } from '../box2d/box2dQueryAabb.js';
import { box2dOverlapCircle, box2dOverlapCircleAsync } from '../box2d/box2dOverlapCircle.js';
import { box2dCastRayClosest, box2dCastRayClosestAsync, box2dCastRayClosestBatch } from '../box2d/box2dRayCast.js';
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
  /** True when config.physics.enabled === false — no WASM worker. Boot flag, not a hot-loop gate. */
  static physicsWorkerAbsent = false;
  static _rayStatsMs = 0;
  static _rayStatsCount = 0;

  static _assertPhysicsWorker() {
    if (this.physicsWorkerAbsent) {
      throw new Error('Box2d: physics worker absent (config.physics.enabled === false)');
    }
  }

  /**
   * B-04. The sync query APIs block the calling thread with Atomics.wait, which
   * throws `TypeError: Atomics.wait cannot be called in this context` on the
   * main thread - a message that says nothing about the async variant that
   * would have worked. Guard here as well as in the impls: the impls cover
   * direct imports, this covers the documented public API, and between them no
   * gameplay call site can hit a bare TypeError.
   */
  static _assertWorkerThread(asyncName) {
    if (typeof window === 'undefined') return; // Worker has no `window`
    throw new Error(
      `Box2d: this query blocks the main thread with Atomics.wait and cannot run here. Use ${asyncName} instead.`,
    );
  }

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
    this._assertPhysicsWorker();
    this._assertWorkerThread('Box2d.queryAABBAsync');
    return box2dQueryAABB(x0, y0, x1, y1, out, filter);
  }

  /** Async QueryAABB (Scene / main). */
  static queryAABBAsync(x0, y0, x1, y1, out, filter) {
    this._assertPhysicsWorker();
    return box2dQueryAABBAsync(x0, y0, x1, y1, out, filter);
  }

  /** Sync overlapCircle (logic). Fills `out` with entity ids. */
  static overlapCircle(cx, cy, radius, out, filter) {
    this._assertPhysicsWorker();
    this._assertWorkerThread('Box2d.overlapCircleAsync');
    return box2dOverlapCircle(cx, cy, radius, out, filter);
  }

  /** Async overlapCircle (Scene / main). */
  static overlapCircleAsync(cx, cy, radius, out, filter) {
    this._assertPhysicsWorker();
    return box2dOverlapCircleAsync(cx, cy, radius, out, filter);
  }

  /** Sync castRayClosest (logic workers). `dx,dy` is displacement, not a point. */
  static castRayClosest(ox, oy, dx, dy, out, filter) {
    this._assertPhysicsWorker();
    this._assertWorkerThread('Box2d.castRayClosestAsync');
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
    this._assertPhysicsWorker();
    return box2dCastRayClosestAsync(ox, oy, dx, dy, out, filter);
  }

  /**
   * Sync batch of castRayClosest. One SAB wait for `count` rays.
   * `rays` is interleaved ox, oy, dx, dy. `entities` receives the hit id or -1.
   */
  static castRayClosestBatch(count, rays, entities, filter) {
    this._assertPhysicsWorker();
    this._assertWorkerThread('Box2d.castRayClosestAsync');
    return box2dCastRayClosestBatch(count, rays, entities, filter);
  }

  /** Sync castRayAll (logic). Fills borrowed `out` with `{ entityIndex, fraction, hitX, hitY }`. */
  static castRayAll(ox, oy, dx, dy, out, filter) {
    this._assertPhysicsWorker();
    this._assertWorkerThread('Box2d.castRayAllAsync');
    return box2dCastRayAll(ox, oy, dx, dy, out, filter);
  }

  /** Async castRayAll (Scene / main). */
  static castRayAllAsync(ox, oy, dx, dy, out, filter) {
    this._assertPhysicsWorker();
    return box2dCastRayAllAsync(ox, oy, dx, dy, out, filter);
  }

  /**
   * Radial impulse. Physics worker applies falloff = 0.5 * radius.
   * Object: `{ x, y, radius, impulsePerLength, maskBits? }`
   * Positional: `(x, y, radius, impulsePerLength, maskBits?)`
   * Non-finite / radius≤0 is a no-op (NaN would melt the WASM solver).
   */
  static explode(xOrOpts, y, radius, impulsePerLength, maskBits) {
    this._assertPhysicsWorker();
    let x;
    let r;
    let impulse;
    let mask;
    if (xOrOpts != null && typeof xOrOpts === 'object') {
      x = xOrOpts.x;
      y = xOrOpts.y;
      r = xOrOpts.radius;
      impulse = xOrOpts.impulsePerLength;
      mask = xOrOpts.maskBits;
    } else {
      x = xOrOpts;
      r = radius;
      impulse = impulsePerLength;
      mask = maskBits;
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(r) ||
      !(r > 0) ||
      !Number.isFinite(impulse)
    ) {
      return false;
    }
    return enqueueExplode((mask == null ? 0xffffffff : mask) >>> 0, x, y, r, impulse);
  }

  /**
   * Entity indices that moved in the last physics step.
   *
   * CONTRACT: `list`, `bits` and `fellAsleep` are live views into the physics
   * SAB, not a copy. The physics worker rewrites them in place on its next
   * step, so consume them before then. `generation` identifies which publish the
   * views belong to - re-read it after you are done and compare; if it moved,
   * the list you were iterating was replaced underneath you. That is what the
   * field is for, and it is why the reader validates GEN against COUNT rather
   * than reporting a pair from two different publishes.
   *
   * A copy per frame is deliberately not offered: this is a per-frame path and
   * an entityCapacity-sized allocation every frame is exactly the GC pressure
   * this engine has been working to remove. Callers that need to hold the set
   * across a frame boundary should copy it themselves, deliberately.
   *
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
