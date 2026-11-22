// physicsApi.js — thin ergonomic layer over wasm cwrap.
// Requires: box2dWasm.js loaded first (Module global).

function createPhysicsApi(Module) {
  // Every export takes and returns numbers, so cwrap hands back the raw export (no type lists: N-303 CR-1).
  const wrap = (name) => Module.cwrap(name);

  const createWorld = wrap("create_world");
  const worldEnableSleeping = wrap("world_enable_sleeping");
  const worldSetStepSpin = wrap("world_set_step_spin");
  const worldSetAwakeReorderInterval = wrap("world_set_awake_reorder_interval");
  const bindGameBuffers = wrap("bind_game_buffers");
  const createBodyBox = wrap("create_body_box");
  const createBodyCircle = wrap("create_body_circle");
  const createBodyPolygon = wrap("create_body_polygon");
  const createBody = wrap("create_body");
  const destroyBody = wrap("destroy_body");
  const overlapAabbIntoFn = wrap("overlap_aabb_into");
  const overlapCircleFn = wrap("overlap_circle");
  const castRayClosestFn = wrap("cast_ray_closest");
  const castRayAllFn = wrap("cast_ray_all");
  const createPrismaticJoint = wrap("create_prismatic_joint");
  const createDistanceJointLocal = wrap("create_distance_joint_local");
  const createRevoluteJointLocal = wrap("create_revolute_joint_local");
  const createWeldJointLocal = wrap("create_weld_joint_local");
  const destroyJoint = wrap("destroy_joint");
  const getJointCount = wrap("get_joint_count");
  const stepWorld = wrap("step_world");
  const collideWorld = wrap("collide_world");
  const getStateByteOffset = wrap("get_state_byte_offset");
  const getSleepingByteOffset = wrap("get_sleeping_byte_offset");
  const getMetaByteOffset = wrap("get_meta_byte_offset");
  const getStateChannelOffset = wrap("get_state_channel_offset");
  const getMetaFloatStride = wrap("get_meta_float_stride");
  const getBodyCapacity = wrap("get_body_capacity");
  const getMaxBodySlots = wrap("get_max_body_slots");
  const getSlotCount = wrap("get_slot_count");
  const getStateRegionBytes = wrap("get_state_region_bytes");
  const getMetaRegionBytes = wrap("get_meta_region_bytes");
  const getJointByteOffset = wrap("get_joint_byte_offset");
  const getJointFloatStride = wrap("get_joint_float_stride");
  const getJointRegionBytes = wrap("get_joint_region_bytes");
  const getJointCapacity = wrap("get_joint_capacity");
  const getQuerySlotsByteOffset = wrap("get_query_slots_byte_offset");
  const getQueryHitsByteOffset = wrap("get_query_hits_byte_offset");
  const getEventHeaderByteOffset = wrap("get_event_header_byte_offset");
  const getContactBeginByteOffset = wrap("get_contact_begin_byte_offset");
  const getContactEndByteOffset = wrap("get_contact_end_byte_offset");
  const getContactHitByteOffset = wrap("get_contact_hit_byte_offset");
  const getSensorBeginByteOffset = wrap("get_sensor_begin_byte_offset");
  const getSensorEndByteOffset = wrap("get_sensor_end_byte_offset");
  const getMoverPlanesByteOffset = wrap("get_mover_planes_byte_offset");
  const getQueryCapacity = wrap("get_query_capacity");
  const getRayHitCapacity = wrap("get_ray_hit_capacity");
  const getQueryHitFloatStride = wrap("get_query_hit_float_stride");
  const getContactEventCapacity = wrap("get_contact_event_capacity");
  const getSensorEventCapacity = wrap("get_sensor_event_capacity");
  const getContactHitCapacity = wrap("get_contact_hit_capacity");
  const getMoverPlaneCapacity = wrap("get_mover_plane_capacity");
  const getMoverPlaneFloatStride = wrap("get_mover_plane_float_stride");
  const getEventHeaderIntCount = wrap("get_event_header_int_count");
  const getContactPairIntStride = wrap("get_contact_pair_int_stride");
  const getBodyMoveCount = wrap("get_body_move_count");
  const getBodyMoveByteOffset = wrap("get_body_move_byte_offset");
  const getBodyFellAsleepByteOffset = wrap("get_body_fell_asleep_byte_offset");
  const getBodyMoveCapacity = wrap("get_body_move_capacity");
  const getAwakeBodyCount = wrap("get_awake_body_count");
  const getProfileByteOffset = wrap("get_profile_byte_offset");
  const getProfileFloatCount = wrap("get_profile_float_count");
  const getCountersByteOffset = wrap("get_counters_byte_offset");
  const getCountersIntCount = wrap("get_counters_int_count");
  const getJointEventsByteOffset = wrap("get_joint_events_byte_offset");
  const getJointEventCapacity = wrap("get_joint_event_capacity");
  const worldSetHitEventThreshold = wrap("world_set_hit_event_threshold");
  const worldExplode = wrap("world_explode");
  const jointConfigure = wrap("joint_configure");

  const createParticleSystem = wrap("create_particle_system");
  const destroyParticleSystem = wrap("destroy_particle_system");
  const createParticleBox = wrap("create_particle_box");
  const createParticleGroupBox = wrap("create_particle_group_box");
  const createParticleGroupCircle = wrap("create_particle_group_circle");
  const destroyParticleGroup = wrap("destroy_particle_group");
  const setParticleSubSteps = wrap("set_particle_sub_steps");
  const setParticleTuning = wrap("set_particle_tuning");
  const setGroupViscousScale = wrap("set_group_viscous_scale");
  const getParticleGroupSlotCount = wrap("get_particle_group_slot_count");
  const getParticleGroupAlive = wrap("get_particle_group_alive");
  const joinParticleGroups = wrap("join_particle_groups");
  const splitParticleGroup = wrap("split_particle_group");
  const particleApplyForce = wrap("particle_apply_force");
  const particleApplyLinearImpulse = wrap("particle_apply_linear_impulse");
  const particleGroupApplyForce = wrap("particle_group_apply_force");
  const particleGroupApplyLinearImpulse = wrap("particle_group_apply_linear_impulse");
  const particleQueryAabb = wrap("particle_query_aabb");
  const particleRayCast = wrap("particle_ray_cast");
  const getParticleQueryHitsByteOffset = wrap("get_particle_query_hits_byte_offset");
  const particleQueryHitsI32 = getParticleQueryHitsByteOffset() >> 2;
  const syncActiveParticleGroupsFn = wrap("sync_active_particle_groups");
  const getSyncParticleGroupsByteOffset = wrap("get_sync_particle_groups_byte_offset");
  const getSyncParticleGroupsMax = wrap("get_sync_particle_groups_max");
  const cullParticlesOutsideBoundsFn = wrap("cull_particles_outside_bounds");
  const getParticleWeightByteOffset = wrap("get_particle_weight_byte_offset");
  const getParticleCount = wrap("get_particle_count");
  const restoreParticlesFn = wrap("restore_particles");
  const getParticleGroupIndexByteOffset = wrap("get_particle_group_index_byte_offset");
  const getParticleRestOffsetByteOffset = wrap("get_particle_rest_offset_byte_offset");
  const getParticlePairCount = wrap("get_particle_pair_count");
  const copyParticleGroupSlots = wrap("copy_particle_group_slots");
  const copyParticlePairs = wrap("copy_particle_pairs");
  const restoreParticleGroupsAndPairsFn = wrap("restore_particle_groups_and_pairs");
  // Weed wasm glue only assigns Module.HEAP32 / HEAPF32 (not HEAPU8/U16/U32).
  const heapBuf = () => Module.HEAPF32.buffer;
  const heapU8 = () => new Uint8Array(heapBuf());
  const heapU16 = () => new Uint16Array(heapBuf());
  const heapU32 = () => new Uint32Array(heapBuf());
  const getLiquidFunStepMs = wrap("get_liquidfun_step_ms");
  const getParticleCapacity = wrap("get_particle_capacity");
  const getParticleRadius = wrap("get_particle_radius");
  const getParticleCountByteOffset = wrap("get_particle_count_byte_offset");
  const getParticleFlagsByteOffset = wrap("get_particle_flags_byte_offset");
  const getParticleXByteOffset = wrap("get_particle_x_byte_offset");
  const getParticleYByteOffset = wrap("get_particle_y_byte_offset");
  const getParticleVxByteOffset = wrap("get_particle_vx_byte_offset");
  const getParticleVyByteOffset = wrap("get_particle_vy_byte_offset");
  const getParticleAlphaByteOffset = wrap("get_particle_alpha_byte_offset");
  // N-142: each particle's index at the last reset, carried through LiquidFun's reorders, and whether one happened.
  const getParticleOriginByteOffset = wrap("get_particle_origin_byte_offset");
  const particleReorderedFn = wrap("particle_reordered");
  const resetParticleOriginsFn = wrap("reset_particle_origins");
  const getParticleUserDataByteOffset = wrap("get_particle_user_data_byte_offset");
  const getParticleColorByteOffset = wrap("get_particle_color_byte_offset");
  const getParticleViscousScaleByteOffset = wrap("get_particle_viscous_scale_byte_offset");
  const setParticleUserDataFn = wrap("set_particle_user_data");
  const setParticleUserDataRangeFn = wrap("set_particle_user_data_range");
  const setParticleColorFn = wrap("set_particle_color");
  const setParticleColorRangeFn = wrap("set_particle_color_range");
  const setParticleFlagsFn = wrap("set_particle_flags");
  const setParticleViscousScaleFn = wrap("set_particle_viscous_scale");
  const setParticleViscousScaleRangeFn = wrap("set_particle_viscous_scale_range");
  const setParticleGroupFlagsFn = wrap("set_particle_group_flags");
  const destroyParticleFn = wrap("destroy_particle");
  const createParticleFn = wrap("create_particle");
  const particleApplyForceRangeFn = wrap("particle_apply_force_range");
  const particleApplyLinearImpulseRangeFn = wrap("particle_apply_linear_impulse_range");
  const setParticleExtraTuningFn = wrap("set_particle_extra_tuning");
  const getExtractIndicesByteOffset = wrap("get_extract_indices_byte_offset");
  const getExtractIndicesMax = wrap("get_extract_indices_max");
  const extractParticlesFn = wrap("extract_particles");

  function filterArgs(filter = {}) {
    return {
      categoryBits: filter.categoryBits ?? 1,
      maskBits: filter.maskBits ?? DEFAULT_FILTER_MASK,
    };
  }

  function assertHeapInt32View(view, name = "out") {
    if (!view || view.BYTES_PER_ELEMENT !== 4) {
      throw new TypeError(`${name} must be Int32Array`);
    }
    if (view.buffer !== Module.HEAPF32.buffer) {
      throw new TypeError(
        `${name} must be a view on Module.HEAP32.buffer (use world._querySlots or createOverlapBuffer)`,
      );
    }
  }

  function bindQueryViews(world) {
    const sab = Module.HEAPF32.buffer;
    const queryCapacity = getQueryCapacity();
    const rayHitCapacity = getRayHitCapacity();
    const queryHitStride = getQueryHitFloatStride();
    const contactEventCapacity = getContactEventCapacity();
    const sensorEventCapacity = getSensorEventCapacity();
    const contactHitCapacity = getContactHitCapacity();
    const moverPlaneCapacity = getMoverPlaneCapacity();
    const moverPlaneStride = getMoverPlaneFloatStride();
    const contactPairStride = getContactPairIntStride();
    const eventHeaderCount = getEventHeaderIntCount();

    world._querySlots = new Int32Array(
      sab,
      getQuerySlotsByteOffset(),
      queryCapacity,
    );
    world._queryHits = new Float32Array(
      sab,
      getQueryHitsByteOffset(),
      rayHitCapacity * queryHitStride,
    );
    world._eventHeader = new Int32Array(
      sab,
      getEventHeaderByteOffset(),
      eventHeaderCount,
    );
    world._contactBegin = new Int32Array(
      sab,
      getContactBeginByteOffset(),
      contactEventCapacity * contactPairStride,
    );
    world._contactEnd = new Int32Array(
      sab,
      getContactEndByteOffset(),
      contactEventCapacity * contactPairStride,
    );
    world._contactHit = new Float32Array(
      sab,
      getContactHitByteOffset(),
      contactHitCapacity * queryHitStride,
    );
    world._sensorBegin = new Int32Array(
      sab,
      getSensorBeginByteOffset(),
      sensorEventCapacity * contactPairStride,
    );
    world._sensorEnd = new Int32Array(
      sab,
      getSensorEndByteOffset(),
      sensorEventCapacity * contactPairStride,
    );
    world._moverPlanes = new Float32Array(
      sab,
      getMoverPlanesByteOffset(),
      moverPlaneCapacity * moverPlaneStride,
    );
    const bodyMoveCapacity = getBodyMoveCapacity();
    world._bodyMoved = new Int32Array(
      sab,
      getBodyMoveByteOffset(),
      bodyMoveCapacity,
    );
    world._bodyFellAsleep = new Uint8Array(
      sab,
      getBodyFellAsleepByteOffset(),
      bodyMoveCapacity,
    );
    world._getBodyMoveCount = getBodyMoveCount;
    world._getAwakeBodyCount = getAwakeBodyCount;
    const profileFloats = getProfileFloatCount();
    world._profile = new Float32Array(
      sab,
      getProfileByteOffset(),
      profileFloats,
    );
    const counterInts = getCountersIntCount();
    world._counters = new Int32Array(
      sab,
      getCountersByteOffset(),
      counterInts,
    );
    // Stashed so callers can decode world._contactHit / _queryHits without re-querying WASM.
    world._contactHitStride = queryHitStride;
    world._queryHitStride = queryHitStride;
    world._jointEvents = new Int32Array(
      sab,
      getJointEventsByteOffset(),
      getJointEventCapacity(),
    );
  }

  class JointHandle {
    constructor(world, handle) {
      this._world = world;
      this.handle = handle;
    }

    destroy() {
      this._world.destroyJoint(this.handle);
    }

    /**
     * Wire break thresholds + weed joint index (read back from joint events after step).
     * @param {number} userDataInt - weed Joint pool index
     * @param {number} [forceThreshold=Infinity]
     * @param {number} [torqueThreshold=Infinity]
     */
    configure(userDataInt, forceThreshold = Infinity, torqueThreshold = Infinity) {
      jointConfigure(this.handle, userDataInt, forceThreshold, torqueThreshold);
    }
  }

  class PhysicsWorld {
    constructor(gravityX = 0.0, gravityY = -9.8, options = {}) {
      const o = options || {};
      this.worldId = createWorld(
        gravityX,
        gravityY,
        o.lengthUnitsPerMeter ?? 1,
        o.contactHertz ?? 30,
        o.contactDampingRatio ?? 10,
        o.contactSpeed ?? 3,
        o.maximumLinearSpeed ?? 400,
        o.numberOfPhysicsWorkers ?? 4,
      );
      this._buffersBound = false;
    }

    enableSleeping(enable = true) {
      worldEnableSleeping(this.worldId, enable ? 1 : 0);
    }

    /** E-298: Box2D's pool threads spin through a step (true) or sleep between its phases (false). */
    setStepSpin(enable) {
      worldSetStepSpin(this.worldId, enable ? 1 : 0);
    }

    /**
     * E-322: every `steps` steps (0: never), at the start of the step, Box2D puts the awake bodies back in body id
     * order and each constraint color's contacts in body order. Results are bit for bit the same.
     */
    setAwakeReorderInterval(steps) {
      worldSetAwakeReorderInterval(this.worldId, steps | 0);
    }

    /**
     * Box2D's tables for the scene (wasm_wrapper.c bind_game_buffers): a body slot per entity (maxBodies) and a joint
     * handle per joint (maxJoints, physics.maxJoints; 0: no joint can be made). N-253, N-310.
     */
    bindBuffers(maxBodies, maxJoints = 0) {
      const maxSlots = getMaxBodySlots();
      if (maxBodies <= 0 || maxBodies > maxSlots) {
        throw new Error(
          `bindBuffers failed: maxBodies ${maxBodies} out of range (1..${maxSlots})`,
        );
      }
      if (!(maxJoints >= 0)) {
        throw new Error(`bindBuffers failed: maxJoints ${maxJoints} is not a count`);
      }
      this._buffersBound = bindGameBuffers(maxBodies, maxJoints) === 1;
      if (!this._buffersBound) {
        throw new Error(
          `bindBuffers failed: Box2D refused ${maxBodies} bodies and ${maxJoints} joints (rebuild box2dWasm after source changes)`,
        );
      }
      bindQueryViews(this);
      return this;
    }

    getMaxBodySlots() {
      return getMaxBodySlots();
    }

    destroyBody(slot) {
      destroyBody(slot);
    }

    overlapAABB(x0, y0, x1, y1, out, filter = {}) {
      assertHeapInt32View(out);
      const f = filterArgs(filter);
      return overlapAabbIntoFn(
        this.worldId,
        x0,
        y0,
        x1,
        y1,
        f.categoryBits,
        f.maskBits,
        out.byteOffset,
        out.length,
      );
    }

    overlapCircle(cx, cy, radius, filter = {}) {
      const f = filterArgs(filter);
      return overlapCircleFn(
        this.worldId,
        cx,
        cy,
        radius,
        f.categoryBits,
        f.maskBits,
      );
    }

    castRayClosest(ox, oy, dx, dy, filter = {}) {
      const f = filterArgs(filter);
      return this.castRayClosestBits(
        ox,
        oy,
        dx,
        dy,
        f.categoryBits,
        f.maskBits,
      );
    }

    castRayClosestBits(ox, oy, dx, dy, categoryBits, maskBits) {
      return castRayClosestFn(
        this.worldId,
        ox,
        oy,
        dx,
        dy,
        categoryBits,
        maskBits,
      );
    }

    castRayAll(ox, oy, dx, dy, filter = {}) {
      const f = filterArgs(filter);
      return castRayAllFn(
        this.worldId,
        ox,
        oy,
        dx,
        dy,
        f.categoryBits,
        f.maskBits,
      );
    }

    createPrismaticJoint(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createPrismaticJoint requires bodyA and bodyB");
      }

      const maxForce = options.maxMotorForce !== undefined ? options.maxMotorForce : (options.maxMotorTorque ?? 0);
      const handle = createPrismaticJoint(
        this.worldId,
        slotA,
        slotB,
        options.anchorX ?? 0,
        options.anchorY ?? 0,
        options.axisAngle ?? 0,
        options.enableLimit ? 1 : 0,
        options.lowerTranslation ?? 0,
        options.upperTranslation ?? 0,
        options.enableMotor ? 1 : 0,
        options.motorSpeed ?? 0,
        maxForce,
      );
      if (handle < 0) {
        throw new Error("createPrismaticJoint failed");
      }
      return new JointHandle(this, handle);
    }

    /**
     * Local-anchor prismatic. WASM only has a world-anchor create, so this
     * turns body A's pose plus localAnchorA into that anchor and adds A's
     * rotation to axisAngle. Body pose defaults to the origin.
     */
    createPrismaticJointLocal(options = {}) {
      const ax = options.localAnchorAX ?? 0;
      const ay = options.localAnchorAY ?? 0;
      const c = options.bodyRotC ?? 1;
      const s = options.bodyRotS ?? 0;
      const bx = options.bodyX ?? 0;
      const by = options.bodyY ?? 0;
      const anchorX = bx + ax * c - ay * s;
      const anchorY = by + ax * s + ay * c;
      let axis = options.axisAngle ?? 0;
      if (s !== 0 || c !== 1) axis += Math.atan2(s, c);
      return this.createPrismaticJoint({
        bodyA: options.bodyA,
        bodyB: options.bodyB,
        anchorX,
        anchorY,
        axisAngle: axis,
        enableLimit: options.enableLimit,
        lowerTranslation: options.lowerTranslation,
        upperTranslation: options.upperTranslation,
        enableMotor: options.enableMotor,
        motorSpeed: options.motorSpeed,
        maxMotorForce: options.maxMotorForce,
        maxMotorTorque: options.maxMotorTorque,
      });
    }

    createDistanceJointLocal(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createDistanceJointLocal requires bodyA and bodyB");
      }

      let length = options.length ?? 1;
      if (!(length > 0) || length !== length) length = 1;
      const handle = createDistanceJointLocal(
        this.worldId,
        slotA,
        slotB,
        options.localAnchorAX ?? 0,
        options.localAnchorAY ?? 0,
        options.localAnchorBX ?? 0,
        options.localAnchorBY ?? 0,
        length,
        options.enableSpring ? 1 : 0,
        options.hertz ?? 1,
        options.dampingRatio ?? 0.7,
      );
      if (handle < 0) {
        throw new Error(
          handle === -2
            ? "createDistanceJointLocal failed (WASM joint table full)"
            : "createDistanceJointLocal failed (null body or Box2D reject)",
        );
      }
      return new JointHandle(this, handle);
    }

    createRevoluteJointLocal(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createRevoluteJointLocal requires bodyA and bodyB");
      }

      const handle = createRevoluteJointLocal(
        this.worldId,
        slotA,
        slotB,
        options.localAnchorAX ?? 0,
        options.localAnchorAY ?? 0,
        options.localAnchorBX ?? 0,
        options.localAnchorBY ?? 0,
        options.enableLimit ? 1 : 0,
        options.lowerAngle ?? 0,
        options.upperAngle ?? 0,
        options.enableMotor ? 1 : 0,
        options.motorSpeed ?? 0,
        options.maxMotorTorque ?? 0,
      );
      if (handle < 0) {
        throw new Error("createRevoluteJointLocal failed");
      }
      return new JointHandle(this, handle);
    }

    createWeldJointLocal(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createWeldJointLocal requires bodyA and bodyB");
      }

      const handle = createWeldJointLocal(
        this.worldId,
        slotA,
        slotB,
        options.localAnchorAX ?? 0,
        options.localAnchorAY ?? 0,
        options.localAnchorBX ?? 0,
        options.localAnchorBY ?? 0,
        options.linearHertz ?? 0,
        options.angularHertz ?? 0,
        options.linearDampingRatio ?? 1,
        options.angularDampingRatio ?? 1,
      );
      if (handle < 0) {
        throw new Error("createWeldJointLocal failed");
      }
      return new JointHandle(this, handle);
    }

    destroyJoint(handle) {
      destroyJoint(handle);
    }

    getJointCount() {
      return getJointCount();
    }

    setHitEventThreshold(value) {
      worldSetHitEventThreshold(this.worldId, value);
    }

    explode(x, y, radius, falloff, impulsePerLength, maskBits = DEFAULT_FILTER_MASK) {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(radius) ||
        !(radius > 0) ||
        !Number.isFinite(falloff) ||
        !Number.isFinite(impulsePerLength)
      ) {
        return;
      }
      worldExplode(
        this.worldId,
        x,
        y,
        radius,
        falloff,
        impulsePerLength,
        maskBits >>> 0,
        0,
      );
    }

    step(dt, subSteps = 2) {
      stepWorld(this.worldId, dt, subSteps);
    }

    /**
     * SST-15's prime: a step's pair update, narrow phase and sensors with no solver and no time (wasm_wrapper.c
     * collide_world), so the next step finds the contacts of the bodies made so far. Its contact and sensor events are
     * in the event buffers as after a step; poses, velocities, moved bodies and the sleep paint are left as they were.
     */
    collide() {
      collideWorld(this.worldId);
    }

    getSharedBuffer() {
      return Module.HEAPF32.buffer;
    }

    getReadyPayload() {
      const stateByteOffset = getStateByteOffset();
      const metaByteOffset = getMetaByteOffset();
      const stateBaseIndex = stateByteOffset >> 2;
      const channelCount = typeof STATE_CHANNEL_COUNT === "number" ? STATE_CHANNEL_COUNT : 8;
      const channelOffsets = [];
      for (let channel = 0; channel < channelCount; channel++) {
        channelOffsets.push(
          stateBaseIndex + getStateChannelOffset(channel),
        );
      }
      // E-327: the rotation stamps publishPose reads (0 from a module without them: every rotation copied).
      const stamps = typeof Module._get_rotation_stamp_count === "function";

      return {
        sab: Module.HEAPF32.buffer,
        bodyCount: getSlotCount(),
        bodyCapacity: getBodyCapacity(),
        channelOffsets,
        sleepingByteOffset: getSleepingByteOffset(),
        rotationStampsByteOffset: stamps ? Module._get_rotation_stamps_byte_offset() : 0,
        rotationStampCount: stamps ? Module._get_rotation_stamp_count() : 0,
        rotationEpochByteOffset: stamps ? Module._get_rotation_epoch_byte_offset() : 0,
        rotationBlockShift: stamps ? Module._get_rotation_block_shift() : 6,
        metaBaseIndex: metaByteOffset >> 2,
        metaStride: getMetaFloatStride(),
        stateByteOffset,
        stateRegionBytes: getStateRegionBytes(),
        metaRegionBytes: getMetaRegionBytes(),
        jointCount: getJointCount(),
        jointBaseIndex: getJointByteOffset() >> 2,
        jointStride: getJointFloatStride(),
        jointCapacity: getJointCapacity(),
        jointRegionBytes: getJointRegionBytes(),
        querySlotsBaseIndex: getQuerySlotsByteOffset() >> 2,
        queryHitsBaseIndex: getQueryHitsByteOffset() >> 2,
        eventHeaderBaseIndex: getEventHeaderByteOffset() >> 2,
        contactBeginBaseIndex: getContactBeginByteOffset() >> 2,
        contactEndBaseIndex: getContactEndByteOffset() >> 2,
        contactHitBaseIndex: getContactHitByteOffset() >> 2,
        sensorBeginBaseIndex: getSensorBeginByteOffset() >> 2,
        sensorEndBaseIndex: getSensorEndByteOffset() >> 2,
        moverPlanesBaseIndex: getMoverPlanesByteOffset() >> 2,
        queryCapacity: getQueryCapacity(),
        rayHitCapacity: getRayHitCapacity(),
        queryHitStride: getQueryHitFloatStride(),
        contactEventCapacity: getContactEventCapacity(),
        sensorEventCapacity: getSensorEventCapacity(),
        contactHitCapacity: getContactHitCapacity(),
        moverPlaneCapacity: getMoverPlaneCapacity(),
        moverPlaneStride: getMoverPlaneFloatStride(),
        eventHeaderIntCount: getEventHeaderIntCount(),
        contactPairIntStride: getContactPairIntStride(),
        bodyMoveBaseIndex: getBodyMoveByteOffset() >> 2,
        bodyFellAsleepByteOffset: getBodyFellAsleepByteOffset(),
        bodyMoveCapacity: getBodyMoveCapacity(),
        jointEventsBaseIndex: getJointEventsByteOffset() >> 2,
        jointEventCapacity: getJointEventCapacity(),
      };
    }

    createParticleSystem(radius = 10, maxCount = 10000, density = 1.0, subSteps = 1, strictContactCheck = false) {
      this._particleSystem = createParticleSystem(this.worldId, radius, density, maxCount, strictContactCheck ? 1 : 0);
      if (subSteps > 0) setParticleSubSteps(subSteps);
      return this._particleSystem;
    }

    destroyParticleSystem() {
      destroyParticleSystem();
      this._particleSystem = null;
    }

    createParticleBox(posX, posY, halfWidth, halfHeight, spacing = 0, flags = 0) {
      if (!this._particleSystem) this.createParticleSystem();
      return createParticleBox(
        posX - halfWidth,
        posY - halfHeight,
        posX + halfWidth,
        posY + halfHeight,
        spacing,
        flags >>> 0,
      );
    }

    createParticleGroupBox(
      posX,
      posY,
      halfWidth,
      halfHeight,
      spacing = 0,
      flags = 0,
      strength = 0.5,
      lifetimeMin = 0,
      lifetimeMax = 0,
      fadeToAlpha0 = 0,
      viscousScale = 1,
      trackGroup = 0,
      groupFlags = 0,
      vx = 0,
      vy = 0,
      omega = 0,
      userData = 0,
      color = 0,
    ) {
      if (!this._particleSystem) this.createParticleSystem();
      return createParticleGroupBox(
        posX - halfWidth,
        posY - halfHeight,
        posX + halfWidth,
        posY + halfHeight,
        spacing,
        flags >>> 0,
        strength,
        lifetimeMin,
        lifetimeMax,
        fadeToAlpha0 ? 1 : 0,
        viscousScale > 0 ? viscousScale : 1,
        trackGroup ? 1 : 0,
        groupFlags >>> 0,
        vx || 0,
        vy || 0,
        omega || 0,
        userData >>> 0,
        color >>> 0,
      );
    }

    createParticleGroupCircle(
      posX,
      posY,
      radius,
      spacing = 0,
      flags = 0,
      strength = 0.5,
      lifetimeMin = 0,
      lifetimeMax = 0,
      fadeToAlpha0 = 0,
      viscousScale = 1,
      trackGroup = 0,
      groupFlags = 0,
      vx = 0,
      vy = 0,
      omega = 0,
      userData = 0,
      color = 0,
    ) {
      if (!this._particleSystem) this.createParticleSystem();
      return createParticleGroupCircle(
        posX,
        posY,
        radius,
        spacing,
        flags >>> 0,
        strength,
        lifetimeMin,
        lifetimeMax,
        fadeToAlpha0 ? 1 : 0,
        viscousScale > 0 ? viscousScale : 1,
        trackGroup ? 1 : 0,
        groupFlags >>> 0,
        vx || 0,
        vy || 0,
        omega || 0,
        userData >>> 0,
        color >>> 0,
      );
    }

    destroyParticleGroup(groupId) {
      destroyParticleGroup(groupId);
    }

    setParticleTuning(tuning) {
      const t = tuning || {};
      setParticleTuning(
        t.dampingStrength != null ? t.dampingStrength : 1,
        t.pressureStrength != null ? t.pressureStrength : 0.05,
        t.viscousStrength != null ? t.viscousStrength : 0.25,
        t.tensileStrength != null ? t.tensileStrength : 0.2,
        t.powderStrength != null ? t.powderStrength : 0.5,
        t.springStrength != null ? t.springStrength : 0.25,
        t.staticPressureStrength != null ? t.staticPressureStrength : 0.2,
        t.staticPressureRelaxation != null ? t.staticPressureRelaxation : 0.2,
        t.staticPressureIterations != null ? t.staticPressureIterations | 0 : 8,
      );
      setParticleExtraTuningFn(
        t.ejectionStrength != null ? t.ejectionStrength : 0.5,
        t.colorMixingStrength != null ? t.colorMixingStrength : 0.5,
        t.repulsiveStrength != null ? t.repulsiveStrength : 1,
      );
    }

    setGroupViscousScale(groupId, scale) {
      setGroupViscousScale(groupId | 0, scale > 0 ? scale : 1);
    }

    getParticleGroupSlotCount() {
      return getParticleGroupSlotCount();
    }

    getParticleGroupAlive(groupId) {
      return getParticleGroupAlive(groupId | 0) | 0;
    }

    joinParticleGroups(groupA, groupB) {
      joinParticleGroups(groupA | 0, groupB | 0);
    }

    splitParticleGroup(groupId) {
      splitParticleGroup(groupId | 0);
    }

    particleApplyForce(index, fx, fy) {
      particleApplyForce(index | 0, fx, fy);
    }

    particleApplyLinearImpulse(index, ix, iy) {
      particleApplyLinearImpulse(index | 0, ix, iy);
    }

    particleGroupApplyForce(groupId, fx, fy) {
      particleGroupApplyForce(groupId | 0, fx, fy);
    }

    particleGroupApplyLinearImpulse(groupId, ix, iy) {
      particleGroupApplyLinearImpulse(groupId | 0, ix, iy);
    }

    /** Fill Int32Array results without allocating; returns the hit count (the WASM stops at 4096). */
    fillParticleQueryAabb(x0, y0, x1, y1, results, cap) {
      const n = particleQueryAabb(x0, y0, x1, y1) | 0;
      const write = n < cap ? n : cap | 0;
      if (write > 0) {
        results.set(Module.HEAP32.subarray(particleQueryHitsI32, particleQueryHitsI32 + write));
      }
      return n;
    }

    fillParticleRayCast(x1, y1, x2, y2, results, cap) {
      const n = particleRayCast(x1, y1, x2, y2) | 0;
      const write = n < cap ? n : cap | 0;
      if (write > 0) {
        results.set(Module.HEAP32.subarray(particleQueryHitsI32, particleQueryHitsI32 + write));
      }
      return n;
    }

    getParticleWeightByteOffset() {
      return getParticleWeightByteOffset();
    }

    getParticleCount() {
      return getParticleCount();
    }

    /**
     * Replace all particles with a SoA snapshot (ungrouped).
     * @param {number} count
     * @param {Float32Array} x length count
     * @param {Float32Array} y length count
     * @param {Float32Array} vx length count
     * @param {Float32Array} vy length count
     * @param {Uint32Array} flags length count
     * @returns {number} restored count, or negative error
     * @param {Uint32Array} [userData]
     * @param {Uint32Array} [color]
     */
    restoreParticles(count, x, y, vx, vy, flags, userData, color) {
      const n = count | 0;
      if (n < 0) return -2;
      if (n === 0) {
        const empty = Module._malloc(4);
        const r = restoreParticlesFn(0, empty, empty, empty, empty, empty, 0, 0);
        Module._free(empty);
        return r;
      }
      const fBytes = n * 4;
      const xPtr = Module._malloc(fBytes);
      const yPtr = Module._malloc(fBytes);
      const vxPtr = Module._malloc(fBytes);
      const vyPtr = Module._malloc(fBytes);
      const flagsPtr = Module._malloc(fBytes);
      let userPtr = 0;
      let colorPtr = 0;
      Module.HEAPF32.set(x.subarray(0, n), xPtr >> 2);
      Module.HEAPF32.set(y.subarray(0, n), yPtr >> 2);
      Module.HEAPF32.set(vx.subarray(0, n), vxPtr >> 2);
      Module.HEAPF32.set(vy.subarray(0, n), vyPtr >> 2);
      heapU32().set(flags.subarray(0, n), flagsPtr >> 2);
      if (userData) {
        userPtr = Module._malloc(fBytes);
        heapU32().set(userData.subarray(0, n), userPtr >> 2);
      }
      if (color) {
        colorPtr = Module._malloc(fBytes);
        heapU32().set(color.subarray(0, n), colorPtr >> 2);
      }
      const r = restoreParticlesFn(n, xPtr, yPtr, vxPtr, vyPtr, flagsPtr, userPtr, colorPtr);
      Module._free(xPtr);
      Module._free(yPtr);
      Module._free(vxPtr);
      Module._free(vyPtr);
      Module._free(flagsPtr);
      if (userPtr) Module._free(userPtr);
      if (colorPtr) Module._free(colorPtr);
      return r;
    }

    /**
     * Snapshot particle HEAP SoA for save games (includes groups + pairs when present).
     * @returns {object|null}
     */
    snapshotParticles() {
      const count = getParticleCount() | 0;
      const radius = getParticleRadius();
      const maxCount = getParticleCapacity() | 0;
      if (count <= 0) {
        return {
          count: 0,
          radius,
          maxCount,
          x: new Float32Array(0),
          y: new Float32Array(0),
          vx: new Float32Array(0),
          vy: new Float32Array(0),
          flags: new Uint32Array(0),
          userData: new Uint32Array(0),
          color: new Uint32Array(0),
          groupIndex: new Int32Array(0),
          restOffset: new Float32Array(0),
          groups: null,
          pairs: null,
        };
      }
      const xOff = getParticleXByteOffset() | 0;
      const yOff = getParticleYByteOffset() | 0;
      const vxOff = getParticleVxByteOffset() | 0;
      const vyOff = getParticleVyByteOffset() | 0;
      const flagsOff = getParticleFlagsByteOffset() | 0;
      if (!xOff || !yOff || !vxOff || !vyOff || !flagsOff) return null;
      const buf = heapBuf();
      const x = new Float32Array(new Float32Array(buf, xOff, count));
      const y = new Float32Array(new Float32Array(buf, yOff, count));
      const vx = new Float32Array(new Float32Array(buf, vxOff, count));
      const vy = new Float32Array(new Float32Array(buf, vyOff, count));
      const flags = new Uint32Array(new Uint32Array(buf, flagsOff, count));
      let userData = new Uint32Array(count);
      let color = new Uint32Array(count);
      const udOff = getParticleUserDataByteOffset() | 0;
      const colOff = getParticleColorByteOffset() | 0;
      if (udOff) userData = new Uint32Array(new Uint32Array(buf, udOff, count));
      if (colOff) color = new Uint32Array(new Uint32Array(buf, colOff, count));

      let groupIndex = new Int32Array(count);
      let restOffset = new Float32Array(count * 2);
      const giOff = getParticleGroupIndexByteOffset() | 0;
      const roOff = getParticleRestOffsetByteOffset() | 0;
      if (giOff) {
        groupIndex = new Int32Array(new Int32Array(buf, giOff, count));
      } else {
        groupIndex.fill(-1);
      }
      if (roOff) {
        restOffset = new Float32Array(new Float32Array(buf, roOff, count * 2));
      }

      let groups = null;
      const slotCount = copyParticleGroupSlots(0, 0, 0, 0, 0, 0, 0, 0) | 0;
      if (slotCount > 0) {
        const alive = new Uint8Array(slotCount);
        const gFlags = new Uint32Array(slotCount);
        const gGroupFlags = new Uint32Array(slotCount);
        const strength = new Float32Array(slotCount);
        const viscousScale = new Float32Array(slotCount);
        const firstIndex = new Int32Array(slotCount);
        const lastIndex = new Int32Array(slotCount);
        const aPtr = Module._malloc(slotCount);
        const fPtr = Module._malloc(slotCount * 4);
        const gfPtr = Module._malloc(slotCount * 4);
        const sPtr = Module._malloc(slotCount * 4);
        const vsPtr = Module._malloc(slotCount * 4);
        const fiPtr = Module._malloc(slotCount * 4);
        const liPtr = Module._malloc(slotCount * 4);
        copyParticleGroupSlots(aPtr, fPtr, gfPtr, sPtr, vsPtr, fiPtr, liPtr, slotCount);
        const u8 = heapU8();
        const u32 = heapU32();
        alive.set(u8.subarray(aPtr, aPtr + slotCount));
        gFlags.set(u32.subarray(fPtr >> 2, (fPtr >> 2) + slotCount));
        gGroupFlags.set(u32.subarray(gfPtr >> 2, (gfPtr >> 2) + slotCount));
        strength.set(Module.HEAPF32.subarray(sPtr >> 2, (sPtr >> 2) + slotCount));
        viscousScale.set(Module.HEAPF32.subarray(vsPtr >> 2, (vsPtr >> 2) + slotCount));
        firstIndex.set(Module.HEAP32.subarray(fiPtr >> 2, (fiPtr >> 2) + slotCount));
        lastIndex.set(Module.HEAP32.subarray(liPtr >> 2, (liPtr >> 2) + slotCount));
        Module._free(aPtr);
        Module._free(fPtr);
        Module._free(gfPtr);
        Module._free(sPtr);
        Module._free(vsPtr);
        Module._free(fiPtr);
        Module._free(liPtr);
        groups = { slotCount, alive, flags: gFlags, groupFlags: gGroupFlags, strength, viscousScale, firstIndex, lastIndex };
      }

      let pairs = null;
      const pairCount = getParticlePairCount() | 0;
      if (pairCount > 0) {
        const a = new Uint16Array(pairCount);
        const b = new Uint16Array(pairCount);
        const pFlags = new Uint32Array(pairCount);
        const distance = new Float32Array(pairCount);
        const pStrength = new Float32Array(pairCount);
        const aPtr = Module._malloc(pairCount * 2);
        const bPtr = Module._malloc(pairCount * 2);
        const fPtr = Module._malloc(pairCount * 4);
        const dPtr = Module._malloc(pairCount * 4);
        const sPtr = Module._malloc(pairCount * 4);
        copyParticlePairs(aPtr, bPtr, fPtr, dPtr, sPtr, pairCount);
        const u16 = heapU16();
        const u32 = heapU32();
        a.set(u16.subarray(aPtr >> 1, (aPtr >> 1) + pairCount));
        b.set(u16.subarray(bPtr >> 1, (bPtr >> 1) + pairCount));
        pFlags.set(u32.subarray(fPtr >> 2, (fPtr >> 2) + pairCount));
        distance.set(Module.HEAPF32.subarray(dPtr >> 2, (dPtr >> 2) + pairCount));
        pStrength.set(Module.HEAPF32.subarray(sPtr >> 2, (sPtr >> 2) + pairCount));
        Module._free(aPtr);
        Module._free(bPtr);
        Module._free(fPtr);
        Module._free(dPtr);
        Module._free(sPtr);
        pairs = { count: pairCount, a, b, flags: pFlags, distance, strength: pStrength };
      }

      return {
        count,
        radius,
        maxCount,
        x,
        y,
        vx,
        vy,
        flags,
        userData,
        color,
        groupIndex,
        restOffset,
        groups,
        pairs,
      };
    }

    /**
     * Restore groups + elastic restOffset + spring/barrier pairs after restoreParticles.
     * @returns {number} 0 ok, negative error
     */
    restoreParticleGroupsAndPairs(payload) {
      if (!payload) return 0;
      const n = getParticleCount() | 0;
      const groupIndex = payload.groupIndex instanceof Int32Array ? payload.groupIndex : new Int32Array(payload.groupIndex || []);
      const restOffset = payload.restOffset instanceof Float32Array ? payload.restOffset : new Float32Array(payload.restOffset || []);
      const groups = payload.groups || null;
      const pairs = payload.pairs || null;
      const slotCount = groups ? (groups.slotCount | 0) : 0;
      const pairCount = pairs ? (pairs.count | 0) : 0;

      if (n > 0 && (groupIndex.length < n || restOffset.length < n * 2)) {
        return -4;
      }

      let giPtr = 0;
      let roPtr = 0;
      let alivePtr = 0;
      let flagsPtr = 0;
      let gFlagsPtr = 0;
      let strengthPtr = 0;
      let vsPtr = 0;
      let fiPtr = 0;
      let liPtr = 0;
      let aPtr = 0;
      let bPtr = 0;
      let pfPtr = 0;
      let distPtr = 0;
      let psPtr = 0;

      try {
        if (n > 0) {
          giPtr = Module._malloc(n * 4);
          roPtr = Module._malloc(n * 2 * 4);
          Module.HEAP32.set(groupIndex.subarray(0, n), giPtr >> 2);
          Module.HEAPF32.set(restOffset.subarray(0, n * 2), roPtr >> 2);
        }
        if (slotCount > 0) {
          alivePtr = Module._malloc(slotCount);
          flagsPtr = Module._malloc(slotCount * 4);
          gFlagsPtr = Module._malloc(slotCount * 4);
          strengthPtr = Module._malloc(slotCount * 4);
          vsPtr = Module._malloc(slotCount * 4);
          fiPtr = Module._malloc(slotCount * 4);
          liPtr = Module._malloc(slotCount * 4);
          heapU8().set(groups.alive.subarray(0, slotCount), alivePtr);
          heapU32().set(groups.flags.subarray(0, slotCount), flagsPtr >> 2);
          heapU32().set(groups.groupFlags.subarray(0, slotCount), gFlagsPtr >> 2);
          Module.HEAPF32.set(groups.strength.subarray(0, slotCount), strengthPtr >> 2);
          Module.HEAPF32.set(groups.viscousScale.subarray(0, slotCount), vsPtr >> 2);
          Module.HEAP32.set(groups.firstIndex.subarray(0, slotCount), fiPtr >> 2);
          Module.HEAP32.set(groups.lastIndex.subarray(0, slotCount), liPtr >> 2);
        }
        if (pairCount > 0) {
          aPtr = Module._malloc(pairCount * 2);
          bPtr = Module._malloc(pairCount * 2);
          pfPtr = Module._malloc(pairCount * 4);
          distPtr = Module._malloc(pairCount * 4);
          psPtr = Module._malloc(pairCount * 4);
          heapU16().set(pairs.a.subarray(0, pairCount), aPtr >> 1);
          heapU16().set(pairs.b.subarray(0, pairCount), bPtr >> 1);
          heapU32().set(pairs.flags.subarray(0, pairCount), pfPtr >> 2);
          Module.HEAPF32.set(pairs.distance.subarray(0, pairCount), distPtr >> 2);
          Module.HEAPF32.set(pairs.strength.subarray(0, pairCount), psPtr >> 2);
        }

        return restoreParticleGroupsAndPairsFn(
          giPtr,
          roPtr,
          slotCount,
          alivePtr,
          flagsPtr,
          gFlagsPtr,
          strengthPtr,
          vsPtr,
          fiPtr,
          liPtr,
          pairCount,
          aPtr,
          bPtr,
          pfPtr,
          distPtr,
          psPtr
        );
      } finally {
        if (giPtr) Module._free(giPtr);
        if (roPtr) Module._free(roPtr);
        if (alivePtr) Module._free(alivePtr);
        if (flagsPtr) Module._free(flagsPtr);
        if (gFlagsPtr) Module._free(gFlagsPtr);
        if (strengthPtr) Module._free(strengthPtr);
        if (vsPtr) Module._free(vsPtr);
        if (fiPtr) Module._free(fiPtr);
        if (liPtr) Module._free(liPtr);
        if (aPtr) Module._free(aPtr);
        if (bPtr) Module._free(bPtr);
        if (pfPtr) Module._free(pfPtr);
        if (distPtr) Module._free(distPtr);
        if (psPtr) Module._free(psPtr);
      }
    }

    getLiquidFunStepMs() {
      return getLiquidFunStepMs();
    }

    getParticleCountByteOffset() {
      return getParticleCountByteOffset();
    }

    getParticleFlagsByteOffset() {
      return getParticleFlagsByteOffset();
    }

    getParticleXByteOffset() {
      return getParticleXByteOffset();
    }

    getParticleYByteOffset() {
      return getParticleYByteOffset();
    }

    getParticleVxByteOffset() {
      return getParticleVxByteOffset();
    }

    getParticleVyByteOffset() {
      return getParticleVyByteOffset();
    }

    getParticleAlphaByteOffset() {
      return getParticleAlphaByteOffset();
    }

    /** N-142: the byte offset of each particle's origin index (its index at the last resetParticleOrigins), 0 without. */
    getParticleOriginByteOffset() {
      return getParticleOriginByteOffset();
    }

    /** N-142: whether a reorder (a compaction, a join, an extraction, a split) moved particles since the last reset. */
    particleReordered() {
      return particleReorderedFn() | 0;
    }

    /** N-142: every origin its own index again, the reorder flag cleared. */
    resetParticleOrigins() {
      resetParticleOriginsFn();
    }

    getParticleUserDataByteOffset() {
      return getParticleUserDataByteOffset();
    }

    getParticleColorByteOffset() {
      return getParticleColorByteOffset();
    }

    getParticleViscousScaleByteOffset() {
      return getParticleViscousScaleByteOffset();
    }

    getParticleGroupIndexByteOffset() {
      return getParticleGroupIndexByteOffset();
    }

    setParticleUserData(index, bits) {
      setParticleUserDataFn(index | 0, bits >>> 0);
    }

    setParticleUserDataRange(first, last, bits) {
      setParticleUserDataRangeFn(first | 0, last | 0, bits >>> 0);
    }

    setParticleColor(index, rgba) {
      setParticleColorFn(index | 0, rgba >>> 0);
    }

    setParticleColorRange(first, last, rgba) {
      setParticleColorRangeFn(first | 0, last | 0, rgba >>> 0);
    }

    setParticleFlags(index, flags) {
      setParticleFlagsFn(index | 0, flags >>> 0);
    }

    setParticleViscousScale(index, scale) {
      setParticleViscousScaleFn(index | 0, scale);
    }

    setParticleViscousScaleRange(first, last, scale) {
      setParticleViscousScaleRangeFn(first | 0, last | 0, scale);
    }

    setParticleGroupFlags(groupId, flags) {
      setParticleGroupFlagsFn(groupId | 0, flags >>> 0);
    }

    destroyParticle(index) {
      destroyParticleFn(index | 0);
    }

    createParticle(x, y, vx, vy, flags, userData, color) {
      return createParticleFn(x, y, vx || 0, vy || 0, flags >>> 0, userData >>> 0, color >>> 0);
    }

    particleApplyForceRange(first, last, fx, fy) {
      particleApplyForceRangeFn(first | 0, last | 0, fx, fy);
    }

    particleApplyLinearImpulseRange(first, last, ix, iy) {
      particleApplyLinearImpulseRangeFn(first | 0, last | 0, ix, iy);
    }

    extractParticles(groupId, count, groupFlags, trackGroup) {
      return extractParticlesFn(groupId | 0, count | 0, groupFlags >>> 0, trackGroup ? 1 : 0);
    }

    fillExtractIndices(indices, count) {
      const n = count | 0;
      if (n <= 0) return;
      const cap = getExtractIndicesMax() | 0;
      const write = n < cap ? n : cap;
      const off = getExtractIndicesByteOffset() | 0;
      if (!off) return;
      const base = off >> 2;
      const heap = Module.HEAP32;
      for (let i = 0; i < write; i++) heap[base + i] = indices[i] | 0;
    }

    syncActiveParticleGroups(maxGroups) {
      return syncActiveParticleGroupsFn(maxGroups | 0) | 0;
    }

    getSyncParticleGroupsByteOffset() {
      return getSyncParticleGroupsByteOffset();
    }

    getSyncParticleGroupsMax() {
      return getSyncParticleGroupsMax();
    }

    cullParticlesOutsideBounds(xMin, yMin, xMax, yMax) {
      cullParticlesOutsideBoundsFn(xMin, yMin, xMax, yMax);
    }

  }

  // The raw creators, for the engine's own body sync (weedjsPost.js createBodyForEntity): one call
  // with the numbers, no option objects, spread copies or handle per body (E-91).
  const bodyCreators = { createBody, createBodyBox, createBodyCircle, createBodyPolygon };
  return { PhysicsWorld, JointHandle, bodyCreators };
}
