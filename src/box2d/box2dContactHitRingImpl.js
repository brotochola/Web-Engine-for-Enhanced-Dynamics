// Box2D contact-hit event ring — SPMC (weedjs_post producer, N logic consumers).
// Record (f32 dual-view on i32 seq/ids): seq, entityA, entityB, genA, genB, px, py, nx, ny, speed

(function (global) {
  var BOX2D_HIT_HEADER_I32 = 4;
  var BOX2D_HIT_STRIDE_I32 = 10; // seq,a,b,genA,genB,px,py,nx,ny,speed (last 5 as f32)
  var BOX2D_HIT_DEFAULT_CAPACITY = 8192;

  var HDR_WRITE = 0;
  var HDR_CAP = 1;
  var HDR_OVERFLOW = 2;

  var ringI32 = null;
  var ringF32 = null;
  var capacity = 0;

  function createContactHitRingSab(eventCapacity) {
    var cap = Math.max(
      256,
      (eventCapacity == null ? BOX2D_HIT_DEFAULT_CAPACITY : eventCapacity) | 0,
    );
    var bytes = (BOX2D_HIT_HEADER_I32 + cap * BOX2D_HIT_STRIDE_I32) * 4;
    var sab = new SharedArrayBuffer(bytes);
    var i32 = new Int32Array(sab);
    Atomics.store(i32, HDR_WRITE, 0);
    Atomics.store(i32, HDR_CAP, cap);
    Atomics.store(i32, HDR_OVERFLOW, 0);
    for (var i = 0; i < cap; i++) {
      i32[BOX2D_HIT_HEADER_I32 + i * BOX2D_HIT_STRIDE_I32] = 0;
    }
    return sab;
  }

  function bindContactHitRing(sab) {
    if (!sab) {
      ringI32 = null;
      ringF32 = null;
      capacity = 0;
      return;
    }
    ringI32 = new Int32Array(sab);
    ringF32 = new Float32Array(sab);
    capacity = Atomics.load(ringI32, HDR_CAP) | 0;
  }

  function isContactHitRingBound() {
    return ringI32 != null && capacity > 0;
  }

  function publishContactHit(entityA, entityB, genA, genB, px, py, nx, ny, speed) {
    if (!ringI32 || !ringF32) return false;
    var cap = capacity;
    var write = Atomics.add(ringI32, HDR_WRITE, 1);
    var base = BOX2D_HIT_HEADER_I32 + (write % cap) * BOX2D_HIT_STRIDE_I32;
    ringI32[base + 1] = entityA | 0;
    ringI32[base + 2] = entityB | 0;
    ringI32[base + 3] = genA | 0;
    ringI32[base + 4] = genB | 0;
    ringF32[base + 5] = px;
    ringF32[base + 6] = py;
    ringF32[base + 7] = nx;
    ringF32[base + 8] = ny;
    ringF32[base + 9] = speed;
    Atomics.store(ringI32, base, write + 1);
    return true;
  }

  function drainContactHitRing(i32, f32, consumerCursor, onHit) {
    if (!i32 || !f32 || !onHit) {
      return { nextCursor: consumerCursor | 0, count: 0, overrun: false };
    }
    var cap = i32[HDR_CAP] | 0;
    if (!(cap > 0)) {
      return { nextCursor: consumerCursor | 0, count: 0, overrun: false };
    }
    var write = Atomics.load(i32, HDR_WRITE) | 0;
    var read = consumerCursor | 0;
    if (write - read > cap) {
      return { nextCursor: write, count: 0, overrun: true };
    }
    var n = 0;
    while (read < write) {
      var base = BOX2D_HIT_HEADER_I32 + (read % cap) * BOX2D_HIT_STRIDE_I32;
      if (Atomics.load(i32, base) !== read + 1) break;
      onHit(
        i32[base + 1] | 0,
        i32[base + 2] | 0,
        i32[base + 3] | 0,
        i32[base + 4] | 0,
        f32[base + 5],
        f32[base + 6],
        f32[base + 7],
        f32[base + 8],
        f32[base + 9],
      );
      read++;
      n++;
    }
    return { nextCursor: read, count: n, overrun: false };
  }

  function initialContactHitCursor(i32) {
    if (!i32) return 0;
    return Atomics.load(i32, HDR_WRITE) | 0;
  }

  global.Box2dContactHitRing = {
    BOX2D_HIT_HEADER_I32: BOX2D_HIT_HEADER_I32,
    BOX2D_HIT_STRIDE_I32: BOX2D_HIT_STRIDE_I32,
    BOX2D_HIT_DEFAULT_CAPACITY: BOX2D_HIT_DEFAULT_CAPACITY,
    createContactHitRingSab: createContactHitRingSab,
    bindContactHitRing: bindContactHitRing,
    isContactHitRingBound: isContactHitRingBound,
    publishContactHit: publishContactHit,
    drainContactHitRing: drainContactHitRing,
    initialContactHitCursor: initialContactHitCursor,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
