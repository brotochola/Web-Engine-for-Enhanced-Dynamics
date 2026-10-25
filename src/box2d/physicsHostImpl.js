// Classic physics host — Scene's workers.physics IS box2dWasm + weedjsPost + this file.
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
    console.error('[physics_host] weedjs host APIs missing — load after weedjsPost.js');
    return;
  }

  weedjsEnableHostMode();

  var MAX_POLYGON_VERTICES = 8;
  var MAX_BODIES_HINT = 65535;

  // Defaults and the validator: physicsConfigImpl.js, loaded by weedjsPost.js (N-15).
  var PhysicsConfig = global.WeedPhysicsConfig;
  var PHYSICS_DEFAULTS = PhysicsConfig.PHYSICS_SIM_DEFAULTS;
  var validatePhysicsConfig = PhysicsConfig.validatePhysicsConfig;

  // Mirrors PHYSICS_STATS (workersUtils.js) — host writes FPS / STEP_MS / MSG_MS.
  var PS = {
    FPS: 0,
    STEP_MS: 1,
    MSG_MS: 2,
    // E-01: WAIT_MS / IDLE_MS. The physics host is not an AbstractWorker, so it
    // does its own frame bookkeeping and cannot inherit the idle measurement.
    WAIT_MS: 47,
    IDLE_MS: 48,
    // E-56: sync queries answered by the wake between steps.
    QUERY_WAKE_MS: 49,
  };

  // M4: blocked-on-sibling ms inside the step. The query IIFEs (bursts waiting
  // for the next logic query) add to this shared object; the step resets it.
  var WAIT_METER = global.__weedWaitMeter || (global.__weedWaitMeter = { ms: 0 });

  // E-24. src/util/frameClock.js stampStep, copied: a classic script cannot
  // import it. tests/node/frameClock.test.js runs this copy against stampStep
  // and compares the buffers byte for byte.
  var FC_HEADER = 32;
  var FC_SLOT = 32;
  var FC_SEQ = 4;
  var FC_GEN = 5;

  function fcReadGen(i32) {
    var gen = 0;
    for (var spin = 0; spin < 8; spin++) {
      var s1 = Atomics.load(i32, FC_SEQ);
      if (s1 & 1) continue;
      gen = Atomics.load(i32, FC_GEN);
      var s2 = Atomics.load(i32, FC_SEQ);
      if (s1 === s2 && (s2 & 1) === 0) return gen;
    }
    return Atomics.load(i32, FC_GEN);
  }

  function fcStamp(state, startAbs, endAbs) {
    if (!state.fcI32 || !(startAbs > 0) || !(endAbs >= startAbs)) return;
    var slot = state.fcSlot;
    if (slot < 0) return;
    var i32 = state.fcI32;
    var f64 = state.fcF64;
    var gen = fcReadGen(i32);
    var i32Base = (FC_HEADER + slot * FC_SLOT) >> 2;
    var f64Base = (FC_HEADER + slot * FC_SLOT) >> 3;
    Atomics.add(i32, i32Base + 5, 1);
    f64[f64Base] = startAbs;
    f64[f64Base + 1] = endAbs;
    Atomics.store(i32, i32Base + 4, gen);
    Atomics.add(i32, i32Base + 5, 1);
  }

  // src/util/frameTotals.js addFrame, copied for the same reason. tests/node/frameTotals.test.js
  // runs this copy against addFrame and compares the buffers byte for byte.
  var FT_HEADER = 64;
  var FT_BINS = 1024;
  var FT_SLOT = FT_HEADER + FT_BINS * 4;

  function ftAdd(state, stepMs, waitMs, extraMs) {
    var slot = state.fcSlot;
    if (!state.ftI32 || slot < 0 || !(stepMs >= 0)) return;
    var i32 = state.ftI32;
    var f64 = state.ftF64;
    var f0 = (slot * FT_SLOT) >> 3;
    var seq = (slot * FT_SLOT) >> 2;
    var work = waitMs > 0 ? stepMs - waitMs : stepMs;
    var bin = work > 0 ? (work * 8) | 0 : 0;
    if (bin >= FT_BINS) bin = FT_BINS - 1;
    Atomics.add(i32, seq, 1);
    f64[f0 + 1] += 1;
    f64[f0 + 2] += stepMs;
    if (waitMs > 0) f64[f0 + 3] += waitMs;
    if (extraMs > 0) f64[f0 + 4] += extraMs;
    state.ftU32[((slot * FT_SLOT + FT_HEADER) >> 2) + bin]++;
    Atomics.add(i32, seq, 1);
  }

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
    // Append-only tail — must match Collider.ARRAY_SCHEMA or fixtureCount binds at the wrong offset.
    layerMask: Uint16Array,
    feedBits: Uint8Array,
    fixtureCount: Uint16Array,
  };

  // Mirrors src/render/liquidFunRender.js bindLiquidFunRender (nested classic
  // worker - no ESM import). Layout must stay identical to that file.
  function bindLiquidFunRenderViews(sab, maxCount, byte) {
    var n = maxCount | 0;
    var at = byte | 0;
    var off = at + 8;
    var count = new Int32Array(sab, at, 1);
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
    off = at + ((off - at + 3) & ~3);
    var baseAlpha = new Float32Array(sab, off, n);
    off += n * 4;
    var layerMask = new Uint16Array(sab, off, n);
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
      layerMask: layerMask,
    };
  }

  // Mirrors src/util/liquidFunGroups.js bindLiquidFunGroups.
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
    var groupFlags = new Int32Array(sab, off, n);
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
      groupFlags: groupFlags,
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

  // byte: where the block starts in buffer (a region of Box2D's block, Phase 4; 64-aligned, so each field
  // aligns as it does from 0), as the components' initializeArrays take it.
  function bindSchema(buffer, count, schema, byte) {
    var views = {};
    var offset = byte | 0;
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

  function bindJointViews(buffer, maxJoints, entityIdWidth) {
    var n = maxJoints;
    var offset = 0;
    var align4 = function (o) {
      return Math.ceil(o / 4) * 4;
    };
    var wide = (entityIdWidth | 0) === 32;
    var type = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var pairs = null;
    var entityA = null;
    var entityB = null;
    if (wide) {
      entityA = new Uint32Array(buffer, offset, n);
      offset += n * 4;
      entityB = new Uint32Array(buffer, offset, n);
      offset += n * 4;
    } else {
      pairs = new Uint32Array(buffer, offset, n);
      offset += n * 4;
    }
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
      entityA: entityA,
      entityB: entityB,
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

  // Mirrors ColliderFixture.initializeArrays
  function bindFixtureViews(buffer, maxFixtures, entityCount, entityIdWidth) {
    var n = maxFixtures | 0;
    var e = entityCount | 0;
    var V = MAX_POLYGON_VERTICES;
    var offset = 0;
    var align4 = function (o) {
      return Math.ceil(o / 4) * 4;
    };
    var active = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var idBytes = (entityIdWidth | 0) === 32 ? 4 : 2;
    var entity =
      idBytes === 4
        ? new Uint32Array(buffer, offset, n)
        : new Uint16Array(buffer, offset, n);
    offset += n * idBytes;
    var next = new Uint16Array(buffer, offset, n);
    offset += n * 2;
    var vertCount = new Uint8Array(buffer, offset, n);
    offset = align4(offset + n);
    var vertexX = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    var vertexY = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    var normalX = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    var normalY = new Float32Array(buffer, offset, n * V);
    offset += n * V * 4;
    offset = align4(offset);
    var head = e > 0 ? new Uint16Array(buffer, offset, e) : null;
    offset += e * 2;
    offset = align4(offset);
    var revision = new Uint32Array(buffer, offset, 1);
    return {
      active: active,
      entity: entity,
      next: next,
      vertCount: vertCount,
      vertexX: vertexX,
      vertexY: vertexY,
      normalX: normalX,
      normalY: normalY,
      head: head,
      revision: revision,
    };
  }

  // Mirrors ChainPoints.initializeArrays. Physics only reads xy/begin/count/loop.
  function bindChainViews(buffer, maxPoints, entityCount) {
    var n = maxPoints | 0;
    var e = entityCount | 0;
    var align4 = function (o) {
      return (o + 3) & ~3;
    };
    var offset = 0;
    var xy = new Float32Array(buffer, offset, n * 2);
    offset += n * 2 * 4;
    var begin = new Int32Array(buffer, offset, e);
    offset += e * 4;
    var count = new Uint16Array(buffer, offset, e);
    offset = align4(offset + e * 2);
    var loop = new Uint8Array(buffer, align4(offset + e * 2), e);
    return { xy: xy, begin: begin, count: count, loop: loop };
  }

  var state = {
    config: {},
    settings: null,
    sleepingEnabled: true,
    globalEntityCount: 0,
    stats: null,
    frameRateData: null,
    clockScale: null,
    frameRateIndex: -1,
    frameRateStride: 1,
    // Phase 4: the engine block malloc'd in Box2D's memory (its raw pointer), 0 without one.
    engineBlockRaw: 0,
    // Running totals of every step, on the frame clock's slot (ftAdd).
    ftI32: null,
    ftF64: null,
    ftU32: null,
    commandSab: null,
    queryAabbSab: null,
    overlapCircleSab: null,
    rayCastSab: null,
    castRayAllSab: null,
    liquidFunQuerySab: null,
    liquidFunExtractSab: null,
    liquidFunUserDataListSab: null,
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
    fixturesEnabled: false,
    maxFixtures: 0,
    fixtureViews: null,
    chainsEnabled: false,
    maxChainPoints: 0,
    chainViews: null,
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
    // Box2D aborted (out of memory, first of all): the error is on screen and the module is dead.
    box2dAborted: false,
  };

  function reportReady() {
    self.postMessage({ msg: 'workerReady', worker: 'PhysicsHost' });
  }

  // bm6-memory-start
  // Box2D's memory is sized once, from this worker's name ('physics pages=N'; 8192 pages without
  // one), by the glue's pre-js (weedjs/weed_pre.js in the sibling build), and it never grows. A
  // glue built without that pre-js makes its own memory, which can grow, and the other workers'
  // views would not see what Box2D allocates after a growth. The host refuses to start instead.
  function box2dMemoryMismatch(workerName, heapBytes) {
    var match = /(?:^|\s)pages=(\d+)(?:\s|$)/.exec(workerName || '');
    var wantedBytes = (match ? +match[1] : 8192) * 65536;
    if (heapBytes === wantedBytes) return '';
    return (
      'Box2D memory is ' + heapBytes / 1048576 + ' MB but the scene asked for ' + wantedBytes / 1048576 +
      ' MB. Rebuild box2dWasm.js with weedjs\\build_for_weed.bat: its weed_pre.js sizes the memory.'
    );
  }
  // bm6-memory-end

  function reportError(title, err) {
    self.postMessage({
      msg: 'error',
      title: title,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack,
      when: Date.now(),
    });
  }

  // bm8-abort-start
  // The text the scene shows when Box2D aborts. "OOM" is the glue's abort when Box2D's memory is
  // full; the memory never grows, so name the key that sizes it, with the value the scene set: the
  // worker's name carries it ('mb=M'), since Phase 4 grows the memory by the engine's block (pages=N
  // is then more than M MB).
  function box2dAbortMessage(what, heapBytes, workerName) {
    if (String(what) === 'OOM') {
      var heapMB = Math.round(heapBytes / 1048576);
      var match = /(?:^|\s)mb=(\d+)(?:\s|$)/.exec(workerName || '');
      var setMB = match ? +match[1] : heapMB;
      return (
        'Box2D ran out of memory: physics.wasmMemoryMB is ' + setMB + ' MB' +
        (heapMB > setMB ? ' (' + heapMB + ' MB with the engine\'s block in the same memory)' : '') +
        '. Raise physics.wasmMemoryMB in the scene config; the memory panel shows the Box2D peak.'
      );
    }
    return 'Box2D aborted: ' + what;
  }
  // bm8-abort-end

  // An abort (out of memory, first of all) stops physics with the scene's fatal error. Set at load,
  // before the first pthread_create: Emscripten hands a helper thread the main thread's onAbort when
  // the helper starts, so a helper's abort is proxied here too (and the crash wakes this thread out
  // of its wait). Nothing here calls into Box2D: the abort may come from inside malloc.
  if (typeof Module !== 'undefined') {
    Module.onAbort = function (what) {
      if (state.box2dAborted) return;
      state.box2dAborted = true;
      state.isPaused = true;
      clearSchedulers();
      var heapBytes = Module.HEAPF32 ? Module.HEAPF32.buffer.byteLength : 0;
      reportError('Box2D stopped', new Error(box2dAbortMessage(what, heapBytes, typeof self !== 'undefined' ? self.name : '')));
    };
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
      overlapCircleSab: state.overlapCircleSab,
      rayCastSab: state.rayCastSab,
      castRayAllSab: state.castRayAllSab,
      liquidFunQuerySab: state.liquidFunQuerySab,
      liquidFunExtractSab: state.liquidFunExtractSab,
      liquidFunUserDataListSab: state.liquidFunUserDataListSab,
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
    state.overlapCircleSab = Box2dOverlapCircle.createOverlapCircleSab();
    Box2dOverlapCircle.bindOverlapCircleSab(state.overlapCircleSab);
    state.rayCastSab = Box2dRayCast.createRayCastSab();
    Box2dRayCast.bindRayCastSab(state.rayCastSab);
    state.castRayAllSab = Box2dCastRayAll.createCastRayAllSab();
    Box2dCastRayAll.bindCastRayAllSab(state.castRayAllSab);
    state.liquidFunQuerySab = LiquidFunQuery.createLiquidFunQuerySab();
    LiquidFunQuery.bindLiquidFunQuerySab(state.liquidFunQuerySab);
    state.liquidFunExtractSab = LiquidFunExtract.createLiquidFunExtractSab();
    LiquidFunExtract.bindLiquidFunExtractSab(state.liquidFunExtractSab);
    state.liquidFunUserDataListSab = LiquidFunUserDataList.createLiquidFunUserDataListSab();
    LiquidFunUserDataList.bindLiquidFunUserDataListSab(state.liquidFunUserDataListSab);
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
      numberOfPhysicsWorkers: s.numberOfPhysicsWorkers,
      maxBodies: maxBodies,
      entityCount: entityCount,
      subSteps: s.subStepCount,
      sleeping: state.sleepingEnabled !== false,
      worldWidth: state.config.worldWidth | 0,
      worldHeight: state.config.worldHeight | 0,
      commandSab: state.commandSab,
      queryAabbSab: state.queryAabbSab,
      overlapCircleSab: state.overlapCircleSab,
      rayCastSab: state.rayCastSab,
      castRayAllSab: state.castRayAllSab,
      liquidFunQuerySab: state.liquidFunQuerySab,
      liquidFunExtractSab: state.liquidFunExtractSab,
      liquidFunUserDataListSab: state.liquidFunUserDataListSab,
      contactSab: state.contactSab,
      movedSab: state.movedSab,
      hitSab: state.hitSab,
      jointBreakSab: state.jointBreakSab,
      hitEventThreshold: s.hitEventThreshold,
      publishContactRing: (state.config.physics || {}).publishContactRing !== false,
      liquidFun: s.liquidFun,
      stats: state.stats ? packView(state.stats) : null,
      collectDetailedStats: !!state.collectDetailedStats,
      posePublish: state.posePublish
        ? {
          dataA: state.posePublish.dataA,
          dataB: state.posePublish.dataB,
          dataAByte: state.posePublish.dataAByte | 0,
          dataBByte: state.posePublish.dataBByte | 0,
          sync: state.posePublish.sync,
          capacity: state.posePublish.capacity | 0,
        }
        : null,
      bodySync: state.bodySyncViews
        ? {
          dirtyFlags: packView(state.bodySyncViews.dirtyFlags),
          dirtyWords: packView(state.bodySyncViews.dirtyWords),
          generation: packView(state.bodySyncViews.generation),
          epoch: state.bodySyncViews.epoch ? packView(state.bodySyncViews.epoch) : null,
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
        inertia: packView(R.inertia),
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
        fixtureCount: C.fixtureCount ? packView(C.fixtureCount) : null,
      },
    };

    if (state.jointsEnabled && state.jointViews) {
      var J = state.jointViews;
      initPayload.maxJoints = state.maxJoints;
      initPayload.entityIdWidth = state.entityIdWidth || 16;
      initPayload.jointViews = {
        type: packView(J.type),
        pairs: J.pairs ? packView(J.pairs) : null,
        entityA: J.entityA ? packView(J.entityA) : null,
        entityB: J.entityB ? packView(J.entityB) : null,
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

    if (state.chainsEnabled && state.chainViews) {
      var Ch = state.chainViews;
      initPayload.maxChainPoints = state.maxChainPoints;
      initPayload.chainViews = {
        xy: packView(Ch.xy),
        begin: packView(Ch.begin),
        count: packView(Ch.count),
        loop: packView(Ch.loop),
      };
    }

    if (state.fixturesEnabled && state.fixtureViews) {
      var F = state.fixtureViews;
      initPayload.maxFixturePoolSize = state.maxFixtures;
      initPayload.fixtureViews = {
        active: packView(F.active),
        entity: packView(F.entity),
        next: packView(F.next),
        vertCount: packView(F.vertCount),
        vertexX: packView(F.vertexX),
        vertexY: packView(F.vertexY),
        head: F.head ? packView(F.head) : null,
        revision: packView(F.revision),
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
        layerMask: packView(L.layerMask),
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
        groupFlags: packView(G.groupFlags),
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
        publishContactRing: (state.config.physics || {}).publishContactRing !== false,
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
    if (!(state.config.debug && state.config.debug.verboseWorkers) && typeof console !== 'undefined') {
      console.log = function () {};
    }

    if (data.buffers && data.buffers.physicsStats) {
      state.stats = new Float32Array(data.buffers.physicsStats);
    }
    if (data.buffers && data.buffers.frameRateData) {
      state.frameRateData = new Float32Array(data.buffers.frameRateData);
    }
    if (data.buffers && data.buffers.clockData) {
      state.clockScale = new Float32Array(data.buffers.clockData);
    }
    if (data.buffers && data.buffers.frameClock && (data.frameClockSlot | 0) === data.frameClockSlot) {
      state.fcI32 = new Int32Array(data.buffers.frameClock);
      state.fcF64 = new Float64Array(data.buffers.frameClock);
      state.fcSlot = data.frameClockSlot | 0;
      if (data.buffers.frameTotals) {
        state.ftI32 = new Int32Array(data.buffers.frameTotals);
        state.ftF64 = new Float64Array(data.buffers.frameTotals);
        state.ftU32 = new Uint32Array(data.buffers.frameTotals);
      }
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

    // Each block's byte in its buffer: a region of the render-queue memory (Phase 4: Box2D's block), else 0.
    var componentByte = buffers.componentDataByte || {};
    state.transform = bindSchema(
      componentData.Transform,
      state.globalEntityCount,
      TRANSFORM_SCHEMA,
      componentByte.Transform,
    );
    state.rigidBody = bindSchema(
      componentData.RigidBody,
      state.globalEntityCount,
      RIGIDBODY_SCHEMA,
      componentByte.RigidBody,
    );
    state.collider = bindSchema(
      componentData.Collider,
      state.globalEntityCount,
      COLLIDER_SCHEMA,
      componentByte.Collider,
    );

    var lfMax = data.liquidFunMaxCount | 0;
    if (!lfMax && data.config && data.config.physics && data.config.physics.liquidFun) {
      lfMax = data.config.physics.liquidFun.maxCount | 0;
    }
    if (buffers.liquidFunRender && lfMax > 0) {
      state.liquidFun = bindLiquidFunRenderViews(buffers.liquidFunRender, lfMax, buffers.liquidFunRenderByte | 0);
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
        epoch: buffers.bodyGenEpoch ? new Int32Array(buffers.bodyGenEpoch) : null,
      };
    } else {
      state.bodySyncViews = null;
    }

    if (data.joints && data.joints.enabled) {
      state.jointsEnabled = true;
      state.maxJoints = data.joints.maxJoints | 0;
      state.entityIdWidth = data.joints.entityIdWidth | 0 || 16;
      state.jointViews = bindJointViews(data.joints.data, state.maxJoints, state.entityIdWidth);
    }

    if (data.fixtures && data.fixtures.enabled) {
      state.fixturesEnabled = true;
      state.maxFixtures = data.fixtures.maxFixturePoolSize | data.fixtures.maxFixtures | 0;
      state.fixtureViews = bindFixtureViews(
        data.fixtures.data,
        state.maxFixtures,
        data.fixtures.entityCount | 0,
        data.fixtures.entityIdWidth | 0 || state.entityIdWidth || 16,
      );
    }

    if (data.chains && data.chains.enabled && data.chains.data) {
      state.chainsEnabled = true;
      state.maxChainPoints = data.chains.maxChainPoints | 0;
      state.chainViews = bindChainViews(
        data.chains.data,
        state.maxChainPoints,
        data.chains.entityCount | 0,
      );
    }

    initializeWorkerPorts(data.workerPorts);
    applyPhysicsConfig(physCfg);

    weedjsWhenModuleReady(function () {
      try {
        var heapBytes =
          typeof Module !== 'undefined' && Module.HEAPF32 ? Module.HEAPF32.buffer.byteLength : -1;
        var mismatch =
          heapBytes < 0 ? '' : box2dMemoryMismatch(typeof self !== 'undefined' ? self.name : '', heapBytes);
        if (mismatch) {
          console.error('[physics_host] ' + mismatch);
          reportError('Box2D memory size mismatch', new Error(mismatch));
          return;
        }
        bootWorld();
        reportReady();
      } catch (err) {
        console.error('[physics_host] boot failed', err);
        // After an abort the error on screen is onAbort's; this one only says "Aborted(OOM)".
        if (!state.box2dAborted) reportError('Physics host boot failed', err);
      }
    });
  }

  // Wake between steps for every sync query kind (review N-24). doStep answers
  // them once per frame; a request posted after that point would wait for the
  // next requestAnimationFrame, its logic worker blocked the whole time.
  var WAKE_KINDS = [
    'Box2dQueryAabb',
    'Box2dOverlapCircle',
    'Box2dRayCast',
    'Box2dCastRayAll',
    'LiquidFunQuery',
    'LiquidFunExtract',
  ];
  var wakeArmed = Object.create(null);
  var wakeDepth = 0;
  // Time spent answering in the wake since the last published frame.
  var queryWakeMs = 0;

  function pumpQueryWake() {
    for (var k = 0; k < WAKE_KINDS.length; k++) armQueryWake(WAKE_KINDS[k]);
  }

  function armQueryWake(kind) {
    if (wakeArmed[kind]) return;
    var api = global[kind];
    if (!api || typeof api.armPendingWake !== 'function') return;
    wakeArmed[kind] = true;
    var armed = api.armPendingWake(function () {
      wakeArmed[kind] = false;
      // Not ready, or mid-step: the end-of-frame pump arms it again.
      if (state._inStep || !state.box2dReady || typeof globalThis.weedjsServiceQueries !== 'function') return;
      // A request that lands as the last one is answered fires the next arm
      // synchronously; past a few in a row, leave it to the pump.
      if (wakeDepth > 8) return;
      wakeDepth++;
      var slot = global.Box2dSyncSlot;
      try {
        var t0 = performance.now();
        if (slot) slot.setWakeService(true);
        try {
          globalThis.weedjsServiceQueries();
        } finally {
          if (slot) slot.setWakeService(false);
        }
        queryWakeMs += performance.now() - t0;
        armQueryWake(kind);
      } finally {
        wakeDepth--;
      }
    });
    if (!armed) wakeArmed[kind] = false;
  }

  // timeScale.js sanitizeTimeScale, copied: a classic script cannot import it.
  // tests/node/timeScale.test.js runs this copy against it over a sweep of values.
  var MAX_TIME_SCALE = 4.0;

  function readTimeScale() {
    var view = state.clockScale;
    if (!view) return 1;
    var s = view[0];
    if (typeof s !== 'number' || s !== s || s === Infinity || s === -Infinity) return 1;
    if (s <= 0) return 0;
    if (s > MAX_TIME_SCALE) return MAX_TIME_SCALE;
    return s;
  }

  // b7-split-start
  /** Longest step Box2D and LiquidFun stay stable with. */
  var MAX_STABLE_DT = 1 / 30;
  /** Most ordinary steps one frame may take; past that the frame is cut short. */
  var MAX_FRAME_STEPS = 4;
  var _frameSplit = { dt: 0, steps: 1 };

  /**
   * B7. A frame's scaled dt as equal steps no longer than MAX_STABLE_DT. It was
   * one step capped at 1/30 s, so Time.scale above 2 at 60 Hz ran at 2 and
   * fixedFps under 30 ran slow. Scale 3 at 60 Hz is 2 steps of 1/40 s; fixedFps
   * 20 is 2 of 1/40 s. Past MAX_FRAME_STEPS (a long hitch at scale 4) the steps
   * stay at MAX_STABLE_DT and the frame loses the rest, as the cap did.
   */
  function splitFrameDt(dt) {
    var steps = Math.ceil(dt / MAX_STABLE_DT - 1e-9);
    if (!(steps >= 1)) steps = 1;
    if (steps > MAX_FRAME_STEPS) steps = MAX_FRAME_STEPS;
    var step = dt / steps;
    if (step > MAX_STABLE_DT) step = MAX_STABLE_DT;
    _frameSplit.dt = step;
    _frameSplit.steps = steps;
    return _frameSplit;
  }
  // b7-split-end

  function gameLoop() {
    if (state.isPaused) return;

    // E-01: scheduler idle since the previous frame, measured before anything
    // else so it cannot absorb the step it sits beside. This is the number
    // E-06 needs and the physics host could not report it at all before.
    var frameStart = performance.now();
    var frameStartAbs = (typeof performance.timeOrigin === 'number' ? performance.timeOrigin : 0) + frameStart;
    if (state.stats && state._lastFrameEndAt > 0) {
      state.stats[PS.IDLE_MS] = Math.max(0, frameStart - state._lastFrameEndAt);
    }

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
      dt *= readTimeScale();
      WAIT_METER.ms = 0;
      if (dt > 0) {
        // B7: a long frame is several stable steps, not one capped step.
        var split = splitFrameDt(dt);
        state._inStep = true;
        try {
          weedjsDoStep(split.dt, state.settings.subStepCount, split.steps);
        } finally {
          state._inStep = false;
        }
      }
      if (state.stats) {
        var stepMs = performance.now() - t0;
        state.stats[PS.STEP_MS] = stepMs;
        state.stats[PS.WAIT_MS] = WAIT_METER.ms;
        state.stats[PS.QUERY_WAKE_MS] = queryWakeMs;
        ftAdd(state, stepMs, WAIT_METER.ms, queryWakeMs);
        queryWakeMs = 0;
      }
    }
    state._lastFrameEndAt = performance.now();
    fcStamp(
      state,
      frameStartAbs,
      (typeof performance.timeOrigin === 'number' ? performance.timeOrigin : 0) + state._lastFrameEndAt
    );

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
    pumpQueryWake();
  }

  function stepOnce(deltaTimeMs) {
    if (!(deltaTimeMs > 0)) deltaTimeMs = 1000 / 60;
    state.frameNumber++;
    state.lastFrameTime = performance.now();
    state.currentFPS = 1000 / deltaTimeMs;
    var dt = (deltaTimeMs / 1000) * readTimeScale();
    if (state.box2dReady && dt > 0) {
      var t0 = performance.now();
      WAIT_METER.ms = 0;
      var split = splitFrameDt(dt);
      state._inStep = true;
      try {
        weedjsDoStep(split.dt, state.settings.subStepCount, split.steps);
      } finally {
        state._inStep = false;
      }
      if (state.stats) {
        var stepMs = performance.now() - t0;
        state.stats[PS.STEP_MS] = stepMs;
        state.stats[PS.WAIT_MS] = WAIT_METER.ms;
        state.stats[PS.QUERY_WAKE_MS] = queryWakeMs;
        ftAdd(state, stepMs, WAIT_METER.ms, queryWakeMs);
        queryWakeMs = 0;
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

  // Phase 4 (WASM_HYPOTHESES): a block of Box2D's memory for the engine's regions (the render-queue memory),
  // asked for before init. Allocated once the module runs, 64-byte aligned and zeroed, and posted back with the
  // memory itself, which every kernel then imports. memory null: no block, and the engine makes its own memory.
  function reserveEngineBlock(bytes) {
    var whenReady = typeof global.weedjsWhenModuleReady === 'function'
      ? global.weedjsWhenModuleReady
      : function (cb) { cb(); };
    whenReady(function () {
      var memory = typeof Module !== 'undefined' ? Module.wasmMemory : null;
      var raw = 0;
      if (memory && bytes > 0 && !state.engineBlockRaw && typeof Module._malloc === 'function') {
        try {
          raw = Module._malloc(bytes + 64);
        } catch (err) {
          raw = 0;
        }
      }
      if (!raw) {
        self.postMessage({ msg: 'engineBlock', memory: null, byte: 0, bytes: 0 });
        return;
      }
      var byte = (raw + 63) & ~63;
      new Uint8Array(memory.buffer, byte, bytes).fill(0);
      state.engineBlockRaw = raw;
      self.postMessage({ msg: 'engineBlock', memory: memory, byte: byte, bytes: bytes });
    });
  }

  function startGameLoop() {
    state.isPaused = false;
    state.lastFrameTime = performance.now();
    // A pause (or the time before start) is not scheduler idle (M4).
    state._lastFrameEndAt = 0;
    clearSchedulers();
    gameLoop();
  }

  self.onmessage = function (event) {
    var data = event.data;
    if (!data || !data.msg) return;
    // A dead module answers nothing that would call into it; a barrier needs no Box2D.
    if (state.box2dAborted && data.msg !== 'barrier') return;
    var t0 = state.collectDetailedStats ? performance.now() : 0;
    try {
      if (data.msg === 'init') {
        state.isPaused = true;
        initializeFromWeedInit(data);
      } else if (data.msg === 'reserveEngineBlock') {
        reserveEngineBlock(data.bytes | 0);
      } else if (data.msg === 'start') {
        startGameLoop();
      } else if (data.msg === 'pause') {
        state.isPaused = true;
        clearSchedulers();
      } else if (data.msg === 'barrier') {
        // Between steps by construction: the reply proves the world is idle.
        self.postMessage({ msg: 'barrierDone', id: data.id | 0 });
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
      // A step that aborted throws here too; the error on screen is onAbort's.
      if (!state.box2dAborted) reportError('Physics host message failed', err);
    }
    if (state.collectDetailedStats) {
      state.messageTimeThisFrame += performance.now() - t0;
    }
  };

  self.postMessage({
    msg: 'log',
    message: 'physics_host loaded',
    when: Date.now(),
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
