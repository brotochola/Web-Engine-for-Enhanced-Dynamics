// WeedJS bridge — loaded by box2dWasm.js (always).
// Owns Module; physicsHostImpl.js calls weedjsDoStep in-process.
// Skip on em-pthread pool workers.

(function () {
  if (self.name === 'em-pthread') {
    return;
  }

  importScripts(
    'box2dConstantsImpl.js',
    'physicsApi.js',
    'box2dCommandRingImpl.js',
    'box2dContactRingImpl.js',
    'box2dContactHitRingImpl.js',
    'box2dJointBreakRingImpl.js',
    'box2dMovedBodiesImpl.js',
    'box2dQueryAabbImpl.js',
    'box2dRayCastImpl.js',
    'liquidFunQueryImpl.js',
    'liquidFunExtractImpl.js',
    'liquidFunUserDataListImpl.js',
  );
  const drainBox2dCommandRing = Box2dCommandRing.drainCommandRing;
  const publishBox2dContactEvent = Box2dContactRing.publishContactEvent;
  const CONTACT_KIND = Box2dContactRing.BOX2D_CONTACT_KIND;
  const publishContactHit = Box2dContactHitRing.publishContactHit;
  const publishJointBreak = Box2dJointBreakRing.publishJointBreak;
  const publishMovedBodies = Box2dMovedBodies.publishMovedBodies;
  const bindMovedBodies = Box2dMovedBodies.bindMovedBodies;

  const MAX_POLY_VERTS = 8;
  const BODY_DIRTY = {
    LIFECYCLE: 1,
    BODY_TYPE: 1 << 1,
    DAMPING: 1 << 2,
    MASS: 1 << 3,
    FILTER: 1 << 4,
    FRICTION: 1 << 5,
    GEOMETRY: 1 << 6,
  };
  // Units: px, px/s, px/s², rad, rad/s (Box2D native — no frame-unit scale).

  let world = null;
  let verdletSubSteps = 4;
  /** Set by physics_host before init (weedjsEnableHostMode). */
  let hostMode = false;
  let hostEntityCount = 0;
  let hostSubSteps = 4;
  let hostDt = 0;
  let moduleReady = false;
  const moduleReadyWaiters = [];
  let cmdI32 = null;
  let cmdF32 = null;
  let contactRingI32 = null;
  let hitRingBound = false;
  let jointBreakRingBound = false;
  let views = null;
  let hasBody = null;
  let createFailed = null;
  let denseList = null;
  let densePositions = null;
  let denseCount = 0;
  let lastBodySyncVisited = 0;
  let bodyDirtyFlags = null;
  let bodyDirtyWords = null;
  let bodyGeneration = null;
  let seenBodyGeneration = null;
  let jointViews = null;
  let liquidFunViews = null;
  let liquidFunGroupsViews = null;
  let liquidFunMaxCount = 0;
  let liquidFunUserDataU32 = null;
  let liquidFunDensity = 1.0;
  let liquidFunXFloatOffset = 0;
  let liquidFunYFloatOffset = 0;
  let liquidFunAlphaFloatOffset = 0;
  // How many particles' px/py were populated as of the last sync - the
  // "existing vs newly-appeared" boundary for the previous-position snapshot
  // below. Reset to 0 whenever the particle system (re)creates, same sites
  // as the X/Y offsets.
  let liquidFunPrevSyncedCount = 0;
  /** High-water of painted thin-SAB emit slots; wipe only this range on clear. */
  let liquidFunPaintedHighWater = 0;
  /** Scene world AABB [0,w]×[0,h]; OOB particle centers get LF_ZOMBIE before step. */
  let liquidFunWorldW = 0;
  let liquidFunWorldH = 0;
  const LF_ZOMBIE = 1 << 0;
  /** Off-screen pose written into HEAP x/y on clear so mid-step readers never see old puddles. */
  const LF_CLEARED_XY = -1e8;
  let pendingLiquidFunEmitA = {
    spacing: 0,
    strength: 0.5,
    tintBits: 0,
    textureId: 0,
    viscousScale: 1,
    trackGroup: 0,
    groupFlags: 0,
    lifetimeMin: 0,
    lifetimeMax: 0, // <= 0 = no age-based destruction (default)
    fadeToAlpha0: 0, // 0 = opaque until destroy; 1 = lerp alpha over life
    scaleSet: 0, // 1 = this burst set scale/alpha
    scaleMin: 1,
    scaleMax: 1,
    alphaMin: 1,
    alphaMax: 1,
    layerMask: 0,
    layerMaskSet: 0,
    lightIntensity: 0,
    userData: 0,
    color: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    pending: false,
  };
  let pendingLiquidFunEmit = pendingLiquidFunEmitA;
  let pendingParticleTuning = {
    dampingStrength: 1,
    pressureStrength: 0.05,
    viscousStrength: 0.25,
    tensileStrength: 0.2,
    powderStrength: 0.5,
    springStrength: 0.25,
    staticPressureStrength: 0.2,
    staticPressureRelaxation: 0.2,
    staticPressureIterations: 8,
    ejectionStrength: 0.5,
    colorMixingStrength: 0.5,
    repulsiveStrength: 1,
  };
  let jointHandle = null; // Int32Array, -1 = none, -2 = fail this revision
  let jointSeenRev = null; // Uint32Array — last synced Joint.revision
  let jointDense = null; // Uint16Array — indices with live WASM handles
  let jointDenseCount = 0;
  let jointLive = null; // Uint8Array scratch (dense-sized marks only)
  let maxJoints = 0;
  let jointCapacityWarn = false;
  let pxChan = null;
  let pyChan = null;
  let rotChan = null;
  let vxChan = null;
  let vyChan = null;
  let angChan = null;
  let sleepingU8 = null;
  let statsF32 = null;
  let collectDetailedStats = false;
  let publishContactRing = true;

  // Published pose double-buffer (render-queue style): visuals read post-step snapshot
  let poseSync = null; // Int32Array [readyFrame, consumedFrame]
  let poseBuffers = [null, null]; // { x, y, rotation } Float32Array views
  let poseCapacity = 0;
  let poseFrame = 0;

  // Mirrors PHYSICS_STATS in src/util/workersUtils.js (nested classic worker — no ESM import).
  const PS = {
    BODY_COUNT: 3,
    JOINT_COUNT: 4,
    CONTACT_BEGIN: 5,
    CONTACT_END: 6,
    SENSOR_BEGIN: 7,
    SENSOR_END: 8,
    WEED_JOINTS: 9,
    BODY_SYNC_MS: 10,
    JOINT_SYNC_MS: 11,
    COMMAND_MS: 12,
    FORCE_MS: 13,
    BOX2D_MS: 14,
    POST_MS: 15,
    BODY_SYNC_CHANGES: 16,
    BODY_SYNC_VISITED: 17,
    JOINT_SYNC_CHANGES: 18,
    COMMAND_COUNT: 19,
    COMMAND_OVERFLOW_TOTAL: 20,
    CONTACT_DROPPED: 21,
    SENSOR_DROPPED: 22,
    HEAP_USED_KB: 23,
    HEAP_HIGH_WATER_KB: 24,
    BODY_MOVED_COUNT: 25,
    AWAKE_COUNT: 26,
    PROFILE_STEP_MS: 27,
    PROFILE_COLLIDE_MS: 28,
    PROFILE_SOLVE_MS: 29,
    PROFILE_SLEEP_MS: 30,
    PROFILE_SENSORS_MS: 31,
    COUNTER_CONTACTS: 32,
    COUNTER_ISLANDS: 33,
    COUNTER_AWAKE_CONTACTS: 34,
    COUNTER_TREE_HEIGHT: 35,
    LIQUIDFUN_MS: 36,
    LF_PASS_GRID_MS: 37,
    LF_PASS_FIND_CONTACTS_MS: 38,
    LF_PASS_BODY_MS: 39,
    LF_PASS_WEIGHT_MS: 40,
    LF_PASS_STATIC_PRESSURE_MS: 41,
    LF_PASS_PRESSURE_MS: 42,
    LF_PASS_CONTACT_SOLVERS_MS: 43,
    LF_PASS_REST_MS: 44,
  };

  let heapHighWaterKb = 0;
  let weedjsHeapBytesUsed = null;

  function viewFromDesc(desc, TypedArray) {
    return new TypedArray(desc.sab, desc.byteOffset, desc.length);
  }

  function bindWeedViews(desc) {
    // Pose/vel/sleeping are HEAP-only (bound in bindStateChannels). SoA supplies the rest.
    views = {
      entityActive: viewFromDesc(desc.entityActive, Uint8Array),
      x: null,
      y: null,
      rotation: null,
      rbActive: viewFromDesc(desc.rbActive, Uint8Array),
      rbStatic: viewFromDesc(desc.rbStatic, Uint8Array),
      vx: null,
      vy: null,
      ax: viewFromDesc(desc.ax, Float32Array),
      ay: viewFromDesc(desc.ay, Float32Array),
      px: desc.px ? viewFromDesc(desc.px, Float32Array) : null,
      py: desc.py ? viewFromDesc(desc.py, Float32Array) : null,
      pRotation: desc.pRotation
        ? viewFromDesc(desc.pRotation, Float32Array)
        : null,
      angularVelocity: null,
      angularAccel: viewFromDesc(desc.angularAccel, Float32Array),
      mass: viewFromDesc(desc.mass, Float32Array),
      linearDamping: viewFromDesc(desc.linearDamping, Float32Array),
      angularDamping: viewFromDesc(desc.angularDamping, Float32Array),
      sleeping: null,
      fixedRotation: desc.fixedRotation
        ? viewFromDesc(desc.fixedRotation, Uint8Array)
        : null,
      sleepThreshold: desc.sleepThreshold
        ? viewFromDesc(desc.sleepThreshold, Float32Array)
        : null,
      colActive: viewFromDesc(desc.colActive, Uint8Array),
      offsetX: viewFromDesc(desc.offsetX, Float32Array),
      offsetY: viewFromDesc(desc.offsetY, Float32Array),
      shapeType: viewFromDesc(desc.shapeType, Uint8Array),
      radius: viewFromDesc(desc.radius, Float32Array),
      width: viewFromDesc(desc.width, Float32Array),
      height: viewFromDesc(desc.height, Float32Array),
      isTrigger: viewFromDesc(desc.isTrigger, Uint8Array),
      collisionLayer: viewFromDesc(desc.collisionLayer, Uint8Array),
      collisionMask: viewFromDesc(desc.collisionMask, Uint32Array),
      collisionGroupIndex: viewFromDesc(desc.collisionGroupIndex, Int32Array),
      friction: viewFromDesc(desc.friction, Float32Array),
      restitution: viewFromDesc(desc.restitution, Float32Array),
      enableHitEvents: viewFromDesc(desc.enableHitEvents, Uint8Array),
      polyCount: viewFromDesc(desc.polyCount, Uint8Array),
      polyVertexX: viewFromDesc(desc.polyVertexX, Float32Array),
      polyVertexY: viewFromDesc(desc.polyVertexY, Float32Array),
    };
  }

  function bindBodySyncViews(desc) {
    if (!desc) {
      bodyDirtyFlags = null;
      bodyDirtyWords = null;
      bodyGeneration = null;
      return;
    }
    bodyDirtyFlags = viewFromDesc(desc.dirtyFlags, Int32Array);
    bodyDirtyWords = viewFromDesc(desc.dirtyWords, Int32Array);
    bodyGeneration = viewFromDesc(desc.generation, Int32Array);
  }

  function bindJointViews(desc, maxJ) {
    if (!desc || !(maxJ > 0)) {
      jointViews = null;
      jointHandle = null;
      jointSeenRev = null;
      jointDense = null;
      jointDenseCount = 0;
      jointLive = null;
      maxJoints = 0;
      return;
    }
    maxJoints = maxJ | 0;
    jointViews = {
      type: viewFromDesc(desc.type, Uint8Array),
      pairs: viewFromDesc(desc.pairs, Uint32Array),
      localAnchorAX: viewFromDesc(desc.localAnchorAX, Float32Array),
      localAnchorAY: viewFromDesc(desc.localAnchorAY, Float32Array),
      localAnchorBX: viewFromDesc(desc.localAnchorBX, Float32Array),
      localAnchorBY: viewFromDesc(desc.localAnchorBY, Float32Array),
      forceThreshold: viewFromDesc(desc.forceThreshold, Float32Array),
      torqueThreshold: viewFromDesc(desc.torqueThreshold, Float32Array),
      active: viewFromDesc(desc.active, Uint8Array),
      length: viewFromDesc(desc.length, Float32Array),
      enableSpring: viewFromDesc(desc.enableSpring, Uint8Array),
      hertz: viewFromDesc(desc.hertz, Float32Array),
      dampingRatio: viewFromDesc(desc.dampingRatio, Float32Array),
      enableLimit: viewFromDesc(desc.enableLimit, Uint8Array),
      lowerAngle: viewFromDesc(desc.lowerAngle, Float32Array),
      upperAngle: viewFromDesc(desc.upperAngle, Float32Array),
      enableMotor: viewFromDesc(desc.enableMotor, Uint8Array),
      motorSpeed: viewFromDesc(desc.motorSpeed, Float32Array),
      maxMotorTorque: viewFromDesc(desc.maxMotorTorque, Float32Array),
      linearHertz: viewFromDesc(desc.linearHertz, Float32Array),
      angularHertz: viewFromDesc(desc.angularHertz, Float32Array),
      linearDampingRatio: viewFromDesc(desc.linearDampingRatio, Float32Array),
      angularDampingRatio: viewFromDesc(desc.angularDampingRatio, Float32Array),
      activeIndices: viewFromDesc(desc.activeIndices, Uint16Array),
      activeIndexPositions: viewFromDesc(desc.activeIndexPositions, Uint16Array),
      activeCount: viewFromDesc(desc.activeCount, Int32Array),
      activeListLock: viewFromDesc(desc.activeListLock, Int32Array),
      revision: viewFromDesc(desc.revision, Uint32Array),
    };
    jointHandle = new Int32Array(maxJoints);
    jointHandle.fill(-1);
    jointSeenRev = new Uint32Array(maxJoints);
    jointDense = new Uint16Array(maxJoints);
    jointDenseCount = 0;
    jointLive = new Uint8Array(maxJoints);
  }

  function bindStateChannels(ready, entityCount) {
    const sab = ready.sab;
    const n = ready.bodyCapacity;
    const off = ready.channelOffsets;
    pxChan = new Float32Array(sab, off[STATE_CHANNELS.X] << 2, n);
    pyChan = new Float32Array(sab, off[STATE_CHANNELS.Y] << 2, n);
    rotChan = new Float32Array(sab, off[STATE_CHANNELS.ROTATION] << 2, n);
    vxChan = new Float32Array(sab, off[STATE_CHANNELS.VX] << 2, n);
    vyChan = new Float32Array(sab, off[STATE_CHANNELS.VY] << 2, n);
    angChan = new Float32Array(sab, off[STATE_CHANNELS.ANG_VEL] << 2, n);
    const rotCChan = new Float32Array(sab, off[STATE_CHANNELS.ROT_C] << 2, n);
    const rotSChan = new Float32Array(sab, off[STATE_CHANNELS.ROT_S] << 2, n);
    sleepingU8 =
      ready.sleepingByteOffset >= 0
        ? new Uint8Array(sab, ready.sleepingByteOffset, n)
        : null;

    // HEAP is sole pose/vel/sleep store — zero channels, then point views (zero-copy).
    const count = Math.min(entityCount | 0, n);
    pxChan.fill(0, 0, count);
    pyChan.fill(0, 0, count);
    rotChan.fill(0, 0, count);
    vxChan.fill(0, 0, count);
    vyChan.fill(0, 0, count);
    angChan.fill(0, 0, count);
    rotCChan.fill(1, 0, count);
    rotSChan.fill(0, 0, count);
    if (sleepingU8) sleepingU8.fill(0, 0, count);

    views.x = pxChan;
    views.y = pyChan;
    views.rotation = rotChan;
    views.rotC = rotCChan;
    views.rotS = rotSChan;
    views.vx = vxChan;
    views.vy = vyChan;
    views.angularVelocity = angChan;
    if (sleepingU8) {
      views.sleeping = sleepingU8;
    }

    seedPrevPose(count);
  }

  function bindPosePublish(pose) {
    poseSync = null;
    poseBuffers = [null, null];
    poseCapacity = 0;
    poseFrame = 0;
    if (!pose || !pose.sync || !pose.dataA || !pose.dataB) return;
    const n = pose.capacity | 0;
    if (!(n > 0)) return;
    poseCapacity = n;
    poseSync = new Int32Array(pose.sync);
    // 4 channels: x,y,rotC,rotS.
    const bytesPerBuf = n * 4 * 4;
    for (let i = 0; i < 2; i++) {
      const sab = i === 0 ? pose.dataA : pose.dataB;
      poseBuffers[i] = {
        x: new Float32Array(sab, 0, n),
        y: new Float32Array(sab, n * 4, n),
        rotC: new Float32Array(sab, n * 8, n),
        rotS: new Float32Array(sab, n * 12, n),
      };
      if (sab.byteLength < bytesPerBuf) {
        console.warn('[weedjs-box2d] pose buffer too small', sab.byteLength, bytesPerBuf);
      }
    }
  }

  function seedPrevPose(count) {
    if (!views.px) return;
    const n = count | 0;
    for (let i = 0; i < n; i++) {
      views.px[i] = views.x[i];
      views.py[i] = views.y[i];
      // pRotation unused by render; leave untouched (no atan2)
    }
  }

  /** Snapshot prev pose before world.step. */
  function snapshotPrevPose(entityCount) {
    if (!views.px) return;
    const n = entityCount | 0;
    const rb = views.rbActive;
    for (let i = 0; i < n; i++) {
      if (rb && !rb[i]) continue;
      views.px[i] = views.x[i];
      views.py[i] = views.y[i];
    }
  }

  /**
   * Publish post-step Transform into double-buffered pose SAB (Atomics seq).
   * SoA: x, y, rotC, rotS.
   */
  function publishPose(/* entityCount */) {
    if (!poseSync || !poseBuffers[0] || !denseList) return;
    const writeIdx = poseFrame & 1;
    const buf = poseBuffers[writeIdx];
    const x = views.x;
    const y = views.y;
    const rotC = views.rotC;
    const rotS = views.rotS;
    const outX = buf.x;
    const outY = buf.y;
    const outC = buf.rotC;
    const outS = buf.rotS;
    const list = denseList;
    const n = denseCount;
    for (let d = 0; d < n; d++) {
      const i = list[d];
      outX[i] = x[i];
      outY[i] = y[i];
      outC[i] = rotC[i];
      outS[i] = rotS[i];
    }
    poseFrame++;
    Atomics.store(poseSync, 0, poseFrame);
    Atomics.notify(poseSync, 0, 1);
  }

  /**
   * Next pose write would overwrite the slot pre_render is still reading.
   * Never skip world.step — only skip publish. HEAP keeps moving; next free
   * slot gets the latest pose (forward skip, not rewind, no sim hitch).
   */
  function posePublishBlocked() {
    if (!poseSync) return false;
    return poseFrame > Atomics.load(poseSync, 1);
  }

  function maybePublishPose(entityCount) {
    if (posePublishBlocked()) return;
    publishPose(entityCount);
  }

  function isFixedRotation(i) {
    return !!(views.fixedRotation && views.fixedRotation[i]);
  }

  function categoryBitsFor(i) {
    const layer = views.collisionLayer[i] | 0;
    return layer <= 31 ? 1 << layer : 1;
  }

  function densityForEntity(i, shape) {
    let area = 0;
    if (shape === ShapeType.Circle) {
      const r = views.radius[i];
      area = Math.PI * r * r;
    } else if (shape === ShapeType.Box) {
      area = views.width[i] * views.height[i];
    } else if (shape === ShapeType.Polygon) {
      const count = views.polyCount[i] | 0;
      const base = i * MAX_POLY_VERTS;
      let twiceArea = 0;
      for (let v = 0; v < count; v++) {
        const next = v + 1 < count ? v + 1 : 0;
        twiceArea +=
          views.polyVertexX[base + v] * views.polyVertexY[base + next] -
          views.polyVertexX[base + next] * views.polyVertexY[base + v];
      }
      area = Math.abs(twiceArea) * 0.5;
    }
    const mass = views.mass[i];
    return mass > 0 && area > 0 ? mass / area : 1;
  }

  function createBodyForEntity(i) {
    const rb = views.rbActive[i] !== 0;
    const col = views.colActive[i] !== 0;
    // Collider-only → implicit static. RB-only / both → honor rbStatic.
    const isStatic = !rb || views.rbStatic[i] !== 0;
    const type = isStatic ? Box2dBodyType.STATIC : Box2dBodyType.DYNAMIC;
    const shape = views.shapeType[i] | 0;
    const rawFriction = views.friction[i];
    const friction = rawFriction >= 0 ? rawFriction : 0;
    const restitution = views.restitution[i] || 0;
    const enableHitEvents = views.enableHitEvents[i] !== 0;
    const linearDamping = views.linearDamping[i] || 0;
    const angularDamping = views.angularDamping[i] || 0;
    const angle = isFixedRotation(i) ? 0 : views.rotation[i];
    const opts = {
      type,
      x: views.x[i],
      y: views.y[i],
      angle,
      offsetX: views.offsetX[i],
      offsetY: views.offsetY[i],
      density: densityForEntity(i, shape),
      friction,
      restitution,
      linearDamping,
      angularDamping,
      gravityScale: 1,
      vx: views.vx[i],
      vy: views.vy[i],
      angularVelocity: views.angularVelocity[i],
      isSensor: views.isTrigger[i] !== 0,
      enableHitEvents,
      categoryBits: categoryBitsFor(i),
      maskBits: views.collisionMask[i] >>> 0,
      groupIndex: views.collisionGroupIndex[i] | 0,
      fixedRotation: isFixedRotation(i),
      entityIndex: i,
    };

    try {
      // RigidBody without Collider: shapeless body (moves, no contacts).
      if (rb && !col) {
        world.create(opts);
        return true;
      }
      if (!col) return false;
      if (shape === ShapeType.Circle) {
        const r = views.radius[i];
        if (!(r > 0)) return false;
        world.createCircle({ ...opts, radius: r });
      } else if (shape === ShapeType.Box) {
        const hx = views.width[i] * 0.5;
        const hy = views.height[i] * 0.5;
        if (!(hx > 0 && hy > 0)) return false;
        world.createBox({ ...opts, hx, hy });
      } else if (shape === ShapeType.Polygon) {
        const count = views.polyCount[i] | 0;
        if (count < 3) return false;
        const base = i * MAX_POLY_VERTS;
        const verts = [];
        for (let v = 0; v < count; v++) {
          verts.push(views.polyVertexX[base + v], views.polyVertexY[base + v]);
        }
        world.createPolygon({ ...opts, verts });
      } else {
        return false;
      }
    } catch (err) {
      console.error('[weedjs-box2d] createBody failed', i, err);
      return false;
    }
    return true;
  }

  function syncBodyGeometry(i) {
    const shape = views.shapeType[i] | 0;
    const offsetX = views.offsetX[i];
    const offsetY = views.offsetY[i];
    if (shape === ShapeType.Circle) {
      const radius = views.radius[i];
      if (radius > 0) {
        bodySetShapeCircleFn(i, radius, offsetX, offsetY);
      }
    } else if (shape === ShapeType.Box) {
      const hx = views.width[i] * 0.5;
      const hy = views.height[i] * 0.5;
      if (hx > 0 && hy > 0) {
        bodySetShapeBoxFn(i, hx, hy, offsetX, offsetY);
      }
    } else if (shape === ShapeType.Polygon) {
      const count = views.polyCount[i] | 0;
      if (count < 3) return;
      const ptr = Module._malloc(count * 2 * 4);
      try {
        const base = i * MAX_POLY_VERTS;
        const heapBase = ptr >> 2;
        for (let v = 0; v < count; v++) {
          Module.HEAPF32[heapBase + v * 2] = views.polyVertexX[base + v];
          Module.HEAPF32[heapBase + v * 2 + 1] = views.polyVertexY[base + v];
        }
        bodySetShapePolygonFn(i, ptr, count, offsetX, offsetY);
      } finally {
        Module._free(ptr);
      }
    }
  }

  function syncBodyProperties(i, flags) {
    const rb = views.rbActive[i] !== 0;
    const col = views.colActive[i] !== 0;
    if (flags & BODY_DIRTY.BODY_TYPE) {
      // Collider-only stays static even if rbStatic SoA is stale.
      bodySetTypeFn(
        i,
        !rb || views.rbStatic[i] ? Box2dBodyType.STATIC : Box2dBodyType.DYNAMIC,
      );
    }
    if (flags & BODY_DIRTY.DAMPING) {
      bodySetLinearDampingFn(i, views.linearDamping[i]);
      bodySetAngularDampingFn(i, views.angularDamping[i]);
    }
    if (flags & BODY_DIRTY.GEOMETRY) {
      if (col) {
        syncBodyGeometry(i);
      } else if (bodyClearShapesFn) {
        bodyClearShapesFn(i);
      }
    }
    if (col && flags & (BODY_DIRTY.MASS | BODY_DIRTY.GEOMETRY)) {
      bodySetDensityFn(i, densityForEntity(i, views.shapeType[i] | 0));
    }
    if (col && flags & BODY_DIRTY.FILTER) {
      bodySetFilterFn(
        i,
        categoryBitsFor(i) >>> 0,
        views.collisionMask[i] >>> 0,
        views.collisionGroupIndex[i] | 0,
      );
    }
    if (col && flags & BODY_DIRTY.FRICTION) {
      const friction = views.friction[i];
      bodySetFrictionFn(i, friction >= 0 ? friction : 0);
      bodySetRestitutionFn(i, views.restitution[i] || 0);
    }
  }

  function addDenseBody(i) {
    if (densePositions[i] >= 0) return;
    densePositions[i] = denseCount;
    denseList[denseCount++] = i;
  }

  function removeDenseBody(i) {
    const position = densePositions[i];
    if (position < 0) return;
    const lastPosition = --denseCount;
    const lastEntity = denseList[lastPosition];
    if (position !== lastPosition) {
      denseList[position] = lastEntity;
      densePositions[lastEntity] = position;
    }
    densePositions[i] = -1;
  }

  function syncBodySlot(i, flags) {
    let changes = 0;
    let created = false;
    const want =
      views.entityActive[i] !== 0 &&
        (views.rbActive[i] !== 0 || views.colActive[i] !== 0)
        ? 1
        : 0;
    let have = hasBody[i];
    const generation = bodyGeneration
      ? Atomics.load(bodyGeneration, i)
      : 0;

    if (have && (!want || seenBodyGeneration[i] !== generation)) {
      // Box2D 3 b2DestroyBody also destroys attached joints (body.c). Wrapper
      // g_joints[] stays live → step_world export_all_joints uses stale
      // b2JointId → b2Array_Get OOB. Drop WASM joints first.
      destroyWasmJointsForEntity(i);
      try {
        world.destroyBody(i);
      } catch (_) {
        /* slot may already be clear */
      }
      hasBody[i] = 0;
      createFailed[i] = 0;
      have = 0;
      removeDenseBody(i);
      changes++;
    }

    if (want && !have) {
      if (createBodyForEntity(i)) {
        hasBody[i] = 1;
        createFailed[i] = 0;
        seenBodyGeneration[i] = generation;
        addDenseBody(i);
        created = true;
        changes++;
        const sleepThreshold = views.sleepThreshold ? views.sleepThreshold[i] : 0;
        if (sleepThreshold > 0) {
          bodySetSleepThresholdFn(i, sleepThreshold);
        }
        if (views.px) {
          views.px[i] = views.x[i];
          views.py[i] = views.y[i];
        }
      } else if (!createFailed[i]) {
        createFailed[i] = 1;
        console.warn('[weedjs-box2d] createBody failed; wait for next dirty', i);
      }
    }
    // LIFECYCLE alone = create/destroy above. Property sync (clear shapes /
    // BODY_TYPE / mass) needs other dirty bits — collider/rb `.active` setters
    // publish LIFECYCLE|GEOMETRY|MASS or LIFECYCLE|BODY_TYPE|MASS so this runs.
    if (hasBody[i] && !created && flags !== BODY_DIRTY.LIFECYCLE) {
      syncBodyProperties(i, flags);
    }
    return changes;
  }

  function syncBodies(entityCount) {
    if (!bodyDirtyFlags || !bodyDirtyWords) {
      throw new Error('[weedjs-box2d] body dirty sync buffers required');
    }
    let changes = 0;
    let visited = 0;
    for (let wordIndex = 0; wordIndex < bodyDirtyWords.length; wordIndex++) {
      let bits = Atomics.exchange(bodyDirtyWords, wordIndex, 0) >>> 0;
      while (bits !== 0) {
        const bit = 31 - Math.clz32(bits & -bits);
        const i = (wordIndex << 5) + bit;
        bits = (bits & (bits - 1)) >>> 0;
        if (i >= entityCount) continue;
        const flags = Atomics.exchange(bodyDirtyFlags, i, 0);
        visited++;
        changes += syncBodySlot(i, flags);
      }
    }
    lastBodySyncVisited = visited;
    return changes;
  }

  function jointRevision(idx) {
    const rev = jointViews.revision;
    return rev ? Atomics.load(rev, idx) >>> 0 : 0;
  }

  function destroyJointAt(idx) {
    const h = jointHandle[idx];
    if (h < 0) {
      if (h === -2) jointHandle[idx] = -1;
      return;
    }
    try {
      world.destroyJoint(h);
    } catch (_) {
      /* already gone with body */
    }
    jointHandle[idx] = -1;
    jointSeenRev[idx] = 0;
  }

  function destroyWasmJointsForEntity(entityIdx) {
    if (!jointHandle || !jointViews || entityIdx < 0) return;
    const pairs = jointViews.pairs;
    const n = maxJoints;
    for (let idx = 0; idx < n; idx++) {
      if (jointHandle[idx] < 0) continue;
      const packed = pairs[idx];
      if ((packed >>> 16) === entityIdx || (packed & 0xffff) === entityIdx) {
        destroyJointAt(idx);
      }
    }
  }

  function acquireJointSpinLock(lockView) {
    if (!lockView) return;
    while (Atomics.compareExchange(lockView, 0, 0, 1) !== 0) {
      // Joint break is rare — short spin lock acceptable here.
    }
  }

  function releaseJointSpinLock(lockView) {
    if (!lockView) return;
    Atomics.store(lockView, 0, 0);
  }

  /** Mirrors Joint.remove (src/core/joint.js) — pool free list untouched (ponytail: idx leak on break, upgrade: bind jointFreeList/jointFreeListTop here too). */
  function removeWeedJoint(idx) {
    const jv = jointViews;
    if (!jv || idx < 0 || idx >= maxJoints || !jv.active[idx]) return;

    acquireJointSpinLock(jv.activeListLock);
    try {
      if (!jv.active[idx]) return;
      const count = jv.activeCount ? Atomics.load(jv.activeCount, 0) : 0;
      const slot = jv.activeIndexPositions[idx];
      const lastSlot = count - 1;

      jv.active[idx] = 0;

      if (slot !== 0xffff && lastSlot >= 0) {
        const lastIdx = jv.activeIndices[lastSlot];
        if (slot !== lastSlot) {
          jv.activeIndices[slot] = lastIdx;
          jv.activeIndexPositions[lastIdx] = slot;
        }
        jv.activeIndices[lastSlot] = 0xffff;
        jv.activeIndexPositions[idx] = 0xffff;
        if (jv.activeCount) {
          Atomics.store(jv.activeCount, 0, lastSlot);
        }
      }
    } finally {
      releaseJointSpinLock(jv.activeListLock);
    }

    if (jv.revision) Atomics.add(jv.revision, idx, 1);
  }

  function createJointAt(idx) {
    const jv = jointViews;
    const packed = jv.pairs[idx];
    const a = packed >>> 16;
    const b = packed & 0xffff;
    if (a === b || !hasBody[a] || !hasBody[b]) return false;
    const rev = jointRevision(idx);
    // -2 = fail for this revision only; slot recycle bumps revision and retries
    if (jointHandle[idx] === -2) {
      if (jointSeenRev[idx] === rev) return false;
      jointHandle[idx] = -1;
    }

    const bodyA = { slot: a };
    const bodyB = { slot: b };
    const opts = {
      bodyA,
      bodyB,
      localAnchorAX: jv.localAnchorAX[idx],
      localAnchorAY: jv.localAnchorAY[idx],
      localAnchorBX: jv.localAnchorBX[idx],
      localAnchorBY: jv.localAnchorBY[idx],
    };

    let handleObj = null;
    try {
      const t = jv.type[idx] | 0;
      if (t === JOINT_TYPE.DISTANCE) {
        handleObj = world.createDistanceJointLocal({
          ...opts,
          length: jv.length[idx],
          enableSpring: jv.enableSpring[idx] !== 0,
          hertz: jv.hertz[idx],
          dampingRatio: jv.dampingRatio[idx],
        });
      } else if (t === JOINT_TYPE.REVOLUTE) {
        handleObj = world.createRevoluteJointLocal({
          ...opts,
          enableLimit: jv.enableLimit[idx] !== 0,
          lowerAngle: jv.lowerAngle[idx],
          upperAngle: jv.upperAngle[idx],
          enableMotor: jv.enableMotor[idx] !== 0,
          motorSpeed: jv.motorSpeed[idx],
          maxMotorTorque: jv.maxMotorTorque[idx],
        });
      } else if (t === JOINT_TYPE.WELD) {
        handleObj = world.createWeldJointLocal({
          ...opts,
          linearHertz: jv.linearHertz[idx],
          angularHertz: jv.angularHertz[idx],
          linearDampingRatio: jv.linearDampingRatio[idx],
          angularDampingRatio: jv.angularDampingRatio[idx],
        });
      } else {
        return false;
      }
    } catch (err) {
      jointHandle[idx] = -2;
      jointSeenRev[idx] = rev;
      if (!jointCapacityWarn) {
        jointCapacityWarn = true;
        console.warn(
          '[weedjs-box2d] joint create failed (OOM/cap/reject) — stop retry',
          err?.message ?? err,
        );
      }
      return false;
    }

    jointHandle[idx] = handleObj.handle;
    jointSeenRev[idx] = rev;
    const force = jv.forceThreshold ? jv.forceThreshold[idx] : Infinity;
    const torque = jv.torqueThreshold ? jv.torqueThreshold[idx] : Infinity;
    handleObj.configure(
      idx,
      Number.isFinite(force) ? force : 1e30,
      Number.isFinite(torque) ? torque : 1e30,
    );
    return true;
  }

  function syncJoints() {
    if (!jointViews || !jointHandle || !world) return 0;
    const jv = jointViews;
    const activeCount = Atomics.load(jv.activeCount, 0) | 0;
    let changes = 0;

    for (let i = 0; i < jointDenseCount; i++) {
      jointLive[jointDense[i]] = 0;
    }

    let nextDenseCount = 0;
    for (let slot = 0; slot < activeCount; slot++) {
      const idx = jv.activeIndices[slot];
      if (idx === 0xffff || !jv.active[idx]) continue;
      jointLive[idx] = 1;
      const packed = jv.pairs[idx];
      const a = packed >>> 16;
      const b = packed & 0xffff;
      const want = hasBody[a] && hasBody[b] ? 1 : 0;
      const have = jointHandle[idx] >= 0 ? 1 : 0;
      const rev = jointRevision(idx);
      if (want && have && jointSeenRev[idx] !== rev) {
        destroyJointAt(idx);
        createJointAt(idx);
        changes++;
      } else if (want && !have) {
        if (createJointAt(idx)) changes++;
      } else if (!want && have) {
        destroyJointAt(idx);
        changes++;
      }
      if (jointHandle[idx] >= 0) {
        jointDense[nextDenseCount++] = idx;
      }
    }

    for (let i = 0; i < jointDenseCount; i++) {
      const idx = jointDense[i];
      if (!jointLive[idx] && jointHandle[idx] >= 0) {
        destroyJointAt(idx);
        changes++;
      }
    }
    jointDenseCount = nextDenseCount;
    return changes;
  }

  let sleepingEnabled = true;

  let bodyApplyForceCenterFn = null;
  let bodyApplyTorqueFn = null;
  let bodySetLinearVelocityFn = null;
  let bodySetTransformFn = null;
  let bodySetAwakeFn = null;
  let bodySetAngularVelocityFn = null;
  let bodySetFixedRotationFn = null;
  let bodySetTypeFn = null;
  let bodySetLinearDampingFn = null;
  let bodySetAngularDampingFn = null;
  let bodySetFilterFn = null;
  let bodySetFrictionFn = null;
  let bodySetRestitutionFn = null;
  let bodySetSleepThresholdFn = null;
  let bodySetDensityFn = null;
  let bodySetShapeBoxFn = null;
  let bodySetShapeCircleFn = null;
  let bodySetShapePolygonFn = null;
  let bodyClearShapesFn = null;

  // Teleports skip b2BodyMoveEvent — accumulate and merge into moved SAB after step
  let pendingTeleportBits = null;
  let pendingTeleportList = null;
  let pendingTeleportCount = 0;

  function markTeleportMoved(entity) {
    const e = entity | 0;
    if (!pendingTeleportBits || e < 0 || e >= pendingTeleportBits.length) return;
    if (pendingTeleportBits[e]) return;
    pendingTeleportBits[e] = 1;
    pendingTeleportList[pendingTeleportCount++] = e >>> 0;
  }

  // Hoisted once — drainCommands must not allocate a fresh handlers object every step
  const cmdHandlers = {
    setTransform(entity, x, y, rotC, rotS) {
      if (!hasBody[entity]) return;
      let c = rotC;
      let s = rotS;
      if (isFixedRotation(entity)) {
        c = 1;
        s = 0;
      }
      bodySetTransformFn(entity, x, y, c, s);
      if (bodySetAwakeFn) bodySetAwakeFn(entity, 1);
      markTeleportMoved(entity);
    },
    setVelocity(entity, vx, vy) {
      if (!hasBody[entity]) return;
      bodySetLinearVelocityFn(entity, vx, vy);
    },
    setRotCS(entity, rotC, rotS) {
      if (!hasBody[entity]) return;
      const x = pxChan[entity];
      const y = pyChan[entity];
      let c = rotC;
      let s = rotS;
      if (isFixedRotation(entity)) {
        c = 1;
        s = 0;
      }
      bodySetTransformFn(entity, x, y, c, s);
      if (bodySetAwakeFn) bodySetAwakeFn(entity, 1);
      markTeleportMoved(entity);
    },
    setAngularVelocity(entity, w) {
      if (!hasBody[entity]) return;
      bodySetAngularVelocityFn(entity, w);
    },
    setFixedRotation(entity, flag) {
      if (!hasBody[entity]) return;
      const f = flag ? 1 : 0;
      bodySetFixedRotationFn(entity, f);
      if (f) {
        rotChan[entity] = 0;
        if (views.rotC) views.rotC[entity] = 1;
        if (views.rotS) views.rotS[entity] = 0;
        bodySetAngularVelocityFn(entity, 0);
      }
    },
    explode(maskBits, x, y, radius, impulsePerLength) {
      if (!world) return;
      world.explode(x, y, radius, radius * 0.5, impulsePerLength, maskBits >>> 0);
    },
    setSleepThreshold(entity, threshold) {
      if (!hasBody[entity]) return;
      bodySetSleepThresholdFn(entity, threshold);
    },
    setAwake(entity, flag) {
      if (!hasBody[entity] || !bodySetAwakeFn) return;
      bodySetAwakeFn(entity, flag ? 1 : 0);
    },
    setLiquidFunEmit(packed, spacing, strength, tintBits, viscousScale) {
      pendingLiquidFunEmit.textureId = packed & 0xffff;
      pendingLiquidFunEmit.trackGroup = (packed >>> 16) & 1;
      pendingLiquidFunEmit.groupFlags = (packed >>> 17) & 0xf;
      pendingLiquidFunEmit.spacing = spacing || 0;
      pendingLiquidFunEmit.strength = strength || 0;
      pendingLiquidFunEmit.tintBits = tintBits >>> 0;
      pendingLiquidFunEmit.viscousScale = viscousScale > 0 ? viscousScale : 1;
      pendingLiquidFunEmit.pending = true;
    },
    setLiquidFunLifespan(lifetimeMinSec, lifetimeMaxSec, fadeToAlpha0) {
      pendingLiquidFunEmit.lifetimeMin = lifetimeMinSec || 0;
      pendingLiquidFunEmit.lifetimeMax = lifetimeMaxSec || 0;
      pendingLiquidFunEmit.fadeToAlpha0 = fadeToAlpha0 ? 1 : 0;
      pendingLiquidFunEmit.pending = true;
    },
    setLiquidFunScale(scaleMin, scaleMax, alphaMin, alphaMax) {
      pendingLiquidFunEmit.scaleSet = 1;
      pendingLiquidFunEmit.scaleMin = scaleMin;
      pendingLiquidFunEmit.scaleMax = scaleMax;
      pendingLiquidFunEmit.alphaMin = alphaMin;
      pendingLiquidFunEmit.alphaMax = alphaMax;
      pendingLiquidFunEmit.pending = true;
    },
    setLiquidFunLight(lightIntensity) {
      pendingLiquidFunEmit.lightIntensity = lightIntensity > 0 ? lightIntensity : 0;
      pendingLiquidFunEmit.pending = true;
    },
    setLiquidFunLayers(mask) {
      pendingLiquidFunEmit.layerMask = mask & 0xffff;
      pendingLiquidFunEmit.layerMaskSet = 1;
      pendingLiquidFunEmit.pending = true;
    },
    setLiquidFunPayload(userData, color, vx, vy, omega) {
      pendingLiquidFunEmit.userData = userData >>> 0;
      pendingLiquidFunEmit.color = color >>> 0;
      pendingLiquidFunEmit.vx = vx || 0;
      pendingLiquidFunEmit.vy = vy || 0;
      pendingLiquidFunEmit.omega = omega || 0;
      pendingLiquidFunEmit.pending = true;
    },
    setParticleUserData(index, bits) {
      if (!world || typeof world.setParticleUserData !== 'function') return;
      world.setParticleUserData(index, bits);
    },
    setParticleUserDataRange(first, last, bits) {
      if (!world || typeof world.setParticleUserDataRange !== 'function') return;
      world.setParticleUserDataRange(first, last, bits);
    },
    setParticleUserDataList() {
      if (typeof LiquidFunUserDataList === 'undefined') return;
      LiquidFunUserDataList.applyLiquidFunUserDataList(liquidFunUserDataU32, function (index, bits) {
        if (world && typeof world.setParticleUserData === 'function') {
          world.setParticleUserData(index, bits);
        }
      });
    },
    setParticleColor(index, rgba) {
      if (!world || typeof world.setParticleColor !== 'function') return;
      world.setParticleColor(index, rgba);
    },
    setParticleColorRange(first, last, rgba) {
      if (!world || typeof world.setParticleColorRange !== 'function') return;
      world.setParticleColorRange(first, last, rgba);
    },
    setParticleFlags(index, flags) {
      if (!world || typeof world.setParticleFlags !== 'function') return;
      world.setParticleFlags(index, flags);
    },
    setParticleViscousScale(index, scale) {
      if (!world || typeof world.setParticleViscousScale !== 'function') return;
      world.setParticleViscousScale(index, scale);
    },
    setParticleViscousScaleRange(first, last, scale) {
      if (!world || typeof world.setParticleViscousScaleRange !== 'function') return;
      world.setParticleViscousScaleRange(first, last, scale);
    },
    setGroupFlags(groupId, flags) {
      if (!world || typeof world.setParticleGroupFlags !== 'function') return;
      world.setParticleGroupFlags(groupId, flags);
    },
    destroyParticle(index) {
      if (!world || typeof world.destroyParticle !== 'function') return;
      world.destroyParticle(index);
    },
    createParticle(flags, x, y, vx, vy) {
      if (!world || typeof world.createParticle !== 'function') return;
      const emit = takePendingLiquidFunEmit();
      const oldCount = world.getParticleCount();
      world.createParticle(x, y, vx, vy, flags || 0, emit.userData, packedEmitColor(emit));
      paintNewLiquidFunParticles(oldCount, emit);
    },
    particleApplyForceRange(first, last, fx, fy) {
      if (!world || typeof world.particleApplyForceRange !== 'function') return;
      world.particleApplyForceRange(first, last, fx, fy);
    },
    particleApplyImpulseRange(first, last, ix, iy) {
      if (!world || typeof world.particleApplyLinearImpulseRange !== 'function') return;
      world.particleApplyLinearImpulseRange(first, last, ix, iy);
    },
    extractParticles(groupId, count, groupFlags, trackGroup) {
      serviceLiquidFunExtract();
    },
    setParticleTuning(phase, a, b, c, d) {
      const p = phase | 0;
      if (p === 0) {
        pendingParticleTuning.dampingStrength = a;
        pendingParticleTuning.pressureStrength = b;
        pendingParticleTuning.viscousStrength = c;
        pendingParticleTuning.tensileStrength = d;
      } else if (p === 1) {
        pendingParticleTuning.powderStrength = a;
        pendingParticleTuning.springStrength = b;
        pendingParticleTuning.staticPressureStrength = c;
        pendingParticleTuning.staticPressureRelaxation = d;
      } else if (p === 2) {
        pendingParticleTuning.staticPressureIterations = a | 0;
      } else if (p === 3) {
        pendingParticleTuning.ejectionStrength = a;
        pendingParticleTuning.colorMixingStrength = b;
        pendingParticleTuning.repulsiveStrength = c;
        if (world && typeof world.setParticleTuning === 'function') {
          world.setParticleTuning(pendingParticleTuning);
        }
      }
    },
    setGroupViscousScale(groupId, scale) {
      if (!world || typeof world.setGroupViscousScale !== 'function') return;
      world.setGroupViscousScale(groupId, scale);
    },
    joinParticleGroups(groupA, groupB) {
      if (!world || typeof world.joinParticleGroups !== 'function') return;
      world.joinParticleGroups(groupA, groupB);
    },
    splitParticleGroup(groupId) {
      if (!world || typeof world.splitParticleGroup !== 'function') return;
      world.splitParticleGroup(groupId);
    },
    particleApplyForce(index, fx, fy) {
      if (!world || typeof world.particleApplyForce !== 'function') return;
      world.particleApplyForce(index, fx, fy);
    },
    particleApplyImpulse(index, ix, iy) {
      if (!world || typeof world.particleApplyLinearImpulse !== 'function') return;
      world.particleApplyLinearImpulse(index, ix, iy);
    },
    groupApplyForce(groupId, fx, fy) {
      if (!world || typeof world.particleGroupApplyForce !== 'function') return;
      world.particleGroupApplyForce(groupId, fx, fy);
    },
    groupApplyImpulse(groupId, ix, iy) {
      if (!world || typeof world.particleGroupApplyLinearImpulse !== 'function') return;
      world.particleGroupApplyLinearImpulse(groupId, ix, iy);
    },
    createParticleSystem(systemId, radius, maxCount, subSteps, strictContactCheck) {
      if (!world) return;
      clearLiquidFunRenderState();
      liquidFunXFloatOffset = 0;
      liquidFunYFloatOffset = 0;
      liquidFunAlphaFloatOffset = 0;
      liquidFunPrevSyncedCount = 0;
      world.createParticleSystem(
        radius || 10,
        maxCount || 10000,
        liquidFunDensity,
        subSteps > 0 ? subSteps : 1,
        !!strictContactCheck,
      );
      if (typeof world.setParticleTuning === 'function') {
        world.setParticleTuning(pendingParticleTuning);
      }
      publishLiquidFunHeap();
    },
    createParticleGroupBox(flags, posX, posY, halfWidth, halfHeight) {
      if (!world) return;
      const emit = takePendingLiquidFunEmit();
      const oldCount = world.getParticleCount();
      const gid = world.createParticleGroupBox(
        posX,
        posY,
        halfWidth,
        halfHeight,
        emit.spacing,
        flags || 0,
        emit.strength,
        emit.lifetimeMin,
        emit.lifetimeMax,
        emit.fadeToAlpha0,
        emit.viscousScale,
        emit.trackGroup,
        emit.groupFlags || 0,
        emit.vx || 0,
        emit.vy || 0,
        emit.omega || 0,
        emit.userData >>> 0,
        packedEmitColor(emit),
      );
      paintNewLiquidFunParticles(oldCount, emit);
      stampGroupLightIntensity(gid, emit.lightIntensity);
    },
    createParticleGroupCircle(systemId, posX, posY, radius, flags) {
      if (!world) return;
      const emit = takePendingLiquidFunEmit();
      const oldCount = world.getParticleCount();
      const gid = world.createParticleGroupCircle(
        posX,
        posY,
        radius,
        emit.spacing,
        flags || 0,
        emit.strength,
        emit.lifetimeMin,
        emit.lifetimeMax,
        emit.fadeToAlpha0,
        emit.viscousScale,
        emit.trackGroup,
        emit.groupFlags || 0,
        emit.vx || 0,
        emit.vy || 0,
        emit.omega || 0,
        emit.userData >>> 0,
        packedEmitColor(emit),
      );
      paintNewLiquidFunParticles(oldCount, emit);
      stampGroupLightIntensity(gid, emit.lightIntensity);
    },
    destroyParticleGroup(systemId, groupId) {
      if (!world) return;
      stampGroupLightIntensity(groupId, 0);
      world.destroyParticleGroup(groupId);
    },
    destroyParticleSystem(systemId) {
      if (!world) return;
      clearLiquidFunRenderState();
      liquidFunXFloatOffset = 0;
      liquidFunYFloatOffset = 0;
      liquidFunAlphaFloatOffset = 0;
      world.destroyParticleSystem();
    },
    clearLiquidFunParticles(systemId) {
      clearAllLiquidFunParticles();
    },
  };

  function drainCommands() {
    if (!cmdI32 || !cmdF32) return 0;
    return drainBox2dCommandRing(cmdI32, cmdF32, cmdHandlers);
  }

  function serviceQueryAabb() {
    if (!world || !world._querySlots) return;
    var overlapFn = function (
      x0,
      y0,
      x1,
      y1,
      categoryBits,
      maskBits,
      results,
      cap,
    ) {
      var n = world.overlapAABB(x0, y0, x1, y1, world._querySlots, {
        categoryBits: categoryBits,
        maskBits: maskBits,
      });
      var write = n < cap ? n : cap;
      var slots = world._querySlots;
      if (write > slots.length) write = slots.length;
      for (var i = 0; i < write; i++) {
        results[i] = slots[i] | 0;
      }
      return n | 0;
    };
    if (typeof Box2dQueryAabb.servicePendingQueryBurst === 'function') {
      Box2dQueryAabb.servicePendingQueryBurst(overlapFn, 1024);
    } else {
      Box2dQueryAabb.servicePendingQuery(overlapFn);
    }
  }

  function serviceRayCast() {
    if (!world || typeof Box2dRayCast === 'undefined') return;
    var castFn = function (
      ox,
      oy,
      dx,
      dy,
      categoryBits,
      maskBits,
    ) {
      var n = world.castRayClosest(ox, oy, dx, dy, {
        categoryBits: categoryBits,
        maskBits: maskBits,
      });
      if (!(n > 0) || !world._queryHits) {
        return { hit: false, entityIndex: -1, fraction: 0, hitX: 0, hitY: 0 };
      }
      var hits = world._queryHits;
      return {
        hit: true,
        entityIndex: hits[0] | 0,
        fraction: hits[1],
        hitX: hits[2],
        hitY: hits[3],
      };
    };
    // Burst: sync logic can post many single-flight casts per its tick.
    if (typeof Box2dRayCast.servicePendingRayCastBurst === 'function') {
      Box2dRayCast.servicePendingRayCastBurst(castFn, 1024);
    } else {
      Box2dRayCast.servicePendingRayCast(castFn);
    }
  }

  function serviceLiquidFunQuery() {
    if (!world || typeof LiquidFunQuery === 'undefined') return;
    var OP_AABB = LiquidFunQuery.OP_AABB;
    var queryFn = function (
      op,
      a,
      b,
      c,
      d,
      results,
      cap,
    ) {
      var n;
      if ((op | 0) === OP_AABB) {
        n = world.fillParticleQueryAabb(a, b, c, d, results, cap);
      } else {
        n = world.fillParticleRayCast(a, b, c, d, results, cap);
      }
      return n | 0;
    };
    if (typeof LiquidFunQuery.servicePendingLiquidFunQueryBurst === 'function') {
      LiquidFunQuery.servicePendingLiquidFunQueryBurst(queryFn, 1024);
    } else {
      LiquidFunQuery.servicePendingLiquidFunQuery(queryFn);
    }
  }

  function serviceLiquidFunExtract() {
    if (!world || typeof LiquidFunExtract === 'undefined') return;
    var extractFn = function (
      groupId,
      indices,
      count,
      groupFlags,
      trackGroup,
    ) {
      if (typeof world.fillExtractIndices === 'function') {
        world.fillExtractIndices(indices, count | 0);
      }
      return world.extractParticles(groupId, count | 0, groupFlags, trackGroup) | 0;
    };
    if (typeof LiquidFunExtract.servicePendingLiquidFunExtractBurst === 'function') {
      LiquidFunExtract.servicePendingLiquidFunExtractBurst(extractFn, 1024);
    } else {
      LiquidFunExtract.servicePendingLiquidFunExtract(extractFn);
    }
  }

  function applyForcesAndTorque() {
    for (let n = 0; n < denseCount; n++) {
      const i = denseList[n];
      if (views.rbStatic[i]) {
        views.ax[i] = 0;
        views.ay[i] = 0;
        views.angularAccel[i] = 0;
        continue;
      }
      const m = views.mass[i];
      const mass = m > 0 ? m : 1;
      const ax = views.ax[i];
      const ay = views.ay[i];
      if (ax !== 0 || ay !== 0) {
        bodyApplyForceCenterFn(i, ax * mass, ay * mass, 1);
      }
      const aa = views.angularAccel[i];
      if (aa !== 0 && !isFixedRotation(i)) {
        bodyApplyTorqueFn(i, aa * mass, 1);
      }
      views.ax[i] = 0;
      views.ay[i] = 0;
      views.angularAccel[i] = 0;
    }
  }

  function entityGen(i) {
    return bodyGeneration ? Atomics.load(bodyGeneration, i) | 0 : 0;
  }

  function publishPairBuffer(buf, count, kind, stride) {
    if (!buf || !(count > 0) || !contactRingI32) return;
    for (let i = 0; i < count; i++) {
      const a = buf[i * stride] | 0;
      const b = buf[i * stride + 1] | 0;
      publishBox2dContactEvent(kind, a, b, entityGen(a), entityGen(b));
    }
  }

  function publishContactRingFromWasm() {
    if (!publishContactRing) return;
    if (!world || !contactRingI32) return;
    const hdr = world._eventHeader;
    if (!hdr) return;
    const stride = 2;
    const beginCount = hdr[EVENT_HEADER.CONTACT_BEGIN_COUNT] | 0;
    const endCount = hdr[EVENT_HEADER.CONTACT_END_COUNT] | 0;
    const sensorBeginCount = hdr[EVENT_HEADER.SENSOR_BEGIN_COUNT] | 0;
    const sensorEndCount = hdr[EVENT_HEADER.SENSOR_END_COUNT] | 0;
    // Ends before begins so logic can drop pairs before re-enter same frame
    publishPairBuffer(world._contactEnd, endCount, CONTACT_KIND.CONTACT_END, stride);
    publishPairBuffer(world._sensorEnd, sensorEndCount, CONTACT_KIND.SENSOR_END, stride);
    publishPairBuffer(world._contactBegin, beginCount, CONTACT_KIND.CONTACT_BEGIN, stride);
    publishPairBuffer(world._sensorBegin, sensorBeginCount, CONTACT_KIND.SENSOR_BEGIN, stride);
  }

  function publishHitsFromWasm() {
    if (!publishContactRing) return;
    if (!world || !hitRingBound) return;
    const hdr = world._eventHeader;
    const hits = world._contactHit;
    if (!hdr || !hits) return;
    const stride = world._contactHitStride || 8;
    const count = hdr[EVENT_HEADER.CONTACT_HIT_COUNT] | 0;
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const a = hits[base] | 0;
      const b = hits[base + 1] | 0;
      publishContactHit(
        a,
        b,
        entityGen(a),
        entityGen(b),
        hits[base + 2],
        hits[base + 3],
        hits[base + 4],
        hits[base + 5],
        hits[base + 6],
      );
    }
  }

  function publishJointBreaksFromWasm() {
    if (!world || !jointBreakRingBound || !jointViews) return;
    const hdr = world._eventHeader;
    const events = world._jointEvents;
    if (!hdr || !events) return;
    const count = hdr[EVENT_HEADER.JOINT_EVENT_COUNT] | 0;
    const jv = jointViews;
    for (let i = 0; i < count; i++) {
      const idx = events[i] | 0;
      if (idx < 0 || idx >= maxJoints) continue;
      const packed = jv.pairs[idx];
      const entityA = packed >>> 16;
      const entityB = packed & 0xffff;
      destroyJointAt(idx);
      removeWeedJoint(idx);
      publishJointBreak(idx, entityA, entityB, entityGen(entityA), entityGen(entityB));
    }
  }

  function resetLiquidFunEmit(e) {
    e.spacing = 0;
    e.strength = 0.5;
    e.tintBits = 0;
    e.textureId = 0;
    e.viscousScale = 1;
    e.trackGroup = 0;
    e.groupFlags = 0;
    e.lifetimeMin = 0;
    e.lifetimeMax = 0;
    e.fadeToAlpha0 = 0;
    e.scaleSet = 0;
    e.scaleMin = 1;
    e.scaleMax = 1;
    e.alphaMin = 1;
    e.alphaMax = 1;
    e.layerMask = 0;
    e.layerMaskSet = 0;
    e.lightIntensity = 0;
    e.userData = 0;
    e.color = 0;
    e.vx = 0;
    e.vy = 0;
    e.omega = 0;
    e.pending = false;
  }

  const pendingLiquidFunEmitB = {
    spacing: 0,
    strength: 0.5,
    tintBits: 0,
    textureId: 0,
    viscousScale: 1,
    trackGroup: 0,
    groupFlags: 0,
    lifetimeMin: 0,
    lifetimeMax: 0,
    fadeToAlpha0: 0,
    scaleSet: 0,
    scaleMin: 1,
    scaleMax: 1,
    alphaMin: 1,
    alphaMax: 1,
    layerMask: 0,
    layerMaskSet: 0,
    lightIntensity: 0,
    userData: 0,
    color: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    pending: false,
  };

  function takePendingLiquidFunEmit() {
    const emit = pendingLiquidFunEmit;
    pendingLiquidFunEmit = emit === pendingLiquidFunEmitB ? pendingLiquidFunEmitA : pendingLiquidFunEmitB;
    resetLiquidFunEmit(pendingLiquidFunEmit);
    return emit;
  }

  function packedEmitColor(emit) {
    if (emit.color) return emit.color >>> 0;
    const t = emit.tintBits >>> 0;
    if (!t) return 0;
    if ((t >>> 24) === 0) return (0xff000000 | t) >>> 0;
    return t;
  }

  function paintNewLiquidFunParticles(oldCount, emit) {
    if (!world) return;
    const count = world.getParticleCount();
    const maxP = Math.min(count, liquidFunMaxCount || 0);
    if (liquidFunViews) {
      const tint = liquidFunViews.tint;
      const textureId = liquidFunViews.textureId;
      const scaleX = liquidFunViews.scaleX;
      const scaleY = liquidFunViews.scaleY;
      const rotC = liquidFunViews.rotC;
      const rotS = liquidFunViews.rotS;
      const baseAlpha = liquidFunViews.baseAlpha;
      const layerMask = liquidFunViews.layerMask;
      const scaleLo = emit.scaleSet ? emit.scaleMin : 1;
      const scaleHi = emit.scaleSet ? emit.scaleMax : 1;
      const alphaLo = emit.scaleSet ? emit.alphaMin : 1;
      const alphaHi = emit.scaleSet ? emit.alphaMax : 1;
      const mask = emit.layerMaskSet ? emit.layerMask & 0xffff : 0;
      for (let i = oldCount; i < maxP; i++) {
        tint[i] = emit.tintBits ? emit.tintBits >>> 0 : 0x3399ff;
        textureId[i] = emit.textureId | 0;
        const s = scaleHi === scaleLo ? scaleLo : scaleLo + self.rng() * (scaleHi - scaleLo);
        scaleX[i] = s;
        scaleY[i] = s;
        if (rotC) rotC[i] = 1.0;
        if (rotS) rotS[i] = 0.0;
        if (baseAlpha) {
          baseAlpha[i] =
            alphaHi === alphaLo ? alphaLo : alphaLo + self.rng() * (alphaHi - alphaLo);
        }
        if (layerMask) layerMask[i] = mask;
      }
    }
    if (maxP > liquidFunPaintedHighWater) liquidFunPaintedHighWater = maxP;
    // Native SoA pose is written at CreateParticle; no AoS→SoA seed needed.
  }

  function resolveLiquidFunHeapPoseOffsets() {
    if (!world || typeof world.getParticleXByteOffset !== 'function') return false;
    if (!liquidFunXFloatOffset || !liquidFunYFloatOffset) {
      const xByteOffset = world.getParticleXByteOffset() | 0;
      const yByteOffset = world.getParticleYByteOffset() | 0;
      if (!xByteOffset || !yByteOffset) return false;
      liquidFunXFloatOffset = xByteOffset >> 2;
      liquidFunYFloatOffset = yByteOffset >> 2;
    }
    if (!liquidFunAlphaFloatOffset && typeof world.getParticleAlphaByteOffset === 'function') {
      const alphaByteOffset = world.getParticleAlphaByteOffset() | 0;
      if (alphaByteOffset) liquidFunAlphaFloatOffset = alphaByteOffset >> 2;
    }
    return !!(liquidFunXFloatOffset && liquidFunYFloatOffset);
  }

  /** Park cleared HEAP pose slots far off-screen (and alpha 0). */
  function wipeLiquidFunHeapPose(hi) {
    const n = hi | 0;
    if (n <= 0) return;
    if (!resolveLiquidFunHeapPoseOffsets()) return;
    if (typeof Module === 'undefined' || !Module.HEAPF32) return;
    const heap = Module.HEAPF32;
    const xBase = liquidFunXFloatOffset;
    const yBase = liquidFunYFloatOffset;
    const aBase = liquidFunAlphaFloatOffset;
    for (let i = 0; i < n; i++) {
      heap[xBase + i] = LF_CLEARED_XY;
      heap[yBase + i] = LF_CLEARED_XY;
      if (aBase) heap[aBase + i] = 0;
    }
  }

  function fillLiquidFunRange(arr, start, end, value) {
    if (!arr || end <= start) return;
    if (typeof arr.fill === 'function') {
      arr.fill(value, start, end);
      return;
    }
    for (let i = start; i < end; i++) arr[i] = value;
  }

  function stampGroupLightIntensity(gid, intensity) {
    const arr = liquidFunGroupsViews && liquidFunGroupsViews.lightIntensity;
    if (!arr) return;
    const maxG = liquidFunGroupsViews.maxGroups | 0;
    const id = gid | 0;
    if (id < 0 || id >= maxG) return;
    const I = intensity > 0 ? intensity : 0;
    arr[id] = I;
    const sqrtArr = liquidFunGroupsViews.sqrtLightIntensity;
    if (sqrtArr) sqrtArr[id] = I > 0 ? Math.sqrt(I) : 0;
  }

  function refillGroupLightSqrt() {
    const I = liquidFunGroupsViews && liquidFunGroupsViews.lightIntensity;
    const s = liquidFunGroupsViews && liquidFunGroupsViews.sqrtLightIntensity;
    if (!I || !s) return;
    const n = I.length < s.length ? I.length : s.length;
    for (let i = 0; i < n; i++) {
      const v = I[i];
      s[i] = v > 0 ? Math.sqrt(v) : 0;
    }
  }

  function clearLiquidFunRenderState() {
    const hi = liquidFunPaintedHighWater | 0;
    wipeLiquidFunHeapPose(hi);
    if (liquidFunViews) {
      if (liquidFunViews.count) liquidFunViews.count[0] = 0;
      if (hi > 0) {
        fillLiquidFunRange(liquidFunViews.tint, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.textureId, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.scaleX, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.scaleY, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.rotC, 0, hi, 1);
        fillLiquidFunRange(liquidFunViews.rotS, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.baseAlpha, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.layerMask, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.x, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.y, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.alpha, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.px, 0, hi, 0);
        fillLiquidFunRange(liquidFunViews.py, 0, hi, 0);
      }
    }
    if (liquidFunGroupsViews?.count) liquidFunGroupsViews.count[0] = 0;
    if (liquidFunGroupsViews?.lightIntensity) {
      fillLiquidFunRange(
        liquidFunGroupsViews.lightIntensity,
        0,
        liquidFunGroupsViews.maxGroups | 0,
        0,
      );
    }
    if (liquidFunGroupsViews?.sqrtLightIntensity) {
      fillLiquidFunRange(
        liquidFunGroupsViews.sqrtLightIntensity,
        0,
        liquidFunGroupsViews.maxGroups | 0,
        0,
      );
    }
    liquidFunPaintedHighWater = 0;
    liquidFunPrevSyncedCount = 0;
  }

  function publishLiquidFunCleared() {
    if (typeof globalThis.weedjsOnLiquidFunCleared === 'function') {
      globalThis.weedjsOnLiquidFunCleared();
    } else if (typeof postMessage === 'function') {
      postMessage({ type: 'LIQUIDFUN_CLEARED' });
    }
  }

  function clearAllLiquidFunParticles() {
    if (!world || typeof world.getParticleCount !== 'function') {
      clearLiquidFunRenderState();
      publishLiquidFunCleared();
      return;
    }
    // Prefer live count for HEAP wipe if paint high-water lagged (e.g. no thin SAB).
    const live = world.getParticleCount() | 0;
    if (live > liquidFunPaintedHighWater) liquidFunPaintedHighWater = live;
    if (typeof world.getParticleGroupSlotCount === 'function') {
      const slots = world.getParticleGroupSlotCount() | 0;
      for (let gid = 0; gid < slots; gid++) {
        if (!(world.getParticleGroupAlive(gid) | 0)) continue;
        world.destroyParticleGroup(gid);
      }
    }
    const left = world.getParticleCount() | 0;
    if (
      left > 0 &&
      typeof world.getParticleFlagsByteOffset === 'function' &&
      typeof Module !== 'undefined' &&
      Module.HEAPF32
    ) {
      const flagsOff = world.getParticleFlagsByteOffset() | 0;
      if (flagsOff > 0) {
        const flags = new Uint32Array(Module.HEAPF32.buffer, flagsOff, left);
        for (let i = 0; i < left; i++) flags[i] = (flags[i] | LF_ZOMBIE) >>> 0;
      }
    } else if (left > 0) {
      console.warn('[weedjs] clearLiquidFunParticles: cannot mark zombies (no HEAP)');
    }
    clearLiquidFunRenderState();
    publishLiquidFunCleared();
  }

  function buildLiquidFunHeap(sab) {
    if (!world || !(liquidFunMaxCount > 0)) return null;
    if (typeof world.getParticleXByteOffset !== 'function') return null;
    const xByteOffset = world.getParticleXByteOffset() | 0;
    if (!xByteOffset) return null;
    const buf =
      sab ||
      (typeof world.getSharedBuffer === 'function' ? world.getSharedBuffer() : Module.HEAPF32.buffer);
    return {
      sab: buf,
      countByteOffset: world.getParticleCountByteOffset() | 0,
      xByteOffset,
      yByteOffset: world.getParticleYByteOffset() | 0,
      vxByteOffset: (world.getParticleVxByteOffset && world.getParticleVxByteOffset()) || 0,
      vyByteOffset: (world.getParticleVyByteOffset && world.getParticleVyByteOffset()) || 0,
      alphaByteOffset:
        (world.getParticleAlphaByteOffset && world.getParticleAlphaByteOffset()) || 0,
      weightByteOffset:
        (world.getParticleWeightByteOffset && world.getParticleWeightByteOffset()) || 0,
      flagsByteOffset:
        (world.getParticleFlagsByteOffset && world.getParticleFlagsByteOffset()) || 0,
      viscousScaleByteOffset:
        (world.getParticleViscousScaleByteOffset && world.getParticleViscousScaleByteOffset()) || 0,
      groupIndexByteOffset:
        (world.getParticleGroupIndexByteOffset && world.getParticleGroupIndexByteOffset()) || 0,
      userDataByteOffset:
        (world.getParticleUserDataByteOffset && world.getParticleUserDataByteOffset()) || 0,
      colorByteOffset:
        (world.getParticleColorByteOffset && world.getParticleColorByteOffset()) || 0,
      maxCount: liquidFunMaxCount | 0,
    };
  }

  function bindLiquidFunUserDataHeap(heap) {
    if (!heap || !heap.sab || !(heap.userDataByteOffset > 0) || !(heap.maxCount > 0)) {
      liquidFunUserDataU32 = null;
      return;
    }
    liquidFunUserDataU32 = new Uint32Array(
      heap.sab,
      heap.userDataByteOffset | 0,
      heap.maxCount | 0,
    );
  }

  function publishLiquidFunHeap() {
    const heap = buildLiquidFunHeap();
    if (!heap) return;
    bindLiquidFunUserDataHeap(heap);
    if (typeof globalThis.weedjsOnLiquidFunHeap === 'function') {
      globalThis.weedjsOnLiquidFunHeap(heap);
    } else if (typeof postMessage === 'function') {
      postMessage({ type: 'LIQUIDFUN_HEAP', liquidFunHeap: heap });
    }
  }

  function syncLiquidFunParticlesToSharedBuffers() {
    // Pose (x/y/alpha/count) lives on the WASM HEAP SAB and is bound zero-copy
    // via LiquidFun.bindHeapPose on box2dReady. Thin SAB keeps emit-only
    // fields (scale/tint/texture/layer). Interpolation prev pose is latched in
    // pre_render (_prevLfX), not copied here.
    if (!world || typeof world.getParticleCount !== 'function') return;
    const live = world.getParticleCount() | 0;
    if (live <= 0 && liquidFunViews?.count) {
      liquidFunViews.count[0] = 0;
    }
    resolveLiquidFunHeapPoseOffsets();
  }

  let lfSyncGroupsI32 = 0;
  let lfSyncStride = 0;

  function syncLiquidFunGroupsToSharedBuffers() {
    if (!world || !liquidFunGroupsViews || typeof world.syncActiveParticleGroups !== 'function') {
      return;
    }
    const maxG = liquidFunGroupsViews.maxGroups | 0;
    const n = world.syncActiveParticleGroups(maxG) | 0;
    liquidFunGroupsViews.count[0] = n;
    if (n <= 0) return;
    if (!lfSyncGroupsI32) {
      const off = world.getSyncParticleGroupsByteOffset() | 0;
      if (!off) return;
      lfSyncGroupsI32 = off >> 2;
      lfSyncStride = world.getSyncParticleGroupsMax() | 0;
    }
    const base = lfSyncGroupsI32;
    const stride = lfSyncStride;
    const heap32 = Module.HEAP32;
    const heapF32 = Module.HEAPF32;
    const id = liquidFunGroupsViews.id;
    const pc = liquidFunGroupsViews.particleCount;
    const first = liquidFunGroupsViews.firstIndex;
    const last = liquidFunGroupsViews.lastIndex;
    const vs = liquidFunGroupsViews.viscousScale;
    const gx = liquidFunGroupsViews.x;
    const gy = liquidFunGroupsViews.y;
    const gvx = liquidFunGroupsViews.vx;
    const gvy = liquidFunGroupsViews.vy;
    const ang = liquidFunGroupsViews.angularVelocity;
    const angle = liquidFunGroupsViews.angle;
    const gFlags = liquidFunGroupsViews.groupFlags;
    for (let i = 0; i < n; i++) {
      id[i] = heap32[base + i];
      pc[i] = heap32[base + stride + i];
      if (first) first[i] = heap32[base + stride * 2 + i];
      if (last) last[i] = heap32[base + stride * 3 + i];
      vs[i] = heapF32[base + stride * 4 + i];
      gx[i] = heapF32[base + stride * 5 + i];
      gy[i] = heapF32[base + stride * 6 + i];
      gvx[i] = heapF32[base + stride * 7 + i];
      gvy[i] = heapF32[base + stride * 8 + i];
      ang[i] = heapF32[base + stride * 9 + i];
      angle[i] = heapF32[base + stride * 10 + i];
      if (gFlags) gFlags[i] = heap32[base + stride * 11 + i];
    }
  }

  function applyLiquidFunTuningFromConfig(lf) {
    if (!lf) return;
    pendingParticleTuning.dampingStrength =
      lf.dampingStrength != null ? lf.dampingStrength : pendingParticleTuning.dampingStrength;
    pendingParticleTuning.pressureStrength =
      lf.pressureStrength != null ? lf.pressureStrength : pendingParticleTuning.pressureStrength;
    pendingParticleTuning.viscousStrength =
      lf.viscousStrength != null ? lf.viscousStrength : pendingParticleTuning.viscousStrength;
    pendingParticleTuning.tensileStrength =
      lf.tensileStrength != null ? lf.tensileStrength : pendingParticleTuning.tensileStrength;
    pendingParticleTuning.powderStrength =
      lf.powderStrength != null ? lf.powderStrength : pendingParticleTuning.powderStrength;
    pendingParticleTuning.springStrength =
      lf.springStrength != null ? lf.springStrength : pendingParticleTuning.springStrength;
    pendingParticleTuning.staticPressureStrength =
      lf.staticPressureStrength != null
        ? lf.staticPressureStrength
        : pendingParticleTuning.staticPressureStrength;
    pendingParticleTuning.staticPressureRelaxation =
      lf.staticPressureRelaxation != null
        ? lf.staticPressureRelaxation
        : pendingParticleTuning.staticPressureRelaxation;
    pendingParticleTuning.staticPressureIterations =
      lf.staticPressureIterations != null
        ? lf.staticPressureIterations | 0
        : pendingParticleTuning.staticPressureIterations;
    pendingParticleTuning.ejectionStrength =
      lf.ejectionStrength != null ? lf.ejectionStrength : pendingParticleTuning.ejectionStrength;
    pendingParticleTuning.colorMixingStrength =
      lf.colorMixingStrength != null ? lf.colorMixingStrength : pendingParticleTuning.colorMixingStrength;
    pendingParticleTuning.repulsiveStrength =
      lf.repulsiveStrength != null ? lf.repulsiveStrength : pendingParticleTuning.repulsiveStrength;
  }

  /** Mark particles whose centers leave scene world AABB so SolveZombie compact removes them this step. */
  function cullLiquidFunOutsideWorld() {
    const w = liquidFunWorldW;
    const h = liquidFunWorldH;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    if (!world || typeof world.cullParticlesOutsideBounds !== 'function') return;
    world.cullParticlesOutsideBounds(0, 0, w, h);
  }

  function afterStep() {
    publishContactRingFromWasm();
    publishHitsFromWasm();
    publishJointBreaksFromWasm();
    publishMovedSabFromStep();
    syncLiquidFunParticlesToSharedBuffers();
    syncLiquidFunGroupsToSharedBuffers();
  }

  function publishMovedSabFromStep() {
    if (!world || typeof publishMovedBodies !== 'function') return;
    const wasmCount =
      typeof world._getBodyMoveCount === 'function'
        ? world._getBodyMoveCount() | 0
        : 0;
    publishMovedBodies(
      world._bodyMoved,
      world._bodyFellAsleep,
      wasmCount,
      pendingTeleportList,
      pendingTeleportCount,
      pendingTeleportBits,
    );
    if (pendingTeleportCount > 0 && pendingTeleportBits) {
      for (let i = 0; i < pendingTeleportCount; i++) {
        pendingTeleportBits[pendingTeleportList[i]] = 0;
      }
      pendingTeleportCount = 0;
    }
  }

  function writePhysicsStats(
    bodySyncMs,
    jointSyncMs,
    commandMs,
    forceMs,
    box2dMs,
    postMs,
    bodySyncChanges,
    jointSyncChanges,
    commandCount,
  ) {
    if (!statsF32) return;
    statsF32[PS.BODY_COUNT] = denseCount;
    const movedViewsEarly =
      typeof Box2dMovedBodies !== 'undefined' && Box2dMovedBodies.getMovedBodiesViews
        ? Box2dMovedBodies.getMovedBodiesViews()
        : null;
    statsF32[PS.BODY_MOVED_COUNT] = movedViewsEarly ? movedViewsEarly.count | 0 : 0;
    if (world && typeof world._getAwakeBodyCount === 'function') {
      statsF32[PS.AWAKE_COUNT] = world._getAwakeBodyCount(world.worldId) | 0;
    } else {
      statsF32[PS.AWAKE_COUNT] = 0;
    }
    if (typeof weedjsHeapBytesUsed === 'function') {
      const usedKbEarly = ((weedjsHeapBytesUsed() | 0) / 1024) | 0;
      if (usedKbEarly > heapHighWaterKb) heapHighWaterKb = usedKbEarly;
      statsF32[PS.HEAP_USED_KB] = usedKbEarly;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    } else {
      statsF32[PS.HEAP_USED_KB] = 0;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    }
    if (!collectDetailedStats) return;
    statsF32[PS.JOINT_COUNT] = world ? world.getJointCount() : 0;
    statsF32[PS.BODY_SYNC_MS] = bodySyncMs;
    statsF32[PS.JOINT_SYNC_MS] = jointSyncMs;
    statsF32[PS.COMMAND_MS] = commandMs;
    statsF32[PS.FORCE_MS] = forceMs;
    statsF32[PS.BOX2D_MS] = box2dMs;
    statsF32[PS.LIQUIDFUN_MS] =
      world && typeof world.getLiquidFunStepMs === 'function'
        ? world.getLiquidFunStepMs()
        : 0;
    statsF32[PS.POST_MS] = postMs;
    statsF32[PS.BODY_SYNC_CHANGES] = bodySyncChanges;
    statsF32[PS.BODY_SYNC_VISITED] = lastBodySyncVisited;
    statsF32[PS.JOINT_SYNC_CHANGES] = jointSyncChanges;
    statsF32[PS.COMMAND_COUNT] = commandCount;
    statsF32[PS.COMMAND_OVERFLOW_TOTAL] = cmdI32
      ? Atomics.load(cmdI32, 3) | 0
      : 0;
    const hdr = world && world._eventHeader;
    if (hdr) {
      statsF32[PS.CONTACT_BEGIN] = hdr[EVENT_HEADER.CONTACT_BEGIN_COUNT] | 0;
      statsF32[PS.CONTACT_END] = hdr[EVENT_HEADER.CONTACT_END_COUNT] | 0;
      statsF32[PS.SENSOR_BEGIN] = hdr[EVENT_HEADER.SENSOR_BEGIN_COUNT] | 0;
      statsF32[PS.SENSOR_END] = hdr[EVENT_HEADER.SENSOR_END_COUNT] | 0;
      const wasmContactDrop = hdr[EVENT_HEADER.CONTACT_DROPPED_COUNT] | 0;
      const wasmSensorDrop = hdr[EVENT_HEADER.SENSOR_DROPPED_COUNT] | 0;
      const ringDrop = contactRingI32
        ? Atomics.load(contactRingI32, 2) | 0
        : 0;
      statsF32[PS.CONTACT_DROPPED] = wasmContactDrop + ringDrop;
      statsF32[PS.SENSOR_DROPPED] = wasmSensorDrop;
    } else {
      statsF32[PS.CONTACT_BEGIN] = 0;
      statsF32[PS.CONTACT_END] = 0;
      statsF32[PS.SENSOR_BEGIN] = 0;
      statsF32[PS.SENSOR_END] = 0;
      statsF32[PS.CONTACT_DROPPED] = 0;
      statsF32[PS.SENSOR_DROPPED] = 0;
    }
    if (jointViews && jointViews.activeCount) {
      statsF32[PS.WEED_JOINTS] = Atomics.load(jointViews.activeCount, 0) | 0;
    } else {
      statsF32[PS.WEED_JOINTS] = 0;
    }
    if (typeof weedjsHeapBytesUsed === 'function') {
      const usedKb = ((weedjsHeapBytesUsed() | 0) / 1024) | 0;
      if (usedKb > heapHighWaterKb) heapHighWaterKb = usedKb;
      statsF32[PS.HEAP_USED_KB] = usedKb;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    } else {
      statsF32[PS.HEAP_USED_KB] = 0;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    }

    const movedViews =
      typeof Box2dMovedBodies !== 'undefined' && Box2dMovedBodies.getMovedBodiesViews
        ? Box2dMovedBodies.getMovedBodiesViews()
        : null;
    statsF32[PS.BODY_MOVED_COUNT] = movedViews ? movedViews.count | 0 : 0;

    if (world && typeof world._getAwakeBodyCount === 'function') {
      statsF32[PS.AWAKE_COUNT] = world._getAwakeBodyCount(world.worldId) | 0;
    } else {
      statsF32[PS.AWAKE_COUNT] = 0;
    }

    const profile = world && world._profile;
    if (profile && profile.length >= 5) {
      statsF32[PS.PROFILE_STEP_MS] = profile[0];
      statsF32[PS.PROFILE_COLLIDE_MS] = profile[1];
      statsF32[PS.PROFILE_SOLVE_MS] = profile[2];
      statsF32[PS.PROFILE_SLEEP_MS] = profile[3];
      statsF32[PS.PROFILE_SENSORS_MS] = profile[4];
    } else {
      statsF32[PS.PROFILE_STEP_MS] = 0;
      statsF32[PS.PROFILE_COLLIDE_MS] = 0;
      statsF32[PS.PROFILE_SOLVE_MS] = 0;
      statsF32[PS.PROFILE_SLEEP_MS] = 0;
      statsF32[PS.PROFILE_SENSORS_MS] = 0;
    }

    const counters = world && world._counters;
    if (counters && counters.length >= 7) {
      statsF32[PS.COUNTER_CONTACTS] = counters[2] | 0;
      statsF32[PS.COUNTER_ISLANDS] = counters[4] | 0;
      statsF32[PS.COUNTER_AWAKE_CONTACTS] = counters[5] | 0;
      statsF32[PS.COUNTER_TREE_HEIGHT] = counters[6] | 0;
    } else {
      statsF32[PS.COUNTER_CONTACTS] = 0;
      statsF32[PS.COUNTER_ISLANDS] = 0;
      statsF32[PS.COUNTER_AWAKE_CONTACTS] = 0;
      statsF32[PS.COUNTER_TREE_HEIGHT] = 0;
    }
  }

  function doStep() {
    const entityCount = hostEntityCount | 0;
    // Honor scene physics.subStepCount (BallsScene = 4) — do not inflate
    const solverSteps = Math.max(1, hostSubSteps | 0);
    const dt = hostDt;
    if (!world) {
      return;
    }
    // Service even when dt==0 / paused so sync query callers do not hang.
    if (!(dt > 0)) {
      serviceQueryAabb();
      serviceRayCast();
      serviceLiquidFunQuery();
      serviceLiquidFunExtract();
      return;
    }
    if (!collectDetailedStats) {
      syncBodies(entityCount);
      drainCommands();
      syncJoints();
      serviceQueryAabb();
      serviceRayCast();
      serviceLiquidFunQuery();
      serviceLiquidFunExtract();
      snapshotPrevPose(entityCount);
      applyForcesAndTorque();
      cullLiquidFunOutsideWorld();
      world.step(dt, solverSteps);
      maybePublishPose(entityCount);
      afterStep();
      writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
    }
    const t0 = performance.now();
    const bodySyncChanges = syncBodies(entityCount);
    const t1 = performance.now();
    const commandCount = drainCommands();
    const t2 = performance.now();
    const jointSyncChanges = syncJoints();
    const t3 = performance.now();
    serviceQueryAabb();
    serviceRayCast();
    serviceLiquidFunQuery();
    serviceLiquidFunExtract();
    snapshotPrevPose(entityCount);
    applyForcesAndTorque();
    const t4 = performance.now();
    cullLiquidFunOutsideWorld();
    world.step(dt, solverSteps);
    const t5 = performance.now();
    maybePublishPose(entityCount);
    afterStep();
    const t6 = performance.now();
    writePhysicsStats(
      t1 - t0,
      t3 - t2,
      t2 - t1,
      t4 - t3,
      t5 - t4,
      t6 - t5,
      bodySyncChanges,
      jointSyncChanges,
      commandCount,
    );
  }

  function handleInit(data) {
    const { PhysicsWorld } = createPhysicsApi(Module);
    const maxBodies = data.maxBodies | 0;
    verdletSubSteps = Math.max(1, data.subSteps | 0 || 4);
    sleepingEnabled = data.sleeping !== false;
    publishContactRing = data.publishContactRing !== false;
    liquidFunWorldW = data.worldWidth | 0;
    liquidFunWorldH = data.worldHeight | 0;
    world = new PhysicsWorld(data.gravityX || 0, data.gravityY || 0, {
      lengthUnitsPerMeter: data.lengthUnitsPerMeter,
      contactHertz: data.contactHertz,
      contactDampingRatio: data.contactDampingRatio,
      contactSpeed: data.contactSpeed,
      maximumLinearSpeed: data.maximumLinearSpeed,
      box2dWorkerCount: data.box2dWorkerCount,
    });
    world.enableSleeping(sleepingEnabled);
    const slots = world.getMaxBodySlots();
    if (maxBodies <= 0 || maxBodies > slots) {
      throw new Error(
        `bindBuffers: maxBodies ${maxBodies} exceeds max slots ${slots}`,
      );
    }
    world.bindBuffers(maxBodies);

    bodyApplyForceCenterFn = Module.cwrap('body_apply_force_center', null, [
      'number',
      'number',
      'number',
      'number',
    ]);
    bodyApplyTorqueFn = Module.cwrap('body_apply_torque', null, [
      'number',
      'number',
      'number',
    ]);
    bodySetLinearVelocityFn = Module.cwrap(
      'body_set_linear_velocity',
      null,
      ['number', 'number', 'number'],
    );
    bodySetTransformFn = Module.cwrap('body_set_transform', null, [
      'number',
      'number',
      'number',
      'number',
      'number',
    ]);
    bodySetAwakeFn = Module.cwrap('body_set_awake', null, ['number', 'number']);
    bodySetAngularVelocityFn = Module.cwrap(
      'body_set_angular_velocity',
      null,
      ['number', 'number'],
    );
    bodySetFixedRotationFn = Module.cwrap('body_set_fixed_rotation', null, [
      'number',
      'number',
    ]);
    bodySetTypeFn = Module.cwrap('body_set_type', null, ['number', 'number']);
    bodySetLinearDampingFn = Module.cwrap('body_set_linear_damping', null, [
      'number',
      'number',
    ]);
    bodySetAngularDampingFn = Module.cwrap('body_set_angular_damping', null, [
      'number',
      'number',
    ]);
    bodySetFilterFn = Module.cwrap('body_set_filter', null, [
      'number',
      'number',
      'number',
      'number',
    ]);
    bodySetFrictionFn = Module.cwrap('body_set_friction', null, [
      'number',
      'number',
    ]);
    bodySetRestitutionFn = Module.cwrap('body_set_restitution', null, [
      'number',
      'number',
    ]);
    bodySetSleepThresholdFn = Module.cwrap('body_set_sleep_threshold', null, [
      'number',
      'number',
    ]);
    bodySetDensityFn = Module.cwrap('body_set_density', null, [
      'number',
      'number',
    ]);
    bodySetShapeBoxFn = Module.cwrap('body_set_shape_box', null, [
      'number',
      'number',
      'number',
      'number',
      'number',
    ]);
    bodySetShapeCircleFn = Module.cwrap('body_set_shape_circle', null, [
      'number',
      'number',
      'number',
      'number',
    ]);
    bodySetShapePolygonFn = Module.cwrap('body_set_shape_polygon', null, [
      'number',
      'number',
      'number',
      'number',
      'number',
    ]);
    bodyClearShapesFn = Module.cwrap('body_clear_shapes', null, ['number']);
    weedjsHeapBytesUsed =
      typeof Module._weedjs_heap_bytes_used === 'function'
        ? Module._weedjs_heap_bytes_used
        : null;
    heapHighWaterKb = 0;
    hostEntityCount = data.entityCount | 0;
    hostSubSteps = Math.max(1, data.subSteps | 0 || 4);
    if (data.commandSab) {
      cmdI32 = new Int32Array(data.commandSab);
      cmdF32 = new Float32Array(data.commandSab);
    }
    if (data.queryAabbSab) {
      Box2dQueryAabb.bindQueryAabbSab(data.queryAabbSab);
    }
    if (data.rayCastSab) {
      Box2dRayCast.bindRayCastSab(data.rayCastSab);
    }
    if (data.liquidFunQuerySab) {
      LiquidFunQuery.bindLiquidFunQuerySab(data.liquidFunQuerySab);
    }
    if (data.liquidFunExtractSab && typeof LiquidFunExtract !== 'undefined') {
      LiquidFunExtract.bindLiquidFunExtractSab(data.liquidFunExtractSab);
    }
    if (data.liquidFunUserDataListSab && typeof LiquidFunUserDataList !== 'undefined') {
      LiquidFunUserDataList.bindLiquidFunUserDataListSab(data.liquidFunUserDataListSab);
    }
    if (data.contactSab) {
      Box2dContactRing.bindContactRing(data.contactSab);
      contactRingI32 = new Int32Array(data.contactSab);
    } else {
      contactRingI32 = null;
    }
    if (data.movedSab) {
      bindMovedBodies(data.movedSab);
    }
    if (data.hitSab) {
      Box2dContactHitRing.bindContactHitRing(data.hitSab);
      hitRingBound = true;
    }
    if (data.jointBreakSab) {
      Box2dJointBreakRing.bindJointBreakRing(data.jointBreakSab);
      jointBreakRingBound = true;
    }
    if (data.hitEventThreshold > 0) {
      world.setHitEventThreshold(data.hitEventThreshold);
    }
    if (data.liquidFun && data.liquidFun.enabled) {
      const lf = data.liquidFun;
      liquidFunDensity = lf.density != null ? lf.density : 1.0;
      applyLiquidFunTuningFromConfig(lf);
      world.createParticleSystem(
        lf.radius || 10,
        lf.maxCount || 10000,
        liquidFunDensity,
        lf.subSteps > 0 ? lf.subSteps : 1,
        !!lf.strictContactCheck,
      );
      if (typeof world.setParticleTuning === 'function') {
        world.setParticleTuning(pendingParticleTuning);
      }
    }

    bindWeedViews(data.views);
    bindPosePublish(data.posePublish);
    bindBodySyncViews(data.bodySync);
    if (!bodyDirtyFlags || !bodyDirtyWords) {
      throw new Error('[weedjs-box2d] WEEDJS_INIT missing bodySync dirty buffers');
    }
    bindJointViews(data.jointViews, data.maxJoints | 0);
    if (data.liquidFunViews) {
      liquidFunViews = {
        count: data.liquidFunViews.count
          ? viewFromDesc(data.liquidFunViews.count, Int32Array)
          : null,
        x: viewFromDesc(data.liquidFunViews.x, Float32Array),
        y: viewFromDesc(data.liquidFunViews.y, Float32Array),
        scaleX: viewFromDesc(data.liquidFunViews.scaleX, Float32Array),
        scaleY: viewFromDesc(data.liquidFunViews.scaleY, Float32Array),
        rotC: data.liquidFunViews.rotC
          ? viewFromDesc(data.liquidFunViews.rotC, Float32Array)
          : null,
        rotS: data.liquidFunViews.rotS
          ? viewFromDesc(data.liquidFunViews.rotS, Float32Array)
          : null,
        alpha: viewFromDesc(data.liquidFunViews.alpha, Float32Array),
        px: data.liquidFunViews.px
          ? viewFromDesc(data.liquidFunViews.px, Float32Array)
          : null,
        py: data.liquidFunViews.py
          ? viewFromDesc(data.liquidFunViews.py, Float32Array)
          : null,
        tint: viewFromDesc(data.liquidFunViews.tint, Uint32Array),
        textureId: viewFromDesc(data.liquidFunViews.textureId, Uint16Array),
        baseAlpha: data.liquidFunViews.baseAlpha
          ? viewFromDesc(data.liquidFunViews.baseAlpha, Float32Array)
          : null,
        layerMask: data.liquidFunViews.layerMask
          ? viewFromDesc(data.liquidFunViews.layerMask, Uint16Array)
          : null,
      };
      liquidFunMaxCount = data.liquidFunMaxCount | 0;
      liquidFunXFloatOffset = 0;
      liquidFunYFloatOffset = 0;
      liquidFunAlphaFloatOffset = 0;
      liquidFunPrevSyncedCount = 0;
      liquidFunPaintedHighWater = 0;
    }
    if (data.liquidFunGroupsViews) {
      liquidFunGroupsViews = {
        count: data.liquidFunGroupsViews.count
          ? viewFromDesc(data.liquidFunGroupsViews.count, Int32Array)
          : null,
        id: viewFromDesc(data.liquidFunGroupsViews.id, Int32Array),
        particleCount: viewFromDesc(data.liquidFunGroupsViews.particleCount, Int32Array),
        firstIndex: data.liquidFunGroupsViews.firstIndex
          ? viewFromDesc(data.liquidFunGroupsViews.firstIndex, Int32Array)
          : null,
        lastIndex: data.liquidFunGroupsViews.lastIndex
          ? viewFromDesc(data.liquidFunGroupsViews.lastIndex, Int32Array)
          : null,
        groupFlags: data.liquidFunGroupsViews.groupFlags
          ? viewFromDesc(data.liquidFunGroupsViews.groupFlags, Int32Array)
          : null,
        viscousScale: viewFromDesc(data.liquidFunGroupsViews.viscousScale, Float32Array),
        x: viewFromDesc(data.liquidFunGroupsViews.x, Float32Array),
        y: viewFromDesc(data.liquidFunGroupsViews.y, Float32Array),
        vx: viewFromDesc(data.liquidFunGroupsViews.vx, Float32Array),
        vy: viewFromDesc(data.liquidFunGroupsViews.vy, Float32Array),
        angularVelocity: viewFromDesc(data.liquidFunGroupsViews.angularVelocity, Float32Array),
        angle: viewFromDesc(data.liquidFunGroupsViews.angle, Float32Array),
        lightIntensity: data.liquidFunGroupsViews.lightIntensity
          ? viewFromDesc(data.liquidFunGroupsViews.lightIntensity, Float32Array)
          : null,
        sqrtLightIntensity: data.liquidFunGroupsViews.sqrtLightIntensity
          ? viewFromDesc(data.liquidFunGroupsViews.sqrtLightIntensity, Float32Array)
          : null,
        maxGroups: data.liquidFunGroupsMax | 0,
      };
    } else {
      liquidFunGroupsViews = null;
    }
    if (data.stats) {
      statsF32 = viewFromDesc(data.stats, Float32Array);
    } else {
      statsF32 = null;
    }
    collectDetailedStats = !!data.collectDetailedStats;
    const entityCount = data.entityCount | 0;
    hasBody = new Uint8Array(entityCount);
    createFailed = new Uint8Array(entityCount);
    denseList = new Uint16Array(entityCount);
    densePositions = new Int32Array(entityCount);
    densePositions.fill(-1);
    seenBodyGeneration = new Int32Array(entityCount);
    pendingTeleportBits = new Uint8Array(entityCount);
    pendingTeleportList = new Uint32Array(entityCount);
    pendingTeleportCount = 0;

    const ready = world.getReadyPayload();
    bindStateChannels(ready, entityCount);

    const liquidFunHeap = buildLiquidFunHeap(ready.sab);

    const readyMsg = {
      type: 'WEEDJS_READY',
      sab: ready.sab,
      bodyCapacity: ready.bodyCapacity,
      channelOffsets: ready.channelOffsets,
      sleepingByteOffset: ready.sleepingByteOffset,
      eventHeaderBaseIndex: ready.eventHeaderBaseIndex,
      contactBeginBaseIndex: ready.contactBeginBaseIndex,
      contactEndBaseIndex: ready.contactEndBaseIndex,
      sensorBeginBaseIndex: ready.sensorBeginBaseIndex,
      sensorEndBaseIndex: ready.sensorEndBaseIndex,
      contactEventCapacity: ready.contactEventCapacity,
      sensorEventCapacity: ready.sensorEventCapacity,
      contactPairIntStride: ready.contactPairIntStride,
      eventHeaderIntCount: ready.eventHeaderIntCount,
      movedSab: data.movedSab || null,
      liquidFunHeap,
    };
    if (typeof globalThis.weedjsOnReady === 'function') {
      globalThis.weedjsOnReady(readyMsg);
    } else {
      postMessage(readyMsg);
    }
  }

  function notifyModuleReady() {
    if (moduleReady) return;
    moduleReady = true;
    while (moduleReadyWaiters.length) {
      moduleReadyWaiters.shift()();
    }
  }

  /**
   * In-process step for classic physics host.
   * @param {number} dtSec
   * @param {number} [subSteps]
   */
  function weedjsDoStep(dtSec, subSteps) {
    if (subSteps != null) {
      hostSubSteps = Math.max(1, subSteps | 0);
    }
    hostDt = dtSec;
    doStep();
  }

  function weedjsEnableHostMode() {
    hostMode = true;
  }

  function weedjsWhenModuleReady(cb) {
    if (typeof cb !== 'function') return;
    if (moduleReady) {
      cb();
      return;
    }
    moduleReadyWaiters.push(cb);
  }

  function weedjsApplyConfig(data) {
    if (!data) return;
    if (data.sleeping !== undefined) {
      sleepingEnabled = data.sleeping !== false;
      if (world) world.enableSleeping(sleepingEnabled);
    }
    if (data.subSteps != null) {
      hostSubSteps = Math.max(1, data.subSteps | 0);
    }
    if (data.entityCount != null) {
      hostEntityCount = data.entityCount | 0;
    }
    if (data.hitEventThreshold != null && world) {
      world.setHitEventThreshold(data.hitEventThreshold);
    }
    if (data.publishContactRing !== undefined) {
      publishContactRing = data.publishContactRing !== false;
    }
  }


  function weedjsSnapshotLiquidFun() {
    if (!world || typeof world.snapshotParticles !== "function") {
      return { count: 0, radius: 0, maxCount: 0, x: null, y: null, vx: null, vy: null, flags: null, render: null, groups: null, pairs: null };
    }
    const snap = world.snapshotParticles();
    if (!snap) {
      return { count: 0, radius: 0, maxCount: 0, x: null, y: null, vx: null, vy: null, flags: null, render: null, groups: null, pairs: null };
    }
    const n = snap.count | 0;
    let render = null;
    if (liquidFunViews && n > 0) {
      render = {
        tint: new Uint32Array(liquidFunViews.tint.subarray(0, n)),
        textureId: new Uint16Array(liquidFunViews.textureId.subarray(0, n)),
        scaleX: new Float32Array(liquidFunViews.scaleX.subarray(0, n)),
        scaleY: new Float32Array(liquidFunViews.scaleY.subarray(0, n)),
        alpha: new Float32Array(liquidFunViews.baseAlpha
          ? liquidFunViews.baseAlpha.subarray(0, n)
          : (liquidFunViews.alpha ? liquidFunViews.alpha.subarray(0, n) : new Float32Array(n).fill(1))),
        rotC: liquidFunViews.rotC ? new Float32Array(liquidFunViews.rotC.subarray(0, n)) : null,
        rotS: liquidFunViews.rotS ? new Float32Array(liquidFunViews.rotS.subarray(0, n)) : null,
        layerMask: liquidFunViews.layerMask ? new Uint16Array(liquidFunViews.layerMask.subarray(0, n)) : null,
      };
    }
    let groupsLightIntensity = null;
    if (liquidFunGroupsViews?.lightIntensity) {
      groupsLightIntensity = new Float32Array(liquidFunGroupsViews.lightIntensity);
    }
    return {
      count: n,
      radius: snap.radius,
      maxCount: snap.maxCount,
      x: snap.x,
      y: snap.y,
      vx: snap.vx,
      vy: snap.vy,
      flags: snap.flags,
      userData: snap.userData || null,
      color: snap.color || null,
      groupIndex: snap.groupIndex || null,
      restOffset: snap.restOffset || null,
      groups: snap.groups || null,
      pairs: snap.pairs || null,
      render,
      groupsLightIntensity,
    };
  }

  function weedjsRestoreLiquidFun(payload) {
    if (!world || typeof world.restoreParticles !== "function") return { ok: false, reason: "no-world" };
    if (!payload) return { ok: false, reason: "no-payload" };
    // Materialize queued floors/walls/boxes before injecting settled particles.
    // Bodies normally appear on the first doStep syncBodies; if particles are
    // restored first, that same first step also builds contacts against brand-new
    // geometry and can amplify the cold-start kick.
    const entityCount = hostEntityCount | 0;
    if (entityCount > 0) {
      try {
        syncBodies(entityCount);
      } catch (_) {
        /* dirty buffers may not be bound yet during very early restore */
      }
    }
    drainCommands();
    const n = payload.count | 0;
    const x = payload.x instanceof Float32Array ? payload.x : new Float32Array(payload.x || []);
    const y = payload.y instanceof Float32Array ? payload.y : new Float32Array(payload.y || []);
    const vx = payload.vx instanceof Float32Array ? payload.vx : new Float32Array(payload.vx || []);
    const vy = payload.vy instanceof Float32Array ? payload.vy : new Float32Array(payload.vy || []);
    const flags = payload.flags instanceof Uint32Array ? payload.flags : new Uint32Array(payload.flags || []);
    const userData = payload.userData instanceof Uint32Array ? payload.userData : payload.userData ? new Uint32Array(payload.userData) : null;
    const color = payload.color instanceof Uint32Array ? payload.color : payload.color ? new Uint32Array(payload.color) : null;
    const r = world.restoreParticles(n, x, y, vx, vy, flags, userData, color);
    if (r < 0) return { ok: false, reason: "wasm", code: r };

    const hasGroups =
      (payload.groupIndex && payload.groupIndex.length) ||
      (payload.groups && (payload.groups.slotCount | 0) > 0) ||
      (payload.pairs && (payload.pairs.count | 0) > 0);
    if (hasGroups && typeof world.restoreParticleGroupsAndPairs === "function") {
      const gr = world.restoreParticleGroupsAndPairs({
        groupIndex: payload.groupIndex,
        restOffset: payload.restOffset,
        groups: payload.groups,
        pairs: payload.pairs,
      });
      if (gr < 0) return { ok: false, reason: "groups", code: gr };
      const slots = payload.groups;
      if (slots && world.setGroupViscousScale) {
        const nSlots = slots.slotCount | 0;
        const alive = slots.alive;
        const scales = slots.viscousScale;
        for (let i = 0; i < nSlots; i++) {
          if (alive && !alive[i]) continue;
          const scale = scales ? scales[i] : 1;
          if (scale > 0 && scale !== 1) world.setGroupViscousScale(i, scale);
        }
      }
    }

    if (liquidFunGroupsViews?.lightIntensity) {
      const src = payload.groupsLightIntensity;
      const dst = liquidFunGroupsViews.lightIntensity;
      dst.fill(0);
      if (src && src.length) {
        const nCopy = src.length < dst.length ? src.length : dst.length;
        dst.set(src.subarray ? src.subarray(0, nCopy) : src, 0);
      }
      refillGroupLightSqrt();
    }

    if (liquidFunViews) {
      if (liquidFunViews.count) liquidFunViews.count[0] = n;
      const render = payload.render || null;
      if (render && n > 0) {
        if (liquidFunViews.tint && render.tint) liquidFunViews.tint.set(render.tint.subarray ? render.tint.subarray(0, n) : render.tint, 0);
        if (liquidFunViews.textureId && render.textureId) liquidFunViews.textureId.set(render.textureId.subarray ? render.textureId.subarray(0, n) : render.textureId, 0);
        if (liquidFunViews.scaleX && render.scaleX) liquidFunViews.scaleX.set(render.scaleX.subarray ? render.scaleX.subarray(0, n) : render.scaleX, 0);
        if (liquidFunViews.scaleY && render.scaleY) liquidFunViews.scaleY.set(render.scaleY.subarray ? render.scaleY.subarray(0, n) : render.scaleY, 0);
        const alphaSrc = render.alpha || render.baseAlpha;
        if (alphaSrc) {
          if (liquidFunViews.baseAlpha) liquidFunViews.baseAlpha.set(alphaSrc.subarray ? alphaSrc.subarray(0, n) : alphaSrc, 0);
          if (liquidFunViews.alpha) liquidFunViews.alpha.set(alphaSrc.subarray ? alphaSrc.subarray(0, n) : alphaSrc, 0);
        }
        if (liquidFunViews.rotC && render.rotC) liquidFunViews.rotC.set(render.rotC.subarray ? render.rotC.subarray(0, n) : render.rotC, 0);
        if (liquidFunViews.rotS && render.rotS) liquidFunViews.rotS.set(render.rotS.subarray ? render.rotS.subarray(0, n) : render.rotS, 0);
        if (liquidFunViews.layerMask) {
          if (render.layerMask) {
            liquidFunViews.layerMask.set(
              render.layerMask.subarray ? render.layerMask.subarray(0, n) : render.layerMask,
              0,
            );
          } else {
            liquidFunViews.layerMask.fill(0);
            const layerId = render.layerId;
            const feed = render.feedLayerId;
            if (layerId || feed) {
              for (let i = 0; i < n; i++) {
                let m = 0;
                const lid = layerId ? layerId[i] | 0 : 0;
                if (lid > 0 && lid < 16) m |= 1 << lid;
                const fid = feed ? feed[i] | 0 : 255;
                if (fid !== 255 && fid >= 0 && fid < 16) m |= 1 << fid;
                liquidFunViews.layerMask[i] = m;
              }
            }
          }
        }
      }
      liquidFunPrevSyncedCount = n;
      liquidFunPaintedHighWater = Math.max(liquidFunPaintedHighWater | 0, n);
      if (typeof publishLiquidFunHeap === "function") publishLiquidFunHeap();
    }
    return { ok: true, count: n };
  }


  globalThis.weedjsSnapshotLiquidFun = weedjsSnapshotLiquidFun;
  globalThis.weedjsRestoreLiquidFun = weedjsRestoreLiquidFun;
  globalThis.weedjsEnableHostMode = weedjsEnableHostMode;
  globalThis.weedjsDoStep = weedjsDoStep;
  globalThis.weedjsWhenModuleReady = weedjsWhenModuleReady;
  globalThis.weedjsHandleInit = handleInit;
  globalThis.weedjsApplyConfig = weedjsApplyConfig;

  const pending = [];
  let inited = false;

  self.onmessage = function (event) {
    const data = event.data;
    if (!data || !data.type) return;
    if (!inited && data.type !== 'WEEDJS_INIT') {
      pending.push(data);
      return;
    }
    if (data.type === 'WEEDJS_INIT') {
      try {
        handleInit(data);
        inited = true;
        while (pending.length) {
          self.onmessage({ data: pending.shift() });
        }
      } catch (err) {
        console.error('[weedjs-box2d] init failed', err);
        postMessage({
          type: 'WEEDJS_ERROR',
          message: err?.message ?? String(err),
        });
      }
      return;
    }
    if (data.type === 'WEEDJS_CONFIG') {
      weedjsApplyConfig(data);
    }
  };

  Module.onRuntimeInitialized = notifyModuleReady;
  // Defer so weed_post can importScripts(physics_host) and set hostMode first.
  if (typeof Module !== 'undefined' && Module.calledRun) {
    setTimeout(notifyModuleReady, 0);
  }
})();
