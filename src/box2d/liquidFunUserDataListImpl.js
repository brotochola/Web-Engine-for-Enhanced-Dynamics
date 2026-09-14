// LiquidFun userData list — fire-and-forget (no Atomics.wait).
// Writer fills indices + mode/add, enqueues opcode 42.
// Physics applies on drain, then clears count.
// Do not reuse the extract SAB (same tick may extract).

(function (global) {
  var MODE_ADD = 0;
  var MODE_SET = 1;

  var HDR_COUNT = 0;
  var HDR_MODE = 1;
  var HDR_ADD_OR_BITS = 2;
  var HDR_MASK = 3;
  var HEADER_I32 = 8;
  var INDICES_I32 = HEADER_I32;
  var DEFAULT_INDEX_CAP = 4096;

  var i32 = null;
  var indexCap = 0;
  var indicesView = null;

  function createLiquidFunUserDataListSab(cap) {
    var indexCapacity = Math.max(
      64,
      (cap == null ? DEFAULT_INDEX_CAP : cap) | 0,
    );
    var sab = new SharedArrayBuffer((INDICES_I32 + indexCapacity) * 4);
    var view = new Int32Array(sab);
    view[HDR_COUNT] = 0;
    view[HDR_MODE] = MODE_ADD;
    view[HDR_ADD_OR_BITS] = 0;
    view[HDR_MASK] = 255;
    view[4] = indexCapacity;
    return sab;
  }

  function bindLiquidFunUserDataListSab(sab) {
    if (!sab) {
      i32 = null;
      indexCap = 0;
      indicesView = null;
      return;
    }
    i32 = new Int32Array(sab);
    indexCap = i32[4] | 0;
    if (!(indexCap > 0)) indexCap = DEFAULT_INDEX_CAP;
    indicesView = i32.subarray(INDICES_I32, INDICES_I32 + indexCap);
  }

  function isLiquidFunUserDataListBound() {
    return i32 != null && indexCap > 0;
  }

  function writeIndices(indices, count) {
    var n = count | 0;
    if (n < 0) n = 0;
    if (n > indexCap) n = indexCap;
    var dst = indicesView;
    if (indices && n > 0) {
      for (var i = 0; i < n; i++) dst[i] = indices[i] | 0;
    }
    return n;
  }

  function writeAdd(indices, count, add) {
    if (!i32) return false;
    var amt = add | 0;
    if (!(amt > 0)) return false;
    var n = writeIndices(indices, count);
    if (n <= 0) return false;
    i32[HDR_COUNT] = n;
    i32[HDR_MODE] = MODE_ADD;
    i32[HDR_ADD_OR_BITS] = amt;
    i32[HDR_MASK] = 255;
    return true;
  }

  function writeSet(indices, count, bits) {
    if (!i32) return false;
    var n = writeIndices(indices, count);
    if (n <= 0) return false;
    i32[HDR_COUNT] = n;
    i32[HDR_MODE] = MODE_SET;
    i32[HDR_ADD_OR_BITS] = bits >>> 0;
    i32[HDR_MASK] = 0;
    return true;
  }

  /**
   * Physics drain: mutate `userData` SoA in place. Optional fallbackSet(index, bits)
   * if userData is missing (set mode only).
   */
  function applyLiquidFunUserDataList(userData, fallbackSet) {
    if (!i32) return 0;
    var n = i32[HDR_COUNT] | 0;
    var mode = i32[HDR_MODE] | 0;
    var addOrBits = i32[HDR_ADD_OR_BITS] >>> 0;
    var mask = i32[HDR_MASK] | 0;
    if (!mask) mask = 255;
    var idx = indicesView;
    if (n > indexCap) n = indexCap;
    if (userData) {
      for (var i = 0; i < n; i++) {
        var p = idx[i] | 0;
        if (mode === MODE_SET) {
          userData[p] = addOrBits;
        } else {
          var prev = userData[p] >>> 0;
          var t = (prev & mask) + addOrBits;
          if (t > mask) t = mask;
          userData[p] = (prev & ~mask) | t;
        }
      }
    } else if (typeof fallbackSet === 'function' && mode === MODE_SET) {
      for (var j = 0; j < n; j++) fallbackSet(idx[j] | 0, addOrBits);
    }
    i32[HDR_COUNT] = 0;
    return n;
  }

  global.LiquidFunUserDataList = {
    MODE_ADD: MODE_ADD,
    MODE_SET: MODE_SET,
    DEFAULT_INDEX_CAP: DEFAULT_INDEX_CAP,
    createLiquidFunUserDataListSab: createLiquidFunUserDataListSab,
    bindLiquidFunUserDataListSab: bindLiquidFunUserDataListSab,
    isLiquidFunUserDataListBound: isLiquidFunUserDataListBound,
    writeAdd: writeAdd,
    writeSet: writeSet,
    applyLiquidFunUserDataList: applyLiquidFunUserDataList,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
