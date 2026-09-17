// Box2D castRayAll request/response SAB — single-flight.
// Hits: 4 floats each (entity, fraction, hitX, hitY).
// WASM _queryHits uses a wider stride; weedjsPost copies the first 4 floats per hit.

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
  var RAY_F32 = HEADER_I32;
  var RESULTS_F32 = HEADER_I32 + 4;
  var HIT_STRIDE = 4;

  var DEFAULT_RESULT_CAP = 256;
  var DEFAULT_CATEGORY = 1;
  var DEFAULT_MASK = 0xffffffff;

  var i32 = null;
  var f32 = null;
  var resultCap = 0;

  function createCastRayAllSab(cap) {
    var resultCapacity = Math.max(8, (cap == null ? DEFAULT_RESULT_CAP : cap) | 0);
    var sab = new SharedArrayBuffer((RESULTS_F32 + resultCapacity * HIT_STRIDE) * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_COUNT, 0);
    Atomics.store(view, HDR_CATEGORY, DEFAULT_CATEGORY);
    Atomics.store(view, HDR_MASK, DEFAULT_MASK | 0);
    Atomics.store(view, HDR_RESULT_CAP, resultCapacity);
    return sab;
  }

  function bindCastRayAllSab(sab) {
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

  function isCastRayAllBound() {
    return i32 != null && resultCap > 0;
  }

  function writeRequest(ox, oy, dx, dy, filter) {
    f32[RAY_F32] = ox;
    f32[RAY_F32 + 1] = oy;
    f32[RAY_F32 + 2] = dx;
    f32[RAY_F32 + 3] = dy;
    var cat = filter && filter.categoryBits != null ? filter.categoryBits | 0 : DEFAULT_CATEGORY;
    var mask = filter && filter.maskBits != null ? filter.maskBits | 0 : DEFAULT_MASK;
    Atomics.store(i32, HDR_CATEGORY, cat);
    Atomics.store(i32, HDR_MASK, mask);
    Atomics.store(i32, HDR_COUNT, 0);
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function claimAndWriteSync(ox, oy, dx, dy, filter) {
    if (!i32) throw new Error('box2dCastRayAll: SAB not bound (wait for box2dReady)');
    for (;;) {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) break;
      Atomics.wait(i32, HDR_STATUS, prev);
    }
    writeRequest(ox, oy, dx, dy, filter);
  }

  function claimAndWriteAsync(ox, oy, dx, dy, filter) {
    if (!i32) {
      return Promise.reject(new Error('box2dCastRayAll: SAB not bound (wait for box2dReady)'));
    }
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(new Error('box2dCastRayAllAsync: Atomics.waitAsync unavailable'));
    }
    function claimLoop() {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) {
        writeRequest(ox, oy, dx, dy, filter);
        return Promise.resolve();
      }
      var r = Atomics.waitAsync(i32, HDR_STATUS, prev);
      if (r.async === false) return claimLoop();
      return r.value.then(claimLoop);
    }
    return claimLoop();
  }

  function ensureHit(slot) {
    if (slot && typeof slot === 'object') return slot;
    return { entityIndex: -1, fraction: 0, hitX: 0, hitY: 0 };
  }

  function copyResultsAndRelease(out) {
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    if (status === STATUS_ERROR) {
      Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
      Atomics.notify(i32, HDR_STATUS, 1);
      throw new Error('box2dCastRayAll: physics reported error');
    }
    if (!Array.isArray(out)) {
      throw new TypeError('box2dCastRayAll: out must be an array');
    }
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var write = count < resultCap ? count : resultCap;
    out.length = write;
    for (var i = 0; i < write; i++) {
      var b = RESULTS_F32 + i * HIT_STRIDE;
      var h = ensureHit(out[i]);
      h.entityIndex = f32[b] | 0;
      h.fraction = f32[b + 1];
      h.hitX = f32[b + 2];
      h.hitY = f32[b + 3];
      out[i] = h;
    }
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

  function box2dCastRayAll(ox, oy, dx, dy, out, filter) {
    var dest = out || [];
    claimAndWriteSync(ox, oy, dx, dy, filter);
    waitUntilDoneSync();
    return copyResultsAndRelease(dest);
  }

  function box2dCastRayAllAsync(ox, oy, dx, dy, out, filter) {
    var dest = out || [];
    return claimAndWriteAsync(ox, oy, dx, dy, filter).then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(copyResultsAndRelease(dest));
        }
        var r = Atomics.waitAsync(i32, HDR_STATUS, s);
        if (r.async === false) return waitLoop();
        return r.value.then(waitLoop);
      }
      return waitLoop();
    });
  }

  function servicePendingCastRayAll(castFn) {
    if (!i32 || typeof castFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;
    var ox = f32[RAY_F32];
    var oy = f32[RAY_F32 + 1];
    var dx = f32[RAY_F32 + 2];
    var dy = f32[RAY_F32 + 3];
    var cat = Atomics.load(i32, HDR_CATEGORY) | 0;
    var mask = Atomics.load(i32, HDR_MASK) | 0;
    var hits = f32.subarray(RESULTS_F32, RESULTS_F32 + resultCap * HIT_STRIDE);
    try {
      var count = castFn(ox, oy, dx, dy, cat, mask, hits, resultCap) | 0;
      Atomics.store(i32, HDR_COUNT, count);
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[box2dCastRayAll] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
  }

  global.Box2dCastRayAll = {
    DEFAULT_RESULT_CAP: DEFAULT_RESULT_CAP,
    HIT_STRIDE: HIT_STRIDE,
    RESULTS_F32: RESULTS_F32,
    createCastRayAllSab: createCastRayAllSab,
    bindCastRayAllSab: bindCastRayAllSab,
    isCastRayAllBound: isCastRayAllBound,
    box2dCastRayAll: box2dCastRayAll,
    box2dCastRayAllAsync: box2dCastRayAllAsync,
    servicePendingCastRayAll: servicePendingCastRayAll,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
