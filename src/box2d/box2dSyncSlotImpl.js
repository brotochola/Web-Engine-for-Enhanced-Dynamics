// Single-flight request slot shared by the sync query SABs: QueryAABB,
// overlapCircle, closest ray (single and batch), castRayAll, LiquidFun
// query and extract. Each keeps its own header and payload; this file owns
// the status word at i32[0] and every wait on it.
// ESM: imported by each facade before its impl. Classic: importScripts from
// weedjsPost.js, before the impls. The impls read it from the global at load.
//
// STATUS: IDLE=0 PENDING=1 DONE=2 ERROR=3 CLAIMED=4
// Caller CAS IDLE→CLAIMED, writes its request, stores PENDING, waits DONE/ERROR,
// reads, stores IDLE. Physics: if PENDING, answers, stores DONE (or ERROR), notifies.

(function (global) {
  var STATUS_IDLE = 0;
  var STATUS_PENDING = 1;
  var STATUS_DONE = 2;
  var STATUS_ERROR = 3;
  var STATUS_CLAIMED = 4;

  var HDR_STATUS = 0;

  // A burst's spin for the next request. A caller's turnaround (wake from its
  // wait, read, next claim) is tens of microseconds; ~25k loads is ~0.1 ms.
  var SPIN_LOADS = 25000;

  // E-01: blocking on a sibling is folded into the shared meter so WAIT_MS is a
  // measurement. A classic script cannot import the ESM accessor, so the meter is
  // created lazily on the global. See src/util/waitMeter.js.
  var WAIT_METER = global.__weedWaitMeter || (global.__weedWaitMeter = { ms: 0 });

  // B-04: the sync calls block with Atomics.wait, which throws a TypeError on
  // the main thread and names neither the thread nor the variant that works.
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

  /** Logic: take the slot. Waiting on another worker that holds it is metered (M4). */
  function claimSync(i32) {
    for (;;) {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) return;
      var tClaim = performance.now();
      Atomics.wait(i32, HDR_STATUS, prev);
      WAIT_METER.ms += performance.now() - tClaim;
    }
  }

  /** Main: take the slot; `write` runs at the claim, before the promise resolves. */
  function claimAsync(i32, write) {
    function claimLoop() {
      var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
      if (prev === STATUS_IDLE) {
        write();
        return Promise.resolve();
      }
      var r = Atomics.waitAsync(i32, HDR_STATUS, prev);
      if (r.async === false) return claimLoop();
      return r.value.then(claimLoop);
    }
    return claimLoop();
  }

  /** Logic: block until DONE or ERROR. The clock starts only when it actually blocks. */
  function waitDoneSync(i32) {
    var s = Atomics.load(i32, HDR_STATUS) | 0;
    if (s === STATUS_DONE || s === STATUS_ERROR) return;
    var t0 = performance.now();
    for (;;) {
      if (s === STATUS_DONE || s === STATUS_ERROR) break;
      Atomics.wait(i32, HDR_STATUS, s);
      s = Atomics.load(i32, HDR_STATUS) | 0;
    }
    WAIT_METER.ms += performance.now() - t0;
  }

  /** Main: once DONE or ERROR, resolve with `read()` (which releases the slot). */
  function waitDoneAsync(i32, read) {
    function waitLoop() {
      var s = Atomics.load(i32, HDR_STATUS) | 0;
      if (s === STATUS_DONE || s === STATUS_ERROR) return Promise.resolve(read());
      var r = Atomics.waitAsync(i32, HDR_STATUS, s);
      if (r.async === false) return waitLoop();
      return r.value.then(waitLoop);
    }
    return waitLoop();
  }

  function isError(i32) {
    return (Atomics.load(i32, HDR_STATUS) | 0) === STATUS_ERROR;
  }

  function isPending(i32) {
    return (Atomics.load(i32, HDR_STATUS) | 0) === STATUS_PENDING;
  }

  /** Request side: free the slot for the next caller. */
  function release(i32) {
    Atomics.store(i32, HDR_STATUS, STATUS_IDLE);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  /** Request side: the request is written; hand it to physics. */
  function post(i32) {
    Atomics.store(i32, HDR_STATUS, STATUS_PENDING);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  /** Physics: the answer is written (DONE) or the service threw (ERROR). */
  function answer(i32, status) {
    Atomics.store(i32, HDR_STATUS, status);
    Atomics.notify(i32, HDR_STATUS, 1);
  }

  /**
   * Physics: spin for the next request of a burst. False ends the burst. A
   * request that comes later is answered by the physics host's wake between
   * steps (E-56), so the step no longer waits up to 2 ms for it. The step is
   * blocked on a logic worker here (M4: WAIT_MS).
   */
  function waitForNextRequest(i32) {
    for (var spin = 0; spin < SPIN_LOADS; spin++) {
      if ((Atomics.load(i32, HDR_STATUS) | 0) === STATUS_PENDING) return true;
    }
    return false;
  }

  /**
   * Physics: drain a burst of single-flight requests within one step. After DONE
   * the caller's turnaround is microseconds (IDLE→CLAIMED→PENDING), so a spin
   * catches it; the timed wait is the fallback when the caller pauses.
   * `serviceOne(arg)` returns 0 when nothing is pending, 2 for a request that
   * ends the burst (a ray batch), anything else truthy for one request.
   * @returns {number} requests serviced
   */
  function serviceBurst(i32, serviceOne, arg, maxRequests) {
    var max = maxRequests | 0;
    if (max <= 0) max = 1;
    var serviced = 0;
    while (serviced < max) {
      var kind = serviceOne(arg);
      if (kind) {
        serviced++;
        if (kind === 2) break;
        continue;
      }
      if (serviced === 0) break;

      var tWait = performance.now();
      var more = waitForNextRequest(i32);
      WAIT_METER.ms += performance.now() - tWait;
      if (!more) break;
    }
    return serviced;
  }

  /**
   * Physics: call `onPending` when the slot next reads PENDING (now, if it does).
   * @returns {boolean} false when it could not arm (no Atomics.waitAsync, or it
   *   fired synchronously)
   */
  function armPendingWake(i32, onPending) {
    if (!i32 || typeof onPending !== 'function' || typeof Atomics.waitAsync !== 'function') return false;
    var status = Atomics.load(i32, HDR_STATUS) | 0;
    if (status === STATUS_PENDING) {
      onPending();
      return true;
    }
    var wait = Atomics.waitAsync(i32, HDR_STATUS, status);
    if (!wait || wait.async === false) {
      onPending();
      return false;
    }
    wait.value.then(function () {
      onPending();
    });
    return true;
  }

  global.Box2dSyncSlot = {
    STATUS_IDLE: STATUS_IDLE,
    STATUS_PENDING: STATUS_PENDING,
    STATUS_DONE: STATUS_DONE,
    STATUS_ERROR: STATUS_ERROR,
    STATUS_CLAIMED: STATUS_CLAIMED,
    HDR_STATUS: HDR_STATUS,
    assertWorkerThread: assertWorkerThread,
    claimSync: claimSync,
    claimAsync: claimAsync,
    waitDoneSync: waitDoneSync,
    waitDoneAsync: waitDoneAsync,
    isError: isError,
    isPending: isPending,
    release: release,
    post: post,
    answer: answer,
    waitForNextRequest: waitForNextRequest,
    serviceBurst: serviceBurst,
    armPendingWake: armPendingWake,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
