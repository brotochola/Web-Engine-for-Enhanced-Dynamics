// Box2D command ring — single logic source (no export/import).
// ESM: imported as side-effect by box2dCommandRing.js
// Classic: importScripts from weedjsPost.js
// Writers: GameObject / logic / main (MPSC). Reader: weedjs_post drain pre-step (SPSC consumer).
// Units: px, px/s; facing as unit complex (rotC, rotS); angular vel rad/s.
//
// Sequence-slot MPSC: HDR_WRITE/HDR_READ are monotonic claim counters.
// Per-slot seq at base+0; payload at base+1..6. Init seq[i]=i.
// Publish stores claim+1; consumer frees with read+cap.

(function (global) {
  var BOX2D_CMD = Object.freeze({
    SET_TRANSFORM: 1, // entity, x, y, rotC, rotS
    SET_VELOCITY: 2, // entity, vx, vy
    SET_ROT_CS: 3, // entity, rotC, rotS
    SET_ANGULAR_VELOCITY: 4, // entity, w
    SET_FIXED_ROTATION: 5, // entity, flag (0|1)
    EXPLODE: 6, // maskBits as entity, x, y, radius, impulsePerLength (falloff=0.5*radius)
    SET_SLEEP_THRESHOLD: 7, // entity, threshold
    CREATE_PARTICLE_SYSTEM: 8, // systemId, radius, maxCount, subSteps, strictContactCheck (0|1)
    CREATE_PARTICLE_GROUP_BOX: 9, // flags (entity slot), posX, posY, halfWidth, halfHeight
    CREATE_PARTICLE_GROUP_CIRCLE: 10, // systemId, posX, posY, radius, flags
    DESTROY_PARTICLE_GROUP: 11, // systemId, groupId
    DESTROY_PARTICLE_SYSTEM: 12, // systemId
    SET_LIQUIDFUN_EMIT: 13, // entity=textureId|(trackGroup<<16); spacing, strength, tintBits, viscousScale
    SET_LIQUIDFUN_LIFESPAN: 14, // lifetimeMinSec, lifetimeMaxSec, fadeToAlpha0 (0|1); next create consumes; 0,0 = no lifespan
    SET_LIQUIDFUN_SCALE: 15, // scaleMin, scaleMax, alphaMin, alphaMax (next create)
    SET_PARTICLE_TUNING: 16, // entity=phase 0|1|2|3; four floats per phase (see enqueueSetParticleTuning)
    SET_GROUP_VISCOUS_SCALE: 17, // entity=groupId, a=viscousScale
    JOIN_PARTICLE_GROUPS: 18, // entity=groupA, a=groupB
    SPLIT_PARTICLE_GROUP: 19, // entity=groupId
    PARTICLE_APPLY_FORCE: 20, // entity=index, a=fx, b=fy
    PARTICLE_APPLY_IMPULSE: 21, // entity=index, a=ix, b=iy
    GROUP_APPLY_FORCE: 22, // entity=groupId, a=fx, b=fy
    GROUP_APPLY_IMPULSE: 23, // entity=groupId, a=ix, b=iy
    CLEAR_LIQUIDFUN_PARTICLES: 24, // systemId — destroy groups + zombie rest; keep system
    SET_AWAKE: 25, // entity, flag (0|1) — b2Body_SetAwake
    SET_LIQUIDFUN_LIGHT: 26, // a=lightIntensity; next create consumes; 0 = not a light
    SET_LIQUIDFUN_LAYERS: 27, // entity=layerMask u16; next create consumes
    SET_PARTICLE_USER_DATA: 28, // entity=index; bits in i32 slot 3
    SET_PARTICLE_USER_DATA_RANGE: 29, // entity=first; last i32[3]; bits i32[4]
    SET_PARTICLE_COLOR: 30, // entity=index; rgba i32[3]
    SET_PARTICLE_COLOR_RANGE: 31, // entity=first; last i32[3]; rgba i32[4]
    SET_PARTICLE_FLAGS: 32, // entity=index; flags i32[3]
    SET_PARTICLE_VISCOUS_SCALE: 33, // entity=index, a=scale
    SET_PARTICLE_VISCOUS_SCALE_RANGE: 34, // entity=first, a=last, b=scale
    SET_GROUP_FLAGS: 35, // entity=groupId; flags i32[3]
    DESTROY_PARTICLE: 36, // entity=index
    CREATE_PARTICLE: 37, // entity=flags; x,y,vx,vy
    SET_LIQUIDFUN_PAYLOAD: 38, // entity=userData; color i32[3]; vx,vy,omega f32
    PARTICLE_APPLY_FORCE_RANGE: 39, // entity=first; last i32[3]; fx,fy
    PARTICLE_APPLY_IMPULSE_RANGE: 40, // entity=first; last i32[3]; ix,iy
    EXTRACT_PARTICLES: 41, // entity=groupId; count, groupFlags, trackGroup (SAB holds indices)
    SET_PARTICLE_USER_DATA_LIST: 42, // indices+add/set in liquidFunUserDataList SAB
  });

  var BOX2D_CMD_HEADER_I32 = 4;
  var BOX2D_CMD_STRIDE_I32 = 8;
  var BOX2D_CMD_DEFAULT_CAPACITY = 4096;

  var HDR_WRITE = 0;
  var HDR_READ = 1;
  var HDR_CAP = 2;
  var HDR_OVERFLOW = 3;

  var ringI32 = null;
  var ringF32 = null;
  var capacity = 0;
  /** When true, warn if enqueued (rotC,rotS) is not near unit length. */
  var assertRotCSUnit = false;

  function setAssertRotCSUnit(on) {
    assertRotCSUnit = !!on;
  }

  function checkRotCS(rotC, rotS) {
    if (!assertRotCSUnit) return;
    if (!isFinite(rotC) || !isFinite(rotS)) {
      console.warn('Box2dCommandRing: non-finite rotCS', rotC, rotS);
      return;
    }
    var n = rotC * rotC + rotS * rotS;
    if (n < 0.998 || n > 1.002) {
      console.warn('Box2dCommandRing: non-unit rotCS', rotC, rotS, 'normSq=', n);
    }
  }

  function createCommandRingSab(cmdCapacity) {
    var cap = Math.max(64, (cmdCapacity == null ? BOX2D_CMD_DEFAULT_CAPACITY : cmdCapacity) | 0);
    var bytes = (BOX2D_CMD_HEADER_I32 + cap * BOX2D_CMD_STRIDE_I32) * 4;
    var sab = new SharedArrayBuffer(bytes);
    var i32 = new Int32Array(sab);
    Atomics.store(i32, HDR_WRITE, 0);
    Atomics.store(i32, HDR_READ, 0);
    Atomics.store(i32, HDR_CAP, cap);
    Atomics.store(i32, HDR_OVERFLOW, 0);
    for (var i = 0; i < cap; i++) {
      i32[BOX2D_CMD_HEADER_I32 + i * BOX2D_CMD_STRIDE_I32] = i;
    }
    return sab;
  }

  function bindCommandRing(sab) {
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

  function isCommandRingBound() {
    return ringI32 != null && capacity > 0;
  }

  function enqueue(opcode, entity, a, b, c, d) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      // Slot free when seq == claim (producer owns after CAS).
      while (Atomics.load(ringI32, base) !== write) {
        /* wait prior lap consumer / slower peer publish */
      }
      ringI32[base + 1] = opcode | 0;
      ringI32[base + 2] = entity | 0;
      ringF32[base + 3] = a;
      ringF32[base + 4] = b;
      ringF32[base + 5] = c;
      ringF32[base + 6] = d;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueSetTransform(entity, x, y, rotC, rotS) {
    var c = rotC == null ? 1 : rotC;
    var s = rotS == null ? 0 : rotS;
    checkRotCS(c, s);
    return enqueue(BOX2D_CMD.SET_TRANSFORM, entity, x, y, c, s);
  }

  function enqueueSetVelocity(entity, vx, vy) {
    return enqueue(BOX2D_CMD.SET_VELOCITY, entity, vx, vy, 0, 0);
  }

  /** @param {number} rotC cosθ @param {number} rotS sinθ */
  function enqueueSetRotCS(entity, rotC, rotS) {
    var c = rotC == null ? 1 : rotC;
    var s = rotS == null ? 0 : rotS;
    checkRotCS(c, s);
    return enqueue(BOX2D_CMD.SET_ROT_CS, entity, c, s, 0, 0);
  }

  function enqueueSetAngularVelocity(entity, w) {
    return enqueue(BOX2D_CMD.SET_ANGULAR_VELOCITY, entity, w, 0, 0, 0);
  }

  function enqueueSetFixedRotation(entity, flag) {
    return enqueue(BOX2D_CMD.SET_FIXED_ROTATION, entity, flag ? 1 : 0, 0, 0, 0);
  }

  function enqueueExplode(maskBits, x, y, radius, impulsePerLength) {
    return enqueue(
      BOX2D_CMD.EXPLODE,
      maskBits | 0,
      x,
      y,
      radius,
      impulsePerLength == null ? 0 : impulsePerLength,
    );
  }

  function enqueueSetSleepThreshold(entity, threshold) {
    return enqueue(BOX2D_CMD.SET_SLEEP_THRESHOLD, entity, threshold, 0, 0, 0);
  }

  function enqueueSetAwake(entity, flag) {
    return enqueue(BOX2D_CMD.SET_AWAKE, entity, flag ? 1 : 0, 0, 0, 0);
  }

  function enqueueCreateParticleSystem(systemId, radius, maxCount, subSteps, strictContactCheck) {
    return enqueue(
      BOX2D_CMD.CREATE_PARTICLE_SYSTEM,
      systemId,
      radius,
      maxCount,
      subSteps > 0 ? subSteps : 1,
      strictContactCheck ? 1 : 0,
    );
  }

  function enqueueSetLiquidFunEmit(spacing, strength, tintBits, textureId, viscousScale, trackGroup, groupFlags) {
    var packed = (textureId | 0) & 0xffff;
    if (trackGroup) packed |= 1 << 16;
    packed |= ((groupFlags | 0) & 0xf) << 17;
    return enqueue(
      BOX2D_CMD.SET_LIQUIDFUN_EMIT,
      packed,
      spacing || 0,
      strength || 0,
      tintBits || 0,
      viscousScale != null && viscousScale > 0 ? viscousScale : 1,
    );
  }

  function enqueueSetLiquidFunLifespan(lifetimeMinSec, lifetimeMaxSec, fadeToAlpha0) {
    return enqueue(
      BOX2D_CMD.SET_LIQUIDFUN_LIFESPAN,
      0,
      lifetimeMinSec || 0,
      lifetimeMaxSec || 0,
      fadeToAlpha0 ? 1 : 0,
      0,
    );
  }

  function enqueueSetLiquidFunScale(scaleMin, scaleMax, alphaMin, alphaMax) {
    return enqueue(
      BOX2D_CMD.SET_LIQUIDFUN_SCALE,
      0,
      scaleMin,
      scaleMax,
      alphaMin,
      alphaMax,
    );
  }

  function enqueueSetLiquidFunLight(lightIntensity) {
    return enqueue(BOX2D_CMD.SET_LIQUIDFUN_LIGHT, 0, lightIntensity > 0 ? lightIntensity : 0, 0, 0, 0);
  }

  function enqueueSetLiquidFunLayers(mask) {
    return enqueue(BOX2D_CMD.SET_LIQUIDFUN_LAYERS, mask & 0xffff, 0, 0, 0, 0);
  }

  /** Apply system def coeffs. Four ring slots (phase 0/1/2/3). */
  function enqueueSetParticleTuning(t) {
    var o = t || {};
    var ok = enqueue(
      BOX2D_CMD.SET_PARTICLE_TUNING,
      0,
      o.dampingStrength != null ? o.dampingStrength : 1,
      o.pressureStrength != null ? o.pressureStrength : 0.05,
      o.viscousStrength != null ? o.viscousStrength : 0.25,
      o.tensileStrength != null ? o.tensileStrength : 0.2,
    );
    ok =
      enqueue(
        BOX2D_CMD.SET_PARTICLE_TUNING,
        1,
        o.powderStrength != null ? o.powderStrength : 0.5,
        o.springStrength != null ? o.springStrength : 0.25,
        o.staticPressureStrength != null ? o.staticPressureStrength : 0.2,
        o.staticPressureRelaxation != null ? o.staticPressureRelaxation : 0.2,
      ) && ok;
    ok =
      enqueue(
        BOX2D_CMD.SET_PARTICLE_TUNING,
        2,
        o.staticPressureIterations != null ? o.staticPressureIterations : 8,
        0,
        0,
        0,
      ) && ok;
    ok =
      enqueue(
        BOX2D_CMD.SET_PARTICLE_TUNING,
        3,
        o.ejectionStrength != null ? o.ejectionStrength : 0.5,
        o.colorMixingStrength != null ? o.colorMixingStrength : 0.5,
        o.repulsiveStrength != null ? o.repulsiveStrength : 1,
        0,
      ) && ok;
    return ok;
  }

  function enqueueBits(opcode, entity, bits) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      while (Atomics.load(ringI32, base) !== write) {
        /* wait */
      }
      ringI32[base + 1] = opcode | 0;
      ringI32[base + 2] = entity | 0;
      ringI32[base + 3] = bits >>> 0;
      ringF32[base + 4] = 0;
      ringF32[base + 5] = 0;
      ringF32[base + 6] = 0;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueRangeBits(opcode, first, last, bits) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      while (Atomics.load(ringI32, base) !== write) {
        /* wait */
      }
      ringI32[base + 1] = opcode | 0;
      ringI32[base + 2] = first | 0;
      ringI32[base + 3] = last | 0;
      ringI32[base + 4] = bits >>> 0;
      ringF32[base + 5] = 0;
      ringF32[base + 6] = 0;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueSetParticleUserData(index, bits) {
    return enqueueBits(BOX2D_CMD.SET_PARTICLE_USER_DATA, index | 0, bits);
  }

  function enqueueSetParticleUserDataRange(first, last, bits) {
    return enqueueRangeBits(BOX2D_CMD.SET_PARTICLE_USER_DATA_RANGE, first | 0, last | 0, bits);
  }

  function enqueueSetParticleColor(index, rgba) {
    return enqueueBits(BOX2D_CMD.SET_PARTICLE_COLOR, index | 0, rgba);
  }

  function enqueueSetParticleColorRange(first, last, rgba) {
    return enqueueRangeBits(BOX2D_CMD.SET_PARTICLE_COLOR_RANGE, first | 0, last | 0, rgba);
  }

  function enqueueSetParticleFlags(index, flags) {
    return enqueueBits(BOX2D_CMD.SET_PARTICLE_FLAGS, index | 0, flags);
  }

  function enqueueSetParticleViscousScale(index, scale) {
    return enqueue(BOX2D_CMD.SET_PARTICLE_VISCOUS_SCALE, index | 0, scale > 0 ? scale : 1, 0, 0, 0);
  }

  function enqueueSetParticleViscousScaleRange(first, last, scale) {
    return enqueue(
      BOX2D_CMD.SET_PARTICLE_VISCOUS_SCALE_RANGE,
      first | 0,
      last | 0,
      scale > 0 ? scale : 1,
      0,
      0,
    );
  }

  function enqueueSetGroupFlags(groupId, flags) {
    return enqueueBits(BOX2D_CMD.SET_GROUP_FLAGS, groupId | 0, flags);
  }

  function enqueueDestroyParticle(index) {
    return enqueue(BOX2D_CMD.DESTROY_PARTICLE, index | 0, 0, 0, 0, 0);
  }

  function enqueueCreateParticle(x, y, vx, vy, flags) {
    return enqueue(BOX2D_CMD.CREATE_PARTICLE, flags || 0, x, y, vx || 0, vy || 0);
  }

  function enqueueSetLiquidFunPayload(userData, color, vx, vy, omega) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      while (Atomics.load(ringI32, base) !== write) {
        /* wait */
      }
      ringI32[base + 1] = BOX2D_CMD.SET_LIQUIDFUN_PAYLOAD;
      ringI32[base + 2] = userData >>> 0;
      ringI32[base + 3] = color >>> 0;
      ringF32[base + 4] = vx || 0;
      ringF32[base + 5] = vy || 0;
      ringF32[base + 6] = omega || 0;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueParticleApplyForceRange(first, last, fx, fy) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      while (Atomics.load(ringI32, base) !== write) {
        /* wait */
      }
      ringI32[base + 1] = BOX2D_CMD.PARTICLE_APPLY_FORCE_RANGE;
      ringI32[base + 2] = first | 0;
      ringI32[base + 3] = last | 0;
      ringF32[base + 4] = fx;
      ringF32[base + 5] = fy;
      ringF32[base + 6] = 0;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueParticleApplyImpulseRange(first, last, ix, iy) {
    if (!ringI32) return false;
    var cap = capacity;
    for (;;) {
      var write = Atomics.load(ringI32, HDR_WRITE);
      var read = Atomics.load(ringI32, HDR_READ);
      if (write - read >= cap) {
        Atomics.add(ringI32, HDR_OVERFLOW, 1);
        return false;
      }
      if (Atomics.compareExchange(ringI32, HDR_WRITE, write, write + 1) !== write) {
        continue;
      }
      var base = BOX2D_CMD_HEADER_I32 + (write % cap) * BOX2D_CMD_STRIDE_I32;
      while (Atomics.load(ringI32, base) !== write) {
        /* wait */
      }
      ringI32[base + 1] = BOX2D_CMD.PARTICLE_APPLY_IMPULSE_RANGE;
      ringI32[base + 2] = first | 0;
      ringI32[base + 3] = last | 0;
      ringF32[base + 4] = ix;
      ringF32[base + 5] = iy;
      ringF32[base + 6] = 0;
      Atomics.store(ringI32, base, write + 1);
      return true;
    }
  }

  function enqueueSetParticleUserDataList() {
    return enqueue(BOX2D_CMD.SET_PARTICLE_USER_DATA_LIST, 0, 0, 0, 0, 0);
  }

  function enqueueExtractParticles(groupId, count, groupFlags, trackGroup) {
    return enqueue(
      BOX2D_CMD.EXTRACT_PARTICLES,
      groupId | 0,
      count | 0,
      groupFlags >>> 0,
      trackGroup ? 1 : 0,
      0,
    );
  }

  function enqueueSetGroupViscousScale(groupId, scale) {
    return enqueue(BOX2D_CMD.SET_GROUP_VISCOUS_SCALE, groupId | 0, scale > 0 ? scale : 1, 0, 0, 0);
  }

  function enqueueJoinParticleGroups(groupA, groupB) {
    return enqueue(BOX2D_CMD.JOIN_PARTICLE_GROUPS, groupA | 0, groupB | 0, 0, 0, 0);
  }

  function enqueueSplitParticleGroup(groupId) {
    return enqueue(BOX2D_CMD.SPLIT_PARTICLE_GROUP, groupId | 0, 0, 0, 0, 0);
  }

  function enqueueParticleApplyForce(index, fx, fy) {
    return enqueue(BOX2D_CMD.PARTICLE_APPLY_FORCE, index | 0, fx, fy, 0, 0);
  }

  function enqueueParticleApplyImpulse(index, ix, iy) {
    return enqueue(BOX2D_CMD.PARTICLE_APPLY_IMPULSE, index | 0, ix, iy, 0, 0);
  }

  function enqueueGroupApplyForce(groupId, fx, fy) {
    return enqueue(BOX2D_CMD.GROUP_APPLY_FORCE, groupId | 0, fx, fy, 0, 0);
  }

  function enqueueGroupApplyImpulse(groupId, ix, iy) {
    return enqueue(BOX2D_CMD.GROUP_APPLY_IMPULSE, groupId | 0, ix, iy, 0, 0);
  }

  function enqueueCreateParticleGroupBox(systemId, posX, posY, halfWidth, halfHeight, flags) {
    // Singleton particle system: entity slot carries flags (systemId unused).
    return enqueue(BOX2D_CMD.CREATE_PARTICLE_GROUP_BOX, flags || 0, posX, posY, halfWidth, halfHeight);
  }

  function enqueueCreateParticleGroupCircle(systemId, posX, posY, radius, flags) {
    return enqueue(BOX2D_CMD.CREATE_PARTICLE_GROUP_CIRCLE, systemId, posX, posY, radius, flags || 0);
  }

  function enqueueDestroyParticleGroup(systemId, groupId) {
    return enqueue(BOX2D_CMD.DESTROY_PARTICLE_GROUP, systemId, groupId, 0, 0, 0);
  }

  function enqueueDestroyParticleSystem(systemId) {
    return enqueue(BOX2D_CMD.DESTROY_PARTICLE_SYSTEM, systemId, 0, 0, 0, 0);
  }

  function enqueueClearLiquidFunParticles(systemId) {
    return enqueue(BOX2D_CMD.CLEAR_LIQUIDFUN_PARTICLES, systemId, 0, 0, 0, 0);
  }

  function drainCommandRing(i32, f32, handlers) {
    if (!i32 || !f32 || !handlers) return 0;
    var cap = i32[HDR_CAP] | 0;
    if (!(cap > 0)) return 0;
    var n = 0;
    for (;;) {
      var read = Atomics.load(i32, HDR_READ);
      var base = BOX2D_CMD_HEADER_I32 + (read % cap) * BOX2D_CMD_STRIDE_I32;
      if (Atomics.load(i32, base) !== read + 1) break;
      var op = i32[base + 1] | 0;
      var entity = i32[base + 2] | 0;
      var aI = i32[base + 3] | 0;
      var bI = i32[base + 4] | 0;
      var a = f32[base + 3];
      var b = f32[base + 4];
      var c = f32[base + 5];
      var d = f32[base + 6];
      switch (op) {
        case BOX2D_CMD.SET_TRANSFORM:
          if (handlers.setTransform) handlers.setTransform(entity, a, b, c, d);
          break;
        case BOX2D_CMD.SET_VELOCITY:
          if (handlers.setVelocity) handlers.setVelocity(entity, a, b);
          break;
        case BOX2D_CMD.SET_ROT_CS:
          if (handlers.setRotCS) handlers.setRotCS(entity, a, b);
          break;
        case BOX2D_CMD.SET_ANGULAR_VELOCITY:
          if (handlers.setAngularVelocity) handlers.setAngularVelocity(entity, a);
          break;
        case BOX2D_CMD.SET_FIXED_ROTATION:
          if (handlers.setFixedRotation) handlers.setFixedRotation(entity, a);
          break;
        case BOX2D_CMD.EXPLODE:
          if (handlers.explode) handlers.explode(entity, a, b, c, d);
          break;
        case BOX2D_CMD.SET_SLEEP_THRESHOLD:
          if (handlers.setSleepThreshold) handlers.setSleepThreshold(entity, a);
          break;
        case BOX2D_CMD.SET_AWAKE:
          if (handlers.setAwake) handlers.setAwake(entity, a);
          break;
        case BOX2D_CMD.CREATE_PARTICLE_SYSTEM:
          if (handlers.createParticleSystem) handlers.createParticleSystem(entity, a, b, c, d);
          break;
        case BOX2D_CMD.CREATE_PARTICLE_GROUP_BOX:
          if (handlers.createParticleGroupBox) handlers.createParticleGroupBox(entity, a, b, c, d);
          break;
        case BOX2D_CMD.CREATE_PARTICLE_GROUP_CIRCLE:
          if (handlers.createParticleGroupCircle) handlers.createParticleGroupCircle(entity, a, b, c, d);
          break;
        case BOX2D_CMD.DESTROY_PARTICLE_GROUP:
          if (handlers.destroyParticleGroup) handlers.destroyParticleGroup(entity, a);
          break;
        case BOX2D_CMD.DESTROY_PARTICLE_SYSTEM:
          if (handlers.destroyParticleSystem) handlers.destroyParticleSystem(entity);
          break;
        case BOX2D_CMD.CLEAR_LIQUIDFUN_PARTICLES:
          if (handlers.clearLiquidFunParticles) handlers.clearLiquidFunParticles(entity);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_EMIT:
          if (handlers.setLiquidFunEmit) handlers.setLiquidFunEmit(entity, a, b, c, d);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_LIFESPAN:
          if (handlers.setLiquidFunLifespan) handlers.setLiquidFunLifespan(a, b, c);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_SCALE:
          if (handlers.setLiquidFunScale) handlers.setLiquidFunScale(a, b, c, d);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_LIGHT:
          if (handlers.setLiquidFunLight) handlers.setLiquidFunLight(a);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_LAYERS:
          if (handlers.setLiquidFunLayers) handlers.setLiquidFunLayers(entity);
          break;
        case BOX2D_CMD.SET_PARTICLE_TUNING:
          if (handlers.setParticleTuning) handlers.setParticleTuning(entity, a, b, c, d);
          break;
        case BOX2D_CMD.SET_GROUP_VISCOUS_SCALE:
          if (handlers.setGroupViscousScale) handlers.setGroupViscousScale(entity, a);
          break;
        case BOX2D_CMD.JOIN_PARTICLE_GROUPS:
          if (handlers.joinParticleGroups) handlers.joinParticleGroups(entity, a);
          break;
        case BOX2D_CMD.SPLIT_PARTICLE_GROUP:
          if (handlers.splitParticleGroup) handlers.splitParticleGroup(entity);
          break;
        case BOX2D_CMD.PARTICLE_APPLY_FORCE:
          if (handlers.particleApplyForce) handlers.particleApplyForce(entity, a, b);
          break;
        case BOX2D_CMD.PARTICLE_APPLY_IMPULSE:
          if (handlers.particleApplyImpulse) handlers.particleApplyImpulse(entity, a, b);
          break;
        case BOX2D_CMD.GROUP_APPLY_FORCE:
          if (handlers.groupApplyForce) handlers.groupApplyForce(entity, a, b);
          break;
        case BOX2D_CMD.GROUP_APPLY_IMPULSE:
          if (handlers.groupApplyImpulse) handlers.groupApplyImpulse(entity, a, b);
          break;
        case BOX2D_CMD.SET_PARTICLE_USER_DATA:
          if (handlers.setParticleUserData) handlers.setParticleUserData(entity, aI >>> 0);
          break;
        case BOX2D_CMD.SET_PARTICLE_USER_DATA_RANGE:
          if (handlers.setParticleUserDataRange) handlers.setParticleUserDataRange(entity, aI, bI >>> 0);
          break;
        case BOX2D_CMD.SET_PARTICLE_COLOR:
          if (handlers.setParticleColor) handlers.setParticleColor(entity, aI >>> 0);
          break;
        case BOX2D_CMD.SET_PARTICLE_COLOR_RANGE:
          if (handlers.setParticleColorRange) handlers.setParticleColorRange(entity, aI, bI >>> 0);
          break;
        case BOX2D_CMD.SET_PARTICLE_FLAGS:
          if (handlers.setParticleFlags) handlers.setParticleFlags(entity, aI >>> 0);
          break;
        case BOX2D_CMD.SET_PARTICLE_VISCOUS_SCALE:
          if (handlers.setParticleViscousScale) handlers.setParticleViscousScale(entity, a);
          break;
        case BOX2D_CMD.SET_PARTICLE_VISCOUS_SCALE_RANGE:
          if (handlers.setParticleViscousScaleRange) handlers.setParticleViscousScaleRange(entity, a, b);
          break;
        case BOX2D_CMD.SET_GROUP_FLAGS:
          if (handlers.setGroupFlags) handlers.setGroupFlags(entity, aI >>> 0);
          break;
        case BOX2D_CMD.DESTROY_PARTICLE:
          if (handlers.destroyParticle) handlers.destroyParticle(entity);
          break;
        case BOX2D_CMD.CREATE_PARTICLE:
          if (handlers.createParticle) handlers.createParticle(entity, a, b, c, d);
          break;
        case BOX2D_CMD.SET_LIQUIDFUN_PAYLOAD:
          if (handlers.setLiquidFunPayload) handlers.setLiquidFunPayload(entity >>> 0, aI >>> 0, b, c, d);
          break;
        case BOX2D_CMD.PARTICLE_APPLY_FORCE_RANGE:
          if (handlers.particleApplyForceRange) handlers.particleApplyForceRange(entity, aI, b, c);
          break;
        case BOX2D_CMD.PARTICLE_APPLY_IMPULSE_RANGE:
          if (handlers.particleApplyImpulseRange) handlers.particleApplyImpulseRange(entity, aI, b, c);
          break;
        case BOX2D_CMD.EXTRACT_PARTICLES:
          if (handlers.extractParticles) handlers.extractParticles(entity, a, b, c);
          break;
        case BOX2D_CMD.SET_PARTICLE_USER_DATA_LIST:
          if (handlers.setParticleUserDataList) handlers.setParticleUserDataList();
          break;
        default:
          break;
      }
      Atomics.store(i32, base, read + cap);
      Atomics.store(i32, HDR_READ, read + 1);
      n++;
    }
    return n;
  }

  global.Box2dCommandRing = {
    BOX2D_CMD: BOX2D_CMD,
    BOX2D_CMD_HEADER_I32: BOX2D_CMD_HEADER_I32,
    BOX2D_CMD_STRIDE_I32: BOX2D_CMD_STRIDE_I32,
    BOX2D_CMD_DEFAULT_CAPACITY: BOX2D_CMD_DEFAULT_CAPACITY,
    createCommandRingSab: createCommandRingSab,
    bindCommandRing: bindCommandRing,
    isCommandRingBound: isCommandRingBound,
    setAssertRotCSUnit: setAssertRotCSUnit,
    enqueueSetTransform: enqueueSetTransform,
    enqueueSetVelocity: enqueueSetVelocity,
    enqueueSetRotCS: enqueueSetRotCS,
    enqueueSetAngularVelocity: enqueueSetAngularVelocity,
    enqueueSetFixedRotation: enqueueSetFixedRotation,
    enqueueExplode: enqueueExplode,
    enqueueSetSleepThreshold: enqueueSetSleepThreshold,
    enqueueSetAwake: enqueueSetAwake,
    enqueueCreateParticleSystem: enqueueCreateParticleSystem,
    enqueueSetLiquidFunEmit: enqueueSetLiquidFunEmit,
    enqueueSetLiquidFunLifespan: enqueueSetLiquidFunLifespan,
    enqueueSetLiquidFunScale: enqueueSetLiquidFunScale,
    enqueueSetLiquidFunLight: enqueueSetLiquidFunLight,
    enqueueSetLiquidFunLayers: enqueueSetLiquidFunLayers,
    enqueueSetParticleTuning: enqueueSetParticleTuning,
    enqueueSetGroupViscousScale: enqueueSetGroupViscousScale,
    enqueueJoinParticleGroups: enqueueJoinParticleGroups,
    enqueueSplitParticleGroup: enqueueSplitParticleGroup,
    enqueueParticleApplyForce: enqueueParticleApplyForce,
    enqueueParticleApplyImpulse: enqueueParticleApplyImpulse,
    enqueueGroupApplyForce: enqueueGroupApplyForce,
    enqueueGroupApplyImpulse: enqueueGroupApplyImpulse,
    enqueueCreateParticleGroupBox: enqueueCreateParticleGroupBox,
    enqueueCreateParticleGroupCircle: enqueueCreateParticleGroupCircle,
    enqueueDestroyParticleGroup: enqueueDestroyParticleGroup,
    enqueueDestroyParticleSystem: enqueueDestroyParticleSystem,
    enqueueClearLiquidFunParticles: enqueueClearLiquidFunParticles,
    enqueueSetParticleUserData: enqueueSetParticleUserData,
    enqueueSetParticleUserDataRange: enqueueSetParticleUserDataRange,
    enqueueSetParticleColor: enqueueSetParticleColor,
    enqueueSetParticleColorRange: enqueueSetParticleColorRange,
    enqueueSetParticleFlags: enqueueSetParticleFlags,
    enqueueSetParticleViscousScale: enqueueSetParticleViscousScale,
    enqueueSetParticleViscousScaleRange: enqueueSetParticleViscousScaleRange,
    enqueueSetGroupFlags: enqueueSetGroupFlags,
    enqueueDestroyParticle: enqueueDestroyParticle,
    enqueueCreateParticle: enqueueCreateParticle,
    enqueueSetLiquidFunPayload: enqueueSetLiquidFunPayload,
    enqueueParticleApplyForceRange: enqueueParticleApplyForceRange,
    enqueueParticleApplyImpulseRange: enqueueParticleApplyImpulseRange,
    enqueueExtractParticles: enqueueExtractParticles,
    enqueueSetParticleUserDataList: enqueueSetParticleUserDataList,
    drainCommandRing: drainCommandRing,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
