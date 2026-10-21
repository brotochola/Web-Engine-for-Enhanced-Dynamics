// LiquidFun extract request/response SAB — single-flight (query pattern).
// Writer claims the slot, fills indices[0..count), posts; physics answers DONE.
// Physics copies indices into WASM, ExtractParticles, writes newGroupId.
// The status word and every wait on it: box2dSyncSlotImpl.js (loaded first).

(function (global) {
  var Slot = global.Box2dSyncSlot;
  if (!Slot) throw new Error('liquidFunExtractImpl.js: load box2dSyncSlotImpl.js first');

  var STATUS_IDLE = Slot.STATUS_IDLE;
  var STATUS_PENDING = Slot.STATUS_PENDING;
  var STATUS_DONE = Slot.STATUS_DONE;
  var STATUS_ERROR = Slot.STATUS_ERROR;

  var HDR_STATUS = Slot.HDR_STATUS;
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

  function claimIdle() {
    Slot.assertWorkerThread('liquidFunExtract', 'liquidFunExtractAsync');
    if (!i32) {
      throw new Error('liquidFunExtract: SAB not bound (wait for box2dReady)');
    }
    Slot.claimSync(i32);
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
    Slot.post(i32);
  }

  function releaseAndRead() {
    var failed = Slot.isError(i32);
    var id = Atomics.load(i32, HDR_NEW_GROUP) | 0;
    Slot.release(i32);
    if (failed) return -1;
    return id;
  }

  function liquidFunExtract(groupId, indices, count, opts) {
    var o = opts || {};
    claimIdle();
    writeRequest(groupId, indices, count, o.groupFlags != null ? o.groupFlags : 0, o.trackGroup !== false);
    Slot.waitDoneSync(i32);
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
    return Slot.claimAsync(i32, function () {
      writeRequest(groupId, indices, count, o.groupFlags != null ? o.groupFlags : 0, o.trackGroup !== false);
    }).then(function () {
      return Slot.waitDoneAsync(i32, releaseAndRead);
    });
  }

  /**
   * Physics: if PENDING, extractFn(groupId, indicesI32, count, groupFlags, trackGroup) → newGroupId
   */
  function servicePendingLiquidFunExtract(extractFn) {
    if (!i32 || typeof extractFn !== 'function') return false;
    if (!Slot.isPending(i32)) return false;
    var groupId = Atomics.load(i32, HDR_GROUP_ID) | 0;
    var count = Atomics.load(i32, HDR_COUNT) | 0;
    var groupFlags = Atomics.load(i32, HDR_GROUP_FLAGS) >>> 0;
    var trackGroup = Atomics.load(i32, HDR_TRACK) | 0;
    var indices = indicesView || i32.subarray(INDICES_I32, INDICES_I32 + indexCap);
    var status = STATUS_DONE;
    try {
      var id = extractFn(groupId, indices, count, groupFlags, trackGroup) | 0;
      Atomics.store(i32, HDR_NEW_GROUP, id);
    } catch (err) {
      Atomics.store(i32, HDR_NEW_GROUP, -1);
      status = STATUS_ERROR;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[liquidFunExtract] service error', err);
      }
    }
    Slot.answer(i32, status);
    return true;
  }

  /**
   * Drain a burst of single-flight extracts within one physics step.
   * See Box2dSyncSlot.serviceBurst.
   * @returns {number} extracts serviced
   */
  function servicePendingLiquidFunExtractBurst(extractFn, maxExtracts) {
    if (!i32 || typeof extractFn !== 'function') return 0;
    return Slot.serviceBurst(i32, servicePendingLiquidFunExtract, extractFn, maxExtracts);
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
