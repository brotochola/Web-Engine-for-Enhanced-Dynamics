// Shared "bodies that moved this physics step" SAB.
// Producer: weedjs_post afterStep (WASM body move events + teleports).
// Consumers: spatial (dirty rebuild), later anything needing movers.
//
// Layout:
//   Int32 header[4]: generation, count, entityCapacity, reserved
//   Uint32 movedList[entityCapacity]
//   Uint8  movedBits[entityCapacity]
//   Uint8  fellAsleep[entityCapacity]  (parallel to list indices, not bits)

(function (global) {
  var HDR_GEN = 0;
  var HDR_COUNT = 1;
  var HDR_CAP = 2;
  var HDR_I32 = 4;

  var movedSab = null;
  var hdrI32 = null;
  var movedList = null;
  var movedBits = null;
  var fellAsleep = null;
  var entityCapacity = 0;

  function createMovedBodiesSab(entityCount) {
    var cap = Math.max(1, entityCount | 0);
    var headerBytes = HDR_I32 * 4;
    var listBytes = cap * 4;
    var bitsBytes = cap;
    var sleepBytes = cap;
    // bits+sleep are 1 byte each; pad so Int32Array views stay valid when cap is odd
    var bytes = (headerBytes + listBytes + bitsBytes + sleepBytes + 3) & ~3;
    var sab = new SharedArrayBuffer(bytes);
    var i32 = new Int32Array(sab, 0, HDR_I32);
    Atomics.store(i32, HDR_GEN, 0);
    Atomics.store(i32, HDR_COUNT, 0);
    Atomics.store(i32, HDR_CAP, cap);
    return sab;
  }

  function viewsFromSab(sab) {
    if (!sab) return null;
    var i32 = new Int32Array(sab, 0, HDR_I32);
    var cap = i32[HDR_CAP] | 0;
    if (cap <= 0) return null;
    var listOffset = HDR_I32 * 4;
    var bitsOffset = listOffset + cap * 4;
    var sleepOffset = bitsOffset + cap;
    return {
      hdrI32: i32,
      movedList: new Uint32Array(sab, listOffset, cap),
      movedBits: new Uint8Array(sab, bitsOffset, cap),
      fellAsleep: new Uint8Array(sab, sleepOffset, cap),
      entityCapacity: cap,
    };
  }

  function bindMovedBodies(sab) {
    movedSab = sab || null;
    var v = viewsFromSab(sab);
    if (!v) {
      hdrI32 = null;
      movedList = null;
      movedBits = null;
      fellAsleep = null;
      entityCapacity = 0;
      return null;
    }
    hdrI32 = v.hdrI32;
    movedList = v.movedList;
    movedBits = v.movedBits;
    fellAsleep = v.fellAsleep;
    entityCapacity = v.entityCapacity;
    return v;
  }

  function isMovedBodiesBound() {
    return movedBits != null && entityCapacity > 0;
  }

  function getMovedBodiesViews() {
    if (!isMovedBodiesBound()) return null;

    // B-06. The publisher writes COUNT first and bumps GEN last:
    //     Atomics.store(hdrI32, HDR_COUNT, count);
    //     Atomics.add(hdrI32, HDR_GEN, 1);
    // so GEN is the commit word. Reading GEN then COUNT without validating
    // returns a pair from two different publishes - new count, old generation -
    // and `generation` is exactly what a consumer uses to decide whether the
    // list it is holding is still the one it asked for. A generation that does
    // not identify its own set is worse than none: it makes the consumer skip
    // the check it would otherwise have done.
    //
    // Re-read GEN after COUNT and retry while it moved. Bounded, because the
    // publisher commits once per physics step and always converges.
    for (var attempt = 0; attempt < 4; attempt++) {
      var gen1 = Atomics.load(hdrI32, HDR_GEN) | 0;
      var cnt = Atomics.load(hdrI32, HDR_COUNT) | 0;
      var gen2 = Atomics.load(hdrI32, HDR_GEN) | 0;
      if (gen1 !== gen2) continue;
      return {
        sab: movedSab,
        hdrI32: hdrI32,
        movedList: movedList,
        movedBits: movedBits,
        fellAsleep: fellAsleep,
        entityCapacity: entityCapacity,
        generation: gen1,
        count: cnt,
      };
    }

    // Contended throughout. GEN is the commit word, so it is still the safer of
    // the two: take the count it last committed against.
    var gen = Atomics.load(hdrI32, HDR_GEN) | 0;
    var count = Atomics.load(hdrI32, HDR_COUNT) | 0;
    return {
      sab: movedSab,
      hdrI32: hdrI32,
      movedList: movedList,
      movedBits: movedBits,
      fellAsleep: fellAsleep,
      entityCapacity: entityCapacity,
      generation: gen,
      count: count,
    };
  }

  /**
   * Clear and rewrite mover set for this step. Single writer (physics).
   * @param {Int32Array|null} wasmSlots dense entity slots from WASM
   * @param {Uint8Array|null} wasmFellAsleep parallel fellAsleep flags
   * @param {number} wasmCount
   * @param {Uint32Array|null} teleportList
   * @param {number} teleportCount
   * @param {Uint8Array|null} teleportBits unused (reserved; skip-dup uses movedBits)
   */
  function publishMovedBodies(
    wasmSlots,
    wasmFellAsleep,
    wasmCount,
    teleportList,
    teleportCount,
    teleportBits,
  ) {
    if (!hdrI32 || !movedList || !movedBits) return 0;
    var cap = entityCapacity;
    movedBits.fill(0);
    if (fellAsleep) fellAsleep.fill(0);

    var count = 0;
    var n = wasmCount | 0;
    if (wasmSlots && n > 0) {
      if (n > cap) n = cap;
      for (var i = 0; i < n; i++) {
        var slot = wasmSlots[i] | 0;
        if (slot < 0 || slot >= cap) continue;
        if (movedBits[slot]) continue;
        movedBits[slot] = 1;
        movedList[count] = slot | 0;
        if (fellAsleep && wasmFellAsleep) {
          fellAsleep[count] = wasmFellAsleep[i] | 0;
        }
        count++;
      }
    }

    var tn = teleportCount | 0;
    if (teleportList && tn > 0) {
      for (var t = 0; t < tn; t++) {
        var e = teleportList[t] | 0;
        if (e < 0 || e >= cap) continue;
        if (movedBits[e]) continue;
        movedBits[e] = 1;
        movedList[count] = e | 0;
        if (fellAsleep) fellAsleep[count] = 0;
        count++;
        if (count >= cap) break;
      }
    }

    Atomics.store(hdrI32, HDR_COUNT, count);
    Atomics.add(hdrI32, HDR_GEN, 1);
    return count;
  }

  var api = {
    HDR_GEN: HDR_GEN,
    HDR_COUNT: HDR_COUNT,
    HDR_CAP: HDR_CAP,
    createMovedBodiesSab: createMovedBodiesSab,
    bindMovedBodies: bindMovedBodies,
    isMovedBodiesBound: isMovedBodiesBound,
    getMovedBodiesViews: getMovedBodiesViews,
    viewsFromSab: viewsFromSab,
    publishMovedBodies: publishMovedBodies,
  };

  global.Box2dMovedBodies = api;
  global.createMovedBodiesSab = createMovedBodiesSab;
  global.bindMovedBodies = bindMovedBodies;
  global.isMovedBodiesBound = isMovedBodiesBound;
  global.getMovedBodiesViews = getMovedBodiesViews;
  global.publishMovedBodies = publishMovedBodies;
})(typeof globalThis !== 'undefined' ? globalThis : self);
