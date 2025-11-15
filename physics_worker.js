// physics_worker.js - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays

importScripts("config.js");
importScripts("gameObject.js");

// Shared memory references
let inputData;
let cameraData;
let entityCount = 0;

// Frame timing
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

// Physics constants (fallback minimums)
const MIN_SPEED = 1; // Minimum velocity (keep moving)

/**
 * Initialize physics worker
 */
function initPhysicsWorker(gameObjectBuffer, inputBuffer, camBuffer, count) {
  console.log("PHYSICS WORKER: Initializing");

  entityCount = count;

  // Initialize GameObject arrays
  GameObject.initializeArrays(gameObjectBuffer, count);

  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  console.log(`PHYSICS WORKER: Ready to integrate ${count} entities`);

  gameLoop();
}

/**
 * Main physics loop
 * Integrates acceleration -> velocity -> position
 * Now uses per-entity physics properties!
 */
function gameLoop() {
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  const dtRatio = deltaTime / 16.67;

  // Cache array references for better performance
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
  for (let i = 0; i < entityCount; i++) {
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
    } else if (speed < MIN_SPEED && speed > 0) {
      const scale = MIN_SPEED / speed;
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

  // Report FPS
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }

  requestAnimationFrame(gameLoop);
}

/**
 * Message handler
 */
self.onmessage = (e) => {
  if (e.data.msg === "init") {
    initPhysicsWorker(
      e.data.gameObjectBuffer,
      e.data.inputBuffer,
      e.data.cameraBuffer,
      e.data.entityCount
    );
  }
};
