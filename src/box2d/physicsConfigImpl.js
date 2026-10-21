// Physics config: the simulation defaults, the worker-count clamp and the
// validator. One source for the classic physics host (importScripts from
// weedjsPost.js, read from the global) and the ESM side (physicsConfig.js,
// used by configDefaults.js and utils.js). Review N-15: the host and utils.js
// each had their own copy, and they had drifted.
(function (global) {
  /** Box2D B2_MAX_WORKERS. */
  var BOX2D_MAX_WORKERS = 32;

  /**
   * What the physics worker simulates with. configDefaults.js PHYSICS_DEFAULTS
   * documents these keys and adds the engine-side ones (enabled, pools, fps).
   */
  var PHYSICS_SIM_DEFAULTS = Object.freeze({
    subStepCount: 4,
    contactHertz: 30,
    contactDampingRatio: 0.7,
    gravity: Object.freeze({ x: 0, y: 0 }),
    lengthUnitsPerMeter: 100,
    contactSpeed: 1000,
    maximumLinearSpeed: 50000,
    numberOfPhysicsWorkers: 4,
    contactRingCapacity: 65536,
    commandRingCapacity: 4096,
    sleeping: true,
    hitEventThreshold: 0,
    liquidFun: Object.freeze({
      enabled: false, // scene sets true to auto-create the system at physics init
      radius: 10, // particle radius, world px
      maxCount: 10000,
      subSteps: 1, // particle solver only; not Box2D subStepCount
      density: 1,
      // liquidfun-c / Google default is false. RemoveSpuriousBodyContacts (qsort,
      // drops floor+wall corner false-positives) only runs when this is true.
      strictContactCheck: false,
      // System def coeffs (lfParticleSystemDef). Solvers read these each step.
      dampingStrength: 1.0,
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
    }),
  });

  var warnedWorkerCountAlias = false;

  /** The first of a, b, c that is not null or undefined. */
  function pick(a, b, c) {
    return a != null ? a : b != null ? b : c;
  }

  /** v when it is a finite number, otherwise fallback. */
  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  /**
   * numberOfPhysicsWorkers, clamped to 1..B2_MAX_WORKERS. The key was
   * box2dWorkerCount before a585e598; that name still works, with a warning,
   * instead of being ignored.
   */
  function physicsWorkerCount(n, base) {
    var v = n.numberOfPhysicsWorkers;
    if (v == null && n.box2dWorkerCount != null) {
      if (!warnedWorkerCountAlias) {
        warnedWorkerCountAlias = true;
        console.warn('[weedjs-box2d] physics.box2dWorkerCount is now numberOfPhysicsWorkers');
      }
      v = n.box2dWorkerCount;
    }
    v = pick(v, base.numberOfPhysicsWorkers, PHYSICS_SIM_DEFAULTS.numberOfPhysicsWorkers) | 0;
    return v < 1 ? 1 : v > BOX2D_MAX_WORKERS ? BOX2D_MAX_WORKERS : v;
  }

  /**
   * Merge `next` over `current` (or the defaults) and clamp each value to what
   * Box2D accepts. A key missing from both falls back to the default.
   */
  function validatePhysicsConfig(current, next) {
    var d = PHYSICS_SIM_DEFAULTS;
    var base = current || d;
    var n = next || {};
    var g = n.gravity || {};
    var bg = base.gravity || d.gravity;
    return {
      subStepCount: Math.max(1, pick(n.subStepCount, base.subStepCount, d.subStepCount) | 0),
      contactHertz: Math.max(0, num(pick(n.contactHertz, base.contactHertz, d.contactHertz), d.contactHertz)),
      contactDampingRatio: Math.max(
        0,
        num(pick(n.contactDampingRatio, base.contactDampingRatio, d.contactDampingRatio), d.contactDampingRatio),
      ),
      gravity: { x: num(g.x, num(bg.x, 0)), y: num(g.y, num(bg.y, 0)) },
      lengthUnitsPerMeter: Math.max(
        1e-6,
        num(pick(n.lengthUnitsPerMeter, base.lengthUnitsPerMeter, d.lengthUnitsPerMeter), d.lengthUnitsPerMeter),
      ),
      contactSpeed: Math.max(0, num(pick(n.contactSpeed, base.contactSpeed, d.contactSpeed), d.contactSpeed)),
      maximumLinearSpeed: Math.max(
        1,
        num(pick(n.maximumLinearSpeed, base.maximumLinearSpeed, d.maximumLinearSpeed), d.maximumLinearSpeed),
      ),
      numberOfPhysicsWorkers: physicsWorkerCount(n, base),
      contactRingCapacity: Math.max(256, pick(n.contactRingCapacity, base.contactRingCapacity, d.contactRingCapacity) | 0),
      commandRingCapacity: Math.max(64, pick(n.commandRingCapacity, base.commandRingCapacity, d.commandRingCapacity) | 0),
      sleeping: !!pick(n.sleeping, base.sleeping, d.sleeping),
      hitEventThreshold: Math.max(
        0,
        num(pick(n.hitEventThreshold, base.hitEventThreshold, d.hitEventThreshold), d.hitEventThreshold),
      ),
      liquidFun: mergeLiquidFunConfig(base.liquidFun, n.liquidFun),
    };
  }

  function mergeLiquidFunConfig(currentLf, newLf) {
    var d = PHYSICS_SIM_DEFAULTS.liquidFun;
    var src = Object.assign({}, d, currentLf || {}, newLf || {});
    return {
      enabled: !!src.enabled,
      radius: Math.max(1e-6, src.radius > 0 ? src.radius : d.radius),
      maxCount: Math.min(65535, Math.max(1, pick(src.maxCount, d.maxCount) | 0)),
      subSteps: Math.max(1, pick(src.subSteps, d.subSteps) | 0),
      density: num(src.density, d.density),
      strictContactCheck: !!src.strictContactCheck,
      dampingStrength: num(src.dampingStrength, d.dampingStrength),
      pressureStrength: num(src.pressureStrength, d.pressureStrength),
      viscousStrength: num(src.viscousStrength, d.viscousStrength),
      tensileStrength: num(src.tensileStrength, d.tensileStrength),
      powderStrength: num(src.powderStrength, d.powderStrength),
      springStrength: num(src.springStrength, d.springStrength),
      staticPressureStrength: num(src.staticPressureStrength, d.staticPressureStrength),
      staticPressureRelaxation: num(src.staticPressureRelaxation, d.staticPressureRelaxation),
      staticPressureIterations: Math.max(1, pick(src.staticPressureIterations, d.staticPressureIterations) | 0),
      ejectionStrength: num(src.ejectionStrength, d.ejectionStrength),
      colorMixingStrength: num(src.colorMixingStrength, d.colorMixingStrength),
      repulsiveStrength: num(src.repulsiveStrength, d.repulsiveStrength),
    };
  }

  global.WeedPhysicsConfig = Object.freeze({
    BOX2D_MAX_WORKERS: BOX2D_MAX_WORKERS,
    PHYSICS_SIM_DEFAULTS: PHYSICS_SIM_DEFAULTS,
    physicsWorkerCount: physicsWorkerCount,
    validatePhysicsConfig: validatePhysicsConfig,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
