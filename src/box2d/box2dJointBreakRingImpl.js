// Box2D joint-break event ring — SPMC (weedjs_post producer, N logic consumers).
// Record i32: seq, jointIndex, entityA, entityB, genA, genB

(function (global) {
  var BOX2D_JOINT_BREAK_HEADER_I32 = 4;
  var BOX2D_JOINT_BREAK_STRIDE_I32 = 6;
  var BOX2D_JOINT_BREAK_DEFAULT_CAPACITY = 1024;

  var HDR_WRITE = 0;
  var HDR_CAP = 1;
  var HDR_OVERFLOW = 2;

  var ringI32 = null;
  var capacity = 0;

  function createJointBreakRingSab(eventCapacity) {
    var cap = Math.max(
      64,
      (eventCapacity == null ? BOX2D_JOINT_BREAK_DEFAULT_CAPACITY : eventCapacity) | 0,
    );
    var bytes = (BOX2D_JOINT_BREAK_HEADER_I32 + cap * BOX2D_JOINT_BREAK_STRIDE_I32) * 4;
    var sab = new SharedArrayBuffer(bytes);
    var i32 = new Int32Array(sab);
    Atomics.store(i32, HDR_WRITE, 0);
    Atomics.store(i32, HDR_CAP, cap);
    Atomics.store(i32, HDR_OVERFLOW, 0);
    for (var i = 0; i < cap; i++) {
      i32[BOX2D_JOINT_BREAK_HEADER_I32 + i * BOX2D_JOINT_BREAK_STRIDE_I32] = 0;
    }
    return sab;
  }

  function bindJointBreakRing(sab) {
    if (!sab) {
      ringI32 = null;
      capacity = 0;
      return;
    }
    ringI32 = new Int32Array(sab);
    capacity = Atomics.load(ringI32, HDR_CAP) | 0;
  }

  function isJointBreakRingBound() {
    return ringI32 != null && capacity > 0;
  }

  function publishJointBreak(jointIndex, entityA, entityB, genA, genB) {
    if (!ringI32) return false;
    var cap = capacity;
    var write = Atomics.add(ringI32, HDR_WRITE, 1);
    var base = BOX2D_JOINT_BREAK_HEADER_I32 + (write % cap) * BOX2D_JOINT_BREAK_STRIDE_I32;
    ringI32[base + 1] = jointIndex | 0;
    ringI32[base + 2] = entityA | 0;
    ringI32[base + 3] = entityB | 0;
    ringI32[base + 4] = genA | 0;
    ringI32[base + 5] = genB | 0;
    Atomics.store(ringI32, base, write + 1);
    return true;
  }

  function drainJointBreakRing(i32, consumerCursor, onBreak) {
    if (!i32 || !onBreak) {
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
      var base = BOX2D_JOINT_BREAK_HEADER_I32 + (read % cap) * BOX2D_JOINT_BREAK_STRIDE_I32;
      if (Atomics.load(i32, base) !== read + 1) break;
      onBreak(
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

  function initialJointBreakCursor(i32) {
    if (!i32) return 0;
    return Atomics.load(i32, HDR_WRITE) | 0;
  }

  global.Box2dJointBreakRing = {
    BOX2D_JOINT_BREAK_HEADER_I32: BOX2D_JOINT_BREAK_HEADER_I32,
    BOX2D_JOINT_BREAK_STRIDE_I32: BOX2D_JOINT_BREAK_STRIDE_I32,
    BOX2D_JOINT_BREAK_DEFAULT_CAPACITY: BOX2D_JOINT_BREAK_DEFAULT_CAPACITY,
    createJointBreakRingSab: createJointBreakRingSab,
    bindJointBreakRing: bindJointBreakRing,
    isJointBreakRingBound: isJointBreakRingBound,
    publishJointBreak: publishJointBreak,
    drainJointBreakRing: drainJointBreakRing,
    initialJointBreakCursor: initialJointBreakCursor,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
