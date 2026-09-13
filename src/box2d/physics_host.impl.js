// Classic physics host — Scene's workers.physics IS box2d_wasm + weedjs_post + this file.
// Speak Weed protocol (init/start/…) and call weedjsDoStep in-process (no nest Atomics).
// Loaded only when wired as the physics worker (B2); skip on em-pthread pool threads.
//
// ponytail: classic SoA bind mirrors Component.initializeArrays schemas — keep in sync
// with Transform / RigidBody / Collider ARRAY_SCHEMA (upgrade: shared classic schema module).

(function (global) {
  if (typeof self !== 'undefined' && self.name === 'em-pthread') {
    return;
  }
  if (typeof weedjsEnableHostMode !== 'function' || typeof weedjsDoStep !== 'function') {
    console.error('[physics_host] weedjs host APIs missing — load after weedjs_post.js');
    return;
  }

  weedjsEnableHostMode();

  var MAX_POLYGON_VERTICES = 8;
  var MAX_BODIES_HINT = 65535;

  // ponytail: classic IIFE cannot import ConfigDefaults.js — keep in sync with PHYSICS_DEFAULTS (upgrade: shared JSON/module).
  var PHYSICS_DEFAULTS = {
    subStepCount: 4,
    contactHertz: 30,
    contactDampingRatio: 0.7,
    gravity: { x: 0, y: 0 },
    lengthUnitsPerMeter: 100,
    contactSpeed: 1000,
    maximumLinearSpeed: 50000,
    box2dWorkerCount: 4,
    contactRingCapacity: 65536,
    commandRingCapacity: 4096,
    sleeping: true,
    hitEventThreshold: 0,
    // ponytail: keep in sync with ConfigDefaults PHYSICS_DEFAULTS.liquidFun.
    liquidFun: {
      enabled: false,
      radius: 10,
      maxCount: 10000,
      subSteps: 1,
      density: 1,
      strictContactCheck: false,
      dampingStrength: 1.0,
      pressureStrength: 0.05,
      viscousStrength: 0.25,
      tensileStrength: 0.2,
      powderStrength: 0.5,
      springStrength: 0.25,
      staticPressureStrength: 0.2,
      staticPressureRelaxation: 0.2,
      staticPressureIterations: 8,
    },
  };

  // Mirrors PHYSICS_STATS (workers-utils.js) — host writes FPS / STEP_MS / MSG_MS.
  var PS = {
    FPS: 0,
    STEP_MS: 1,
    MSG_MS: 2,
  };

  // Mirrors Transform / RigidBody ARRAY_SCHEMA (pose/vel/sleeping = HEAP only).
  var TRANSFORM_SCHEMA = {
    active: Uint8Array,
    entityType: Uint8Array,
    isItOnScreen: Uint8Array,
  };

  var RIGIDBODY_SCHEMA = {
    active: Uint8Array,
    static: Uint8Array,
    ax: Float32Array,
    ay: Float32Array,
    px: Float32Array,
    py: Float32Array,
    pRotation: Float32Array,
    angularAccel: Float32Array,
    mass: Float32Array,
    invMass: Float32Array,
    inertia: Float32Array,
    invInertia: Float32Array,
    linearDamping: Float32Array,
    angularDamping: Float32Array,
    fixedRotation: Uint8Array,
    speed: Float32Array,
    sleepThreshold: Float32Array,
  };

  var COLLIDER_SCHEMA = {
    active: Uint8Array,
    shapeType: Uint8Array,
    offsetX: Float32Array,
    offsetY: Float32Array,
    radius: Float32Array,
    width: Float32Array,
    height: Float32Array,
    isTrigger: Uint8Array,
    collisionLayer: Uint8Array,
    collisionMask: Uint32Array,
    collisionGroupIndex: Int32Array,
    friction: Float32Array,
    restitution: Float32Array,
    enableHitEvents: Uint8Array,
    visualRange: Float32Array,
    polyCount: Uint8Array,
    polyCentroidX: Float32Array,
    polyCentroidY: Float32Array,
    polyVertexX: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyVertexY: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyNormalX: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyNormalY: { type: Float32Array, length: MAX_POLYGON_VERTICES },
  };

  // Mirrors src/core/liquidFunRender.js bindLiquidFunRender (nested classic
  // worker - no ESM import). Layout must stay identical to that file.
  function bindLiquidFunRenderViews(sab, maxCount) {
    var n = maxCount | 0;
    var off = 8;
    var count = new Int32Array(sab, 0, 1);
    var x = new Float32Array(sab, off, n);
    off += n * 4;
    var y = new Float32Array(sab, off, n);
    off += n * 4;
    var scaleX = new Float32Array(sab, off, n);
    off += n * 4;
    var scaleY = new Float32Array(sab, off, n);
    off += n * 4;
    var rotC = new Float32Array(sab, off, n);
    off += n * 4;
    var rotS = new Float32Array(sab, off, n);
    off += n * 4;
    var alpha = new Float32Array(sab, off, n);
    off += n * 4;
    var px = new Float32Array(sab, off, n);
    off += n * 4;
    var py = new Float32Array(sab, off, n);
    off += n * 4;
    var tint = new Uint32Array(sab, off, n);
    off += n * 4;
    var textureId = new Uint16Array(sab, off, n);
    off += n * 2;
    off = (off + 3) & ~3;
    var baseAlpha = new Float32Array(sab, off, n);
    off += n * 4;
    var layerId = new Uint8Array(sab, off, n);
    return {
      count: count,
      x: x,
      y: y,
      scaleX: scaleX,
      scaleY: scaleY,
      rotC: rotC,
      rotS: rotS,
      alpha: alpha,
      px: px,
      py: py,
      tint: tint,
      textureId: textureId,
      baseAlpha: baseAlpha,
      layerId: layerId,
    };
  }

  // Mirrors src/core/liquidFunGroups.js bindLiquidFunGroups.
  function bindLiquidFunGroupsViews(sab, maxGroups) {
    var n = maxGroups | 0;
    var off = 0;
    var count = new Int32Array(sab, off, 1);
    off += 4;
    var id = new Int32Array(sab, off, n);
    off += n * 4;
    var particleCount = new Int32Array(sab, off, n);
    off += n * 4;
    var firstIndex = new Int32Array(sab, off, n);
    off += n * 4;
    var lastIndex = new Int32Array(sab, off, n);
    off += n * 4;
    var viscousScale = new Float32Array(sab, off, n);
    off += n * 4;
    var x = new Float32Array(sab, off, n);
    off += n * 4;
    var y = new Float32Array(sab, off, n);
    off += n * 4;
    var vx = new Float32Array(sab, off, n);
    off += n * 4;
    var vy = new Float32Array(sab, off, n);
    off += n * 4;
    var angularVelocity = new Float32Array(sab, off, n);
    off += n * 4;
    var angle = new Float32Array(sab, off, n);
    off += n * 4;
    var lightIntensity = new Float32Array(sab, off, n);
    off += n * 4;
    var sqrtLightIntensity = new Float32Array(sab, off, n);
    return {
      count: count,
      id: id,
      particleCount: particleCount,
      firstIndex: firstIndex,
      lastIndex: lastIndex,
      viscousScale: viscousScale,
      x: x,
      y: y,
      vx: vx,
      vy: vy,
      angularVelocity: angularVelocity,
      angle: angle,
      lightIntensity: lightIntensity,
      sqrtLightIntensity: sqrtLightIntensity,
      maxGroups: n,
    };
  }

  function schemaEntry(typeOrSpec) {
    if (typeOrSpec && typeof typeOrSpec === 'object' && typeOrSpec.type) {
      return { type: typeOrSpec.type, length: typeOrSpec.length | 0 || 1 };
    }
    return { type: typeOrSpec, length: 1 };
  }

  function bindSchema(buffer, count, schema) {
    var views = {};
    var offset = 0;
    var names = Object.keys(schema);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var entry = schemaEntry(schema[name]);
      var type = entry.type;
      var elements = count * entry.length;
      var bytesPerElement = type.BYTES_PER_ELEMENT;
      var remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }
      views[name] = new type(buffer, offset, elements);
      offset += elements * bytesPerElement;
    }
    return views;
  }

  function packView(arr) {
    return {
      sab: arr.buffer,
      byteOffset: arr.byteOffset,
      length: arr.length,
    };
  }

  function validatePhysicsConfig(current, next) {
    var base = current || PHYSICS_DEFAULTS;
    var n = next || {};
    var g = n.gravity || base.gravity || PHYSICS_DEFAULTS.gravity;
    return {
      subStepCount: Math.max(
        1,
        (n.subStepCount != null ? n.subStepCount : base.subStepCount) | 0,
      ),
      contactHertz:
        n.contactHertz != null ? n.contactHertz : base.contactHertz,
      contactDampingRatio:
        n.contactDampingRatio != null
          ? n.contactDampingRatio
          : base.contactDampingRatio,
      gravity: { x: g.x || 0, y: g.y || 0 },
      lengthUnitsPerMeter:
        n.lengthUnitsPerMeter != null
          ? n.lengthUnitsPerMeter
          : base.lengthUnitsPerMeter,
      contactSpeed:
        n.contactSpeed != null ? n.contactSpeed : base.contactSpeed,
      maximumLinearSpeed:
        n.maximumLinearSpeed != null
          ? n.maximumLinearSpeed
          : base.maximumLinearSpeed,
      box2dWorkerCount:
        n.box2dWorkerCount != null
          ? n.box2dWorkerCount
          : base.box2dWorkerCount,
      contactRingCapacity:
        n.contactRingCapacity != null
          ? n.contactRingCapacity
          : base.contactRingCapacity,
      commandRingCapacity: Math.max(
        64,
        (n.commandRingCapacity != null
          ? n.commandRingCapacity
          : base.commandRingCapacity) | 0,
      ),
      sleeping: n.sleeping != null ? n.sleeping : base.sleeping,
      hitEventThreshold:
        n.hitEventThreshold != null
          ? n.hitEventThreshold
          : base.hitEventThreshold,
      liquidFun: mergeLiquidFunConfig(base.liquidFun, n.liquidFun),
    };
  }

  function mergeLiquidFunConfig(currentLf, newLf) {
    var d = PHYSICS_DEFAULTS.liquidFun;
    var src = {};
    var i;
    var from;
    var keys;
    from = [d, currentLf || {}, newLf || {}];
    for (i = 0; i < from.length; i++) {
      keys = Object.keys(from[i]);
      for (var k = 0; k < keys.length; k++) {
        src[keys[k]] = from[i][keys[k]];
      }
    }
    return {
      enabled: !!src.enabled,
      radius: Math.max(1e-6, src.radius > 0 ? src.radius : d.radius),
      maxCount: Math.min(65535, Math.max(1, (src.maxCount != null ? src.maxCount : d.maxCount) | 0)),
      subSteps: Math.max(1, (src.subSteps != null ? src.subSteps : d.subSteps) | 0),
      density: typeof src.density === 'number' && isFinite(src.density) ? src.density : d.density,
      strictContactCheck: !!src.strictContactCheck,
      dampingStrength:
        typeof src.dampingStrength === 'number' && isFinite(src.dampingStrength)
          ? src.dampingStrength
          : d.dampingStrength,
      pressureStrength:
        typeof src.pressureStrength === 'number' && isFinite(src.pressureStrength)
          ? src.pressureStrength
          : d.pressureStrength,
      viscousStrength:
        typeof src.viscousStrength === 'number' && isFinite(src.viscousStrength)
          ? src.viscousStrength
          : d.viscousStrength,
      tensileStrength:
        typeof src.tensileStrength === 'number' && isFinite(src.tensileStrength)
          ? src.tensileStrength
          : d.tensileStrength,
      powderStrength:
        typeof src.powderStrength === 'number' && isFinite(src.powderStrength)
          ? src.powderStrength
          : d.powderStrength,
      springStrength:
        typeof src.springStrength === 'number' && isFinite(src.springStrength)
          ? src.springStrength
          : d.springStrength,
      staticPressureStrength:
        typeof src.staticPressureStrength === 'number' && isFinite(src.staticPressureStrength)
          ? src.staticPressureStrength
          : d.staticPressureStrength,
      staticPressureRelaxation:
        typeof src.staticPressureRelaxation === 'number' && isFinite(src.staticPressureRelaxation)
          ? src.staticPressureRelaxation
          : d.staticPressureRelaxation,
      staticPressureIterations: Math.max(
        1,
        (src.staticPressureIterations != null ? src.staticPressureIterations : d.staticPressureIterations) | 0,
      ),
    };
  }

  function bindJointViews(buffer, maxJoints) {
    var n = maxJoints;
    var offset = 0;
    var align4 = function (o) {
      return Math.ceil(o / 4) * 4;
    };
    var type = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var pairs = new Uint32Array(buffer, offset, n);
    offset += n * 4;
    var localAnchorAX = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var localAnchorAY = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var localAnchorBX = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var localAnchorBY = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var forceThreshold = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var torqueThreshold = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var active = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var length = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var enableSpring = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var hertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var dampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var enableLimit = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var lowerAngle = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var upperAngle = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var enableMotor = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var motorSpeed = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var maxMotorTorque = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var linearHertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var angularHertz = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var linearDampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var angularDampingRatio = new Float32Array(buffer, offset, n);
    offset += n * 4;
    var activeIndices = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    var activeIndexPositions = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    var activeCount = new Int32Array(buffer, offset, 1);
    var activeListLock = new Int32Array(buffer, offset + 4, 1);
    offset += 8;
    var revision = new Uint32Array(buffer, offset, n);
    return {
      type: type,
      pairs: pairs,
      localAnchorAX: localAnchorAX,
      localAnchorAY: localAnchorAY,
      localAnchorBX: localAnchorBX,
      localAnchorBY: localAnchorBY,
      forceThreshold: forceThreshold,
      torqueThreshold: torqueThreshold,
      active: active,
      length: length,
      enableSpring: enableSpring,
      hertz: hertz,
      dampingRatio: dampingRatio,
      enableLimit: enableLimit,
      lowerAngle: lowerAngle,
      upperAngle: upperAngle,
      enableMotor: enableMotor,
      motorSpeed: motorSpeed,
      maxMotorTorque: maxMotorTorque,
      linearHertz: linearHertz,
      angularHertz: angularHertz,
      linearDampingRatio: linearDampingRatio,
      angularDampingRatio: angularDampingRatio,
      activeIndices: activeIndices,
      activeIndexPositions: activeIndexPositions,
      activeCount: activeCount,
      activeListLock: activeListLock,
      revision: revision,
    };
  }

  var state = {
    config: {},
    settings: null,
    sleepingEnabled: true,
    globalEntityCount: 0,
    stats: null,
    frameRateData: null,
    frameRateIndex: -1,
    frameRateStride: 1,
    commandSab: null,
    queryAabbSab: null,
    rayCastSab: null,
    liquidFunQuerySab: null,
    contactSab: null,
    movedSab: null,
    hitSab: null,
    jointBreakSab: null,
    bodySyncViews: null,
    transform: null,
    rigidBody: null,
    collider: null,
    jointsEnabled: false,
    maxJoints: 0,
    jointViews: null,
    box2dReady: false,
    isPaused: true,
    lastFrameTime: 0,
    frameNumber: 0,
    currentFPS: 0,
    messageTimeThisFrame: 0,
    noLimitFPS: false,
    fixedFps: 0,
    intervalId: 0,
    posePublish: null,
    workerPorts: new Map(),
    timeoutId: 0,
    collectDetailedStats: false,
  };

  function reportReady() {
    self.postMessage({ msg: 'workerReady', worker: 'PhysicsHost' });
  }

  function reportError(title, err) {
    self.postMessage({
      msg: 'error',
      title: title,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack,
      when: Date.now(),
    });
  }

  function writeFPS() {
    if (state.frameRateData && state.frameRateIndex >= 0) {
      var base = state.frameRateIndex * state.frameRateStride;
      state.frameRateData[base] = state.currentFPS;
      if (state.frameRateStride > 1) {
        state.frameRateData[base + 1] = state.frameNumber;
      }
    }
    if (state.stats) {
      state.stats[PS.FPS] = state.currentFPS;
      if (state.collectDetailedStats) {
        state.stats[PS.MSG_MS] = state.messageTimeThisFrame;
      }
    }
  }

  function fanoutBox2dReady(ready) {
    self.postMessage({
      msg: 'box2dReady',
      sab: ready.sab,
      bodyCapacity: ready.bodyCapacity,
      channelOffsets: ready.channelOffsets,
      sleepingByteOffset: ready.sleepingByteOffset,
      commandSab: state.commandSab,
      queryAabbSab: state.queryAabbSab,
      rayCastSab: state.rayCastSab,
      liquidFunQuerySab: state.liquidFunQuerySab,
      contactSab: state.contactSab,
      movedSab: state.movedSab,
      hitSab: state.hitSab,
      jointBreakSab: state.jointBreakSab,
      eventHeaderBaseIndex: ready.eventHeaderBaseIndex,
      contactBeginBaseIndex: ready.contactBeginBaseIndex,
      contactEndBaseIndex: ready.contactEndBaseIndex,
      sensorBeginBaseIndex: ready.sensorBeginBaseIndex,
      sensorEndBaseIndex: ready.sensorEndBaseIndex,
      contactEventCapacity: ready.contactEventCapacity,
      sensorEventCapacity: ready.sensorEventCapacity,
      contactPairIntStride: ready.contactPairIntStride || 2,
      eventHeaderIntCount: ready.eventHeaderIntCount || 11,
      liquidFunHeap: ready.liquidFunHeap || null,
    });
  }

  function bootWorld() {
    var entityCount = state.globalEntityCount | 0;
    var maxBodies = Math.min(entityCount, MAX_BODIES_HINT);
    if (entityCount > MAX_BODIES_HINT) {
      throw new Error(
        'Physics: totalEntityCount ' +
        entityCount +
        ' exceeds Box2D MAX_BODIES ' +
        MAX_BODIES_HINT,
      );
    }

    state.commandSab = Box2dCommandRing.createCommandRingSab(
      state.settings.commandRingCapacity,
    );
    Box2dCommandRing.bindCommandRing(state.commandSab);
    state.queryAabbSab = Box2dQueryAabb.createQueryAabbSab();
    Box2dQueryAabb.bindQueryAabbSab(state.queryAabbSab);
    state.rayCastSab = Box2dRayCast.createRayCastSab();
    Box2dRayCast.bindRayCastSab(state.rayCastSab);
    state.liquidFunQuerySab = LiquidFunQuery.createLiquidFunQuerySab();
    LiquidFunQuery.bindLiquidFunQuerySab(state.liquidFunQuerySab);
    state.contactSab = Box2dContactRing.createContactRingSab(
      state.settings.contactRingCapacity,
    );
    state.movedSab = Box2dMovedBodies.createMovedBodiesSab(entityCount);
    Box2dMovedBodies.bindMovedBodies(state.movedSab);
    state.hitSab = Box2dContactHitRing.createContactHitRingSab(
      state.settings.contactRingCapacity,
    );
    state.jointBreakSab = Box2dJointBreakRing.createJointBreakRingSab();

    var s = state.settings;
    var T = state.transform;
    var R = state.rigidBody;
    var C = state.collider;
    var initPayload = {
      type: 'WEEDJS_INIT',
      gravityX: s.gravity.x,
      gravityY: s.gravity.y,
      lengthUnitsPerMeter: s.lengthUnitsPerMeter,
      contactHertz: s.contactHertz,
      contactDampingRatio: s.contactDampingRatio,
      contactSpeed: s.contactSpeed,
      maximumLinearSpeed: s.maximumLinearSpeed,
      box2dWorkerCount: s.box2dWorkerCount,
      maxBodies: maxBodies,
      entityCount: entityCount,
      subSteps: s.subStepCount,
      sleeping: state.sleepingEnabled !== false,
      worldWidth: state.config.worldWidth | 0,
      worldHeight: state.config.worldHeight | 0,
      commandSab: state.commandSab,
      queryAabbSab: state.queryAabbSab,
      rayCastSab: state.rayCastSab,
      liquidFunQuerySab: state.liquidFunQuerySab,
      contactSab: state.contactSab,
      movedSab: state.movedSab,
      hitSab: state.hitSab,
      jointBreakSab: state.jointBreakSab,
      hitEventThreshold: s.hitEventThreshold,
      liquidFun: s.liquidFun,
      stats: state.stats ? packView(state.stats) : null,
      collectDetailedStats: !!state.collectDetailedStats,
      posePublish: state.posePublish
        ? {
          dataA: state.posePublish.dataA,
          dataB: state.posePublish.dataB,
          sync: state.posePublish.sync,
          capacity: state.posePublish.capacity | 0,
        }
        : null,
      bodySync: state.bodySyncViews
        ? {
          dirtyFlags: packView(state.bodySyncViews.dirtyFlags),
          dirtyWords: packView(state.bodySyncViews.dirtyWords),
          generation: packView(state.bodySyncViews.generation),
        }
        : null,
      views: {
        entityActive: packView(T.active),
        rbActive: packView(R.active),
        rbStatic: packView(R.static),
        ax: packView(R.ax),
        ay: packView(R.ay),
        px: packView(R.px),
        py: packView(R.py),
        pRotation: packView(R.pRotation),
        angularAccel: packView(R.angularAccel),
        mass: packView(R.mass),
        linearDamping: packView(R.linearDamping),
        angularDamping: packView(R.angularDamping),
        fixedRotation: packView(R.fixedRotation),
        sleepThreshold: packView(R.sleepThreshold),
        colActive: packView(C.active),
        offsetX: packView(C.offsetX),
        offsetY: packView(C.offsetY),
        shapeType: packView(C.shapeType),
        radius: packView(C.radius),
        width: packView(C.width),
        height: packView(C.height),
        isTrigger: packView(C.isTrigger),
        collisionLayer: packView(C.collisionLayer),
        collisionMask: packView(C.collisionMask),
        collisionGroupIndex: packView(C.collisionGroupIndex),
        friction: packView(C.friction),
        restitution: packView(C.restitution),
        enableHitEvents: packView(C.enableHitEvents),
        polyCount: packView(C.polyCount),
        polyVertexX: packView(C.polyVertexX),
        polyVertexY: packView(C.polyVertexY),
      },
    };

    if (state.jointsEnabled && state.jointViews) {
      var J = state.jointViews;
      initPayload.maxJoints = state.maxJoints;
      initPayload.jointViews = {
        type: packView(J.type),
        pairs: packView(J.pairs),
        localAnchorAX: packView(J.localAnchorAX),
        localAnchorAY: packView(J.localAnchorAY),
        localAnchorBX: packView(J.localAnchorBX),
        localAnchorBY: packView(J.localAnchorBY),
        forceThreshold: packView(J.forceThreshold),
        torqueThreshold: packView(J.torqueThreshold),
        active: packView(J.active),
        length: packView(J.length),
        enableSpring: packView(J.enableSpring),
        hertz: packView(J.hertz),
        dampingRatio: packView(J.dampingRatio),
        enableLimit: packView(J.enableLimit),
        lowerAngle: packView(J.lowerAngle),
        upperAngle: packView(J.upperAngle),
        enableMotor: packView(J.enableMotor),
        motorSpeed: packView(J.motorSpeed),
        maxMotorTorque: packView(J.maxMotorTorque),
        linearHertz: packView(J.linearHertz),
        angularHertz: packView(J.angularHertz),
        linearDampingRatio: packView(J.linearDampingRatio),
        angularDampingRatio: packView(J.angularDampingRatio),
        activeIndices: packView(J.activeIndices),
        activeIndexPositions: packView(J.activeIndexPositions),
        activeCount: packView(J.activeCount),
        activeListLock: packView(J.activeListLock),
        revision: packView(J.revision),
      };
    }

    if (state.liquidFun) {
      var L = state.liquidFun;
      initPayload.liquidFunMaxCount = state.liquidFunMaxCount;
      initPayload.liquidFunViews = {
        count: packView(L.count),
        x: packView(L.x),
        y: packView(L.y),
        scaleX: packView(L.scaleX),
        scaleY: packView(L.scaleY),
        rotC: packView(L.rotC),
        rotS: packView(L.rotS),
        alpha: packView(L.alpha),
        px: packView(L.px),
        py: packView(L.py),
        tint: packView(L.tint),
        textureId: packView(L.textureId),
        baseAlpha: packView(L.baseAlpha),
        layerId: packView(L.layerId),
      };
    }

    if (state.liquidFunGroups) {
      var G = state.liquidFunGroups;
      initPayload.liquidFunGroupsMax = G.maxGroups;
      initPayload.liquidFunGroupsViews = {
        count: packView(G.count),
        id: packView(G.id),
        particleCount: packView(G.particleCount),
        firstIndex: packView(G.firstIndex),
        lastIndex: packView(G.lastIndex),
        viscousScale: packView(G.viscousScale),
        x: packView(G.x),
        y: packView(G.y),
        vx: packView(G.vx),
        vy: packView(G.vy),
        angularVelocity: packView(G.angularVelocity),
        angle: packView(G.angle),
        lightIntensity: packView(G.lightIntensity),
        sqrtLightIntensity: packView(G.sqrtLightIntensity),
      };
    }

    global.weedjsOnReady = function (ready) {
      state.box2dReady = true;
      fanoutBox2dReady(ready);
      console.log(
        '[physics_host] Box2D READY + hot rebind + command ring',
        ready.bodyCapacity,
      );
    };

    global.weedjsOnLiquidFunHeap = function (heap) {
      self.postMessage({ msg: 'liquidFunHeap', liquidFunHeap: heap || null });
    };

    global.weedjsOnLiquidFunCleared = function () {
      self.postMessage({ msg: 'liquidFunCleared' });
    };

    weedjsHandleInit(initPayload);
  }

  function applyPhysicsConfig(partial) {
    state.config.physics = Object.assign(
      {},
      state.config.physics || {},
      partial || {},
    );
    state.settings = validatePhysicsConfig(
      state.settings,
      state.config.physics,
    );
    state.sleepingEnabled =
      state.config.physics.sleeping != null
        ? state.config.physics.sleeping
        : PHYSICS_DEFAULTS.sleeping;

    if (state.box2dReady) {
      weedjsApplyConfig({
        subSteps: state.settings.subStepCount,
        sleeping: state.sleepingEnabled !== false,
        hitEventThreshold: state.settings.hitEventThreshold,
      });
    }
  }

  function initializeWorkerPorts(ports) {
    if (!ports) return;
    var keys = Object.keys(ports);
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      var port = ports[name];
      state.workerPorts.set(name, port);
      port.onmessage = function () {
        /* physics host: ports reserved for renderer link; no entity scripts */
      };
    }
  }

  function installSeededRng(data) {
    var seed = data.config && data.config.seed != null ? data.config.seed : Date.now();
    var workerId = data.workerName || 'physics';
    var sid = 5381;
    var s = String(workerId);
    for (var i = 0; i < s.length; i++) {
      sid = (((sid << 5) + sid) ^ s.charCodeAt(i)) >>> 0;
    }
    var z = ((seed >>> 0) + Math.imul(sid, 0x9e3779b9)) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    var t = (z ^ (z >>> 16)) >>> 0;
    self.rng = function () {
      t += 0x6d2b79f5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function initializeFromWeedInit(data) {
    state.config = data.config || {};
    installSeededRng(data);
    state.globalEntityCount = data.globalEntityCount | 0;
    state.posePublish = data.posePublish || null;
    state.collectDetailedStats = !!(state.config.debug && state.config.debug.collectDetailedStats);

    if (data.buffers && data.buffers.physicsStats) {
      state.stats = new Float32Array(data.buffers.physicsStats);
    }
    if (data.buffers && data.buffers.frameRateData) {
      state.frameRateData = new Float32Array(data.buffers.frameRateData);
    }
    if (data.frameRateIndex !== undefined) {
      state.frameRateIndex = data.frameRateIndex | 0;
    }
    if (data.frameRateStride !== undefined) {
      state.frameRateStride = data.frameRateStride | 0 || 1;
    }

    var physCfg = state.config.physics || {};
    var fixedFps = Number(physCfg.fixedFps);
    if (fixedFps > 0) {
      state.fixedFps = fixedFps;
      state.noLimitFPS = false;
    } else if (physCfg.noLimitFPS === true) {
      state.noLimitFPS = true;
    }

    var buffers = data.buffers || {};
    var componentData = buffers.componentData || {};
    if (!componentData.Transform || !componentData.RigidBody || !componentData.Collider) {
      throw new Error('[physics_host] init missing Transform/RigidBody/Collider buffers');
    }

    state.transform = bindSchema(
      componentData.Transform,
      state.globalEntityCount,
      TRANSFORM_SCHEMA,
    );
    state.rigidBody = bindSchema(
      componentData.RigidBody,
      state.globalEntityCount,
      RIGIDBODY_SCHEMA,
    );
    state.collider = bindSchema(
      componentData.Collider,
      state.globalEntityCount,
      COLLIDER_SCHEMA,
    );

    var lfMax = data.liquidFunMaxCount | 0;
    if (!lfMax && data.config && data.config.physics && data.config.physics.liquidFun) {
      lfMax = data.config.physics.liquidFun.maxCount | 0;
    }
    if (buffers.liquidFunRender && lfMax > 0) {
      state.liquidFun = bindLiquidFunRenderViews(buffers.liquidFunRender, lfMax);
      state.liquidFunMaxCount = lfMax;
    }
    if (buffers.liquidFunGroups) {
      state.liquidFunGroups = bindLiquidFunGroupsViews(buffers.liquidFunGroups, 256);
    }

    if (buffers.bodyDirtyFlags && buffers.bodyDirtyWords && buffers.bodyGeneration) {
      state.bodySyncViews = {
        dirtyFlags: new Int32Array(buffers.bodyDirtyFlags),
        dirtyWords: new Int32Array(buffers.bodyDirtyWords),
        generation: new Int32Array(buffers.bodyGeneration),
      };
    } else {
      state.bodySyncViews = null;
    }

    if (data.joints && data.joints.enabled) {
      state.jointsEnabled = true;
      state.maxJoints = data.joints.maxJoints | 0;
      state.jointViews = bindJointViews(data.joints.data, state.maxJoints);
    }

    initializeWorkerPorts(data.workerPorts);
    applyPhysicsConfig(physCfg);

    weedjsWhenModuleReady(function () {
      try {
        bootWorld();
        reportReady();
      } catch (err) {
        console.error('[physics_host] boot failed', err);
        reportError('Physics host boot failed', err);
      }
    });
  }

  function gameLoop() {
    if (state.isPaused) return;

    state.frameNumber++;
    var now = performance.now();
    var deltaTime = now - state.lastFrameTime;
    // Reject sub-ms deltas too. startGameLoop() sets lastFrameTime then calls
    // gameLoop() synchronously, so the first dt is often << 1ms. LiquidFun
    // pressure scales with (diameter/dt)^2 — that micro-step explodes a
    // restored settled puddle upward on the first frame after load.
    if (!(deltaTime >= 1) || deltaTime > 1000) {
      deltaTime = 1000 / 60;
    }
    state.lastFrameTime = now;
    state.currentFPS = 1000 / deltaTime;

    if (state.box2dReady) {
      var t0 = performance.now();
      var dt;
      if (state.fixedFps > 0) {
        // Lockstep: ignore wall clock so each interval fires the same sim step.
        dt = 1 / state.fixedFps;
      } else {
        dt = deltaTime / 1000;
        // Stutter guard: cap a single step so one hitch cannot hand Box2D /
        // LiquidFun an unstable dt. Variable-rate path stays at 1/20s.
        var maxDt = 1 / 20;
        if (dt > maxDt) dt = maxDt;
      }
      if (dt > 0) {
        weedjsDoStep(dt, state.settings.subStepCount);
      }
      if (state.stats) {
        state.stats[PS.STEP_MS] = performance.now() - t0;
      }
    }

    writeFPS();
    state.messageTimeThisFrame = 0;

    if (state.fixedFps > 0) {
      if (!state.intervalId) {
        state.intervalId = setInterval(gameLoop, 1000 / state.fixedFps);
      }
    } else if (state.noLimitFPS) {
      state.timeoutId = setTimeout(gameLoop, 2);
    } else {
      requestAnimationFrame(gameLoop);
    }
  }

  function stepOnce(deltaTimeMs) {
    if (!(deltaTimeMs > 0)) deltaTimeMs = 1000 / 60;
    state.frameNumber++;
    state.lastFrameTime = performance.now();
    state.currentFPS = 1000 / deltaTimeMs;
    var dt = deltaTimeMs / 1000;
    if (state.box2dReady && dt > 0) {
      var t0 = performance.now();
      weedjsDoStep(dt, state.settings.subStepCount);
      if (state.stats) {
        state.stats[PS.STEP_MS] = performance.now() - t0;
      }
    }
    writeFPS();
    state.messageTimeThisFrame = 0;
  }

  function clearSchedulers() {
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = 0;
    }
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = 0;
    }
  }

  function startGameLoop() {
    state.isPaused = false;
    state.lastFrameTime = performance.now();
    clearSchedulers();
    gameLoop();
  }

  self.onmessage = function (event) {
    var data = event.data;
    if (!data || !data.msg) return;
    var t0 = performance.now();
    try {
      if (data.msg === 'init') {
        state.isPaused = true;
        initializeFromWeedInit(data);
      } else if (data.msg === 'start') {
        startGameLoop();
      } else if (data.msg === 'pause') {
        state.isPaused = true;
        clearSchedulers();
      } else if (data.msg === 'resume') {
        startGameLoop();
      } else if (data.msg === 'step') {
        var stepMs = Number(data.deltaTime);
        state.isPaused = false;
        stepOnce(stepMs);
        state.isPaused = true;
        self.postMessage({ msg: 'stepDone', id: data.id | 0 });
      } else if (data.msg === 'updatePhysicsConfig') {
        applyPhysicsConfig(data.config || {});
      } else if (data.msg === 'snapshotLiquidFun') {
        var snap = typeof weedjsSnapshotLiquidFun === 'function' ? weedjsSnapshotLiquidFun() : null;
        var transfer = [];
        var pushBuf = function (a) {
          if (a && a.buffer) transfer.push(a.buffer);
        };
        if (snap) {
          pushBuf(snap.pos);
          pushBuf(snap.vel);
          pushBuf(snap.flags);
          pushBuf(snap.groupIndex);
          pushBuf(snap.restOffset);
          if (snap.groups) {
            Object.keys(snap.groups).forEach(function (k) { pushBuf(snap.groups[k]); });
          }
          if (snap.pairs) {
            Object.keys(snap.pairs).forEach(function (k) { pushBuf(snap.pairs[k]); });
          }
          if (snap.render) {
            Object.keys(snap.render).forEach(function (k) { pushBuf(snap.render[k]); });
          }
          pushBuf(snap.groupsLightIntensity);
        }
        self.postMessage({ msg: 'liquidFunSnapshot', requestId: data.requestId | 0, snapshot: snap }, transfer);
      } else if (data.msg === 'restoreLiquidFun') {
        var result = typeof weedjsRestoreLiquidFun === 'function'
          ? weedjsRestoreLiquidFun(data.payload || null)
          : { ok: false, reason: 'missing-fn' };
        self.postMessage({ msg: 'liquidFunRestoreComplete', requestId: data.requestId | 0, result: result });
      }
    } catch (err) {
      console.error('[physics_host]', err);
      reportError('Physics host message failed', err);
    }
    state.messageTimeThisFrame += performance.now() - t0;
  };

  self.postMessage({
    msg: 'log',
    message: 'physics_host loaded',
    when: Date.now(),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
