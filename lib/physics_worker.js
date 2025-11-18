self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays

// Import engine dependencies only
importScripts("gameObject.js");
importScripts("AbstractWorker.js");

// Note: Game-specific scripts are loaded dynamically by AbstractWorker
// Physics worker only needs GameObject arrays for physics calculations

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

    // Physics constants
    this.MIN_SPEED = 1; // Minimum velocity (keep moving)

    // Collision detection
    this.collisionData = null; // SharedArrayBuffer for collision pairs
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    console.log("PHYSICS WORKER: Initializing");

    // Initialize collision buffer
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      console.log("PHYSICS WORKER: Collision detection enabled");
    }

    console.log(
      `PHYSICS WORKER: Ready to integrate ${this.entityCount} entities`
    );
    console.log(
      "PHYSICS WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * Performs physics integration for all entities
   */
  update(deltaTime, dtRatio, resuming) {
    // Cache array references for better performance
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const vx = GameObject.vx;
    const vy = GameObject.vy;
    const ax = GameObject.ax;
    const ay = GameObject.ay;
    const velocityAngle = GameObject.velocityAngle;
    const speed = GameObject.speed;
    const maxVel = GameObject.maxVel;
    const maxAcc = GameObject.maxAcc;
    const friction = GameObject.friction;

    // Physics integration for all entities
    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - saves expensive physics calculations
      if (!active[i]) continue;

      this.integrateEntity(
        i,
        dtRatio,
        x,
        y,
        vx,
        vy,
        ax,
        ay,
        velocityAngle,
        speed,
        maxVel,
        maxAcc,
        friction
      );
    }

    // Detect collisions after physics integration
    if (this.collisionData) {
      this.detectCollisions();
    }
  }

  /**
   * Integrate physics for a single entity
   */
  integrateEntity(
    i,
    dtRatio,
    x,
    y,
    vx,
    vy,
    ax,
    ay,
    velocityAngle,
    speed,
    maxVel,
    maxAcc,
    friction
  ) {
    // Step 1: Clamp acceleration to entity's maximum
    const accel = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i]);
    const maxAcceleration = maxAcc[i];

    if (accel > maxAcceleration && maxAcceleration > 0) {
      const scale = maxAcceleration / accel;
      ax[i] *= scale;
      ay[i] *= scale;
    }

    // Step 2: Integrate acceleration into velocity
    vx[i] += ax[i] * dtRatio;
    vy[i] += ay[i] * dtRatio;

    // Step 3: Apply friction (if any)
    if (friction[i] > 0) {
      const frictionFactor = Math.pow(1 - friction[i], dtRatio);
      vx[i] *= frictionFactor;
      vy[i] *= frictionFactor;
    }

    // Step 4: Clamp velocity to entity's min/max speed
    const currentSpeed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    const maxSpeed = maxVel[i];

    if (currentSpeed > maxSpeed && maxSpeed > 0) {
      const scale = maxSpeed / currentSpeed;
      vx[i] *= scale;
      vy[i] *= scale;
      speed[i] = maxSpeed;
    } else if (currentSpeed < this.MIN_SPEED && currentSpeed > 0) {
      const scale = this.MIN_SPEED / currentSpeed;
      vx[i] *= scale;
      vy[i] *= scale;
      speed[i] = this.MIN_SPEED;
    } else {
      speed[i] = currentSpeed;
    }

    // Step 5: Integrate velocity into position
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;

    // Step 6: Update sprite rotation to face direction of movement
    velocityAngle[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;

    // Step 7: Clear acceleration (will be recalculated next frame by logic worker)
    ax[i] = 0;
    ay[i] = 0;
  }

  /**
   * Detect collisions between entities (Unity-style)
   * Uses neighbor data from spatial worker for broad phase
   * Writes collision pairs to shared buffer for logic worker to process
   */
  detectCollisions() {
    if (!this.neighborData) return;

    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const radius = GameObject.radius;

    // Track collision pairs (use Set to avoid duplicates)
    const collisionPairs = [];
    const pairSet = new Set();

    // Iterate through all active entities
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Get precomputed neighbors from spatial worker (broad phase)
      const offset = i * (1 + (this.config.maxNeighbors || 100));
      const neighborCount = this.neighborData[offset];

      // Check each neighbor for collision (narrow phase)
      for (let n = 0; n < neighborCount; n++) {
        const j = this.neighborData[offset + 1 + n];

        // Skip if neighbor is inactive
        if (!active[j]) continue;

        // Skip self-collision
        if (i === j) continue;

        // Only check each pair once (i < j ensures this)
        if (i >= j) continue;

        // Circle-circle collision detection
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const distSq = dx * dx + dy * dy;
        const radiusSum = radius[i] + radius[j];
        const radiusSumSq = radiusSum * radiusSum;

        // Collision detected!
        if (distSq < radiusSumSq) {
          // Create unique pair key (smaller index first)
          const pairKey = `${i},${j}`;

          if (!pairSet.has(pairKey)) {
            pairSet.add(pairKey);
            collisionPairs.push(i, j);
          }
        }
      }
    }

    // Write collision pairs to shared buffer
    // Format: [pairCount, entityA, entityB, entityA, entityB, ...]
    const maxPairs = (this.collisionData.length - 1) / 2;
    const actualPairs = Math.min(collisionPairs.length / 2, maxPairs);

    this.collisionData[0] = actualPairs; // Write pair count

    // Write pairs
    for (let i = 0; i < actualPairs * 2; i++) {
      this.collisionData[1 + i] = collisionPairs[i];
    }

    // Debug: Log if we hit the limit
    if (collisionPairs.length / 2 > maxPairs) {
      console.warn(
        `PHYSICS WORKER: Collision buffer overflow! ${
          collisionPairs.length / 2
        } pairs detected, but only ${maxPairs} can be stored.`
      );
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
