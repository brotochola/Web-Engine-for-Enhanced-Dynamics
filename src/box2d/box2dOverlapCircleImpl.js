// Box2D overlapCircle request/response SAB — single-flight (clone of QueryAABB).
// Writers: logic / Scene. Reader: weedjs_post copies world._querySlots.

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
  var HEADER_I32 = 8;
  var CIRCLE_F32 = HEADER_I32;
  var RESULTS_I32 = HEADER_I32 + 4;

  var DEFAULT_RESULT_CAP = 4096;
  var DEFAULT_CATEGORY = 1;
  var DEFAULT_MASK = 0xffffffff;

  var i32 = null;
  var f32 = null;
  var resultCap = 0;

  function createOverlapCircleSab(cap) {
    var resultCapacity = Math.max(64, (cap == null ? DEFAULT_RESULT_CAP : cap) | 0);
    var sab = new SharedArrayBuffer((RESULTS_I32 + resultCapacity) * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_COUNT, 0);
    Atomics.store(view, HDR_CATEGORY, DEFAULT_CATEGORY);
    Atomics.store(view, HDR_MASK, DEFAULT_MASK | 0);
    Atomics.store(view, HDR_RESULT_CAP, resultCapacity);
    return sab;
  }

  function bindOverlapCircleSab(sab) {
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

  function isOverlapCircleBound() {
    return i32 != null && resultCap > 0;
  }

  function assertOut(out) {
    if (!out || out.BYTES_PER_ELEMENT !== 4 || !(out instanceof Int32Array)) {
      throw new TypeError('box2dOverlapCircle: out must be Int32Array');
    }
  }

  function writeRequest(cx, cy, radius, filter) {
    f32[CIRCLE_F32] = cx;
    f32[CIRCLE_F32 + 1] = cy;
    f32[CIRCLE_F32 + 2] = radius;
    f32[CIRCLE_F32 + 3] = 0;
    var cat = filter && filter.categoryBits != null ? filter.categoryBits | 0 : DEFAULT_CATEGORY;
    var mask = filter && filter.maskBits != null ? filter.maskBits | 0 : DEFAULT_MASK;
    Atomics.store(i32, HDR_CATEGORY, cat);
    Atomics.store(i32, HDR_MASK, mask);
    Atomics.store(i32, HDR_COUNT, 0);
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function claimAndWriteSync(cx, cy, radius, filter) {
    if (!i32) throw new Error('box2dOverlapCircle: SAB not bound (wait for box2dReady)');
    for (;;) {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) break;
      Atomics.wait(i32, HDR_STATUS, prev);
    }
    writeRequest(cx, cy, radius, filter);
  }

  function claimAndWriteAsync(cx, cy, radius, filter) {
    if (!i32) {
      return Promise.reject(new Error('box2dOverlapCircle: SAB not bound (wait for box2dReady)'));
    }
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(new Error('box2dOverlapCircleAsync: Atomics.waitAsync unavailable'));
    }
    function claimLoop() {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) {
        writeRequest(cx, cy, radius, filter);
        return Promise.resolve();
      }
      var r = Atomics.waitAsync(i32, HDR_STATUS, prev);
      if (r.async === false) return claimLoop();
      return r.value.then(claimLoop);
    }
    return claimLoop();
  }

  function copyResultsAndRelease(out) {
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    if (status === STATUS_ERROR) {
      Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
      Atomics.notify(i32, HDR_STATUS, 1);
      throw new Error('box2dOverlapCircle: physics reported error');
    }
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var n = count < out.length ? count : out.length;
    var base = RESULTS_I32;
    for (var i = 0; i < n; i++) out[i] = i32[base + i] | 0;
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

  function box2dOverlapCircle(cx, cy, radius, out, filter) {
    assertOut(out);
    claimAndWriteSync(cx, cy, radius, filter);
    waitUntilDoneSync();
    return copyResultsAndRelease(out);
  }

  function box2dOverlapCircleAsync(cx, cy, radius, out, filter) {
    assertOut(out);
    return claimAndWriteAsync(cx, cy, radius, filter).then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(copyResultsAndRelease(out));
        }
        var r = Atomics.waitAsync(i32, HDR_STATUS, s);
        if (r.async === false) return waitLoop();
        return r.value.then(waitLoop);
      }
      return waitLoop();
    });
  }

  function servicePendingOverlapCircle(overlapFn) {
    if (!i32 || typeof overlapFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;
    var cx = f32[CIRCLE_F32];
    var cy = f32[CIRCLE_F32 + 1];
    var radius = f32[CIRCLE_F32 + 2];
    var cat = Atomics.load(i32, HDR_CATEGORY) | 0;
    var mask = Atomics.load(i32, HDR_MASK) | 0;
    var cap = resultCap | 0;
    var results = i32.subarray(RESULTS_I32, RESULTS_I32 + cap);
    try {
      var count = overlapFn(cx, cy, radius, cat, mask, results, cap) | 0;
      Atomics.store(i32, HDR_COUNT, count);
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[box2dOverlapCircle] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
  }

  global.Box2dOverlapCircle = {
    DEFAULT_RESULT_CAP: DEFAULT_RESULT_CAP,
    RESULTS_I32: RESULTS_I32,
    createOverlapCircleSab: createOverlapCircleSab,
    bindOverlapCircleSab: bindOverlapCircleSab,
    isOverlapCircleBound: isOverlapCircleBound,
    box2dOverlapCircle: box2dOverlapCircle,
    box2dOverlapCircleAsync: box2dOverlapCircleAsync,
    servicePendingOverlapCircle: servicePendingOverlapCircle,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
