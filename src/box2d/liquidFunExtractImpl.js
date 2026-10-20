// LiquidFun extract request/response SAB — single-flight (query pattern).
// Writer CAS IDLE→CLAIMED, fills indices[0..count), stores PENDING; physics waits DONE.
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

  var DEFAULT_INDEX_CAP = 4096;

  var i32 = null;
  var indexCap = 0;
  var indicesView = null;

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
      indicesView = null;
      return;
    }
    i32 = new Int32Array(sab);
    indexCap = Atomics.load(i32, HDR_RESULT_CAP) | 0;
    indicesView = i32.subarray(INDICES_I32, INDICES_I32 + indexCap);
  }

  function isLiquidFunExtractBound() {
    return i32 != null && indexCap > 0;
  }

  // B-04: the sync variants block with Atomics.wait, which throws a TypeError
  // on the main thread. Duplicated rather than imported because this file is a
  // dual-mode script (ESM side-effect import AND importScripts), so it cannot
  // take a dependency without changing the classic load order - the same reason
  // the header constants above are duplicated across this family.
  function assertWorkerThread(syncName, asyncName) {
    if (typeof window === 'undefined') return; // Worker has no `window`
    throw new Error(
      syncName +
        ' blocks the calling thread with Atomics.wait and cannot run on the main thread. ' +
        'Use ' +
        asyncName +
        ' instead.',
    );
  }

  function claimIdle() {
    assertWorkerThread('liquidFunExtract', 'liquidFunExtractAsync');
    if (!i32) {
      throw new Error('liquidFunExtract: SAB not bound (wait for box2dReady)');
    }
    for (;;) {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) break;
      // M4: another worker holds the slot. A block on a sibling, like the
      // wait for DONE, so it is metered too.
      var tClaim = performance.now();
      Atomics.wait(i32, HDR_STATUS, prev);
      WAIT_METER.ms += performance.now() - tClaim;
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

  // E-01: the engine blocks on a sibling in exactly one place, and this is it.
  // Fold the blocked time into the shared meter so WAIT_MS is a measurement
  // instead of a hardcoded zero. These files are UMD/IIFE loaded by
  // importScripts, so they cannot import the ESM accessor; the meter is created
  // lazily on the global that the IIFE already receives. See src/util/waitMeter.js.
  var WAIT_METER = global.__weedWaitMeter || (global.__weedWaitMeter = { ms: 0 });

  function waitUntilDoneSync() {
    var s = Atomics.load(i32, HDR_STATUS) | 0;
    if (s === STATUS_DONE || s === STATUS_ERROR) return;
    // Clock starts only once we know we are actually going to block.
    var t0 = performance.now();
    for (;;) {
      if (s === STATUS_DONE || s === STATUS_ERROR) break;
      Atomics.wait(i32, HDR_STATUS, s);
      s = Atomics.load(i32, HDR_STATUS) | 0;
    }
    WAIT_METER.ms += performance.now() - t0;
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
    var indices = indicesView || i32.subarray(INDICES_I32, INDICES_I32 + indexCap);
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

  /**
   * Drain a burst of single-flight extracts within one physics step.
   * Same spin/wait pattern as ray + LiquidFun query.
   * @returns {number} extracts serviced
   */
  function servicePendingLiquidFunExtractBurst(extractFn, maxExtracts) {
    if (!i32 || typeof extractFn !== 'function') return 0;
    var max = maxExtracts | 0;
    if (max <= 0) max = 1;
    var serviced = 0;
    while (serviced < max) {
      if (servicePendingLiquidFunExtract(extractFn)) {
        serviced++;
        continue;
      }
      if (serviced === 0) break;

      var tWait = performance.now();
      var more = waitForNextRequest();
      WAIT_METER.ms += performance.now() - tWait;
      if (!more) break;
    }
    return serviced;
  }

  /**
   * Spin, then wait up to 2 ms, for the next request of a burst. False ends the
   * burst. The physics step is blocked on a logic worker here (M4: WAIT_MS).
   */
  function waitForNextRequest() {
    for (var spin = 0; spin < 100000; spin++) {
      if ((Atomics.load(i32, HDR_STATUS) | 0) === STATUS_PENDING) return true;
    }
    var s2 = Atomics.load(i32, HDR_STATUS) | 0;
    if (s2 === STATUS_PENDING) return true;
    if (s2 === STATUS_CLAIMED) {
      Atomics.wait(i32, HDR_STATUS, STATUS_CLAIMED, 2.0);
      return true;
    }
    Atomics.wait(i32, HDR_STATUS, s2, 2.0);
    var s3 = Atomics.load(i32, HDR_STATUS) | 0;
    return s3 === STATUS_PENDING || s3 === STATUS_CLAIMED;
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
    servicePendingLiquidFunExtractBurst: servicePendingLiquidFunExtractBurst,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
