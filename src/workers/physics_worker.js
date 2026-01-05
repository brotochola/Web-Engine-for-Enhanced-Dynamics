self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays
// Supports Circle and AABB (Box) colliders

// Import engine dependencies
import { GameObject } from "../core/gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { clamp01, validatePhysicsConfig } from "../core/utils.js";
import { rng } from "../core/utils.js";
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

    // Runtime physics settings (will be filled from Scene config)
    this.settings = null;

    // Collision data buffer for Unity-style callbacks
    this.collisionData = null;
    this.maxCollisionPairs = 10000; // Default, will be set from config

    // Fixed timestep accumulator for stable physics with noLimitFPS
    // When noLimitFPS is true, we accumulate time and run physics at a fixed rate
    this.timeAccumulator = 0;
    this.fixedDeltaTime = 16.67; // Target: 60fps physics tick (will be divided by subStepCount)
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    //console.log("PHYSICS WORKER: Initializing with component system");

    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()

    // Initialize collision data buffer for Unity-style collision callbacks
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      this.maxCollisionPairs =
        this.config.physics?.maxCollisionPairs ||
        this.config.maxCollisionPairs ||
        10000;
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

    // CRITICAL: Sync RigidBody positions to Transform for rendering
    this.syncPhysicsToTransform();
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
    if (data.msg === "updatePhysicsConfig") {
      this.applyPhysicsConfig(data.config || {});
    }
  }

  /**
   * Sync RigidBody physics positions to Transform for rendering
   * NOTE: No longer needed - physics now writes directly to Transform.x/y/rotation
   */
  syncPhysicsToTransform() {
    // REMOVED: Transform now stores position/rotation directly
    // Physics worker reads/writes Transform.x/y/rotation instead of RigidBody.x/y/rotation
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

    // Get world bounds for boundary constraints
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    // Get the number of entities with RigidBody (not all entities have physics)
    const rigidBodyCount = this.entityCount;

    // OPTIMIZATION: Use query system to reset collision counters only for physics entities
    const physicsEntities = this.query([RigidBody]);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
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
      maxVel,
      rigidBodyCount
    );

    // Step 2: Apply constraints (collisions, boundary) with sub-stepping
    for (let step = 0; step < this.settings.subStepCount; step++) {
      this.applyConstraintsVerlet(
        active,
        rigidBodyActive,
        colliderActive,
        x,
        y,
        shapeType,
        radius,
        width,
        height,
        isTrigger,
        collisionCount,
        worldWidth,
        worldHeight,
        rigidBodyCount
      );
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

    // Get world bounds for boundary constraints
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    // Get the number of entities with RigidBody
    const rigidBodyCount = RigidBody.px?.length || 0;

    // OPTIMIZATION: Use query system to reset collision counters only for physics entities
    // Note: In fixed step mode, we reset per-step to avoid accumulation issues
    const physicsEntities = this.query([RigidBody, Transform]);
    for (let idx = 0; idx < physicsEntities.length; idx++) {
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
      maxVel,
      rigidBodyCount
    );

    // Step 2: Apply constraints ONCE per fixed step (substepping is handled by accumulator)
    this.applyConstraintsVerlet(
      active,
      rigidBodyActive,
      colliderActive,
      x,
      y,
      shapeType,
      radius,
      width,
      height,
      isTrigger,
      collisionCount,
      worldWidth,
      worldHeight,
      rigidBodyCount
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
    maxVel,
    rigidBodyCount
  ) {
    const damping = this.settings.verletDamping;
    const isStatic = RigidBody.static;
    const friction = RigidBody.friction;
    const maxAcc = RigidBody.maxAcc;

    const gravityScale = dtRatio * dtRatio;

    // OPTIMIZATION: Use query system to get only entities with RigidBody component
    // This skips entities without physics (houses, decorations, etc.)
    const physicsEntities = this.query([RigidBody, Transform]);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      if (!active[i] || !rigidBodyActive[i]) continue;
      if (isStatic[i]) continue;

      const oldX = x[i];
      const oldY = y[i];

      // Verlet Integration
      let dx = (x[i] - px[i]) * damping;
      let dy = (y[i] - py[i]) * damping;

      if (friction[i] > 0) {
        const frictionFactor = Math.pow(1 - friction[i], dtRatio);
        dx *= frictionFactor;
        dy *= frictionFactor;
      }

      // Apply acceleration (scaled by dtRatio)
      let accX = ax[i] * dtRatio;
      let accY = ay[i] * dtRatio;

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

      // Velocity clamping using squared comparison (avoids sqrt for most entities)
      const speedSquared = dx * dx + dy * dy;
      const maxSpeed = maxVel[i] * dtRatio;
      const maxSpeedSquared = maxSpeed * maxSpeed;

      if (speedSquared > maxSpeedSquared) {
        // Only calculate sqrt when we actually need to clamp
        const velScale = maxSpeed / Math.sqrt(speedSquared);
        dx *= velScale;
        dy *= velScale;
      }

      x[i] = oldX + dx;
      y[i] = oldY + dy;

      px[i] = oldX;
      py[i] = oldY;

      vx[i] = dx / dtRatio;
      vy[i] = dy / dtRatio;

      ax[i] = 0;
      ay[i] = 0;
    }
  }

  /**
   * Apply constraints: boundary constraints and collision resolution
   * Now handles both circles and boxes for boundary checks
   */
  applyConstraintsVerlet(
    active,
    rigidBodyActive,
    colliderActive,
    x,
    y,
    shapeType,
    radius,
    width,
    height,
    isTrigger,
    collisionCount,
    worldWidth,
    worldHeight,
    rigidBodyCount
  ) {
    const px = RigidBody.px;
    const py = RigidBody.py;
    const boundaryElasticity = this.settings.boundaryElasticity;
    const isStatic = RigidBody.static;

    // Get collider offsets for accurate boundary checks
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    // STEP 1: Apply collision constraints FIRST using spatial grid
    // This allows entities to push each other around before boundary clamping
    if (this.neighborData) {
      this.resolveCollisionsVerlet(
        active,
        rigidBodyActive,
        colliderActive,
        x,
        y,
        shapeType,
        radius,
        width,
        height,
        isTrigger,
        collisionCount,
        rigidBodyCount
      );
    }

    // STEP 2: Apply boundary constraints AFTER collisions
    // This ensures collision resolution can't push entities outside world bounds
    // (Previously boundaries were applied first, then collisions could push entities
    // back into the floor, causing vibration)
    for (let i = 0; i < rigidBodyCount; i++) {
      if (!active[i] || !rigidBodyActive[i]) continue;
      if (isStatic[i]) continue;

      // Get entity bounds based on shape type
      let halfW, halfH;
      if (shapeType[i] === SHAPE_BOX) {
        halfW = width[i] * 0.5;
        halfH = height[i] * 0.5;
      } else {
        // Circle: use radius for both
        halfW = radius[i];
        halfH = radius[i];
      }

      // Get collider offset (default to 0 if not set)
      const offX = offsetX[i] || 0;
      const offY = offsetY[i] || 0;

      // Left boundary (collider center + offset must stay within bounds)
      if (x[i] + offX < halfW) {
        x[i] = halfW - offX;
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Right boundary
      if (x[i] + offX > worldWidth - halfW) {
        x[i] = worldWidth - halfW - offX;
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Top boundary
      if (y[i] + offY < halfH) {
        y[i] = halfH - offY;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }

      // Bottom boundary
      if (y[i] + offY > worldHeight - halfH) {
        y[i] = worldHeight - halfH - offY;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }
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
    shapeType,
    radius,
    width,
    height,
    isTrigger,
    collisionCount,
    rigidBodyCount
  ) {
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
    const responseStrength = this.settings.collisionResponseStrength;
    const isStatic = RigidBody.static;

    // Get collider offsets for accurate collision positions
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    let pairCount = 0;
    const collisionData = this.collisionData;
    const maxPairs = this.maxCollisionPairs;

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i] || !colliderActive[i]) continue;

      const offset = i * (1 + maxNeighbors);
      const neighborCount = this.neighborData ? this.neighborData[offset] : 0;

      if (neighborCount === 0) continue;

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

      for (let n = 0; n < neighborCount; n++) {
        const j = this.neighborData[offset + 1 + n];

        if (i === j || !active[j] || !colliderActive[j]) continue;
        if (i >= j) continue; // Only process each pair once

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

        const eitherIsTrigger = isTrigger[i] || isTrigger[j];

        // Apply physical response if neither is a trigger
        if (!eitherIsTrigger) {
          // Entities without RigidBody component should act as static
          const iHasRigidBody = rigidBodyActive[i];
          const jHasRigidBody = rigidBodyActive[j];
          const iStatic = !iHasRigidBody || isStatic[i];
          const jStatic = !jHasRigidBody || isStatic[j];

          const correction = result.depth * responseStrength;
          const nx = result.nx;
          const ny = result.ny;

          if (iStatic && jStatic) {
            // Both static - no movement
          } else if (iStatic) {
            // i is static - only push j away
            x[j] -= nx * correction;
            y[j] -= ny * correction;
          } else if (jStatic) {
            // j is static - only push i away
            x[i] += nx * correction;
            y[i] += ny * correction;
          } else {
            // Both dynamic - split correction
            const halfCorrection = correction * 0.5;
            x[i] += nx * halfCorrection;
            y[i] += ny * halfCorrection;
            x[j] -= nx * halfCorrection;
            y[j] -= ny * halfCorrection;
          }
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
  }

  /**
   * Test Circle vs Circle collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testCircleCircle(x1, y1, r1, x2, y2, r2) {
    const dx = x1 - x2;
    const dy = y1 - y2;
    const dist2 = dx * dx + dy * dy;
    const minDist = r1 + r2;

    if (dist2 >= minDist * minDist) return null;

    const dist = Math.sqrt(dist2);

    // Handle exact overlap
    if (dist === 0) {
      const angle = rng() * Math.PI * 2;
      return {
        collided: true,
        depth: minDist,
        nx: Math.cos(angle),
        ny: Math.sin(angle),
      };
    }

    return {
      collided: true,
      depth: minDist - dist,
      nx: dx / dist,
      ny: dy / dist,
    };
  }

  /**
   * Test Circle vs AABB collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testCircleAABB(circleX, circleY, circleR, boxX, boxY, boxW, boxH) {
    const halfW = boxW * 0.5;
    const halfH = boxH * 0.5;

    // Find the closest point on the AABB to the circle center
    const closestX = Math.max(boxX - halfW, Math.min(circleX, boxX + halfW));
    const closestY = Math.max(boxY - halfH, Math.min(circleY, boxY + halfH));

    // Calculate distance from circle center to closest point
    const dx = circleX - closestX;
    const dy = circleY - closestY;
    const dist2 = dx * dx + dy * dy;

    if (dist2 >= circleR * circleR) return null;

    const dist = Math.sqrt(dist2);

    // Circle center is inside the box
    if (dist === 0) {
      // Find which edge is closest
      const distToLeft = circleX - (boxX - halfW);
      const distToRight = boxX + halfW - circleX;
      const distToTop = circleY - (boxY - halfH);
      const distToBottom = boxY + halfH - circleY;

      const minDistX = Math.min(distToLeft, distToRight);
      const minDistY = Math.min(distToTop, distToBottom);

      if (minDistX < minDistY) {
        // Push horizontally
        const nx = distToLeft < distToRight ? -1 : 1;
        return {
          collided: true,
          depth: minDistX + circleR,
          nx: nx,
          ny: 0,
        };
      } else {
        // Push vertically
        const ny = distToTop < distToBottom ? -1 : 1;
        return {
          collided: true,
          depth: minDistY + circleR,
          nx: 0,
          ny: ny,
        };
      }
    }

    return {
      collided: true,
      depth: circleR - dist,
      nx: dx / dist,
      ny: dy / dist,
    };
  }

  /**
   * Test AABB vs AABB collision
   * @returns {{ collided: boolean, depth: number, nx: number, ny: number } | null}
   */
  testAABBAABB(x1, y1, w1, h1, x2, y2, w2, h2) {
    const halfW1 = w1 * 0.5;
    const halfH1 = h1 * 0.5;
    const halfW2 = w2 * 0.5;
    const halfH2 = h2 * 0.5;

    // Calculate overlap on each axis
    const dx = x1 - x2;
    const dy = y1 - y2;

    const overlapX = halfW1 + halfW2 - Math.abs(dx);
    const overlapY = halfH1 + halfH2 - Math.abs(dy);

    // No collision if no overlap on either axis
    if (overlapX <= 0 || overlapY <= 0) return null;

    // Push along axis with smallest overlap (Separating Axis Theorem)
    if (overlapX < overlapY) {
      // Push horizontally
      const nx = dx > 0 ? 1 : -1;
      return {
        collided: true,
        depth: overlapX,
        nx: nx,
        ny: 0,
      };
    } else {
      // Push vertically
      const ny = dy > 0 ? 1 : -1;
      return {
        collided: true,
        depth: overlapY,
        nx: 0,
        ny: ny,
      };
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
