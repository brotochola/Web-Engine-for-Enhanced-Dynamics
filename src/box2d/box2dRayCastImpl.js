// Box2D castRayClosest request/response SAB — single-flight (one outstanding cast).
// ESM: imported as side-effect by box2dRayCast.js
// Classic: importScripts from weedjs_post.js
// Writers: logic / GameObject / Scene (main async). Reader+filler: weedjs_post doStep.
//
// STATUS: IDLE=0 PENDING=1 DONE=2 ERROR=3 CLAIMED=4
// Caller CAS IDLE→CLAIMED, writes origin+delta+filter, stores PENDING, waits DONE/ERROR,
// copies hit into out, stores IDLE.
// Physics: if PENDING, castRayClosest → hit fields, DONE, notify.

(function (global) {
  var STATUS_IDLE = 0;
  var STATUS_PENDING = 1;
  var STATUS_DONE = 2;
  var STATUS_ERROR = 3;
  var STATUS_CLAIMED = 4;

  var HDR_STATUS = 0;
  var HDR_HIT = 1;
  var HDR_ENTITY = 2;
  var HDR_CATEGORY = 3;
  var HDR_MASK = 4;
  // 5..7 reserved
  var HEADER_I32 = 8;
  var RAY_F32 = HEADER_I32; // ox, oy, dx, dy
  var OUT_F32 = HEADER_I32 + 4; // fraction, hitX, hitY (+1 pad)

  var DEFAULT_CATEGORY = 1;
  var DEFAULT_MASK = 0xffffffff;

  var i32 = null;
  var f32 = null;
  var bound = false;

  function createRayCastSab() {
    var i32Count = OUT_F32 + 4;
    var sab = new SharedArrayBuffer(i32Count * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_HIT, 0);
    Atomics.store(view, HDR_ENTITY, -1);
    Atomics.store(view, HDR_CATEGORY, DEFAULT_CATEGORY);
    Atomics.store(view, HDR_MASK, DEFAULT_MASK | 0);
    return sab;
  }

  function bindRayCastSab(sab) {
    if (!sab) {
      i32 = null;
      f32 = null;
      bound = false;
      return;
    }
    i32 = new Int32Array(sab);
    f32 = new Float32Array(sab);
    bound = true;
  }

  function isRayCastBound() {
    return bound && i32 != null;
  }

  function ensureOut(out) {
    if (out && typeof out === 'object') return out;
    return {
      hit: false,
      entityIndex: -1,
      fraction: 0,
      hitX: 0,
      hitY: 0,
    };
  }

  function writeRequest(ox, oy, dx, dy, filter) {
    f32[RAY_F32] = ox;
    f32[RAY_F32 + 1] = oy;
    f32[RAY_F32 + 2] = dx;
    f32[RAY_F32 + 3] = dy;
    var cat =
      filter && filter.categoryBits != null
        ? filter.categoryBits | 0
        : DEFAULT_CATEGORY;
    var mask =
      filter && filter.maskBits != null ? filter.maskBits | 0 : DEFAULT_MASK;
    Atomics.store(i32, HDR_CATEGORY, cat);
    Atomics.store(i32, HDR_MASK, mask);
    Atomics.store(i32, HDR_HIT, 0);
    Atomics.store(i32, HDR_ENTITY, -1);
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function claimAndWriteSync(ox, oy, dx, dy, filter) {
    if (!i32) {
      throw new Error('box2dCastRayClosest: SAB not bound (wait for box2dReady)');
    }
    for (;;) {
      var prev = Atomics.compareExchange(
        i32,
        HDR_STATUS,
        STATUS_IDLE,
        STATUS_CLAIMED,
      );
      if (prev === STATUS_IDLE) break;
      Atomics.wait(i32, HDR_STATUS, prev);
    }
    writeRequest(ox, oy, dx, dy, filter);
  }

  function claimAndWriteAsync(ox, oy, dx, dy, filter) {
    if (!i32) {
      return Promise.reject(
        new Error('box2dCastRayClosest: SAB not bound (wait for box2dReady)'),
      );
    }
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(
        new Error('box2dCastRayClosestAsync: Atomics.waitAsync unavailable'),
      );
    }

    function claimLoop() {
      var prev = Atomics.compareExchange(
        i32,
        HDR_STATUS,
        STATUS_IDLE,
        STATUS_CLAIMED,
      );
      if (prev === STATUS_IDLE) {
        writeRequest(ox, oy, dx, dy, filter);
        return Promise.resolve();
      }
      var r = Atomics.waitAsync(i32, HDR_STATUS, prev);
      if (r.async === false) {
        return claimLoop();
      }
      return r.value.then(claimLoop);
    }

    return claimLoop();
  }

  function copyResultAndRelease(out) {
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    if (status === STATUS_ERROR) {
      Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
      Atomics.notify(i32, HDR_STATUS, 1);
      throw new Error('box2dCastRayClosest: physics reported error');
    }
    var hit = (Atomics.load(i32, HDR_HIT) | 0) !== 0;
    out.hit = hit;
    out.entityIndex = hit ? Atomics.load(i32, HDR_ENTITY) | 0 : -1;
    out.fraction = hit ? f32[OUT_F32] : 0;
    out.hitX = hit ? f32[OUT_F32 + 1] : 0;
    out.hitY = hit ? f32[OUT_F32 + 2] : 0;
    Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
    Atomics.notify(i32, HDR_STATUS, 1);
    return out;
  }

  function waitUntilDoneSync() {
    for (;;) {
      var s = Atomics.load(i32, HDR_STATUS) | 0;
      if (s === STATUS_DONE || s === STATUS_ERROR) return;
      Atomics.wait(i32, HDR_STATUS, s);
    }
  }

  /**
   * Sync castRayClosest (logic workers / GameObject). Blocks with Atomics.wait.
   * @param {number} ox
   * @param {number} oy
   * @param {number} dx displacement X (not necessarily unit)
   * @param {number} dy displacement Y
   * @param {{ hit?: boolean, entityIndex?: number, fraction?: number, hitX?: number, hitY?: number }} [out]
   * @param {{ categoryBits?: number, maskBits?: number }} [filter]
   */
  function box2dCastRayClosest(ox, oy, dx, dy, out, filter) {
    var result = ensureOut(out);
    claimAndWriteSync(ox, oy, dx, dy, filter);
    waitUntilDoneSync();
    return copyResultAndRelease(result);
  }

  /**
   * Async castRayClosest for main thread (Atomics.waitAsync).
   * @returns {Promise<object>}
   */
  function box2dCastRayClosestAsync(ox, oy, dx, dy, out, filter) {
    var result = ensureOut(out);
    return claimAndWriteAsync(ox, oy, dx, dy, filter).then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(copyResultAndRelease(result));
        }
        var r = Atomics.waitAsync(i32, HDR_STATUS, s);
        if (r.async === false) {
          return waitLoop();
        }
        return r.value.then(waitLoop);
      }
      return waitLoop();
    });
  }

  /**
   * Physics: if a cast is PENDING, run castFn and publish result.
   * castFn(ox,oy,dx,dy,categoryBits,maskBits) →
   *   { hit:boolean, entityIndex:number, fraction:number, hitX:number, hitY:number }
   * @returns {boolean} true if a cast was serviced
   */
  function servicePendingRayCast(castFn) {
    if (!i32 || typeof castFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;

    var ox = f32[RAY_F32];
    var oy = f32[RAY_F32 + 1];
    var dx = f32[RAY_F32 + 2];
    var dy = f32[RAY_F32 + 3];
    var cat = Atomics.load(i32, HDR_CATEGORY) | 0;
    var mask = Atomics.load(i32, HDR_MASK) | 0;

    try {
      var r = castFn(ox, oy, dx, dy, cat, mask) || {};
      var hit = !!r.hit;
      Atomics.store(i32, HDR_HIT, hit ? 1 : 0);
      Atomics.store(i32, HDR_ENTITY, hit ? (r.entityIndex | 0) : -1);
      f32[OUT_F32] = hit ? +r.fraction || 0 : 0;
      f32[OUT_F32 + 1] = hit ? +r.hitX || 0 : 0;
      f32[OUT_F32 + 2] = hit ? +r.hitY || 0 : 0;
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_HIT, 0);
      Atomics.store(i32, HDR_ENTITY, -1);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[box2dCastRayClosest] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
  }

  /**
   * Drain a burst of single-flight casts within one physics step.
   * After DONE, logic turnaround is microseconds (IDLE→CLAIMED→PENDING); busy-spin
   * catches that without bailing on a transient IDLE between DONE and CLAIMED.
   * Timed wait is a fallback when the caller pauses between casts.
   * @returns {number} casts serviced
   */
  function servicePendingRayCastBurst(castFn, maxCasts) {
    if (!i32 || typeof castFn !== 'function') return 0;
    var max = maxCasts | 0;
    if (max <= 0) max = 1;
    var serviced = 0;
    while (serviced < max) {
      if (servicePendingRayCast(castFn)) {
        serviced++;
        continue;
      }
      if (serviced === 0) break;

      var found = false;
      for (var spin = 0; spin < 100000; spin++) {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_PENDING) {
          found = true;
          break;
        }
      }
      if (found) continue;

      var s2 = Atomics.load(i32, HDR_STATUS) | 0;
      if (s2 === STATUS_PENDING) continue;
      if (s2 === STATUS_CLAIMED) {
        Atomics.wait(i32, HDR_STATUS, STATUS_CLAIMED, 2.0);
        continue;
      }
      Atomics.wait(i32, HDR_STATUS, s2, 2.0);
      var s3 = Atomics.load(i32, HDR_STATUS) | 0;
      if (s3 !== STATUS_PENDING && s3 !== STATUS_CLAIMED) break;
    }
    return serviced;
  }

  global.Box2dRayCast = {
    STATUS_IDLE: STATUS_IDLE,
    STATUS_PENDING: STATUS_PENDING,
    STATUS_DONE: STATUS_DONE,
    STATUS_ERROR: STATUS_ERROR,
    STATUS_CLAIMED: STATUS_CLAIMED,
    createRayCastSab: createRayCastSab,
    bindRayCastSab: bindRayCastSab,
    isRayCastBound: isRayCastBound,
    box2dCastRayClosest: box2dCastRayClosest,
    box2dCastRayClosestAsync: box2dCastRayClosestAsync,
    servicePendingRayCast: servicePendingRayCast,
    servicePendingRayCastBurst: servicePendingRayCastBurst,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
