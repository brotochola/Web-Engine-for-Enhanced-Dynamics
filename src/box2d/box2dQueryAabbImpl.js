// Box2D QueryAABB request/response SAB — single-flight (one outstanding query).
// ESM: imported as side-effect by box2dQueryAabb.js
// Classic: importScripts from weedjsPost.js
// Writers: logic / GameObject / Scene (main async). Reader+filler: weedjs_post doStep.
// The status word and every wait on it: box2dSyncSlotImpl.js (loaded first).
//
// Caller claims the slot, writes AABB+filter, posts, waits DONE/ERROR,
// copies results into out, releases.
// Physics: if PENDING, overlapAABB → results, COUNT, DONE, notify.

(function (global) {
  var Slot = global.Box2dSyncSlot;
  if (!Slot) throw new Error('box2dQueryAabbImpl.js: load box2dSyncSlotImpl.js first');

  var STATUS_IDLE = Slot.STATUS_IDLE;
  var STATUS_PENDING = Slot.STATUS_PENDING;
  var STATUS_DONE = Slot.STATUS_DONE;
  var STATUS_ERROR = Slot.STATUS_ERROR;
  var STATUS_CLAIMED = Slot.STATUS_CLAIMED;

  var HDR_STATUS = Slot.HDR_STATUS;
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
    Slot.post(i32);
  }

  function claimAndWriteSync(x0, y0, x1, y1, filter) {
    Slot.assertWorkerThread('box2dQueryAABB', 'box2dQueryAABBAsync');
    if (!i32) {
      throw new Error('box2dQueryAABB: SAB not bound (wait for box2dReady)');
    }
    Slot.claimSync(i32);
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
    return Slot.claimAsync(i32, function () {
      writeRequest(x0, y0, x1, y1, filter);
    });
  }

  function copyResultsAndRelease(out) {
    if (Slot.isError(i32)) {
      Slot.release(i32);
      throw new Error('box2dQueryAABB: physics reported error');
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

  /**
   * Sync QueryAABB (logic workers / GameObject). Blocks with Atomics.wait.
   * @returns {number} entities found, each once (may exceed out.length)
   */
  function box2dQueryAABB(x0, y0, x1, y1, out, filter) {
    assertOut(out);
    claimAndWriteSync(x0, y0, x1, y1, filter);
    Slot.waitDoneSync(i32);
    return copyResultsAndRelease(out);
  }

  /**
   * Async QueryAABB for main thread (Atomics.waitAsync).
   * @returns {Promise<number>}
   */
  function box2dQueryAABBAsync(x0, y0, x1, y1, out, filter) {
    assertOut(out);
    return claimAndWriteAsync(x0, y0, x1, y1, filter).then(function () {
      return Slot.waitDoneAsync(i32, function () {
        return copyResultsAndRelease(out);
      });
    });
  }

  /**
   * Physics: if a query is PENDING, run overlapFn and publish results.
   * overlapFn(x0,y0,x1,y1,categoryBits,maskBits,resultsI32,resultCap) → hit count
   * (writes up to resultCap slots into resultsI32; a count above resultCap is
   * published as resultCap, since only that many slots hold ids).
   * @returns {boolean} true if a query was serviced
   */
  function servicePendingQuery(overlapFn) {
    if (!i32 || typeof overlapFn !== 'function') return false;
    if (!Slot.isPending(i32)) return false;

    var x0 = f32[AABB_F32];
    var y0 = f32[AABB_F32 + 1];
    var x1 = f32[AABB_F32 + 2];
    var y1 = f32[AABB_F32 + 3];
    var cat = Atomics.load(i32, HDR_CATEGORY) | 0;
    var mask = Atomics.load(i32, HDR_MASK) | 0;
    var cap = resultCap | 0;
    var results = i32.subarray(RESULTS_I32, RESULTS_I32 + cap);

    var status = STATUS_DONE;
    try {
      var count = overlapFn(x0, y0, x1, y1, cat, mask, results, cap) | 0;
      Atomics.store(i32, HDR_COUNT, count < cap ? count : cap);
    } catch (err) {
      Atomics.store(i32, HDR_COUNT, 0);
      status = STATUS_ERROR;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[box2dQueryAABB] service error', err);
      }
    }
    Slot.answer(i32, status);
    return true;
  }

  // Physics side of queryAABB and overlapCircle: copy the WASM query slots into
  // a results view. Since N-22 the WASM lists each body once and stops at
  // slots.length bodies (its query capacity); before, it listed a compound body
  // once per shape, and the first-wins dedupe here stays for a wasm of that age.
  // Reaching the capacity means bodies past it were not listed: warned once per
  // query kind.
  var seenStamp = new Int32Array(0);
  var seenGen = 0;
  var capacityWarned = Object.create(null);

  function copyUniqueSlots(slots, n, results, cap, kind) {
    if (n >= slots.length) {
      n = slots.length;
      if (!capacityWarned[kind] && typeof console !== 'undefined' && console.warn) {
        capacityWarned[kind] = true;
        console.warn(
          '[Box2d.' + kind + '] reached the WASM query capacity (' + n +
            ' bodies): bodies past it are not listed. Query a smaller area.',
        );
      }
    }
    if (++seenGen === 0x40000000) {
      seenStamp.fill(0);
      seenGen = 1;
    }
    var w = 0;
    for (var i = 0; i < n && w < cap; i++) {
      var s = slots[i] | 0;
      if (s >= seenStamp.length) {
        var grown = new Int32Array(Math.max(s + 1, seenStamp.length * 2, 1024));
        grown.set(seenStamp);
        seenStamp = grown;
      }
      if (seenStamp[s] === seenGen) continue;
      seenStamp[s] = seenGen;
      results[w++] = s;
    }
    return w;
  }

  // Wake the physics thread between frames. A sync query posted after doStep
  // otherwise waits for the next requestAnimationFrame (~16 ms inside logic's step).
  function armPendingWake(onPending) {
    return Slot.armPendingWake(i32, onPending);
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
    copyUniqueSlots: copyUniqueSlots,
    armPendingWake: armPendingWake,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
