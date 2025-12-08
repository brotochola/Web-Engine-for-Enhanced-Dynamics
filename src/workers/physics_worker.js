self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays

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

/**
 * PhysicsWorker - Handles physics integration for all entities
 * Integrates acceleration -> velocity -> position
 * Extends AbstractWorker for common worker functionality
 */
class PhysicsWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Physics worker is generic - doesn't need game-specific classes
    this.needsGameScripts = false;

    // Runtime physics settings (filled from config)
    this.settings = {
      subStepCount: 4,
      boundaryElasticity: 0.8,
      collisionResponseStrength: 0.5,
      verletDamping: 0.995,
      minSpeedForRotation: 0.1,
      gravity: { x: 0, y: 0 },
    };

    // Collision data buffer for Unity-style callbacks
    this.collisionData = null;
    this.maxCollisionPairs = 10000; // Default, will be set from config
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    //console.log("PHYSICS WORKER: Initializing with component system");

    // Initialize component arrays
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );
    if (data.buffers.componentData.RigidBody) {
      RigidBody.initializeArrays(
        data.buffers.componentData.RigidBody,
        data.componentPools.RigidBody.count
      );
    }
    if (data.buffers.componentData.Collider) {
      Collider.initializeArrays(
        data.buffers.componentData.Collider,
        data.componentPools.Collider.count
      );
    }

    // Initialize collision data buffer for Unity-style collision callbacks
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      this.maxCollisionPairs =
        this.config.physics?.maxCollisionPairs ||
        this.config.maxCollisionPairs ||
        10000;
      // console.log(
      //   `PHYSICS WORKER: Collision callbacks enabled (max ${this.maxCollisionPairs} pairs)`
      // );
    }

    this.applyPhysicsConfig(this.config.physics || {});

    // console.log("PHYSICS WORKER: Using Verlet integration exclusively");
    // console.log(
    //   `PHYSICS WORKER: Sub-steps per frame: ${this.settings.subStepCount}`
    // );

    // console.log(
    //   `PHYSICS WORKER: Ready to integrate ${this.entityCount} entities`
    // );
    // console.log(
    //   "PHYSICS WORKER: Initialization complete, waiting for start signal..."
    // );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * Performs physics integration for all entities
   */
  update(deltaTime, dtRatio, resuming) {
    this.updateVerlet(deltaTime, dtRatio);

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
  updateVerlet(deltaTime, dtRatio) {
    // Cache array references from components
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const rotation = Transform.rotation;
    const px = RigidBody.px;
    const py = RigidBody.py;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    const velocityAngle = RigidBody.velocityAngle;
    const speed = RigidBody.speed;
    const maxVel = RigidBody.maxVel;
    const radius = Collider.radius;
    const isTrigger = Collider.isTrigger;
    const collisionCount = RigidBody.collisionCount;

    // Get world bounds for boundary constraints
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

    // Get the number of entities with RigidBody (not all entities have physics)
    const rigidBodyCount = RigidBody.px?.length || 0;

    // Reset collision counters once per frame (used for diagnostics/tuning)
    for (let i = 0; i < rigidBodyCount; i++) {
      if (!active[i]) continue;
      collisionCount[i] = 0;
    }

    const gx = this.settings.gravity.x || 0;
    const gy = this.settings.gravity.y || 0;

    // Step 1: Move balls using Verlet integration
    this.moveBallsVerlet(
      active,
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
      radius,
      rigidBodyCount
    );

    // Step 2: Apply constraints (collisions, boundaries) with sub-stepping
    for (let step = 0; step < this.settings.subStepCount; step++) {
      this.applyConstraintsVerlet(
        active,
        x,
        y,
        radius,
        isTrigger,
        collisionCount,
        worldWidth,
        worldHeight,
        rigidBodyCount
      );
    }

    // Step 3: Update derived properties (velocityAngle, speed) from positions
    this.updateDerivedProperties(
      active,
      x,
      y,
      px,
      py,
      vx,
      vy,
      velocityAngle,
      speed,
      rigidBodyCount
    );
  }

  /**
   * Move balls using Verlet integration
   * ENHANCED: Now includes configurable damping for energy dissipation
   */
  moveBallsVerlet(
    active,
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
    radius,
    rigidBodyCount
  ) {
    const damping = this.settings.verletDamping;

    const gravityScale = Math.pow(dtRatio, 2);

    // Only process entities that have RigidBody component
    for (let i = 0; i < rigidBodyCount; i++) {
      if (!active[i]) continue;

      // Store old position for Verlet integration
      const oldX = x[i];
      const oldY = y[i];

      // Calculate implicit velocity from position history (with damping)
      let dx = (x[i] - px[i]) * damping;
      let dy = (y[i] - py[i]) * damping;

      // Add forces: gravity + game logic acceleration
      dx += gravityScale * gx + ax[i] * dtRatio;
      dy += gravityScale * gy + ay[i] * dtRatio;

      // Speed limiting
      // Use entity's maxVel setting or default to a reasonable cap
      let maxSpeed = maxVel[i] > 0 ? maxVel[i] : 100;

      // Adaptive speed limiting removed - it causes "crushing" behavior in stacks
      // because it prevents the balls from pushing back against gravity strongly enough.
      /*
      if (collisionCount[i] >= 2) {
        // Reduce speed inversely to collision count
        maxSpeed = Math.max(radius[i] * (1 / collisionCount[i]), 0.5);
      }
      */

      // Clamp velocity to prevent instability
      dx = Math.max(-maxSpeed, Math.min(maxSpeed, dx));
      dy = Math.max(-maxSpeed, Math.min(maxSpeed, dy));

      // Apply velocity to get new position
      x[i] = oldX + dx;
      y[i] = oldY + dy;

      // Update previous position (standard Verlet)
      px[i] = oldX;
      py[i] = oldY;

      // Store velocity for compatibility with rendering/game logic
      vx[i] = dx / dtRatio;
      vy[i] = dy / dtRatio;

      // Clear acceleration (will be set by logic worker next frame)
      ax[i] = 0;
      ay[i] = 0;
    }
  }

  /**
   * Apply constraints: boundary constraints and collision resolution
   * ENHANCED: Now includes configurable boundary elasticity (bouncy walls)
   * This is run multiple times per frame (sub-stepping) for stability
   */
  applyConstraintsVerlet(
    active,
    x,
    y,
    radius,
    isTrigger,
    collisionCount,
    worldWidth,
    worldHeight,
    rigidBodyCount
  ) {
    // Get previous position arrays for velocity manipulation
    const px = RigidBody.px;
    const py = RigidBody.py;

    const boundaryElasticity = this.settings.boundaryElasticity;

    // Apply boundary constraints with bounce - only for entities with RigidBody
    for (let i = 0; i < rigidBodyCount; i++) {
      if (!active[i]) continue;

      const r = radius[i];

      // Left boundary
      if (x[i] < r) {
        x[i] = r;
        // Apply bounce by reversing velocity component (manipulate previous position)
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Right boundary
      if (x[i] > worldWidth - r) {
        x[i] = worldWidth - r;
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Top boundary
      if (y[i] < r) {
        y[i] = r;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }

      // Bottom boundary
      if (y[i] > worldHeight - r) {
        y[i] = worldHeight - r;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }
    }

    // Apply collision constraints using spatial grid
    if (this.neighborData) {
      // In Verlet mode, we don't need to rely on neighborData strictly if we're just checking all pairs
      // But that's O(N^2). We must use neighborData.
      // If neighbors are missing, collisions are missed.
      this.resolveCollisionsVerlet(
        active,
        x,
        y,
        radius,
        isTrigger,
        collisionCount,
        rigidBodyCount
      );
    }
  }

  /**
   * Resolve collisions using constraint-based approach
   * ENHANCED: Better handling of exact overlaps and configurable response strength
   * Pushes overlapping entities apart (RopeBall style)
   * Also records collision pairs for Unity-style callbacks (Enter/Stay/Exit)
   *
   * Note: Trigger colliders (isTrigger=1) detect collisions but don't apply physical response
   */
  resolveCollisionsVerlet(
    active,
    x,
    y,
    radius,
    isTrigger,
    collisionCount,
    rigidBodyCount
  ) {
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;

    // Get collision response strength (0.5 = soft/bouncy, 1.0 = rigid)
    const responseStrength = this.settings.collisionResponseStrength;

    // Track collision pairs for callbacks
    let pairCount = 0;
    const collisionData = this.collisionData;
    const maxPairs = this.maxCollisionPairs;

    // Process all entities for collision detection (including trigger-only entities like Mouse)
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Get neighbors from spatial worker
      const offset = i * (1 + maxNeighbors);
      const neighborCount = this.neighborData ? this.neighborData[offset] : 0;

      // Check collisions with each neighbor
      for (let n = 0; n < neighborCount; n++) {
        const j = this.neighborData[offset + 1 + n];

        if (i === j || !active[j]) continue;

        // Only process each pair once (i < j)
        if (i >= j) continue;

        // Calculate distance between entities
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        const dist2 = dx * dx + dy * dy;

        // Check for overlap
        const minDist = radius[i] + radius[j];

        // Early exit if no collision possible
        if (dist2 >= minDist * minDist) continue;

        const dist = Math.sqrt(dist2);

        // Handle exact overlap (rare but possible)
        if (dist === 0) {
          // Check if either entity is a trigger
          const eitherIsTrigger = isTrigger[i] || isTrigger[j];

          // Only apply physical response if neither is a trigger
          if (!eitherIsTrigger) {
            // Push in random direction
            const angle = rng() * Math.PI * 2;
            const separation = 0.001;
            x[i] = x[i] + Math.cos(angle) * separation;
            y[i] = y[i] + Math.sin(angle) * separation;
            x[j] = x[j] - Math.cos(angle) * separation;
            y[j] = y[j] - Math.sin(angle) * separation;
          }

          // Only increment collision count for entities with RigidBody
          if (i < rigidBodyCount) collisionCount[i]++;
          if (j < rigidBodyCount) collisionCount[j]++;

          // Record collision pair for callbacks (even for triggers!)
          if (collisionData && pairCount < maxPairs) {
            collisionData[1 + pairCount * 2] = i;
            collisionData[1 + pairCount * 2 + 1] = j;
            pairCount++;
          }
          continue;
        }

        // Calculate overlap depth
        const depth = minDist - dist;

        if (depth > 0) {
          // Check if either entity is a trigger (no physical response, just detection)
          const eitherIsTrigger = isTrigger[i] || isTrigger[j];

          // Only apply physical response if neither is a trigger
          if (!eitherIsTrigger) {
            // Normalize direction vector
            const nx = dx / dist;
            const ny = dy / dist;

            // Calculate push factor with response strength
            // Split the correction evenly between both entities
            const correction = depth * responseStrength * 0.5;

            // Push both entities apart
            x[i] += nx * correction;
            y[i] += ny * correction;
            x[j] -= nx * correction;
            y[j] -= ny * correction;
          }

          // Track collision count for adaptive speed limiting (only for entities with RigidBody)
          if (i < rigidBodyCount) collisionCount[i]++;
          if (j < rigidBodyCount) collisionCount[j]++;

          // Record collision pair for callbacks (even for triggers!)
          if (collisionData && pairCount < maxPairs) {
            collisionData[1 + pairCount * 2] = i;
            collisionData[1 + pairCount * 2 + 1] = j;
            pairCount++;
          }
        }
      }
    }

    // Write total pair count to shared buffer (index 0)
    if (collisionData) {
      collisionData[0] = pairCount;
    }
  }

  /**
   * Update derived properties from positions
   * ENHANCED: Minimum speed threshold prevents rotation jitter when stationary
   * Calculate velocity, speed, and angle from position changes
   */
  updateDerivedProperties(
    active,
    x,
    y,
    px,
    py,
    vx,
    vy,
    velocityAngle,
    speed,
    rigidBodyCount
  ) {
    const minSpeedForRotation = this.settings.minSpeedForRotation;

    // Only process entities that have RigidBody component
    for (let i = 0; i < rigidBodyCount; i++) {
      if (!active[i]) continue;

      // Velocity is already stored in vx/vy from moveBallsVerlet
      const currentSpeed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      speed[i] = currentSpeed;

      // Only update rotation if moving above minimum threshold
      // This prevents visual jitter when entities are nearly stationary
      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;
      }
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
