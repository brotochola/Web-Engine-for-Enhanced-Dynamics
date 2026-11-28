// Shared Box2D / Weed layout constants (classic globals for importScripts).
// ESM: imported as side-effect by box2dConstants.js
(function (global) {
  /**
   * Collider shape — WASM C b2_game_shape_* numbers (single source for Weed + glue).
   * Box=0, Circle=1, Polygon=2, Chain=3.
   */
  var ShapeType = Object.freeze({
    Box: 0,
    Circle: 1,
    Polygon: 2,
    Chain: 3,
    // aliases for classic glue
    BOX: 0,
    CIRCLE: 1,
    POLYGON: 2,
    CHAIN: 3,
  });

  /** Box2D body motion class (not a shape) */
  var Box2dBodyType = Object.freeze({
    STATIC: 0,
    DYNAMIC: 1,
    KINEMATIC: 2,
  });

  var META_FLAG = Object.freeze({
    STATIC: 1,
    DISABLED: 2,
  });

  var STATE_CHANNELS = Object.freeze({
    X: 0,
    Y: 1,
    ROTATION: 2,
    VX: 3,
    VY: 4,
    ANG_VEL: 5,
    ROT_C: 6,
    ROT_S: 7,
    // E-353: RigidBody.speed, sqrt(vx * vx + vy * vy), which Box2D writes with the velocities when the scene asks
    // (physics.deriveSpeed: a registered type sets deriveSpeed).
    SPEED: 8,
  });

  var STATE_CHANNEL_COUNT = 9;

  var JOINT_TYPE = Object.freeze({
    DISTANCE: 0,
    PRISMATIC: 3,
    REVOLUTE: 4,
    WELD: 5,
  });

  var JOINT_FLAG = Object.freeze({
    ACTIVE: 1,
    DISABLED: 2,
  });

  var JOINT_LAYOUT = Object.freeze({
    TYPE: 0,
    FLAGS: 1,
    AX: 2,
    AY: 3,
    BX: 4,
    BY: 5,
    ROT_C: 6,
    ROT_S: 7,
  });

  var EVENT_HEADER = Object.freeze({
    OVERLAP_COUNT: 0,
    RAY_HIT_COUNT: 1,
    CONTACT_BEGIN_COUNT: 2,
    CONTACT_END_COUNT: 3,
    CONTACT_HIT_COUNT: 4,
    SENSOR_BEGIN_COUNT: 5,
    SENSOR_END_COUNT: 6,
    MOVER_PLANE_COUNT: 7,
    CONTACT_DROPPED_COUNT: 8,
    SENSOR_DROPPED_COUNT: 9,
    JOINT_EVENT_COUNT: 10,
  });

  var DEFAULT_FILTER_MASK = 0xffffffff;

  // CR-20: the physics worker's stats slots, one table for the host, the post glue (classic scripts) and the page
  // (workersUtils.js re-exports it).
  /**
   * Physics Worker Stats Schema (Box2D)
   * Outer worker writes FPS / STEP_MS / MSG_MS; nested weedjs writes body/joint/contact counts.
   */
  var PHYSICS_STATS = Object.freeze({
    FPS: 0,
    STEP_MS: 1,
    MSG_MS: 2,
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
    /** Allocator used (kilobytes) — float32-safe vs raw bytes above 16MB. */
    HEAP_USED_KB: 23,
    /** Max HEAP_USED_KB seen this session. */
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
    /** Cumulative pose publishes skipped because pre-render still holds the slot. */
    POSE_SKIP_TOTAL: 45,
    /** Cumulative pose publish attempts (skip + success). */
    POSE_PUBLISH_TOTAL: 46,
    /** Wall ms of lfParticleSystem_Step + pose deinterleave inside step_world. */
    LIQUIDFUN_MS: 36,
    LF_PASS_GRID_MS: 37,
    LF_PASS_FIND_CONTACTS_MS: 38,
    LF_PASS_BODY_MS: 39,
    LF_PASS_WEIGHT_MS: 40,
    LF_PASS_STATIC_PRESSURE_MS: 41,
    LF_PASS_PRESSURE_MS: 42,
    LF_PASS_CONTACT_SOLVERS_MS: 43,
    LF_PASS_REST_MS: 44,
    /** Wall ms blocked on a sibling inside the step. See E-01. */
    WAIT_MS: 47,
    /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
    IDLE_MS: 48,
    /**
     * Wall ms answering sync queries between steps, since the previous frame (E-56).
     * Outside STEP_MS: a request that lands after the step's service point is
     * answered by the host's wake instead of waiting for the next frame.
     */
    QUERY_WAKE_MS: 49,
    /**
     * Box2D memory in use at its highest (kilobytes): static data, stacks and the highest heap
     * address reached (`sbrk(0)`; dlmalloc never gives memory back). This is the figure to size
     * Box2D's memory from; HEAP_USED_KB counts live bytes only.
     */
    MEMORY_PEAK_KB: 50,
    STRIDE_FLOATS: 51,
    BUFFER_SIZE: 51 * 4,
  });

  global.Box2dConstants = {
    ShapeType: ShapeType,
    Box2dBodyType: Box2dBodyType,
    META_FLAG: META_FLAG,
    STATE_CHANNELS: STATE_CHANNELS,
    STATE_CHANNEL_COUNT: STATE_CHANNEL_COUNT,
    JOINT_TYPE: JOINT_TYPE,
    JOINT_FLAG: JOINT_FLAG,
    JOINT_LAYOUT: JOINT_LAYOUT,
    EVENT_HEADER: EVENT_HEADER,
    DEFAULT_FILTER_MASK: DEFAULT_FILTER_MASK,
    PHYSICS_STATS: PHYSICS_STATS,
  };

  // Classic globals (weedjsPost / physicsApi importScripts)
  global.ShapeType = ShapeType;
  global.Box2dBodyType = Box2dBodyType;
  global.META_FLAG = META_FLAG;
  global.STATE_CHANNELS = STATE_CHANNELS;
  global.STATE_CHANNEL_COUNT = STATE_CHANNEL_COUNT;
  global.JOINT_TYPE = JOINT_TYPE;
  global.JOINT_FLAG = JOINT_FLAG;
  global.JOINT_LAYOUT = JOINT_LAYOUT;
  global.EVENT_HEADER = EVENT_HEADER;
  global.DEFAULT_FILTER_MASK = DEFAULT_FILTER_MASK;
})(typeof globalThis !== 'undefined' ? globalThis : self);
