// physics-api.js — thin ergonomic layer over wasm cwrap.
// Requires: box2d_wasm.js loaded first (Module global).

function createPhysicsApi(Module) {
  const wrap = (name, ret, args) => Module.cwrap(name, ret, args);

  const createWorld = wrap("create_world", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const worldEnableSleeping = wrap("world_enable_sleeping", null, [
    "number",
    "number",
  ]);
  const bindGameBuffers = wrap("bind_game_buffers", "number", ["number"]);
  const createBodyBox = wrap("create_body_box", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createBodyCircle = wrap("create_body_circle", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createBodyPolygon = wrap("create_body_polygon", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createBody = wrap("create_body", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyAddShapeBox = wrap("body_add_shape_box", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyAddShapeCircle = wrap("body_add_shape_circle", null, [
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyAddShapePolygon = wrap("body_add_shape_polygon", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyClearShapes = wrap("body_clear_shapes", null, ["number"]);
  const destroyBody = wrap("destroy_body", null, ["number"]);
  const bodySetTransform = wrap("body_set_transform", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodySetLinearVelocity = wrap("body_set_linear_velocity", null, [
    "number",
    "number",
    "number",
  ]);
  const bodySetAngularVelocity = wrap("body_set_angular_velocity", null, [
    "number",
    "number",
  ]);
  const bodySetFixedRotation = wrap("body_set_fixed_rotation", null, [
    "number",
    "number",
  ]);
  const bodyApplyForce = wrap("body_apply_force", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyApplyForceCenter = wrap("body_apply_force_center", null, [
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodySetLinearDamping = wrap("body_set_linear_damping", null, [
    "number",
    "number",
  ]);
  const bodySetAngularDamping = wrap("body_set_angular_damping", null, [
    "number",
    "number",
  ]);
  const bodySetGravityScale = wrap("body_set_gravity_scale", null, [
    "number",
    "number",
  ]);
  const bodyApplyLinearImpulse = wrap("body_apply_linear_impulse", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const bodyApplyLinearImpulseCenter = wrap(
    "body_apply_linear_impulse_center",
    null,
    ["number", "number", "number", "number"],
  );
  const bodyApplyAngularImpulse = wrap("body_apply_angular_impulse", null, [
    "number",
    "number",
    "number",
  ]);
  const bodyApplyTorque = wrap("body_apply_torque", null, [
    "number",
    "number",
    "number",
  ]);
  const bodySetAwake = wrap("body_set_awake", null, ["number", "number"]);
  const bodySetFilter = wrap("body_set_filter", null, [
    "number",
    "number",
    "number",
    "number",
  ]);
  const overlapAabbIntoFn = wrap("overlap_aabb_into", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const overlapCircleFn = wrap("overlap_circle", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const overlapBoxFn = wrap("overlap_box", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const castRayClosestFn = wrap("cast_ray_closest", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const castRayAllFn = wrap("cast_ray_all", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const castMoverFn = wrap("cast_mover", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const collideMoverFn = wrap("collide_mover", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createRevoluteJoint = wrap("create_revolute_joint", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createDistanceJoint = wrap("create_distance_joint", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createPrismaticJoint = wrap("create_prismatic_joint", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createWeldJoint = wrap("create_weld_joint", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createDistanceJointLocal = wrap("create_distance_joint_local", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createRevoluteJointLocal = wrap("create_revolute_joint_local", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createWeldJointLocal = wrap("create_weld_joint_local", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const destroyJoint = wrap("destroy_joint", null, ["number"]);
  const getJointCount = wrap("get_joint_count", "number", []);
  const stepWorld = wrap("step_world", null, ["number", "number", "number"]);
  const getStateByteOffset = wrap("get_state_byte_offset", "number", []);
  const getSleepingByteOffset = wrap("get_sleeping_byte_offset", "number", []);
  const getMetaByteOffset = wrap("get_meta_byte_offset", "number", []);
  const getStateChannelOffset = wrap("get_state_channel_offset", "number", [
    "number",
  ]);
  const getMetaFloatStride = wrap("get_meta_float_stride", "number", []);
  const getBodyCapacity = wrap("get_body_capacity", "number", []);
  const getMaxBodySlots = wrap("get_max_body_slots", "number", []);
  const getSlotCount = wrap("get_slot_count", "number", []);
  const getStateRegionBytes = wrap("get_state_region_bytes", "number", []);
  const getMetaRegionBytes = wrap("get_meta_region_bytes", "number", []);
  const getJointByteOffset = wrap("get_joint_byte_offset", "number", []);
  const getJointFloatStride = wrap("get_joint_float_stride", "number", []);
  const getJointRegionBytes = wrap("get_joint_region_bytes", "number", []);
  const getJointCapacity = wrap("get_joint_capacity", "number", []);
  const getQuerySlotsByteOffset = wrap("get_query_slots_byte_offset", "number", []);
  const getQueryHitsByteOffset = wrap("get_query_hits_byte_offset", "number", []);
  const getEventHeaderByteOffset = wrap("get_event_header_byte_offset", "number", []);
  const getContactBeginByteOffset = wrap("get_contact_begin_byte_offset", "number", []);
  const getContactEndByteOffset = wrap("get_contact_end_byte_offset", "number", []);
  const getContactHitByteOffset = wrap("get_contact_hit_byte_offset", "number", []);
  const getSensorBeginByteOffset = wrap("get_sensor_begin_byte_offset", "number", []);
  const getSensorEndByteOffset = wrap("get_sensor_end_byte_offset", "number", []);
  const getMoverPlanesByteOffset = wrap("get_mover_planes_byte_offset", "number", []);
  const getQueryCapacity = wrap("get_query_capacity", "number", []);
  const getRayHitCapacity = wrap("get_ray_hit_capacity", "number", []);
  const getQueryHitFloatStride = wrap("get_query_hit_float_stride", "number", []);
  const getContactEventCapacity = wrap("get_contact_event_capacity", "number", []);
  const getSensorEventCapacity = wrap("get_sensor_event_capacity", "number", []);
  const getContactHitCapacity = wrap("get_contact_hit_capacity", "number", []);
  const getMoverPlaneCapacity = wrap("get_mover_plane_capacity", "number", []);
  const getMoverPlaneFloatStride = wrap("get_mover_plane_float_stride", "number", []);
  const getEventHeaderIntCount = wrap("get_event_header_int_count", "number", []);
  const getContactPairIntStride = wrap("get_contact_pair_int_stride", "number", []);
  const getBodyMoveCount = wrap("get_body_move_count", "number", []);
  const getBodyMoveByteOffset = wrap("get_body_move_byte_offset", "number", []);
  const getBodyFellAsleepByteOffset = wrap(
    "get_body_fell_asleep_byte_offset",
    "number",
    [],
  );
  const getBodyMoveCapacity = wrap("get_body_move_capacity", "number", []);
  const getAwakeBodyCount = wrap("get_awake_body_count", "number", ["number"]);
  const getProfileByteOffset = wrap("get_profile_byte_offset", "number", []);
  const getProfileFloatCount = wrap("get_profile_float_count", "number", []);
  const getCountersByteOffset = wrap("get_counters_byte_offset", "number", []);
  const getCountersIntCount = wrap("get_counters_int_count", "number", []);
  const getJointEventsByteOffset = wrap(
    "get_joint_events_byte_offset",
    "number",
    [],
  );
  const getJointEventCapacity = wrap("get_joint_event_capacity", "number", []);
  const bodySetRestitution = wrap("body_set_restitution", null, [
    "number",
    "number",
  ]);
  const bodySetSleepThreshold = wrap("body_set_sleep_threshold", null, [
    "number",
    "number",
  ]);
  const worldSetHitEventThreshold = wrap(
    "world_set_hit_event_threshold",
    null,
    ["number", "number"],
  );
  const worldExplode = wrap("world_explode", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const jointConfigure = wrap("joint_configure", null, [
    "number",
    "number",
    "number",
    "number",
  ]);

  const createParticleSystem = wrap("create_particle_system", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const destroyParticleSystem = wrap("destroy_particle_system", null, []);
  const createParticleBox = wrap("create_particle_box", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createParticleGroupBox = wrap("create_particle_group_box", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const createParticleGroupCircle = wrap("create_particle_group_circle", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const destroyParticleGroup = wrap("destroy_particle_group", null, [
    "number",
  ]);
  const setParticleSubSteps = wrap("set_particle_sub_steps", null, [
    "number",
  ]);
  const setParticleTuning = wrap("set_particle_tuning", null, [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const setGroupViscousScale = wrap("set_group_viscous_scale", null, [
    "number",
    "number",
  ]);
  const getParticleGroupSlotCount = wrap("get_particle_group_slot_count", "number", []);
  const getParticleGroupAlive = wrap("get_particle_group_alive", "number", ["number"]);
  const getParticleGroupParticleCount = wrap("get_particle_group_particle_count", "number", [
    "number",
  ]);
  const getParticleGroupCenterX = wrap("get_particle_group_center_x", "number", ["number"]);
  const getParticleGroupCenterY = wrap("get_particle_group_center_y", "number", ["number"]);
  const getParticleGroupVx = wrap("get_particle_group_vx", "number", ["number"]);
  const getParticleGroupVy = wrap("get_particle_group_vy", "number", ["number"]);
  const getParticleGroupAngularVelocity = wrap("get_particle_group_angular_velocity", "number", [
    "number",
  ]);
  const getParticleGroupAngle = wrap("get_particle_group_angle", "number", ["number"]);
  const getParticleGroupViscousScale = wrap("get_particle_group_viscous_scale", "number", [
    "number",
  ]);
  const getParticleGroupFirstIndex = wrap("get_particle_group_first_index", "number", ["number"]);
  const getParticleGroupLastIndex = wrap("get_particle_group_last_index", "number", ["number"]);
  const getParticleGroupFlags = wrap("get_particle_group_flags", "number", ["number"]);
  const joinParticleGroups = wrap("join_particle_groups", null, ["number", "number"]);
  const splitParticleGroup = wrap("split_particle_group", null, ["number"]);
  const particleApplyForce = wrap("particle_apply_force", null, ["number", "number", "number"]);
  const particleApplyLinearImpulse = wrap("particle_apply_linear_impulse", null, [
    "number",
    "number",
    "number",
  ]);
  const particleGroupApplyForce = wrap("particle_group_apply_force", null, [
    "number",
    "number",
    "number",
  ]);
  const particleGroupApplyLinearImpulse = wrap("particle_group_apply_linear_impulse", null, [
    "number",
    "number",
    "number",
  ]);
  const particleQueryAabb = wrap("particle_query_aabb", "number", [
    "number",
    "number",
    "number",
    "number",
  ]);
  const particleRayCast = wrap("particle_ray_cast", "number", [
    "number",
    "number",
    "number",
    "number",
  ]);
  const getParticleQueryHitsByteOffset = wrap(
    "get_particle_query_hits_byte_offset",
    "number",
    [],
  );
  const particleQueryHitsI32 = getParticleQueryHitsByteOffset() >> 2;
  const syncActiveParticleGroupsFn = wrap("sync_active_particle_groups", "number", [
    "number",
  ]);
  const getSyncParticleGroupsByteOffset = wrap(
    "get_sync_particle_groups_byte_offset",
    "number",
    [],
  );
  const getSyncParticleGroupsMax = wrap("get_sync_particle_groups_max", "number", []);
  const cullParticlesOutsideBoundsFn = wrap("cull_particles_outside_bounds", null, [
    "number",
    "number",
    "number",
    "number",
  ]);
  const getParticleWeightByteOffset = wrap("get_particle_weight_byte_offset", "number", []);
  const getParticleCount = wrap("get_particle_count", "number", []);
  const restoreParticlesFn = wrap("restore_particles", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const getParticleGroupIndexByteOffset = wrap("get_particle_group_index_byte_offset", "number", []);
  const getParticleRestOffsetByteOffset = wrap("get_particle_rest_offset_byte_offset", "number", []);
  const getParticlePairCount = wrap("get_particle_pair_count", "number", []);
  const copyParticleGroupSlots = wrap("copy_particle_group_slots", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const copyParticlePairs = wrap("copy_particle_pairs", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  const restoreParticleGroupsAndPairsFn = wrap("restore_particle_groups_and_pairs", "number", [
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
    "number",
  ]);
  // Weed wasm glue only assigns Module.HEAP32 / HEAPF32 (not HEAPU8/U16/U32).
  const heapBuf = () => Module.HEAPF32.buffer;
  const heapU8 = () => new Uint8Array(heapBuf());
  const heapU16 = () => new Uint16Array(heapBuf());
  const heapU32 = () => new Uint32Array(heapBuf());
  const getLiquidFunStepMs = wrap("get_liquidfun_step_ms", "number", []);
  const getParticleCapacity = wrap("get_particle_capacity", "number", []);
  const getParticleRadius = wrap("get_particle_radius", "number", []);
  const getParticleCountByteOffset = wrap("get_particle_count_byte_offset", "number", []);
  const getParticlePosByteOffset = wrap("get_particle_pos_byte_offset", "number", []);
  const getParticleVelByteOffset = wrap("get_particle_vel_byte_offset", "number", []);
  const getParticleFlagsByteOffset = wrap("get_particle_flags_byte_offset", "number", []);
  const getParticleXByteOffset = wrap("get_particle_x_byte_offset", "number", []);
  const getParticleYByteOffset = wrap("get_particle_y_byte_offset", "number", []);
  const getParticleVxByteOffset = wrap("get_particle_vx_byte_offset", "number", []);
  const getParticleVyByteOffset = wrap("get_particle_vy_byte_offset", "number", []);
  const getParticleAlphaByteOffset = wrap("get_particle_alpha_byte_offset", "number", []);
  const DEFAULT_MATERIAL = Object.freeze({
    density: 1.0,
    friction: 0.3,
    restitution: 0.0,
    linearDamping: 0.0,
    angularDamping: 0.0,
    gravityScale: 1.0,
    vx: 0.0,
    vy: 0.0,
    angularVelocity: 0.0,
    isSensor: false,
    enableHitEvents: false,
    categoryBits: 1,
    maskBits: DEFAULT_FILTER_MASK,
  });

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
    // Stashed so callers can decode world._contactHit records without re-querying WASM.
    world._contactHitStride = queryHitStride;
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

  class BodyHandle {
    constructor(world, slot) {
      this._world = world;
      this.slot = slot;
    }

    destroy() {
      this._world.destroyBody(this.slot);
    }

    setTransform(x, y, rotC = 1, rotS = 0) {
      bodySetTransform(this.slot, x, y, rotC, rotS);
    }

    setLinearVelocity(vx, vy) {
      bodySetLinearVelocity(this.slot, vx, vy);
    }

    setAngularVelocity(angularVelocity) {
      bodySetAngularVelocity(this.slot, angularVelocity);
    }

    setFixedRotation(locked = true) {
      bodySetFixedRotation(this.slot, locked ? 1 : 0);
    }

    applyForce(fx, fy, px, py, wake = true) {
      bodyApplyForce(this.slot, fx, fy, px, py, wake ? 1 : 0);
    }

    applyForceCenter(fx, fy, wake = true) {
      bodyApplyForceCenter(this.slot, fx, fy, wake ? 1 : 0);
    }

    applyLinearImpulse(ix, iy, px, py, wake = true) {
      bodyApplyLinearImpulse(this.slot, ix, iy, px, py, wake ? 1 : 0);
    }

    applyLinearImpulseCenter(ix, iy, wake = true) {
      bodyApplyLinearImpulseCenter(this.slot, ix, iy, wake ? 1 : 0);
    }

    applyAngularImpulse(impulse, wake = true) {
      bodyApplyAngularImpulse(this.slot, impulse, wake ? 1 : 0);
    }

    applyTorque(torque, wake = true) {
      bodyApplyTorque(this.slot, torque, wake ? 1 : 0);
    }

    setAwake(awake = true) {
      bodySetAwake(this.slot, awake ? 1 : 0);
    }

    setFilter(categoryBits, maskBits = DEFAULT_FILTER_MASK, groupIndex = 0) {
      bodySetFilter(this.slot, categoryBits, maskBits, groupIndex);
    }

    setLinearDamping(damping) {
      bodySetLinearDamping(this.slot, damping);
    }

    setAngularDamping(damping) {
      bodySetAngularDamping(this.slot, damping);
    }

    setGravityScale(scale) {
      bodySetGravityScale(this.slot, scale);
    }

    setRestitution(value) {
      bodySetRestitution(this.slot, value);
    }

    setSleepThreshold(value) {
      bodySetSleepThreshold(this.slot, value);
    }

    addShapeBox(hx, hy, offsetX = 0, offsetY = 0) {
      bodyAddShapeBox(this.slot, hx, hy, offsetX, offsetY);
    }

    addShapeCircle(radius, offsetX = 0, offsetY = 0) {
      bodyAddShapeCircle(this.slot, radius, offsetX, offsetY);
    }

    addShapePolygon(verts, offsetX = 0, offsetY = 0) {
      if (!Array.isArray(verts) || verts.length < 6 || verts.length % 2 !== 0) {
        throw new Error("addShapePolygon requires verts as [x0,y0,...] length >= 6");
      }
      const vertCount = verts.length / 2;
      const bytes = vertCount * 2 * 4;
      const ptr = Module._malloc(bytes);
      Module.HEAPF32.set(verts, ptr >> 2);
      try {
        bodyAddShapePolygon(this.slot, ptr, vertCount, offsetX, offsetY);
      } finally {
        Module._free(ptr);
      }
    }

    clearShapes() {
      bodyClearShapes(this.slot);
    }
  }

  class PhysicsWorld {
    static BODY_TYPE = typeof Box2dBodyType !== 'undefined' ? Box2dBodyType : BODY_TYPE;
    static Box2dBodyType = typeof Box2dBodyType !== 'undefined' ? Box2dBodyType : BODY_TYPE;
    static ShapeType = ShapeType;
    static DEFAULT_MATERIAL = DEFAULT_MATERIAL;
    static EVENT_HEADER = EVENT_HEADER;

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
        o.box2dWorkerCount ?? 4,
      );
      this._buffersBound = false;
    }

    enableSleeping(enable = true) {
      worldEnableSleeping(this.worldId, enable ? 1 : 0);
    }

    bindBuffers(maxBodies) {
      const maxSlots = getMaxBodySlots();
      if (maxBodies <= 0 || maxBodies > maxSlots) {
        throw new Error(
          `bindBuffers failed: maxBodies ${maxBodies} out of range (1..${maxSlots})`,
        );
      }
      this._buffersBound = bindGameBuffers(maxBodies) === 1;
      if (!this._buffersBound) {
        throw new Error(
          `bindBuffers failed: WASM malloc for ${maxBodies} bodies (rebuild box2d_wasm after source changes)`,
        );
      }
      bindQueryViews(this);
      return this;
    }

    getMaxBodySlots() {
      return getMaxBodySlots();
    }

    /** Shapeless body (RigidBody-only). No contacts until addShape*. */
    create(options = {}) {
      const o = { ...DEFAULT_MATERIAL, ...options };
      const slot = createBody(
        this.worldId,
        o.type ?? BODY_TYPE.DYNAMIC,
        o.x ?? 0,
        o.y ?? 0,
        o.angle ?? 0,
        o.linearDamping,
        o.angularDamping,
        o.gravityScale,
        o.vx,
        o.vy,
        o.angularVelocity,
        o.fixedRotation ? 1 : 0,
        o.entity ?? o.entityIndex ?? -1,
      );
      if (slot < 0) {
        throw new Error("create failed");
      }
      return new BodyHandle(this, slot);
    }

    createBox(options = {}) {
      const o = { ...DEFAULT_MATERIAL, ...options };
      const slot = createBodyBox(
        this.worldId,
        o.type ?? BODY_TYPE.DYNAMIC,
        o.x ?? 0,
        o.y ?? 0,
        o.angle ?? 0,
        o.hx ?? 0.5,
        o.hy ?? 0.5,
        o.offsetX ?? 0,
        o.offsetY ?? 0,
        o.density,
        o.friction,
        o.restitution,
        o.linearDamping,
        o.angularDamping,
        o.gravityScale,
        o.vx,
        o.vy,
        o.angularVelocity,
        o.isSensor ? 1 : 0,
        o.enableHitEvents ? 1 : 0,
        o.categoryBits,
        o.maskBits,
        o.groupIndex ?? 0,
        o.fixedRotation ? 1 : 0,
        o.entity ?? o.entityIndex ?? -1,
      );
      if (slot < 0) {
        throw new Error("createBox failed");
      }
      return new BodyHandle(this, slot);
    }

    createCircle(options = {}) {
      const o = { ...DEFAULT_MATERIAL, ...options };
      const slot = createBodyCircle(
        this.worldId,
        o.type ?? BODY_TYPE.DYNAMIC,
        o.x ?? 0,
        o.y ?? 0,
        o.angle ?? 0,
        o.radius ?? 0.5,
        o.offsetX ?? 0,
        o.offsetY ?? 0,
        o.density,
        o.friction,
        o.restitution,
        o.linearDamping,
        o.angularDamping,
        o.gravityScale,
        o.vx,
        o.vy,
        o.angularVelocity,
        o.isSensor ? 1 : 0,
        o.enableHitEvents ? 1 : 0,
        o.categoryBits,
        o.maskBits,
        o.groupIndex ?? 0,
        o.fixedRotation ? 1 : 0,
        o.entity ?? o.entityIndex ?? -1,
      );
      if (slot < 0) {
        throw new Error("createCircle failed");
      }
      return new BodyHandle(this, slot);
    }

    createPolygon(options = {}) {
      const o = { ...DEFAULT_MATERIAL, ...options };
      const verts = o.verts ?? o.vertices;
      if (!Array.isArray(verts) || verts.length < 6 || verts.length % 2 !== 0) {
        throw new Error("createPolygon requires verts as [x0,y0,x1,y1,...] length >= 6");
      }
      const vertCount = verts.length / 2;
      const bytes = vertCount * 2 * 4;
      const ptr = Module._malloc(bytes);
      Module.HEAPF32.set(verts, ptr >> 2);
      const slot = createBodyPolygon(
        this.worldId,
        o.type ?? BODY_TYPE.DYNAMIC,
        o.x ?? 0,
        o.y ?? 0,
        o.angle ?? 0,
        ptr,
        vertCount,
        o.offsetX ?? 0,
        o.offsetY ?? 0,
        o.density,
        o.friction,
        o.restitution,
        o.linearDamping,
        o.angularDamping,
        o.gravityScale,
        o.vx,
        o.vy,
        o.angularVelocity,
        o.isSensor ? 1 : 0,
        o.enableHitEvents ? 1 : 0,
        o.categoryBits,
        o.maskBits,
        o.groupIndex ?? 0,
        o.fixedRotation ? 1 : 0,
        o.entity ?? o.entityIndex ?? -1,
      );
      Module._free(ptr);
      if (slot < 0) {
        throw new Error("createPolygon failed");
      }
      return new BodyHandle(this, slot);
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

    createOverlapBuffer(capacity = getQueryCapacity()) {
      const ptr = Module._malloc(capacity * 4);
      return {
        view: Module.HEAP32.subarray(ptr >> 2, (ptr >> 2) + capacity),
        free: () => Module._free(ptr),
      };
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

    overlapBox(cx, cy, hx, hy, angle, filter = {}) {
      const f = filterArgs(filter);
      return overlapBoxFn(
        this.worldId,
        cx,
        cy,
        hx,
        hy,
        angle,
        f.categoryBits,
        f.maskBits,
      );
    }

    castRayClosest(ox, oy, dx, dy, filter = {}) {
      const f = filterArgs(filter);
      return castRayClosestFn(
        this.worldId,
        ox,
        oy,
        dx,
        dy,
        f.categoryBits,
        f.maskBits,
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

    castMover(cx, cy, halfHeight, radius, dx, dy, filter = {}) {
      const f = filterArgs(filter);
      return castMoverFn(
        this.worldId,
        cx,
        cy,
        halfHeight,
        radius,
        dx,
        dy,
        f.categoryBits,
        f.maskBits,
      );
    }

    collideMover(cx, cy, halfHeight, radius, filter = {}) {
      const f = filterArgs(filter);
      return collideMoverFn(
        this.worldId,
        cx,
        cy,
        halfHeight,
        radius,
        f.categoryBits,
        f.maskBits,
      );
    }

    createRevoluteJoint(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createRevoluteJoint requires bodyA and bodyB");
      }

      const handle = createRevoluteJoint(
        this.worldId,
        slotA,
        slotB,
        options.anchorX ?? 0,
        options.anchorY ?? 0,
        options.enableLimit ? 1 : 0,
        options.lowerAngle ?? 0,
        options.upperAngle ?? 0,
        options.enableMotor ? 1 : 0,
        options.motorSpeed ?? 0,
        options.maxMotorTorque ?? 0,
      );
      if (handle < 0) {
        throw new Error("createRevoluteJoint failed");
      }
      return new JointHandle(this, handle);
    }

    createDistanceJoint(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createDistanceJoint requires bodyA and bodyB");
      }

      const handle = createDistanceJoint(
        this.worldId,
        slotA,
        slotB,
        options.anchorX ?? 0,
        options.anchorY ?? 0,
        options.length ?? 1,
        options.enableSpring ? 1 : 0,
        options.hertz ?? 1,
        options.dampingRatio ?? 0.7,
      );
      if (handle < 0) {
        throw new Error("createDistanceJoint failed");
      }
      return new JointHandle(this, handle);
    }

    createPrismaticJoint(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createPrismaticJoint requires bodyA and bodyB");
      }

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
        options.maxMotorForce ?? 0,
      );
      if (handle < 0) {
        throw new Error("createPrismaticJoint failed");
      }
      return new JointHandle(this, handle);
    }

    createWeldJoint(options = {}) {
      const slotA = options.bodyA?.slot;
      const slotB = options.bodyB?.slot;
      if (slotA === undefined || slotB === undefined) {
        throw new Error("createWeldJoint requires bodyA and bodyB");
      }

      const handle = createWeldJoint(
        this.worldId,
        slotA,
        slotB,
        options.anchorX ?? 0,
        options.anchorY ?? 0,
        options.linearHertz ?? 0,
        options.angularHertz ?? 0,
        options.linearDampingRatio ?? 1,
        options.angularDampingRatio ?? 1,
      );
      if (handle < 0) {
        throw new Error("createWeldJoint failed");
      }
      return new JointHandle(this, handle);
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

    getSlotCount() {
      return getSlotCount();
    }

    setHitEventThreshold(value) {
      worldSetHitEventThreshold(this.worldId, value);
    }

    explode(x, y, radius, falloff, impulsePerLength, maskBits = DEFAULT_FILTER_MASK) {
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

    configureJoint(handle, userDataInt, forceThreshold, torqueThreshold) {
      jointConfigure(handle, userDataInt, forceThreshold, torqueThreshold);
    }

    step(dt, subSteps = 2) {
      stepWorld(this.worldId, dt, subSteps);
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

      return {
        sab: Module.HEAPF32.buffer,
        bodyCount: getSlotCount(),
        bodyCapacity: getBodyCapacity(),
        channelOffsets,
        sleepingByteOffset: getSleepingByteOffset(),
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
      );
    }

    destroyParticleGroup(groupId) {
      destroyParticleGroup(groupId);
    }

    setParticleSubSteps(steps) {
      setParticleSubSteps(steps);
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

    getParticleGroupParticleCount(groupId) {
      return getParticleGroupParticleCount(groupId | 0) | 0;
    }

    getParticleGroupCenterX(groupId) {
      return getParticleGroupCenterX(groupId | 0);
    }

    getParticleGroupCenterY(groupId) {
      return getParticleGroupCenterY(groupId | 0);
    }

    getParticleGroupVx(groupId) {
      return getParticleGroupVx(groupId | 0);
    }

    getParticleGroupVy(groupId) {
      return getParticleGroupVy(groupId | 0);
    }

    getParticleGroupAngularVelocity(groupId) {
      return getParticleGroupAngularVelocity(groupId | 0);
    }

    getParticleGroupAngle(groupId) {
      return getParticleGroupAngle(groupId | 0);
    }

    getParticleGroupViscousScale(groupId) {
      return getParticleGroupViscousScale(groupId | 0);
    }

    getParticleGroupFirstIndex(groupId) {
      return getParticleGroupFirstIndex(groupId | 0) | 0;
    }

    getParticleGroupLastIndex(groupId) {
      return getParticleGroupLastIndex(groupId | 0) | 0;
    }

    getParticleGroupFlags(groupId) {
      return getParticleGroupFlags(groupId | 0) >>> 0;
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

    particleQueryAabb(x0, y0, x1, y1) {
      const n = particleQueryAabb(x0, y0, x1, y1) | 0;
      if (n <= 0) return [];
      return Array.from(Module.HEAP32.subarray(particleQueryHitsI32, particleQueryHitsI32 + n));
    }

    particleRayCast(x1, y1, x2, y2) {
      const n = particleRayCast(x1, y1, x2, y2) | 0;
      if (n <= 0) return [];
      return Array.from(Module.HEAP32.subarray(particleQueryHitsI32, particleQueryHitsI32 + n));
    }

    /** Fill Int32Array results without allocating; returns full hit count. */
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
     */
    restoreParticles(count, x, y, vx, vy, flags) {
      const n = count | 0;
      if (n < 0) return -2;
      if (n === 0) {
        const empty = Module._malloc(4);
        const r = restoreParticlesFn(0, empty, empty, empty, empty, empty);
        Module._free(empty);
        return r;
      }
      const fBytes = n * 4;
      const xPtr = Module._malloc(fBytes);
      const yPtr = Module._malloc(fBytes);
      const vxPtr = Module._malloc(fBytes);
      const vyPtr = Module._malloc(fBytes);
      const flagsPtr = Module._malloc(fBytes);
      Module.HEAPF32.set(x.subarray(0, n), xPtr >> 2);
      Module.HEAPF32.set(y.subarray(0, n), yPtr >> 2);
      Module.HEAPF32.set(vx.subarray(0, n), vxPtr >> 2);
      Module.HEAPF32.set(vy.subarray(0, n), vyPtr >> 2);
      heapU32().set(flags.subarray(0, n), flagsPtr >> 2);
      const r = restoreParticlesFn(n, xPtr, yPtr, vxPtr, vyPtr, flagsPtr);
      Module._free(xPtr);
      Module._free(yPtr);
      Module._free(vxPtr);
      Module._free(vyPtr);
      Module._free(flagsPtr);
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

    getParticleCapacity() {
      return getParticleCapacity();
    }

    getParticleRadius() {
      return getParticleRadius();
    }

    getParticleCountByteOffset() {
      return getParticleCountByteOffset();
    }

    getParticlePosByteOffset() {
      return getParticlePosByteOffset();
    }

    getParticleVelByteOffset() {
      return getParticleVelByteOffset();
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

  return { PhysicsWorld, BodyHandle, JointHandle };
}
