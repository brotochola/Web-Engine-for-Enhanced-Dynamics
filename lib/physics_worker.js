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

    // Collision detection
    this.collisionData = null; // SharedArrayBuffer for collision pairs

    // Physics mode: 'standard' (velocity-based) or 'verlet' (position-based)
    this.physicsMode = "standard";

    // Verlet integration settings
    this.subStepCount = 4; // Number of constraint iterations per frame
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

    // Determine physics mode
    const physicsConfig = this.config.physics || {};
    this.physicsMode = physicsConfig.mode || "standard";
    this.subStepCount = physicsConfig.subStepCount || 4;

    console.log(`PHYSICS WORKER: Physics mode: ${this.physicsMode}`);
    if (this.physicsMode === "verlet") {
      console.log(`PHYSICS WORKER: Verlet sub-steps: ${this.subStepCount}`);
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
    // Choose physics integration method based on mode
    if (this.physicsMode === "verlet") {
      this.updateVerlet(deltaTime, dtRatio);
    } else {
      this.updateStandard(deltaTime, dtRatio);
    }
  }

  /**
   * Standard velocity-based physics (original system)
   */
  updateStandard(deltaTime, dtRatio) {
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
    const minSpeed = GameObject.minSpeed;
    const friction = GameObject.friction;

    // Apply global gravity if configured (check physics config first, then root)
    const gravity = this.config.physics?.gravity || this.config.gravity;
    if (gravity) {
      const gx = gravity.x || 0;
      const gy = gravity.y || 0;

      if (gx !== 0 || gy !== 0) {
        for (let i = 0; i < this.entityCount; i++) {
          if (!active[i]) continue;
          ax[i] += gx * dtRatio;
          ay[i] += gy * dtRatio;
        }
      }
    }

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
        minSpeed,
        friction
      );
    }

    // Detect collisions after physics integration
    if (this.collisionData) {
      this.detectCollisions();

      // Apply separation to prevent overlap (simple boid-like push)
      if (this.config.physics?.applySeparation || this.config.applySeparation) {
        this.applySeparation();
      }

      // Resolve collisions physically if enabled (full physics with bounce)
      if (
        this.config.physics?.resolveCollisions ||
        this.config.resolveCollisions
      ) {
        this.resolveCollisions();
      }
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
    minSpeed,
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
    const minimumSpeed = minSpeed[i];

    if (currentSpeed > maxSpeed && maxSpeed > 0) {
      const scale = maxSpeed / currentSpeed;
      vx[i] *= scale;
      vy[i] *= scale;
      speed[i] = maxSpeed;
    } else if (
      currentSpeed < minimumSpeed &&
      currentSpeed > 0 &&
      minimumSpeed > 0
    ) {
      const scale = minimumSpeed / currentSpeed;
      vx[i] *= scale;
      vy[i] *= scale;
      speed[i] = minimumSpeed;
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

  /**
   * Resolve collisions physically (elastic collision response)
   * Reads collision pairs from collisionData buffer and resolves them
   */
  resolveCollisions() {
    if (!this.collisionData) return;

    const x = GameObject.x;
    const y = GameObject.y;
    const vx = GameObject.vx;
    const vy = GameObject.vy;
    const radius = GameObject.radius;
    const maxVel = GameObject.maxVel;

    // Get collision config from physics section (with fallbacks to root for backwards compatibility)
    const physicsConfig = this.config.physics || {};
    const restitution =
      physicsConfig.collisionRestitution ||
      this.config.collisionRestitution ||
      0.5; // Bounciness
    const positionCorrection =
      physicsConfig.collisionPositionCorrection ||
      this.config.collisionPositionCorrection ||
      0.4; // How much to push apart
    const friction =
      physicsConfig.collisionFriction || this.config.collisionFriction || 0.05; // Tangential friction

    // Read collision pairs from buffer
    const pairCount = this.collisionData[0];

    // Resolve each collision pair
    for (let p = 0; p < pairCount; p++) {
      const i = this.collisionData[1 + p * 2];
      const j = this.collisionData[1 + p * 2 + 1];

      // Calculate collision normal
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const dist2 = dx * dx + dy * dy;

      if (dist2 === 0) continue; // Skip if exactly overlapping

      const dist = Math.sqrt(dist2);
      const nx = dx / dist; // Normal X
      const ny = dy / dist; // Normal Y

      // Calculate overlap
      const minDist = radius[i] + radius[j];
      const overlap = minDist - dist;

      if (overlap > 0) {
        // Position correction - push balls apart
        const correction = overlap * positionCorrection * 0.5;
        x[i] -= nx * correction;
        y[i] -= ny * correction;
        x[j] += nx * correction;
        y[j] += ny * correction;

        // Velocity resolution
        const dvx = vx[j] - vx[i];
        const dvy = vy[j] - vy[i];

        // Relative velocity along collision normal
        const velAlongNormal = dvx * nx + dvy * ny;

        // Don't resolve if objects are separating
        if (velAlongNormal < 0) {
          // Calculate impulse
          const impulse = -(1 + restitution) * velAlongNormal * 0.5;

          // Apply impulse to velocities
          vx[i] -= impulse * nx;
          vy[i] -= impulse * ny;
          vx[j] += impulse * nx;
          vy[j] += impulse * ny;

          // Apply friction along tangent
          const tx = -ny; // Tangent X
          const ty = nx; // Tangent Y
          const velAlongTangent = dvx * tx + dvy * ty;
          const frictionImpulse = velAlongTangent * friction * 0.5;

          vx[i] -= frictionImpulse * tx;
          vy[i] -= frictionImpulse * ty;
          vx[j] += frictionImpulse * tx;
          vy[j] += frictionImpulse * ty;
        }
      }
    }

    // Clamp velocities to prevent explosions
    for (let p = 0; p < pairCount; p++) {
      const i = this.collisionData[1 + p * 2];
      const j = this.collisionData[1 + p * 2 + 1];

      // Clamp entity i
      const speedI = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      if (speedI > maxVel[i]) {
        const scale = maxVel[i] / speedI;
        vx[i] *= scale;
        vy[i] *= scale;
      }

      // Clamp entity j
      const speedJ = Math.sqrt(vx[j] * vx[j] + vy[j] * vy[j]);
      if (speedJ > maxVel[j]) {
        const scale = maxVel[j] / speedJ;
        vx[j] *= scale;
        vy[j] *= scale;
      }
    }
  }

  /**
   * Apply simple separation forces to prevent overlap (boid-style)
   * No physics simulation - just push overlapping entities apart
   * This is simpler and more game-like than full collision resolution
   */
  applySeparation() {
    if (!this.collisionData) return;

    const x = GameObject.x;
    const y = GameObject.y;
    const radius = GameObject.radius;

    // Get separation strength from physics config (with fallback to root for backwards compatibility)
    const separationStrength =
      this.config.physics?.separationStrength ||
      this.config.separationStrength ||
      0.5;

    // Read collision pairs from buffer
    const pairCount = this.collisionData[0];

    // Apply separation to each overlapping pair
    for (let p = 0; p < pairCount; p++) {
      const i = this.collisionData[1 + p * 2];
      const j = this.collisionData[1 + p * 2 + 1];

      // Calculate distance between entities
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const dist2 = dx * dx + dy * dy;

      if (dist2 === 0) {
        // Entities are exactly on top of each other - push in random direction
        const angle = Math.random() * Math.PI * 2;
        const pushDist = (radius[i] + radius[j]) * separationStrength;
        x[i] -= Math.cos(angle) * pushDist * 0.5;
        y[i] -= Math.sin(angle) * pushDist * 0.5;
        x[j] += Math.cos(angle) * pushDist * 0.5;
        y[j] += Math.sin(angle) * pushDist * 0.5;
        continue;
      }

      const dist = Math.sqrt(dist2);
      const minDist = radius[i] + radius[j];
      const overlap = minDist - dist;

      // Only push apart if overlapping
      if (overlap > 0) {
        // Calculate push direction (unit vector)
        const nx = dx / dist;
        const ny = dy / dist;

        // Push both entities apart by half the overlap distance
        const pushAmount = overlap * separationStrength * 0.5;
        x[i] -= nx * pushAmount;
        y[i] -= ny * pushAmount;
        x[j] += nx * pushAmount;
        y[j] += ny * pushAmount;
      }
    }
  }

  /**
   * Verlet Integration Physics (RopeBall-style)
   * Uses position-based dynamics with constraint solving
   * More stable for particle systems and large numbers of colliding objects
   */
  updateVerlet(deltaTime, dtRatio) {
    // Cache array references
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const px = GameObject.px;
    const py = GameObject.py;
    const vx = GameObject.vx;
    const vy = GameObject.vy;
    const ax = GameObject.ax;
    const ay = GameObject.ay;
    const velocityAngle = GameObject.velocityAngle;
    const speed = GameObject.speed;
    const maxVel = GameObject.maxVel;
    const radius = GameObject.radius;
    const collisionCount = GameObject.collisionCount;

    // Get gravity configuration
    const gravity = this.config.physics?.gravity || this.config.gravity;
    const gx = gravity?.x || 0;
    const gy = gravity?.y || 0;

    // Get world bounds for boundary constraints
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;

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
      gx,
      gy,
      dtRatio,
      maxVel,
      radius,
      collisionCount
    );

    // Step 2: Apply constraints (collisions, boundaries) with sub-stepping
    for (let step = 0; step < this.subStepCount; step++) {
      this.applyConstraintsVerlet(
        active,
        x,
        y,
        radius,
        collisionCount,
        worldWidth,
        worldHeight
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
      speed
    );
  }

  /**
   * Move balls using Verlet integration
   * Based on RopeBall's moveBalls() method
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
    gx,
    gy,
    dtRatio,
    maxVel,
    radius,
    collisionCount
  ) {
    // Gravity scaling factor (RopeBall uses squared time factor for smooth acceleration)
    const gravity = Math.pow(dtRatio, 2);

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Store old position for Verlet integration
      const oldX = x[i];
      const oldY = y[i];

      // Standard Verlet integration: x_new = 2*x - x_old + forces
      // This gives us: x_new = x + (x - x_old) + forces
      // Which is: x_new = x + velocity + forces

      // Calculate implicit velocity from position history
      let dx = x[i] - px[i];
      let dy = y[i] - py[i];

      // Add forces (gravity + any game logic acceleration)
      dx += gravity * gx + ax[i] * dtRatio;
      dy += gravity * gy + ay[i] * dtRatio;

      // Speed limiting based on collision count (RopeBall feature)
      // More collisions = slower max speed to prevent instability
      let maxSpeed = 100;
      if (collisionCount[i] >= 2) {
        maxSpeed = radius[i] * (1 / collisionCount[i]);
      }

      // Also respect entity's maxVel setting
      if (maxVel[i] > 0 && maxVel[i] < maxSpeed) {
        maxSpeed = maxVel[i];
      }

      // Clamp velocity to prevent instability
      dx = Math.min(Math.max(dx, -maxSpeed), maxSpeed);
      dy = Math.min(Math.max(dy, -maxSpeed), maxSpeed);

      // Apply velocity to get new position
      x[i] = oldX + dx;
      y[i] = oldY + dy;

      // Update previous position (standard Verlet)
      px[i] = oldX;
      py[i] = oldY;

      // Store velocity in vx/vy for compatibility with game logic and rendering
      vx[i] = dx / dtRatio;
      vy[i] = dy / dtRatio;

      // Clear acceleration (will be set by logic worker next frame)
      ax[i] = 0;
      ay[i] = 0;
    }
  }

  /**
   * Apply constraints: boundary constraints and collision resolution
   * Based on RopeBall's doConstraints() method
   * This is run multiple times per frame (sub-stepping) for stability
   */
  applyConstraintsVerlet(
    active,
    x,
    y,
    radius,
    collisionCount,
    worldWidth,
    worldHeight
  ) {
    // Reset collision counts
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;
      collisionCount[i] = 0;
    }

    // Apply boundary constraints
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      const r = radius[i];

      // Clamp to world boundaries
      if (x[i] < r) x[i] = r;
      if (y[i] < r) y[i] = r;
      if (x[i] > worldWidth - r) x[i] = worldWidth - r;
      if (y[i] > worldHeight - r) y[i] = worldHeight - r;
    }

    // Apply collision constraints using spatial grid
    // This mimics RopeBall's chunk-based collision detection
    if (this.neighborData) {
      this.resolveCollisionsVerlet(active, x, y, radius, collisionCount);
    }
  }

  /**
   * Resolve collisions using constraint-based approach
   * Pushes overlapping entities apart (RopeBall style)
   */
  resolveCollisionsVerlet(active, x, y, radius, collisionCount) {
    // Use neighbor data from spatial worker for efficiency
    const maxNeighbors = this.config.maxNeighbors || 100;

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Get neighbors from spatial worker
      const offset = i * (1 + maxNeighbors);
      const neighborCount = this.neighborData ? this.neighborData[offset] : 0;

      // Check collisions with each neighbor
      for (let n = 0; n < neighborCount; n++) {
        const j = this.neighborData[offset + 1 + n];

        if (i === j || !active[j]) continue;

        // Calculate distance between entities
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Check for overlap
        const minDist = radius[i] + radius[j];
        const depth = minDist - dist;

        if (depth > 0 && dist > 0) {
          // Calculate push factor (RopeBall formula)
          const fac = (1 / dist) * depth * 0.5;

          // Push both entities apart
          x[i] += dx * fac;
          y[i] += dy * fac;
          x[j] -= dx * fac;
          y[j] -= dy * fac;

          // Track collision count for speed limiting
          collisionCount[i]++;
          collisionCount[j]++;
        }
      }
    }
  }

  /**
   * Update derived properties from positions
   * Calculate velocity, speed, and angle from position changes
   */
  updateDerivedProperties(active, x, y, px, py, vx, vy, velocityAngle, speed) {
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Velocity is already stored in vx/vy from moveBallsVerlet
      // Just update speed and angle
      const currentSpeed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      speed[i] = currentSpeed;

      // Update rotation to face direction of movement
      if (currentSpeed > 0.01) {
        velocityAngle[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;
      }
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
