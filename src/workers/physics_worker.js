self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays
// Supports Circle and AABB (Box) colliders

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
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
// Note: Game-specific scripts are loaded dynamically by AbstractWorker
// Physics worker uses RigidBody component for physics calculations

// Shape type constants (must match Collider.shapeType values)
const SHAPE_CIRCLE = 0;
const SHAPE_BOX = 1;

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

    // PERFORMANCE: Reusable collision result object to avoid GC pressure
    // Instead of allocating thousands of objects per frame, we reuse this one
    this.collisionResult = {
      collided: false,
      depth: 0,
      nx: 0,
      ny: 0,
    };
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
        this.config.physics?.maxCollisionPairs ?? this.config.maxCollisionPairs ?? 10000;
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

    // OPTIMIZATION: Cache query results per frame to avoid repeated calls
    // These queries are cached by the query system, but accessing them once is still faster
    this._cachedPhysicsEntities = null;
    this._cachedColliderEntities = null;

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
  }

  handleCustomMessage(data) {
    if (data.msg === 'updatePhysicsConfig') {
      this.applyPhysicsConfig(data.config || {});
    }
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

    const gx = this.settings.gravity.x || 0;
    const gy = this.settings.gravity.y || 0;

    // Step 1: Move entities using Verlet integration
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

    // Step 2: Apply constraints (collisions, boundary) with sub-stepping
    for (let step = 0; step < this.settings.subStepCount; step++) {
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
      // this.applyConstraintsVerlet(
      //   active,
      //   rigidBodyActive,
      //   colliderActive,
      //   x,
      //   y,
      //   offsetX,
      //   offsetY,
      //   shapeType,
      //   radius,
      //   width,
      //   height,
      //   isTrigger,
      //   collisionCount,
      //   worldWidth,
      //   worldHeight,
      //   rigidBodyCount
      // );
    }
  }

  /**
   * Fixed-step Verlet update for use with accumulator (noLimitFPS mode)
   * Runs movement + ONE constraint pass per call. The accumulator loop handles substepping.
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

    const gx = this.settings.gravity.x || 0;
    const gy = this.settings.gravity.y || 0;

    // Step 1: Move entities using Verlet integration with fixed timestep
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

    // Step 2: Apply constraints ONCE per fixed step (substepping is handled by accumulator)
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

    const sleepThreshold = this.config.physics.sleepThreshold;
    const wakeUpThreshold = this.config.physics.wakeUpThreshold;
    const stillnessTime = RigidBody.stillnessTime;

    // const maxAcc = RigidBody.maxAcc;

    const gravityScale = dtRatio * dtRatio;

    // Use cached query result from updateVerlet/updateVerletFixedStep
    // This avoids redundant queryActiveEntities calls per frame
    const physicsEntities = this._cachedPhysicsEntities;

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      // Note: active[i] check no longer needed - queryActiveEntities already filters
      if (!rigidBodyActive[i]) continue;
      if (isStatic[i]) continue;
      // SLEEPING OPTIMIZATION: Skip physics integration for sleeping entities

      // Apply acceleration (scaled by dtRatio)
      let accX = ax[i] * dtRatio;
      let accY = ay[i] * dtRatio;

      //wake up
      if (accX > wakeUpThreshold || accY > wakeUpThreshold) {
        sleeping[i] = 0;
        stillnessTime[i] = 0;
      }

      if (sleeping[i]) {
        // CRITICAL: Keep px/py in sync with x/y for sleeping entities
        // Even though we skip physics integration, the position can still be
        // modified by collisions or boundary constraints. If px/py become
        // out of sync, Verlet integration will produce NaN when the entity wakes up.
        // Always sync px/py with x/y to maintain Verlet relationship
        px[i] = x[i];
        py[i] = y[i];
        continue;
      }

      const oldX = x[i];
      const oldY = y[i];

      // DEFENSIVE: Validate px/py before using in Verlet integration
      // If px/py are NaN, initialize them from current position and velocity
      if (isNaN(px[i]) || isNaN(py[i])) {
        px[i] = x[i] - (vx[i] || 0) * dtRatio;
        py[i] = y[i] - (vy[i] || 0) * dtRatio;
      }

      // Verlet Integration
      let dx = (x[i] - px[i]) * damping;
      let dy = (y[i] - py[i]) * damping;

      // DEFENSIVE: Check for NaN in dx/dy before continuing
      // This can happen if px/py were corrupted or not properly initialized
      if (isNaN(dx) || isNaN(dy)) {
        // Recover by initializing px/py from current position
        // This handles edge cases where entity state was corrupted
        px[i] = x[i];
        py[i] = y[i];
        dx = 0;
        dy = 0;
      }

      if (friction[i] > 0) {
        const frictionFactor = Math.pow(1 - friction[i], dtRatio);
        dx *= frictionFactor;
        dy *= frictionFactor;
      }

      // // Limit acceleration magnitude while preserving direction
      // const accMagnitudeSquared =accX * accX + accY * accY
      // const maxAccel = maxAcc[i]*dtRatio;
      // if (accMagnitudeSquared > maxAccel**2) {
      //   const accScale = maxAccel / Math.sqrt(accMagnitudeSquared);
      //   accX *= accScale;
      //   accY *= accScale;
      // }

      dx += gravityScale * gx + accX;
      dy += gravityScale * gy + accY;

      // DEFENSIVE: Final check for NaN before updating position
      if (isNaN(dx)) dx = 0;
      if (isNaN(dy)) dy = 0;

      // Velocity clamping using squared comparison (avoids sqrt for most entities)
      // OPTIMIZED: Inline calculation to avoid function call overhead
      const speedSquared = dx * dx + dy * dy;
      const maxSpeed = maxVel[i] * dtRatio;
      const maxSpeedSquared = maxSpeed * maxSpeed;

      if (speedSquared > maxSpeedSquared) {
        // OPTIMIZED: Inline clamp to avoid object allocation
        const velScale = maxSpeed / Math.sqrt(speedSquared);
        dx *= velScale;
        dy *= velScale;
      }

      x[i] = oldX + dx;
      y[i] = oldY + dy;

      // DEFENSIVE: Final validation - if position is still NaN, reset to previous position
      if (isNaN(x[i]) || isNaN(y[i])) {
        x[i] = oldX;
        y[i] = oldY;
        px[i] = oldX;
        py[i] = oldY;
      }

      px[i] = oldX;
      py[i] = oldY;

      vx[i] = dx / dtRatio;
      vy[i] = dy / dtRatio;

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

    const rigidBodyCount = this.rigidBodyCount;

    // OPTIMIZATION: Query for active entities with Collider component instead of iterating all entities
    // Cache query result to avoid repeated calls in the same frame
    if (!this._cachedColliderEntities) {
      this._cachedColliderEntities = this.queryActiveEntities([Collider]);
    }
    const colliderEntities = this._cachedColliderEntities;
    const colliderCount = colliderEntities.length;

    // Cache sleeping array reference for performance
    const sleeping = RigidBody.sleeping;

    for (let idx = 0; idx < colliderCount; idx++) {
      const i = colliderEntities[idx];
      // Note: active[i] check no longer needed - queryActiveEntities already filters
      // If the Entity's collider is disabled, skip collision resolution
      if (!colliderActive[i]) continue;

      // Direct array access (no method call overhead)
      // Layout: [totalCount, collisionCount, neighbors...]
      // Physics only iterates collision candidates (first collisionCount neighbors)
      const offset = i * stride;
      const collisionCandidateCount = neighborData[offset + 1];

      if (collisionCandidateCount === 0) continue;

      // HOISTED: Access entity 'i' properties ONCE outside the inner loop
      const shapeI = shapeType[i];
      const radiusI = radius[i];
      const widthI = width[i];
      const heightI = height[i];
      // Hoist offsets (invariant) but NOT position (variant)
      const offXi = offsetX[i];
      const offYi = offsetY[i];

      // NOTE: colliderX_i / colliderY_i CANNOT be hoisted because x[i]/y[i]
      // change during the loop as collisions are resolved!

      // OPTIMIZATION: Cache entity i's static and sleeping state outside the loop
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
          // Both are sleeping - skip collision check (they won't move)
          continue;
        }

        // Get shape type for neighbor 'j'
        const shapeJ = shapeType[j];

        // Calculate offset-adjusted collider positions
        // We MUST re-calculate i's position here because it might have moved
        // in a previous iteration of this same loop (multi-collision)
        const colliderX_i = x[i] + offXi;
        const colliderY_i = y[i] + offYi;

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
          const invMassI = iStatic ? 0 : invMass[i] || 1;
          const invMassJ = jStatic ? 0 : invMass[j] || 1;
          const totalInvMass = invMassI + invMassJ;

          if (totalInvMass > 0) {
            // Distribute correction based on inverse mass ratio
            const corrI = correction * (invMassI / totalInvMass);
            const corrJ = correction * (invMassJ / totalInvMass);

            x[i] += nx * corrI;
            y[i] += ny * corrI;
            x[j] -= nx * corrJ;
            y[j] -= ny * corrJ;
          }
          // If totalInvMass === 0, both are static/infinite mass - no movement
        }

        // Track collision count
        if (i < rigidBodyCount) collisionCount[i]++;
        if (j < rigidBodyCount) collisionCount[j]++;

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
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
self.physicsWorker = physicsWorker;
