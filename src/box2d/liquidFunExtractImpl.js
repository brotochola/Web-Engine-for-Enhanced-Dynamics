// LiquidFun extract request/response SAB — single-flight (query pattern).
// Writer fills indices[0..count), stores PENDING, waits DONE.
// Physics copies indices into WASM, ExtractParticles, writes newGroupId.

(function (global) {
  var STATUS_IDLE = 0;
  var STATUS_PENDING = 1;
  var STATUS_DONE = 2;
  var STATUS_ERROR = 3;
  var STATUS_CLAIMED = 4;

  var HDR_STATUS = 0;
  var HDR_NEW_GROUP = 1;
  var HDR_COUNT = 2;
  var HDR_GROUP_ID = 3;
  var HDR_GROUP_FLAGS = 4;
  var HDR_TRACK = 5;
  var HDR_RESULT_CAP = 6;
  var HEADER_I32 = 8;
  var INDICES_I32 = HEADER_I32;

  var DEFAULT_INDEX_CAP = 1024;

  var i32 = null;
  var indexCap = 0;

  function createLiquidFunExtractSab(cap) {
    var indexCapacity = Math.max(
      64,
      (cap == null ? DEFAULT_INDEX_CAP : cap) | 0,
    );
    var sab = new SharedArrayBuffer((INDICES_I32 + indexCapacity) * 4);
    var view = new Int32Array(sab);
    Atomics.store(view, HDR_STATUS, STATUS_IDLE);
    Atomics.store(view, HDR_NEW_GROUP, -1);
    Atomics.store(view, HDR_COUNT, 0);
    Atomics.store(view, HDR_GROUP_ID, -1);
    Atomics.store(view, HDR_GROUP_FLAGS, 0);
    Atomics.store(view, HDR_TRACK, 1);
    Atomics.store(view, HDR_RESULT_CAP, indexCapacity);
    return sab;
  }

  function bindLiquidFunExtractSab(sab) {
    if (!sab) {
      i32 = null;
      indexCap = 0;
      return;
    }
    i32 = new Int32Array(sab);
    indexCap = Atomics.load(i32, HDR_RESULT_CAP) | 0;
  }

  function isLiquidFunExtractBound() {
    return i32 != null && indexCap > 0;
  }

  function claimIdle() {
    if (!i32) {
      throw new Error('liquidFunExtract: SAB not bound (wait for box2dReady)');
    }
    for (;;) {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) break;
      Atomics.wait(i32, HDR_STATUS, prev);
    }
  }

  function writeRequest(groupId, indices, count, groupFlags, trackGroup) {
    var n = count | 0;
    if (n < 0) n = 0;
    if (n > indexCap) n = indexCap;
    var src = indices;
    if (src && n > 0) {
      for (var i = 0; i < n; i++) {
        i32[INDICES_I32 + i] = src[i] | 0;
      }
    }
    Atomics.store(i32, HDR_GROUP_ID, groupId | 0);
    Atomics.store(i32, HDR_GROUP_FLAGS, groupFlags >>> 0);
    Atomics.store(i32, HDR_TRACK, trackGroup ? 1 : 0);
    Atomics.store(i32, HDR_COUNT, n);
    Atomics.store(i32, HDR_NEW_GROUP, -1);
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  function waitUntilDoneSync() {
    for (;;) {
      var s = Atomics.load(i32, HDR_STATUS) | 0;
      if (s === STATUS_DONE || s === STATUS_ERROR) return;
      Atomics.wait(i32, HDR_STATUS, s);
    }
  }

  function releaseAndRead() {
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    var id = Atomics.load(i32, HDR_NEW_GROUP) | 0;
    Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
    Atomics.notify(i32, HDR_STATUS, 1);
    if (status === STATUS_ERROR) return -1;
    return id;
  }

  function liquidFunExtract(groupId, indices, count, opts) {
    var o = opts || {};
    claimIdle();
    writeRequest(groupId, indices, count, o.groupFlags != null ? o.groupFlags : 0, o.trackGroup !== false);
    waitUntilDoneSync();
    return releaseAndRead();
  }

  function liquidFunExtractAsync(groupId, indices, count, opts) {
    var o = opts || {};
    if (typeof Atomics.waitAsync !== 'function') {
      return Promise.reject(new Error('liquidFunExtractAsync: Atomics.waitAsync unavailable'));
    }
    if (!i32) {
      return Promise.reject(new Error('liquidFunExtract: SAB not bound (wait for box2dReady)'));
    }
    function claimLoop() {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) {
        writeRequest(groupId, indices, count, o.groupFlags != null ? o.groupFlags : 0, o.trackGroup !== false);
        return Promise.resolve();
      }
      var r = Atomics.waitAsync(i32, HDR_STATUS, prev);
      if (r.async === false) return claimLoop();
      return r.value.then(claimLoop);
    }
    return claimLoop().then(function () {
      function waitLoop() {
        var s = Atomics.load(i32, HDR_STATUS) | 0;
        if (s === STATUS_DONE || s === STATUS_ERROR) {
          return Promise.resolve(releaseAndRead());
        }
        var r = Atomics.waitAsync(i32, HDR_STATUS, s);
        if (r.async === false) return waitLoop();
        return r.value.then(waitLoop);
      }
      return waitLoop();
    });
  }

  /**
   * Physics: if PENDING, extractFn(groupId, indicesI32, count, groupFlags, trackGroup) → newGroupId
   */
  function servicePendingLiquidFunExtract(extractFn) {
    if (!i32 || typeof extractFn !== 'function') return false;
    if ((Atomics.load(i32, HDR_STATUS) | 0) !== STATUS_PENDING) return false;
    var groupId = Atomics.load(i32, HDR_GROUP_ID) | 0;
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var groupFlags = Atomics.load(i32, HDR_GROUP_FLAGS) >>> 0;
    var trackGroup = Atomics.load(i32, HDR_TRACK) | 0;
    var indices = i32.subarray(INDICES_I32, INDICES_I32 + indexCap);
    try {
      var id = extractFn(groupId, indices, count, groupFlags, trackGroup) | 0;
      Atomics.store(i32, HDR_NEW_GROUP, id);
      Atomics.store(i32, HDR_STATUS, STATUS_DONE);
    } catch (err) {
      Atomics.store(i32, HDR_NEW_GROUP, -1);
      Atomics.store(i32, HDR_STATUS, STATUS_ERROR);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[liquidFunExtract] service error', err);
      }
    }
    Atomics.notify(i32, HDR_STATUS, 1);
    return true;
  }

  global.LiquidFunExtract = {
    STATUS_IDLE: STATUS_IDLE,
    STATUS_PENDING: STATUS_PENDING,
    STATUS_DONE: STATUS_DONE,
    STATUS_ERROR: STATUS_ERROR,
    DEFAULT_INDEX_CAP: DEFAULT_INDEX_CAP,
    createLiquidFunExtractSab: createLiquidFunExtractSab,
    bindLiquidFunExtractSab: bindLiquidFunExtractSab,
    isLiquidFunExtractBound: isLiquidFunExtractBound,
    liquidFunExtract: liquidFunExtract,
    liquidFunExtractAsync: liquidFunExtractAsync,
    servicePendingLiquidFunExtract: servicePendingLiquidFunExtract,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
