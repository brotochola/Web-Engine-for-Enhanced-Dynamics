// LiquidFun QueryAABB / RayCast request/response SAB — single-flight.
// ESM: imported as side-effect by liquidFunQuery.js
// Classic: importScripts from weedjsPost.js
// Writers: logic / GameObject / Scene (main async). Reader+filler: weedjs_post doStep.
// The status word and every wait on it: box2dSyncSlotImpl.js (loaded first).
//
// OP: AABB=0 RAY=1
// Caller claims the slot, writes OP+coords, posts, waits DONE/ERROR,
// copies results into out, releases.
// Physics: if PENDING, particle query → results, COUNT, DONE, notify.

(function (global) {
  var Slot = global.Box2dSyncSlot;
  if (!Slot) throw new Error('liquidFunQueryImpl.js: load box2dSyncSlotImpl.js first');

  var STATUS_IDLE = Slot.STATUS_IDLE;
  var STATUS_PENDING = Slot.STATUS_PENDING;
  var STATUS_DONE = Slot.STATUS_DONE;
  var STATUS_ERROR = Slot.STATUS_ERROR;
  var STATUS_CLAIMED = Slot.STATUS_CLAIMED;

  var OP_AABB = 0;
  var OP_RAY = 1;

  var HDR_STATUS = Slot.HDR_STATUS;
  var HDR_COUNT = 1;
  var HDR_OP = 2;
  var HDR_RESULT_CAP = 3;
  // 4..7 reserved
  var HEADER_I32 = 8;
  var COORDS_F32 = HEADER_I32; // 4 floats
  var RESULTS_I32 = HEADER_I32 + 4;

  var DEFAULT_RESULT_CAP = 4096;

  var i32 = null;
  var f32 = null;
  var resultCap = 0;
  var resultsView = null;

  function createLiquidFunQuerySab(cap) {
    var resultCapacity = Math.max(
      64,
      (cap == null ? DEFAULT_RESULT_CAP : cap) | 0,
    );
    var i32Count = RESULTS_I32 + resultCapacity;
    var sab = new SharedArrayBuffer(i32Count * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_COUNT, 0);
    Atomics.store(view, HDR_OP, OP_AABB);
    Atomics.store(view, HDR_RESULT_CAP, resultCapacity);
    return sab;
  }

  function bindLiquidFunQuerySab(sab) {
    if (!sab) {
      i32 = null;
      f32 = null;
      resultCap = 0;
      resultsView = null;
      return;
    }
    i32 = new Int32Array(sab);
    f32 = new Float32Array(sab);
    resultCap = Atomics.load(i32, HDR_RESULT_CAP) | 0;
    resultsView = i32.subarray(RESULTS_I32, RESULTS_I32 + resultCap);
  }

  function isLiquidFunQueryBound() {
    return i32 != null && resultCap > 0;
  }

  function assertOut(out) {
    if (!out || out.BYTES_PER_ELEMENT !== 4 || !(out instanceof Int32Array)) {
      throw new TypeError('liquidFunQuery: out must be Int32Array');
    }
  }

  function writeRequest(op, a, b, c, d) {
    Atomics.store(i32, HDR_OP, op | 0);
    f32[COORDS_F32] = a;
    f32[COORDS_F32 + 1] = b;
    f32[COORDS_F32 + 2] = c;
    f32[COORDS_F32 + 3] = d;
    Atomics.store(i32, HDR_COUNT, 0);
    Slot.post(i32);
  }

  function claimAndWriteSync(op, a, b, c, d) {
    Slot.assertWorkerThread('liquidFunQuery', 'liquidFunQueryAABBAsync / liquidFunRayCastAsync');
    if (!i32) {
      throw new Error('liquidFunQuery: SAB not bound (wait for box2dReady)');
    }
    Slot.claimSync(i32);
    writeRequest(op, a, b, c, d);
  }

  function claimAndWriteAsync(op, a, b, c, d) {
    if (!i32) {
      return Promise.reject(
        new Error('liquidFunQuery: SAB not bound (wait for box2dReady)'),
      );
    }
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(
        new Error('liquidFunQueryAsync: Atomics.waitAsync unavailable'),
      );
    }
    return Slot.claimAsync(i32, function () {
      writeRequest(op, a, b, c, d);
    });
  }

  function copyResultsAndRelease(out) {
    if (Slot.isError(i32)) {
      Slot.release(i32);
      throw new Error('liquidFunQuery: physics reported error');
    }
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var n = count < out.length ? count : out.length;
    var base = RESULTS_I32;
    for (var i = 0; i < n; i++) {
      out[i] = i32[base + i] | 0;
    }
    Slot.release(i32);
    return count;
  }

  function querySync(op, a, b, c, d, out) {
    assertOut(out);
    claimAndWriteSync(op, a, b, c, d);
    Slot.waitDoneSync(i32);
    return copyResultsAndRelease(out);
  }

  function queryAsync(op, a, b, c, d, out) {
    assertOut(out);
    return claimAndWriteAsync(op, a, b, c, d).then(function () {
      return Slot.waitDoneAsync(i32, function () {
        return copyResultsAndRelease(out);
      });
    });
  }

  function liquidFunQueryAABB(x0, y0, x1, y1, out) {
    return querySync(OP_AABB, x0, y0, x1, y1, out);
  }

  function liquidFunQueryAABBAsync(x0, y0, x1, y1, out) {
    return queryAsync(OP_AABB, x0, y0, x1, y1, out);
  }

  function liquidFunRayCast(x1, y1, x2, y2, out) {
    return querySync(OP_RAY, x1, y1, x2, y2, out);
  }

  function liquidFunRayCastAsync(x1, y1, x2, y2, out) {
    return queryAsync(OP_RAY, x1, y1, x2, y2, out);
  }

  /**
   * Physics: if a query is PENDING, run queryFn and publish results.
   * queryFn(op, a, b, c, d, resultsI32, resultCap) → hit count
   * @returns {boolean} true if a query was serviced
   */
  function servicePendingLiquidFunQuery(queryFn) {
    if (!i32 || typeof queryFn !== 'function') return false;
    if (!Slot.isPending(i32)) return false;

    var op = Atomics.load(i32, HDR_OP) | 0;
    var a = f32[COORDS_F32];
    var b = f32[COORDS_F32 + 1];
    var c = f32[COORDS_F32 + 2];
    var d = f32[COORDS_F32 + 3];
    var cap = resultCap | 0;
    var results = resultsView || i32.subarray(RESULTS_I32, RESULTS_I32 + cap);

    var status = STATUS_DONE;
    try {
      var count = queryFn(op, a, b, c, d, results, cap) | 0;
      Atomics.store(i32, HDR_COUNT, count);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      status = STATUS_ERROR;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[liquidFunQuery] service error', err);
      }
    }
    Slot.answer(i32, status);
    return true;
  }

  /**
   * Drain a burst of single-flight queries within one physics step.
   * See Box2dSyncSlot.serviceBurst.
   * @returns {number} queries serviced
   */
  function servicePendingLiquidFunQueryBurst(queryFn, maxQueries) {
    if (!i32 || typeof queryFn !== 'function') return 0;
    return Slot.serviceBurst(i32, servicePendingLiquidFunQuery, queryFn, maxQueries);
  }

  global.LiquidFunQuery = {
    STATUS_IDLE: STATUS_IDLE,
    STATUS_PENDING: STATUS_PENDING,
    STATUS_DONE: STATUS_DONE,
    STATUS_ERROR: STATUS_ERROR,
    STATUS_CLAIMED: STATUS_CLAIMED,
    OP_AABB: OP_AABB,
    OP_RAY: OP_RAY,
    DEFAULT_RESULT_CAP: DEFAULT_RESULT_CAP,
    createLiquidFunQuerySab: createLiquidFunQuerySab,
    bindLiquidFunQuerySab: bindLiquidFunQuerySab,
    isLiquidFunQueryBound: isLiquidFunQueryBound,
    liquidFunQueryAABB: liquidFunQueryAABB,
    liquidFunQueryAABBAsync: liquidFunQueryAABBAsync,
    liquidFunRayCast: liquidFunRayCast,
    liquidFunRayCastAsync: liquidFunRayCastAsync,
    servicePendingLiquidFunQuery: servicePendingLiquidFunQuery,
    servicePendingLiquidFunQueryBurst: servicePendingLiquidFunQueryBurst,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
