self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel and friction from GameObject arrays
// Supports Circle and AABB (Box) colliders

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { Constraint } from '../core/Constraint.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import { PHYSICS_DEFAULTS } from '../core/ConfigDefaults.js';
import { PHYSICS_STATS, createStatsWriter } from './workers-utils.js';
import {
  clamp01,
  validatePhysicsConfig,
  closestPointOnAABB,
  testCircleCircleCollision,
  testCircleAABBCollision,
  testAABBAABBCollision,
} from '../core/utils.js';
import { rng } from '../core/utils.js';
import { Camera } from '../core/Camera.js';
// Note: Game-specific scripts are loaded dynamically by AbstractWorker
// Physics worker uses RigidBody component for physics calculations

// Shape type constants (must match Collider.shapeType values)
const SHAPE_CIRCLE = 0;
const SHAPE_BOX = 1;
const MIN_CONSTRAINT_DIST_SQ = 0.0001 * 0.0001;
const CONSTRAINT_ERROR_EPSILON = 0.001;

/**
 * PhysicsWorker - Handles physics integration for all entities
 * Integrates acceleration -> velocity -> position
 * Extends AbstractWorker for common worker functionality
 */
class PhysicsWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Physics worker doesn't create GameObject instances (but has access to all components)
    this.needsGameScripts = false;
    this.rigidBodyCount = 0

    // Runtime physics settings (will be filled from Scene config)
    this.settings = null;

    // Collision data buffer for Unity-style callbacks
    this.collisionData = null;
    this.maxCollisionPairs = 10000; // Default, will be set from config

    // Fixed timestep accumulator for stable physics with noLimitFPS
    // When noLimitFPS is true, we accumulate time and run physics at a fixed rate
    this.timeAccumulator = 0;
    this.fixedDeltaTime = 16.67; // Target: 60fps physics tick (will be divided by subStepCount)

    // Stats tracking
    this.collisionChecksThisFrame = 0;
    this.collisionsResolvedThisFrame = 0;
    this.collisionPairsThisFrame = 0;
    this.constraintSolveTimeThisFrame = 0;
    this.moveTimeThisFrame = 0;
    this.collisionSolveTimeThisFrame = 0;

    // PERFORMANCE: Reusable collision result object to avoid GC pressure
    // Instead of allocating thousands of objects per frame, we reuse this one
    this.collisionResult = {
      collided: false,
      depth: 0,
      nx: 0,
      ny: 0,
    };

    // Constraint system
    this.constraintsEnabled = false;
    this.maxConstraints = 0;
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    //console.log("PHYSICS WORKER: Initializing with component system");

    // Initialize stats buffer for writing metrics
    if (data.buffers.physicsStats) {
      this.stats = createStatsWriter(data.buffers.physicsStats, PHYSICS_STATS);
      console.log('PHYSICS WORKER: Stats buffer initialized');
    }

    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()

    // Initialize collision data buffer for Unity-style collision callbacks
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      this.maxCollisionPairs =
        this.config.physics?.maxCollisionPairs ?? this.config.maxCollisionPairs ?? PHYSICS_DEFAULTS.maxCollisionPairs;
    }

    // Initialize constraint system if enabled
    if (data.constraints && data.constraints.enabled) {
      this.constraintsEnabled = true;
      this.maxConstraints = data.constraints.maxConstraints;

      // Initialize Constraint arrays from SharedArrayBuffer
      Constraint.initializeArrays(data.constraints.data, this.maxConstraints);
      Constraint.initialize(this.maxConstraints);
      Constraint.initializeFreeList(data.constraints.freeList, data.constraints.freeListTop);

      console.log(`PHYSICS WORKER: Constraint system initialized with ${this.maxConstraints} max constraints`);
    }

    this.applyPhysicsConfig(this.config.physics || {});
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * Performs physics integration for all entities
   *
   * When noLimitFPS is true, uses a fixed-timestep accumulator to ensure stable physics.
   * SubSteps divide the fixed timestep for constraint solving, not the variable frame time.
   */
  update(deltaTime, dtRatio, resuming) {
    // Reset stats counters once per frame (before fixed-step accumulator loop)
    this.collisionChecksThisFrame = 0;
    this.collisionsResolvedThisFrame = 0;
    this.collisionPairsThisFrame = 0;
    this.constraintSolveTimeThisFrame = 0;
    this.moveTimeThisFrame = 0;
    this.collisionSolveTimeThisFrame = 0;

    // OPTIMIZATION: Cache query results per frame to avoid repeated calls
    // These queries are cached by the query system, but accessing them once is still faster
    this._cachedPhysicsEntities = null;
    this._cachedColliderEntities = null;

    this.buildDenseColliders();

    if (this.noLimitFPS && this.settings.subStepCount > 1) {
      // Fixed timestep mode: accumulate time and run physics at fixed intervals
      // This ensures subSteps work correctly regardless of actual frame rate
      const fixedStep = this.fixedDeltaTime / this.settings.subStepCount;
      const fixedDtRatio = fixedStep / 16.67;

      // Clamp accumulated time to prevent spiral of death (max ~3 frames worth)
      this.timeAccumulator += Math.min(deltaTime, 50);

      // Run physics steps at fixed intervals
      while (this.timeAccumulator >= fixedStep) {
        this.updateVerletFixedStep(fixedStep, fixedDtRatio);
        this.timeAccumulator -= fixedStep;
      }
    } else {
      // Standard mode: run physics with actual deltaTime
      this.updateVerlet(deltaTime, dtRatio, resuming);
    }
  }

  /**
   * Merge new physics config sent from main thread
   * @param {Object} partialConfig
   */
  applyPhysicsConfig(partialConfig = {}) {
    // Persist merged config on worker (helps future updates)
    this.config.physics = {
      ...(this.config.physics || {}),
      ...partialConfig,
    };

    // Use utility function for validation and merging
    this.settings = validatePhysicsConfig(this.settings, this.config.physics);

    // Cache derived values that don't change during the scene
    const wakeUpThreshold = this.config.physics.wakeUpThreshold ?? PHYSICS_DEFAULTS.wakeUpThreshold;
    this._wakeUpThresholdSq = wakeUpThreshold * wakeUpThreshold;
    this._sleepThreshold = this.config.physics.sleepThreshold ?? PHYSICS_DEFAULTS.sleepThreshold;
  }

  handleCustomMessage(data) {
    if (data.msg === 'updatePhysicsConfig') {
      this.applyPhysicsConfig(data.config || {});
    }
  }

  /**
   * Build a dense array of active colliders that ACTUALLY have collision candidates.
   * This runs ONCE per frame, eliminating thousands of empty loop iterations in sub-stepping.
   */
  buildDenseColliders() {
    if (!this._cachedColliderEntities) {
      this._cachedColliderEntities = this.queryActiveEntities([Collider]);
    }
    const colliderEntities = this._cachedColliderEntities;
    const colliderCount = colliderEntities.length;

    if (!this._denseColliders || this._denseColliders.length < colliderCount) {
      this._denseColliders = new Uint16Array(Math.max(colliderCount, 1024));
    }

    const denseColliders = this._denseColliders;
    let denseCount = 0;

    const neighborData = Grid.neighborData;
    const stride = Grid._stride;
    const colliderActive = Collider.active;

    for (let idx = 0; idx < colliderCount; idx++) {
      const i = colliderEntities[idx];
      if (colliderActive[i]) {
        if (neighborData[i * stride + 1] > 0) {
          denseColliders[denseCount++] = i;
        }
      }
    }

    this._denseColliderCount = denseCount;
  }

  /**
   * Verlet Integration Physics (RopeBall-style)
   * Uses position-based dynamics with constraint solving
   * More stable for particle systems and large numbers of colliding objects
   */
  updateVerlet(deltaTime, dtRatio, resuming) {
    // PERFORMANCE OPTIMIZATION: Cache TypedArray references locally
    // These are NOT copying data - they're caching references to avoid property lookups.
    // Each "Transform.x" access requires a property lookup. By caching the reference once,
    // we eliminate thousands of property lookups per frame (one per entity per iteration).
    // Local const variables are faster than "this.x" because:
    //   1. JIT can store them in CPU registers
    //   2. No object property chain traversal
    //   3. Clear scope boundaries help compiler optimization
    // DO NOT move these to instance properties (this.x) - that would be slower!
    const active = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const colliderActive = Collider.active;
    const x = Transform.x;
    const y = Transform.y;
    const rotation = Transform.rotation;
    const px = RigidBody.px;
    const py = RigidBody.py;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    const maxVel = RigidBody.maxVel;
    const collisionCount = RigidBody.collisionCount;

    // Collider properties
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const isTrigger = Collider.isTrigger;

    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    // // Get world bounds for boundary constraints
    // const worldWidth = this.config.worldWidth;
    // const worldHeight = this.config.worldHeight;

    // Get the number of entities with RigidBody (not all entities have physics)
    // const rigidBodyCount = this.globalEntityCount;

    // OPTIMIZATION: Use queryActiveEntities to reset collision counters only for active physics entities
    // Cache query result to avoid repeated calls in the same frame
    if (!this._cachedPhysicsEntities) {
      this._cachedPhysicsEntities = this.queryActiveEntities([RigidBody]);
    }
    const physicsEntities = this._cachedPhysicsEntities;
    this.rigidBodyCount = physicsEntities.length;

    for (let idx = 0; idx < this.rigidBodyCount; idx++) {
      const i = physicsEntities[idx];
      collisionCount[i] = 0;
    }

    const gx = this.settings.gravity.x;
    const gy = this.settings.gravity.y;

    // Step 1: Move entities using Verlet integration
    const shouldProfile = !!this.stats;
    let startTime = shouldProfile ? performance.now() : 0;
    this.moveEntitiesVerlet(
      active,
      rigidBodyActive,
      x,
      y,
      px,
      py,
      vx,
      vy,
      ax,
      ay,
      dtRatio,
      gx,
      gy,
      maxVel
    );
    if (shouldProfile) {
      this.moveTimeThisFrame += performance.now() - startTime;
    }

    // Step 2: Apply constraints (collisions, boundary) with sub-stepping
    for (let step = 0; step < this.settings.subStepCount; step++) {
      startTime = shouldProfile ? performance.now() : 0;
      this.resolveCollisionsVerlet(
        active,
        rigidBodyActive,
        colliderActive,
        x,
        y,
        offsetX,
        offsetY,
        shapeType,
        radius,
        width,
        height,
        isTrigger,
        collisionCount
      );
      if (shouldProfile) {
        this.collisionSolveTimeThisFrame += performance.now() - startTime;
      }

      // Solve distance constraints (position-based dynamics)
      if (this.constraintsEnabled) {
        const distIters = this.settings.distanceConstraintIterations;
        for (let it = 0; it < distIters; it++) {
          this.solveDistanceConstraints(x, y, active);
        }
      }
    }
  }

  /**
   * Fixed-step Verlet update for use with accumulator (noLimitFPS mode)
   * Runs movement + collision resolve + distance-constraint sweeps per call. The accumulator loop handles substepping.
   * This ensures physics runs at a consistent rate regardless of actual frame rate.
   * OPTIMIZED: Uses query system to iterate only entities with physics components
   */
  updateVerletFixedStep(fixedDeltaTime, fixedDtRatio) {
    // PERFORMANCE OPTIMIZATION: Cache TypedArray references (see updateVerlet for full explanation)
    // These local consts eliminate property lookups in hot loops - DO NOT move to instance properties!
    const active = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const colliderActive = Collider.active;
    const x = Transform.x;
    const y = Transform.y;
    const px = RigidBody.px;
    const py = RigidBody.py;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    const maxVel = RigidBody.maxVel;
    const collisionCount = RigidBody.collisionCount;

    // Collider properties
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const isTrigger = Collider.isTrigger;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    // // Get world bounds for boundary constraints
    // const worldWidth = this.config.worldWidth;
    // const worldHeight = this.config.worldHeight;

    // Get the number of entities with RigidBody
    // const rigidBodyCount = RigidBody.px?.length || 0;

    // OPTIMIZATION: Use queryActiveEntities to reset collision counters only for active physics entities
    // Note: In fixed step mode, we reset per-step to avoid accumulation issues
    // Cache query result to avoid repeated calls in the same frame
    if (!this._cachedPhysicsEntities) {
      this._cachedPhysicsEntities = this.queryActiveEntities([RigidBody]);
    }
    const physicsEntities = this._cachedPhysicsEntities;
    const rigidBodyCount = physicsEntities.length;
    for (let idx = 0; idx < rigidBodyCount; idx++) {
      const i = physicsEntities[idx];
      collisionCount[i] = 0;
    }

    const gx = this.settings.gravity.x;
    const gy = this.settings.gravity.y;

    // Step 1: Move entities using Verlet integration with fixed timestep
    const shouldProfile = !!this.stats;
    let startTime = shouldProfile ? performance.now() : 0;
    this.moveEntitiesVerlet(
      active,
      rigidBodyActive,
      x,
      y,
      px,
      py,
      vx,
      vy,
      ax,
      ay,
      fixedDtRatio,
      gx,
      gy,
      maxVel
    );
    if (shouldProfile) {
      this.moveTimeThisFrame += performance.now() - startTime;
    }

    // Step 2: Apply constraints per fixed step (substepping is handled by accumulator)
    startTime = shouldProfile ? performance.now() : 0;
    this.resolveCollisionsVerlet(
      active,
      rigidBodyActive,
      colliderActive,
      x,
      y,
      offsetX,
      offsetY,
      shapeType,
      radius,
      width,
      height,
      isTrigger,
      collisionCount
    );
    if (shouldProfile) {
      this.collisionSolveTimeThisFrame += performance.now() - startTime;
    }

    // Solve distance constraints (position-based dynamics)
    if (this.constraintsEnabled) {
      const distIters = this.settings.distanceConstraintIterations;
      for (let it = 0; it < distIters; it++) {
        this.solveDistanceConstraints(x, y, active);
      }
    }
  }

  /**
   * Move entities using Verlet integration
   * Works for both circles and boxes - shape doesn't affect movement
   * OPTIMIZED: Uses query system to iterate only entities with RigidBody
   */
  moveEntitiesVerlet(
    active,
    rigidBodyActive,
    x,
    y,
    px,
    py,
    vx,
    vy,
    ax,
    ay,
    dtRatio,
    gx,
    gy,
    maxVel
  ) {
    const damping = this.settings.verletDamping;
    const isStatic = RigidBody.static;
    const friction = RigidBody.friction;
    const sleeping = RigidBody.sleeping;

    // Use cached values (calculated once in applyPhysicsConfig, not per-frame)
    const wakeUpThresholdSq = this._wakeUpThresholdSq;
    const stillnessTime = RigidBody.stillnessTime;

    const gravityScale = dtRatio * dtRatio;
    const invDtRatio = 1 / dtRatio; // Pre-computed inverse to avoid division in loop

    // Use cached query result from updateVerlet/updateVerletFixedStep
    // This avoids redundant queryActiveEntities calls per frame
    const physicsEntities = this._cachedPhysicsEntities;

    const physicsCount = physicsEntities.length;
    let idx = 0;

    // Manual 4-way unrolling keeps the hot math in a straighter-line block,
    // which gives the JIT a better chance to optimize this SoA loop.
    for (; idx + 3 < physicsCount; idx += 4) {
      let i = physicsEntities[idx];
      // Note: active[i] and rigidBodyActive[i] checks removed - queryActiveEntities already filters
      if (!(isStatic[i] || sleeping[i])) {
        const accX = ax[i] * dtRatio;
        const accY = ay[i] * dtRatio;
        if (accX * accX > wakeUpThresholdSq || accY * accY > wakeUpThresholdSq) {
          sleeping[i] = 0;
          stillnessTime[i] = 0;
        }
        const oldX = x[i];
        const oldY = y[i];
        if (px[i] !== px[i] || py[i] !== py[i]) {
          px[i] = oldX;
          py[i] = oldY;
        }
        let dx = (x[i] - px[i]) * damping;
        let dy = (y[i] - py[i]) * damping;
        if (friction[i] > 0) {
          const frictionFactor = 1 - friction[i] * dtRatio;
          dx *= frictionFactor;
          dy *= frictionFactor;
        }
        dx += gravityScale * gx + accX;
        dy += gravityScale * gy + accY;
        const speedSquared = dx * dx + dy * dy;
        const maxSpeed = maxVel[i] * dtRatio;
        const maxSpeedSquared = maxSpeed * maxSpeed;
        if (speedSquared > maxSpeedSquared) {
          const velScale = maxSpeed / Math.sqrt(speedSquared);
          dx *= velScale;
          dy *= velScale;
        }
        if (dx !== dx || dy !== dy || dx === Infinity || dx === -Infinity || dy === Infinity || dy === -Infinity) {
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = 0;
          vy[i] = 0;
          ax[i] = 0;
          ay[i] = 0;
        } else {
          x[i] = oldX + dx;
          y[i] = oldY + dy;
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = dx * invDtRatio;
          vy[i] = dy * invDtRatio;
          ax[i] = 0;
          ay[i] = 0;
        }
      } else if (sleeping[i]) {
        px[i] = x[i];
        py[i] = y[i];
        ax[i] = 0;
        ay[i] = 0;
      }

      i = physicsEntities[idx + 1];
      if (!(isStatic[i] || sleeping[i])) {
        const accX = ax[i] * dtRatio;
        const accY = ay[i] * dtRatio;
        if (accX * accX > wakeUpThresholdSq || accY * accY > wakeUpThresholdSq) {
          sleeping[i] = 0;
          stillnessTime[i] = 0;
        }
        const oldX = x[i];
        const oldY = y[i];
        if (px[i] !== px[i] || py[i] !== py[i]) {
          px[i] = oldX;
          py[i] = oldY;
        }
        let dx = (x[i] - px[i]) * damping;
        let dy = (y[i] - py[i]) * damping;
        if (friction[i] > 0) {
          const frictionFactor = 1 - friction[i] * dtRatio;
          dx *= frictionFactor;
          dy *= frictionFactor;
        }
        dx += gravityScale * gx + accX;
        dy += gravityScale * gy + accY;
        const speedSquared = dx * dx + dy * dy;
        const maxSpeed = maxVel[i] * dtRatio;
        const maxSpeedSquared = maxSpeed * maxSpeed;
        if (speedSquared > maxSpeedSquared) {
          const velScale = maxSpeed / Math.sqrt(speedSquared);
          dx *= velScale;
          dy *= velScale;
        }
        if (dx !== dx || dy !== dy || dx === Infinity || dx === -Infinity || dy === Infinity || dy === -Infinity) {
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = 0;
          vy[i] = 0;
          ax[i] = 0;
          ay[i] = 0;
        } else {
          x[i] = oldX + dx;
          y[i] = oldY + dy;
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = dx * invDtRatio;
          vy[i] = dy * invDtRatio;
          ax[i] = 0;
          ay[i] = 0;
        }
      } else if (sleeping[i]) {
        px[i] = x[i];
        py[i] = y[i];
        ax[i] = 0;
        ay[i] = 0;
      }

      i = physicsEntities[idx + 2];
      if (!(isStatic[i] || sleeping[i])) {
        const accX = ax[i] * dtRatio;
        const accY = ay[i] * dtRatio;
        if (accX * accX > wakeUpThresholdSq || accY * accY > wakeUpThresholdSq) {
          sleeping[i] = 0;
          stillnessTime[i] = 0;
        }
        const oldX = x[i];
        const oldY = y[i];
        if (px[i] !== px[i] || py[i] !== py[i]) {
          px[i] = oldX;
          py[i] = oldY;
        }
        let dx = (x[i] - px[i]) * damping;
        let dy = (y[i] - py[i]) * damping;
        if (friction[i] > 0) {
          const frictionFactor = 1 - friction[i] * dtRatio;
          dx *= frictionFactor;
          dy *= frictionFactor;
        }
        dx += gravityScale * gx + accX;
        dy += gravityScale * gy + accY;
        const speedSquared = dx * dx + dy * dy;
        const maxSpeed = maxVel[i] * dtRatio;
        const maxSpeedSquared = maxSpeed * maxSpeed;
        if (speedSquared > maxSpeedSquared) {
          const velScale = maxSpeed / Math.sqrt(speedSquared);
          dx *= velScale;
          dy *= velScale;
        }
        if (dx !== dx || dy !== dy || dx === Infinity || dx === -Infinity || dy === Infinity || dy === -Infinity) {
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = 0;
          vy[i] = 0;
          ax[i] = 0;
          ay[i] = 0;
        } else {
          x[i] = oldX + dx;
          y[i] = oldY + dy;
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = dx * invDtRatio;
          vy[i] = dy * invDtRatio;
          ax[i] = 0;
          ay[i] = 0;
        }
      } else if (sleeping[i]) {
        px[i] = x[i];
        py[i] = y[i];
        ax[i] = 0;
        ay[i] = 0;
      }

      i = physicsEntities[idx + 3];
      if (!(isStatic[i] || sleeping[i])) {
        const accX = ax[i] * dtRatio;
        const accY = ay[i] * dtRatio;
        if (accX * accX > wakeUpThresholdSq || accY * accY > wakeUpThresholdSq) {
          sleeping[i] = 0;
          stillnessTime[i] = 0;
        }
        const oldX = x[i];
        const oldY = y[i];
        if (px[i] !== px[i] || py[i] !== py[i]) {
          px[i] = oldX;
          py[i] = oldY;
        }
        let dx = (x[i] - px[i]) * damping;
        let dy = (y[i] - py[i]) * damping;
        if (friction[i] > 0) {
          const frictionFactor = 1 - friction[i] * dtRatio;
          dx *= frictionFactor;
          dy *= frictionFactor;
        }
        dx += gravityScale * gx + accX;
        dy += gravityScale * gy + accY;
        const speedSquared = dx * dx + dy * dy;
        const maxSpeed = maxVel[i] * dtRatio;
        const maxSpeedSquared = maxSpeed * maxSpeed;
        if (speedSquared > maxSpeedSquared) {
          const velScale = maxSpeed / Math.sqrt(speedSquared);
          dx *= velScale;
          dy *= velScale;
        }
        if (dx !== dx || dy !== dy || dx === Infinity || dx === -Infinity || dy === Infinity || dy === -Infinity) {
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = 0;
          vy[i] = 0;
          ax[i] = 0;
          ay[i] = 0;
        } else {
          x[i] = oldX + dx;
          y[i] = oldY + dy;
          px[i] = oldX;
          py[i] = oldY;
          vx[i] = dx * invDtRatio;
          vy[i] = dy * invDtRatio;
          ax[i] = 0;
          ay[i] = 0;
        }
      } else if (sleeping[i]) {
        px[i] = x[i];
        py[i] = y[i];
        ax[i] = 0;
        ay[i] = 0;
      }
    }

    for (; idx < physicsCount; idx++) {
      const i = physicsEntities[idx];
      // Note: active[i] and rigidBodyActive[i] checks removed - queryActiveEntities already filters

      // Combined static + sleeping early-out (single branch for non-moving entities)
      if (isStatic[i] || sleeping[i]) {
        if (sleeping[i]) {
          px[i] = x[i];
          py[i] = y[i];
          ax[i] = 0;
          ay[i] = 0;
        }
        continue;
      }

      const accX = ax[i] * dtRatio;
      const accY = ay[i] * dtRatio;

      // Wake-up check: use squared comparison to avoid Math.abs overhead
      if (accX * accX > wakeUpThresholdSq || accY * accY > wakeUpThresholdSq) {
        sleeping[i] = 0;
        stillnessTime[i] = 0;
      }

      const oldX = x[i];
      const oldY = y[i];

      // Initialize px/py for newly created entities (NaN !== NaN is faster than isNaN)
      if (px[i] !== px[i] || py[i] !== py[i]) {
        px[i] = oldX;
        py[i] = oldY;
      }

      // Verlet Integration
      let dx = (x[i] - px[i]) * damping;
      let dy = (y[i] - py[i]) * damping;

      // Apply friction using linear approximation (faster than Math.pow)
      if (friction[i] > 0) {
        const frictionFactor = 1 - friction[i] * dtRatio;
        dx *= frictionFactor;
        dy *= frictionFactor;
      }

      dx += gravityScale * gx + accX;
      dy += gravityScale * gy + accY;

      // Velocity clamping using squared comparison (avoids sqrt for most entities)
      const speedSquared = dx * dx + dy * dy;
      const maxSpeed = maxVel[i] * dtRatio;
      const maxSpeedSquared = maxSpeed * maxSpeed;

      if (speedSquared > maxSpeedSquared) {
        const velScale = maxSpeed / Math.sqrt(speedSquared);
        dx *= velScale;
        dy *= velScale;
      }

      // NaN/Infinity safety: if integration produced non-finite values, reset entity motion.
      // Catches bugs in game code (e.g. 0/0 in steering) and the Infinity*0=NaN path
      // in velocity clamping. Without this, one bad frame corrupts the entity permanently.
      if (dx !== dx || dy !== dy || dx === Infinity || dx === -Infinity || dy === Infinity || dy === -Infinity) {
        px[i] = oldX;
        py[i] = oldY;
        vx[i] = 0;
        vy[i] = 0;
        ax[i] = 0;
        ay[i] = 0;
        continue;
      }

      x[i] = oldX + dx;
      y[i] = oldY + dy;

      px[i] = oldX;
      py[i] = oldY;

      vx[i] = dx * invDtRatio;
      vy[i] = dy * invDtRatio;

      ax[i] = 0;
      ay[i] = 0;
    }
  }

  /**
   * Resolve collisions - routes to appropriate handler based on shape types
   */
  resolveCollisionsVerlet(
    active,
    rigidBodyActive,
    colliderActive,
    x,
    y,
    offsetX,
    offsetY,
    shapeType,
    radius,
    width,
    height,
    isTrigger,
    collisionCount
  ) {

    const responseStrength = this.settings.collisionResponseStrength;
    const isStatic = RigidBody.static;
    const invMass = RigidBody.invMass;

    let pairCount = 0;
    const collisionData = this.collisionData;
    const maxPairs = this.maxCollisionPairs;

    // PERFORMANCE: Cache Grid arrays locally to avoid method call overhead in hot loop
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;
    const visualRange = Collider.visualRange;
    const collisionLayer = Collider.collisionLayer;
    const collisionMask = Collider.collisionMask;

    // OPTIMIZATION: Use pre-built dense list of active colliders that ACTUALLY have collision candidates
    // This perfectly bypasses thousands of empty loop iterations in sub-stepping.
    const denseColliders = this._denseColliders;
    const denseCount = this._denseColliderCount;

    // Cache sleeping array reference for performance
    const sleeping = RigidBody.sleeping;

    for (let idx = 0; idx < denseCount; idx++) {
      const i = denseColliders[idx];
      // Note: active[i], colliderActive[i], and candidateCount > 0 are already checked in buildDenseColliders

      // Direct array access (no method call overhead)
      // Layout: [totalCount, collisionCount, neighbors...]
      // Physics only iterates collision candidates (first collisionCount neighbors)
      const offset = i * stride;
      const collisionCandidateCount = neighborData[offset + 1];

      // HOISTED: Access entity 'i' properties ONCE outside the inner loop
      const shapeI = shapeType[i];
      const radiusI = radius[i];
      const widthI = width[i];
      const heightI = height[i];
      // Hoist offsets (invariant) but NOT position (variant)
      const offXi = offsetX[i];
      const offYi = offsetY[i];

      // NOTE: colliderX_i / colliderY_i CANNOT be hoisted arbitrarily because x[i]/y[i]
      // change during the loop as collisions are resolved! 
      // But reading from SAB over and over is slow, so we cache it in a local register and update when it moves.
      let localXi = x[i];
      let localYi = y[i];

      // OPTIMIZATION: Cache entity i's layer/mask and static/sleeping state outside the loop
      const layerBitI = 1 << (collisionLayer[i] & 31);
      const maskI = collisionMask[i];
      const iHasRigidBody = rigidBodyActive[i];
      const iStatic = !iHasRigidBody || isStatic[i];
      const iSleeping = iHasRigidBody && sleeping[i];

      // Iterate only collision candidates (partitioned by spatial worker)
      // No early break needed - these are pre-filtered to collision range
      for (let n = 0; n < collisionCandidateCount; n++) {
        const j = neighborData[offset + 2 + n];

        if (i === j || !active[j] || !colliderActive[j]) continue;
        // Only process each pair once, but always process if j can't see (static obstacle with visualRange=0)
        if (i >= j && visualRange[j] > 0) continue;

        // OPTIMIZATION: Skip collision checks between two static entities
        // Static entities never move, so collisions between them are already resolved and won't change
        const jHasRigidBody = rigidBodyActive[j];
        const jStatic = !jHasRigidBody || isStatic[j];
        if (iStatic && jStatic) {
          // Both are static - skip collision check entirely
          continue;
        }

        // OPTIMIZATION: Skip collision checks between two sleeping entities
        // Sleeping entities won't move, so no collision resolution needed
        // However, we still need to check sleeping vs awake to wake them up
        const jSleeping = jHasRigidBody && sleeping[j];
        if (iSleeping && jSleeping) {
          continue;
        }

        // Collision layer/mask filtering: skip if either entity's layer isn't in the other's mask
        const layerBitJ = 1 << (collisionLayer[j] & 31);
        if (!(layerBitI & collisionMask[j]) || !(layerBitJ & maskI)) continue;

        // Get shape type for neighbor 'j'
        const shapeJ = shapeType[j];

        // Calculate offset-adjusted collider positions
        // We MUST re-calculate i's position here because it might have moved
        // in a previous iteration of this same loop (multi-collision)
        const colliderX_i = localXi + offXi;
        const colliderY_i = localYi + offYi;

        const colliderX_j = x[j] + offsetX[j];
        const colliderY_j = y[j] + offsetY[j];

        // Collision result: { collided, depth, nx, ny }
        let result = null;

        // Track collision check
        this.collisionChecksThisFrame++;

        if (shapeI === SHAPE_CIRCLE && shapeJ === SHAPE_CIRCLE) {
          // Circle vs Circle
          result = this.testCircleCircle(
            colliderX_i,
            colliderY_i,
            radiusI,
            colliderX_j,
            colliderY_j,
            radius[j]
          );
        } else if (shapeI === SHAPE_CIRCLE && shapeJ === SHAPE_BOX) {
          // Circle vs Box
          result = this.testCircleAABB(
            colliderX_i,
            colliderY_i,
            radiusI,
            colliderX_j,
            colliderY_j,
            width[j],
            height[j]
          );
        } else if (shapeI === SHAPE_BOX && shapeJ === SHAPE_CIRCLE) {
          // Box vs Circle (swap and invert normal)
          result = this.testCircleAABB(
            colliderX_j,
            colliderY_j,
            radius[j],
            colliderX_i,
            colliderY_i,
            widthI,
            heightI
          );
          if (result && result.collided) {
            result.nx = -result.nx;
            result.ny = -result.ny;
          }
        } else if (shapeI === SHAPE_BOX && shapeJ === SHAPE_BOX) {
          // Box vs Box
          result = this.testAABBAABB(
            colliderX_i,
            colliderY_i,
            widthI,
            heightI,
            colliderX_j,
            colliderY_j,
            width[j],
            height[j]
          );
        }

        if (!result || !result.collided) continue;

        // Track collision resolved
        this.collisionsResolvedThisFrame++;

        const eitherIsTrigger = isTrigger[i] || isTrigger[j];

        // SLEEPING OPTIMIZATION: Wake entities on collision
        // If either entity is sleeping, wake it up (collision means something is happening)
        // NOTE: Do NOT wake up entities if either is a trigger (triggers are for events only)
        // Note: iSleeping and jSleeping are already computed above
        if (!eitherIsTrigger) {
          if (iHasRigidBody && iSleeping) {
            sleeping[i] = 0;
            RigidBody.stillnessTime[i] = 0;
          }
          if (jHasRigidBody && jSleeping) {
            sleeping[j] = 0;
            RigidBody.stillnessTime[j] = 0;
          }
        }

        // Apply physical response if neither is a trigger
        if (!eitherIsTrigger) {
          // OPTIMIZATION: iStatic and jStatic are already computed above
          // No need to recompute them here

          const correction = result.depth * responseStrength;
          const nx = result.nx;
          const ny = result.ny;

          // Mass-weighted collision response:
          // Lighter objects move more, heavier objects move less
          // Static objects have invMass = 0 (infinite mass)
          const invMassI = iStatic ? 0 : invMass[i];
          const invMassJ = jStatic ? 0 : invMass[j];
          const totalInvMass = invMassI + invMassJ;

          if (totalInvMass > 0) {
            // Distribute correction based on inverse mass ratio
            const corrI = correction * (invMassI / totalInvMass);
            const corrJ = correction * (invMassJ / totalInvMass);

            x[i] = localXi += nx * corrI;
            y[i] = localYi += ny * corrI;
            x[j] -= nx * corrJ;
            y[j] -= ny * corrJ;
          }
          // If totalInvMass === 0, both are static/infinite mass - no movement
        }

        // Track collision count
        if (iHasRigidBody) collisionCount[i]++;
        if (jHasRigidBody) collisionCount[j]++;

        // Record collision pair for callbacks
        if (collisionData && pairCount < maxPairs) {
          collisionData[1 + pairCount * 2] = i;
          collisionData[1 + pairCount * 2 + 1] = j;
          pairCount++;
        }
      }
    }

    if (collisionData) {
      collisionData[0] = pairCount;
    }

    // Store for stats reporting
    this.collisionPairsThisFrame = pairCount;
  }

  /**
   * Test Circle vs Circle collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testCircleCircle(x1, y1, r1, x2, y2, r2) {
    // Reuse collision result object to avoid GC pressure
    const result = this.collisionResult;
    return testCircleCircleCollision(x1, y1, r1, x2, y2, r2, result);
  }

  /**
   * Test Circle vs AABB collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testCircleAABB(circleX, circleY, circleR, boxX, boxY, boxW, boxH) {
    // Reuse collision result object to avoid GC pressure
    const result = this.collisionResult;
    return testCircleAABBCollision(circleX, circleY, circleR, boxX, boxY, boxW, boxH, result);
  }

  /**
   * Test AABB vs AABB collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testAABBAABB(x1, y1, w1, h1, x2, y2, w2, h2) {
    // Reuse collision result object to avoid GC pressure
    const result = this.collisionResult;
    return testAABBAABBCollision(x1, y1, w1, h1, x2, y2, w2, h2, result);
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // Write stats to SharedArrayBuffer every frame
    if (this.stats) {
      this.stats[PHYSICS_STATS.FPS] = this.currentFPS;
      this.stats[PHYSICS_STATS.COLLISION_CHECKS] = this.collisionChecksThisFrame;
      this.stats[PHYSICS_STATS.COLLISIONS_RESOLVED] = this.collisionsResolvedThisFrame;
      this.stats[PHYSICS_STATS.COLLISION_PAIRS] = this.collisionPairsThisFrame;
      this.stats[PHYSICS_STATS.CONSTRAINT_MS] = this.constraintSolveTimeThisFrame;
      this.stats[PHYSICS_STATS.MSG_MS] = this.messageTimeThisFrame;
      this.stats[PHYSICS_STATS.MOVE_MS] = this.moveTimeThisFrame;
      this.stats[PHYSICS_STATS.COLLISION_MS] = this.collisionSolveTimeThisFrame;
    }
  }

  // ========================================
  // DISTANCE CONSTRAINT SOLVING
  // ========================================

  /**
   * Solve distance constraints using position-based dynamics (PBD)
   * Each constraint maintains a target distance between two entities.
   *
   * Algorithm:
   * 1. For each active constraint, get entity positions
   * 2. Calculate current distance between entities
   * 3. Compute position correction to reach target distance
   * 4. Apply correction scaled by stiffness (split 50/50 between entities)
   *
   * @param {Float32Array} x - Entity X positions
   * @param {Float32Array} y - Entity Y positions
   * @param {Uint8Array} active - Entity active flags
   */
  solveDistanceConstraints(x, y, active) {
    const shouldProfile = !!this.stats;
    const startTime = shouldProfile ? performance.now() : 0;

    const pairs = Constraint.pairs;
    const restLength = Constraint.restLength;
    const stiffness = Constraint.stiffness;
    const constraintActive = Constraint.active;
    const denseConstraints = Constraint.activeIndices;
    const denseConstraintCount = Constraint.getDenseActiveCount();

    if (!constraintActive || !denseConstraints || denseConstraintCount === 0) {
      if (shouldProfile) {
        this.constraintSolveTimeThisFrame += performance.now() - startTime;
      }
      return;
    }

    // Cache RigidBody static flags for mass-weighted response
    const isStatic = RigidBody.static;
    const invMass = RigidBody.invMass;
    const rigidBodyActive = RigidBody.active;

    for (let denseIdx = 0; denseIdx < denseConstraintCount; denseIdx++) {
      const i = denseConstraints[denseIdx];
      if (!constraintActive[i]) continue;

      // Unpack entity indices
      const packed = pairs[i];
      const entityA = packed >>> 16;
      const entityB = packed & 0xFFFF;

      // Skip if either entity is inactive
      if (!active[entityA] || !active[entityB]) continue;

      // Mass-weighted response (similar to collision resolution)
      const aHasRB = rigidBodyActive[entityA];
      const bHasRB = rigidBodyActive[entityB];
      const aStatic = !aHasRB || isStatic[entityA];
      const bStatic = !bHasRB || isStatic[entityB];

      // Get inverse masses (static = 0 = infinite mass)
      const invMassA = aStatic ? 0 : invMass[entityA];
      const invMassB = bStatic ? 0 : invMass[entityB];
      const totalInvMass = invMassA + invMassB;

      // Skip if both are static (no movement possible)
      if (totalInvMass === 0) continue;

      // Get current positions
      const ax = x[entityA];
      const ay = y[entityA];
      const bx = x[entityB];
      const by = y[entityB];

      // Calculate distance vector and current distance
      const dx = bx - ax;
      const dy = by - ay;
      const distSq = dx * dx + dy * dy;

      // Skip if entities are at same position (avoid division by zero)
      if (distSq < MIN_CONSTRAINT_DIST_SQ) continue;

      const currentDist = Math.sqrt(distSq);

      // Calculate error (how far from rest length)
      const targetDist = restLength[i];
      const error = currentDist - targetDist;

      // Skip if already at target distance
      if (error > -CONSTRAINT_ERROR_EPSILON && error < CONSTRAINT_ERROR_EPSILON) continue;

      // Calculate correction direction (normalized)
      const invCurrentDist = 1 / currentDist;
      const nx = dx * invCurrentDist;
      const ny = dy * invCurrentDist;

      // Apply stiffness to correction
      const correction = error * stiffness[i] * 0.5; // 0.5 for relaxation

      // Distribute correction based on mass
      const corrA = correction * (invMassA / totalInvMass);
      const corrB = correction * (invMassB / totalInvMass);

      // Apply position corrections
      // Entity A moves toward B (positive correction)
      // Entity B moves toward A (negative correction)
      x[entityA] += nx * corrA;
      y[entityA] += ny * corrA;
      x[entityB] -= nx * corrB;
      y[entityB] -= ny * corrB;
    }

    if (shouldProfile) {
      this.constraintSolveTimeThisFrame += performance.now() - startTime;
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
self.physicsWorker = physicsWorker;
