// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays

importScripts("gameObject.js");
importScripts("AbstractWorker.js");

/**
 * PhysicsWorker - Handles physics integration for all entities
 * Integrates acceleration -> velocity -> position
 * Extends AbstractWorker for common worker functionality
 */
class PhysicsWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Physics constants
    this.MIN_SPEED = 1; // Minimum velocity (keep moving)
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    console.log("PHYSICS WORKER: Initializing");

    console.log(
      `PHYSICS WORKER: Ready to integrate ${this.entityCount} entities`
    );

    // Start the game loop
    this.startGameLoop();
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
    const rotation = GameObject.rotation;
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
        rotation,
        maxVel,
        maxAcc,
        friction
      );
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
    rotation,
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
    const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    const maxSpeed = maxVel[i];

    if (speed > maxSpeed && maxSpeed > 0) {
      const scale = maxSpeed / speed;
      vx[i] *= scale;
      vy[i] *= scale;
    } else if (speed < this.MIN_SPEED && speed > 0) {
      const scale = this.MIN_SPEED / speed;
      vx[i] *= scale;
      vy[i] *= scale;
    }

    // Step 5: Integrate velocity into position
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;

    // Step 6: Update sprite rotation to face direction of movement
    rotation[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;

    // Step 7: Clear acceleration (will be recalculated next frame by logic worker)
    ax[i] = 0;
    ay[i] = 0;
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self);
