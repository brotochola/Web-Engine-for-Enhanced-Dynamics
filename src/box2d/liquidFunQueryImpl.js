// LiquidFun QueryAABB / RayCast request/response SAB — single-flight.
// ESM: imported as side-effect by liquidFunQuery.js
// Classic: importScripts from weedjs_post.js
// Writers: logic / GameObject / Scene (main async). Reader+filler: weedjs_post doStep.
//
// STATUS: IDLE=0 PENDING=1 DONE=2 ERROR=3 CLAIMED=4
// OP: AABB=0 RAY=1
// Caller CAS IDLE→CLAIMED, writes OP+coords, stores PENDING, waits DONE/ERROR,
// copies results into out, stores IDLE.
// Physics: if PENDING, particle query → results, COUNT, DONE, notify.

(function (global) {
  var STATUS_IDLE = 0;
  var STATUS_PENDING = 1;
  var STATUS_DONE = 2;
  var STATUS_ERROR = 3;
  var STATUS_CLAIMED = 4;

  var OP_AABB = 0;
  var OP_RAY = 1;

  var HDR_STATUS = 0;
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
      return;
    }
    i32 = new Int32Array(sab);
    f32 = new Float32Array(sab);
    resultCap = Atomics.load(i32, HDR_RESULT_CAP) | 0;
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
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function claimAndWriteSync(op, a, b, c, d) {
    if (!i32) {
      throw new Error('liquidFunQuery: SAB not bound (wait for box2dReady)');
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

    function claimLoop() {
      var prev = Atomics.compareExchange(
        i32,
        HDR_STATUS,
        STATUS_IDLE,
        STATUS_CLAIMED,
      );
      if (prev === STATUS_IDLE) {
        writeRequest(op, a, b, c, d);
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

  function copyResultsAndRelease(out) {
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    if (status === STATUS_ERROR) {
      Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
      Atomics.notify(i32, HDR_STATUS, 1);
      throw new Error('liquidFunQuery: physics reported error');
    }
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var n = count < out.length ? count : out.length;
    var base = RESULTS_I32;
    for (var i = 0; i < n; i++) {
      out[i] = i32[base + i] | 0;
    }
    Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
    Atomics.notify(i32, HDR_STATUS, 1);
    return count;
  }

  function waitUntilDoneSync() {
    for (;;) {
      var s = Atomics.load(i32, HDR_STATUS) | 0;
      if (s === STATUS_DONE || s === STATUS_ERROR) return;
      Atomics.wait(i32, HDR_STATUS, s);
    }
  }

  function liquidFunQueryAABB(x0, y0, x1, y1, out) {
    assertOut(out);
    claimAndWriteSync(OP_AABB, x0, y0, x1, y1);
    waitUntilDoneSync();
    return copyResultsAndRelease(out);
  }

  function liquidFunQueryAABBAsync(x0, y0, x1, y1, out) {
    assertOut(out);
    return claimAndWriteAsync(OP_AABB, x0, y0, x1, y1).then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(copyResultsAndRelease(out));
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

  function liquidFunRayCast(x1, y1, x2, y2, out) {
    assertOut(out);
    claimAndWriteSync(OP_RAY, x1, y1, x2, y2);
    waitUntilDoneSync();
    return copyResultsAndRelease(out);
  }

  function liquidFunRayCastAsync(x1, y1, x2, y2, out) {
    assertOut(out);
    return claimAndWriteAsync(OP_RAY, x1, y1, x2, y2).then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(copyResultsAndRelease(out));
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
   * Physics: if a query is PENDING, run queryFn and publish results.
   * queryFn(op, a, b, c, d, resultsI32, resultCap) → hit count
   * @returns {boolean} true if a query was serviced
   */
  function servicePendingLiquidFunQuery(queryFn) {
    if (!i32 || typeof queryFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;

    var op = Atomics.load(i32, HDR_OP) | 0;
    var a = f32[COORDS_F32];
    var b = f32[COORDS_F32 + 1];
    var c = f32[COORDS_F32 + 2];
    var d = f32[COORDS_F32 + 3];
    var cap = resultCap | 0;
    var results = i32.subarray(RESULTS_I32, RESULTS_I32 + cap);

    try {
      var count = queryFn(op, a, b, c, d, results, cap) | 0;
      Atomics.store(i32, HDR_COUNT, count);
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[liquidFunQuery] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
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
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
