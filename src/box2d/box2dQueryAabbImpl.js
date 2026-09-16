// Box2D QueryAABB request/response SAB — single-flight (one outstanding query).
// ESM: imported as side-effect by box2dQueryAabb.js
// Classic: importScripts from weedjs_post.js
// Writers: logic / GameObject / Scene (main async). Reader+filler: weedjs_post doStep.
//
// STATUS: IDLE=0 PENDING=1 DONE=2 ERROR=3 CLAIMED=4
// Caller CAS IDLE→CLAIMED, writes AABB+filter, stores PENDING, waits DONE/ERROR,
// copies results into out, stores IDLE.
// Physics: if PENDING, overlapAABB → results, COUNT, DONE, notify.

(function (global) {
  var STATUS_IDLE = 0;
  var STATUS_PENDING = 1;
  var STATUS_DONE = 2;
  var STATUS_ERROR = 3;
  var STATUS_CLAIMED = 4;

  var HDR_STATUS = 0;
  var HDR_COUNT = 1;
  var HDR_CATEGORY = 2;
  var HDR_MASK = 3;
  var HDR_RESULT_CAP = 4;
  // 5..7 reserved
  var HEADER_I32 = 8;
  var AABB_F32 = HEADER_I32; // x0,y0,x1,y1 at f32[8..11]
  var RESULTS_I32 = HEADER_I32 + 4; // after 4 AABB floats

  var DEFAULT_RESULT_CAP = 4096;
  var DEFAULT_CATEGORY = 1;
  var DEFAULT_MASK = 0xffffffff;

  var i32 = null;
  var f32 = null;
  var resultCap = 0;

  function createQueryAabbSab(cap) {
    var resultCapacity = Math.max(
      64,
      (cap == null ? DEFAULT_RESULT_CAP : cap) | 0,
    );
    var i32Count = RESULTS_I32 + resultCapacity;
    var sab = new SharedArrayBuffer(i32Count * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_COUNT, 0);
    Atomics.store(view, HDR_CATEGORY, DEFAULT_CATEGORY);
    Atomics.store(view, HDR_MASK, DEFAULT_MASK | 0);
    Atomics.store(view, HDR_RESULT_CAP, resultCapacity);
    return sab;
  }

  function bindQueryAabbSab(sab) {
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

  function isQueryAabbBound() {
    return i32 != null && resultCap > 0;
  }

  function assertOut(out) {
    if (!out || out.BYTES_PER_ELEMENT !== 4 || !(out instanceof Int32Array)) {
      throw new TypeError('box2dQueryAABB: out must be Int32Array');
    }
  }

  function writeRequest(x0, y0, x1, y1, filter) {
    f32[AABB_F32] = x0;
    f32[AABB_F32 + 1] = y0;
    f32[AABB_F32 + 2] = x1;
    f32[AABB_F32 + 3] = y1;
    var cat =
      filter && filter.categoryBits != null
        ? filter.categoryBits | 0
        : DEFAULT_CATEGORY;
    var mask =
      filter && filter.maskBits != null
        ? filter.maskBits | 0
        : DEFAULT_MASK;
    Atomics.store(i32, HDR_CATEGORY, cat);
    Atomics.store(i32, HDR_MASK, mask);
    Atomics.store(i32, HDR_COUNT, 0);
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function claimAndWriteSync(x0, y0, x1, y1, filter) {
    if (!i32) {
      throw new Error('box2dQueryAABB: SAB not bound (wait for box2dReady)');
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
    writeRequest(x0, y0, x1, y1, filter);
  }

  function claimAndWriteAsync(x0, y0, x1, y1, filter) {
    if (!i32) {
      return Promise.reject(
        new Error('box2dQueryAABB: SAB not bound (wait for box2dReady)'),
      );
    }
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(
        new Error('box2dQueryAABBAsync: Atomics.waitAsync unavailable'),
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
        writeRequest(x0, y0, x1, y1, filter);
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
      throw new Error('box2dQueryAABB: physics reported error');
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

  /**
   * Sync QueryAABB (logic workers / GameObject). Blocks with Atomics.wait.
   * @returns {number} full hit count (may exceed out.length)
   */
  function box2dQueryAABB(x0, y0, x1, y1, out, filter) {
    assertOut(out);
    claimAndWriteSync(x0, y0, x1, y1, filter);
    waitUntilDoneSync();
    return copyResultsAndRelease(out);
  }

  /**
   * Async QueryAABB for main thread (Atomics.waitAsync).
   * @returns {Promise<number>}
   */
  function box2dQueryAABBAsync(x0, y0, x1, y1, out, filter) {
    assertOut(out);
    return claimAndWriteAsync(x0, y0, x1, y1, filter).then(function () {
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
   * Physics: if a query is PENDING, run overlapFn and publish results.
   * overlapFn(x0,y0,x1,y1,categoryBits,maskBits,resultsI32,resultCap) → hit count
   * (writes up to resultCap slots into resultsI32; may return count > resultCap).
   * @returns {boolean} true if a query was serviced
   */
  function servicePendingQuery(overlapFn) {
    if (!i32 || typeof overlapFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;

    var x0 = f32[AABB_F32];
    var y0 = f32[AABB_F32 + 1];
    var x1 = f32[AABB_F32 + 2];
    var y1 = f32[AABB_F32 + 3];
    var cat = Atomics.load(i32, HDR_CATEGORY) | 0;
    var mask = Atomics.load(i32, HDR_MASK) | 0;
    var cap = resultCap | 0;
    var results = i32.subarray(RESULTS_I32, RESULTS_I32 + cap);

    try {
      var count = overlapFn(x0, y0, x1, y1, cat, mask, results, cap) | 0;
      Atomics.store(i32, HDR_COUNT, count);
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[box2dQueryAABB] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
  }

  global.Box2dQueryAabb = {
    STATUS_IDLE: STATUS_IDLE,
    STATUS_PENDING: STATUS_PENDING,
    STATUS_DONE: STATUS_DONE,
    STATUS_ERROR: STATUS_ERROR,
    STATUS_CLAIMED: STATUS_CLAIMED,
    DEFAULT_RESULT_CAP: DEFAULT_RESULT_CAP,
    createQueryAabbSab: createQueryAabbSab,
    bindQueryAabbSab: bindQueryAabbSab,
    isQueryAabbBound: isQueryAabbBound,
    box2dQueryAABB: box2dQueryAABB,
    box2dQueryAABBAsync: box2dQueryAABBAsync,
    servicePendingQuery: servicePendingQuery,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
