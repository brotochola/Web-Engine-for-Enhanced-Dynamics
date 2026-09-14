// Box2D contact/sensor event ring — SPMC (one weedjs_post producer, N logic consumers).
// Per-record commit sequence; each consumer keeps a private read cursor.
// Producer overwrites freely. Consumer detects write-read > capacity as overrun
// and jumps cursor (caller must clear pair state).

(function (global) {
  var BOX2D_CONTACT_KIND = Object.freeze({
    CONTACT_BEGIN: 1,
    CONTACT_END: 2,
    SENSOR_BEGIN: 3,
    SENSOR_END: 4,
  });

  var BOX2D_CONTACT_HEADER_I32 = 4;
  var BOX2D_CONTACT_STRIDE_I32 = 6; // seq, kind, a, b, genA, genB
  // Dense spawn scenes (10k+ bodies) can emit >>8k begin/end events before
  // logic drains once; 64k ≈ 1.5MB SAB and covers Predator-scale bursts.
  var BOX2D_CONTACT_DEFAULT_CAPACITY = 65536;

  var HDR_WRITE = 0;
  var HDR_CAP = 1;
  var HDR_OVERFLOW = 2;

  var ringI32 = null;
  var capacity = 0;

  function createContactRingSab(eventCapacity) {
    var cap = Math.max(
      256,
      (eventCapacity == null ? BOX2D_CONTACT_DEFAULT_CAPACITY : eventCapacity) | 0,
    );
    var bytes = (BOX2D_CONTACT_HEADER_I32 + cap * BOX2D_CONTACT_STRIDE_I32) * 4;
    var sab = new SharedArrayBuffer(bytes);
    var i32 = new Int32Array(sab);
    Atomics.store(i32, HDR_WRITE, 0);
    Atomics.store(i32, HDR_CAP, cap);
    Atomics.store(i32, HDR_OVERFLOW, 0);
    for (var i = 0; i < cap; i++) {
      i32[BOX2D_CONTACT_HEADER_I32 + i * BOX2D_CONTACT_STRIDE_I32] = 0;
    }
    return sab;
  }

  function bindContactRing(sab) {
    if (!sab) {
      ringI32 = null;
      capacity = 0;
      return;
    }
    ringI32 = new Int32Array(sab);
    capacity = Atomics.load(ringI32, HDR_CAP) | 0;
  }

  function isContactRingBound() {
    return ringI32 != null && capacity > 0;
  }

  function publishContactEvent(kind, entityA, entityB, genA, genB) {
    if (!ringI32) return false;
    var cap = capacity;
    var write = Atomics.add(ringI32, HDR_WRITE, 1);
    var base = BOX2D_CONTACT_HEADER_I32 + (write % cap) * BOX2D_CONTACT_STRIDE_I32;
    ringI32[base + 1] = kind | 0;
    ringI32[base + 2] = entityA | 0;
    ringI32[base + 3] = entityB | 0;
    ringI32[base + 4] = genA | 0;
    ringI32[base + 5] = genB | 0;
    Atomics.store(ringI32, base, write + 1);
    return true;
  }

  /**
   * Drain from consumerCursor (monotonic). Returns { nextCursor, count, overrun }.
   * onEvent(kind, a, b, genA, genB) called in order when records available.
   */
  function drainContactRing(i32, consumerCursor, onEvent) {
    if (!i32 || !onEvent) {
      return { nextCursor: consumerCursor | 0, count: 0, overrun: false };
    }
    var cap = i32[HDR_CAP] | 0;
    if (!(cap > 0)) {
      return { nextCursor: consumerCursor | 0, count: 0, overrun: false };
    }
    var write = Atomics.load(i32, HDR_WRITE);
    var read = consumerCursor | 0;
    if (write - read > cap) {
      Atomics.add(i32, HDR_OVERFLOW, 1);
      return { nextCursor: write, count: 0, overrun: true };
    }
    var n = 0;
    while (read < write) {
      var base = BOX2D_CONTACT_HEADER_I32 + (read % cap) * BOX2D_CONTACT_STRIDE_I32;
      if (Atomics.load(i32, base) !== read + 1) break;
      onEvent(
        i32[base + 1] | 0,
        i32[base + 2] | 0,
        i32[base + 3] | 0,
        i32[base + 4] | 0,
        i32[base + 5] | 0,
      );
      read++;
      n++;
    }
    return { nextCursor: read, count: n, overrun: false };
  }

  function getContactRingOverflow(i32) {
    if (!i32) return 0;
    return Atomics.load(i32, HDR_OVERFLOW) | 0;
  }

  /**
   * Snap consumer cursor to producer write head (late bind / cold start).
   * Logic has no pair state yet — replaying a partial backlog is worse than
   * starting clean (End without Begin, or Begin for contacts already settled).
   */
  function initialContactCursor(i32) {
    if (!i32) return 0;
    return Atomics.load(i32, HDR_WRITE) | 0;
  }

  global.Box2dContactRing = {
    BOX2D_CONTACT_KIND: BOX2D_CONTACT_KIND,
    BOX2D_CONTACT_HEADER_I32: BOX2D_CONTACT_HEADER_I32,
    BOX2D_CONTACT_STRIDE_I32: BOX2D_CONTACT_STRIDE_I32,
    BOX2D_CONTACT_DEFAULT_CAPACITY: BOX2D_CONTACT_DEFAULT_CAPACITY,
    createContactRingSab: createContactRingSab,
    bindContactRing: bindContactRing,
    isContactRingBound: isContactRingBound,
    publishContactEvent: publishContactEvent,
    drainContactRing: drainContactRing,
    getContactRingOverflow: getContactRingOverflow,
    initialContactCursor: initialContactCursor,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
