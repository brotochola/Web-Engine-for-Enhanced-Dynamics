// Shared Box2D / Weed layout constants (classic globals for importScripts).
// ESM: imported as side-effect by box2dConstants.js
(function (global) {
  /**
   * Collider shape — WASM C b2_game_shape_* numbers (single source for Weed + glue).
   * Box=0, Circle=1, Polygon=2.
   */
  var ShapeType = Object.freeze({
    Box: 0,
    Circle: 1,
    Polygon: 2,
    // aliases for classic glue
    BOX: 0,
    CIRCLE: 1,
    POLYGON: 2,
  });

  /** Box2D body motion class (not a shape) */
  var Box2dBodyType = Object.freeze({
    STATIC: 0,
    DYNAMIC: 1,
    KINEMATIC: 2,
  });

  /** @deprecated use Box2dBodyType */
  var BODY_TYPE = Box2dBodyType;

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
  });

  var STATE_CHANNEL_COUNT = 8;

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

  global.Box2dConstants = {
    ShapeType: ShapeType,
    Box2dBodyType: Box2dBodyType,
    BODY_TYPE: BODY_TYPE,
    META_FLAG: META_FLAG,
    STATE_CHANNELS: STATE_CHANNELS,
    STATE_CHANNEL_COUNT: STATE_CHANNEL_COUNT,
    JOINT_TYPE: JOINT_TYPE,
    JOINT_FLAG: JOINT_FLAG,
    JOINT_LAYOUT: JOINT_LAYOUT,
    EVENT_HEADER: EVENT_HEADER,
    DEFAULT_FILTER_MASK: DEFAULT_FILTER_MASK,
  };

  // Classic globals (weedjs_post / physics-api importScripts)
  global.ShapeType = ShapeType;
  global.Box2dBodyType = Box2dBodyType;
  global.BODY_TYPE = BODY_TYPE;
  global.META_FLAG = META_FLAG;
  global.STATE_CHANNELS = STATE_CHANNELS;
  global.STATE_CHANNEL_COUNT = STATE_CHANNEL_COUNT;
  global.JOINT_TYPE = JOINT_TYPE;
  global.JOINT_FLAG = JOINT_FLAG;
  global.JOINT_LAYOUT = JOINT_LAYOUT;
  global.EVENT_HEADER = EVENT_HEADER;
  global.DEFAULT_FILTER_MASK = DEFAULT_FILTER_MASK;
})(typeof globalThis !== 'undefined' ? globalThis : self);
