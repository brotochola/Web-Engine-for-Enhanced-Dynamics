// physics_worker.js - Physics integration (velocity, position updates)
// Separating physics from logic allows both to run in parallel
importScripts("config.js");
importScripts("sharedArrays.js");

// Physics constants
const MAX_ACCELERATION = 0.5; // Prevent extreme accelerations
const MAX_SPEED = 20; // Maximum velocity
const MIN_SPEED = 1; // Minimum velocity (keep moving)

// Shared memory references
let arrays;
let inputData;
let cameraData;

// Frame timing
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

/**
 * Initialize physics worker
 */
function initPhysicsWorker(buffer, inputBuffer, camBuffer) {
  console.log("PHYSICS WORKER: Initializing");

  arrays = new BoidArrays(buffer);
  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  console.log(`PHYSICS WORKER: Ready to integrate ${ENTITY_COUNT} entities`);

  gameLoop();
}

/**
 * Main physics loop
 * Integrates acceleration -> velocity -> position
 */
function gameLoop() {
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  const dtRatio = deltaTime / 16.67;

  // Cache array references for better performance
  const x = arrays.x;
  const y = arrays.y;
  const vx = arrays.vx;
  const vy = arrays.vy;
  const ax = arrays.ax;
  const ay = arrays.ay;
  const rotation = arrays.rotation;

  // Physics integration for all entities
  // This loop is cache-friendly because we access arrays sequentially
  for (let i = 0; i < ENTITY_COUNT; i++) {
    // Step 1: Clamp acceleration to maximum
    const accel = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i]);
    if (accel > MAX_ACCELERATION) {
      const scale = MAX_ACCELERATION / accel;
      ax[i] *= scale;
      ay[i] *= scale;
    }

    // Step 2: Integrate acceleration into velocity
    vx[i] += ax[i] * dtRatio;
    vy[i] += ay[i] * dtRatio;

    // Step 3: Clamp velocity to min/max speed
    const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);

    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed;
      vx[i] *= scale;
      vy[i] *= scale;
    } else if (speed < MIN_SPEED && speed > 0) {
      const scale = MIN_SPEED / speed;
      vx[i] *= scale;
      vy[i] *= scale;
    }

    // Step 4: Integrate velocity into position
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;

    // Step 5: Update sprite rotation to face direction of movement
    rotation[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;

    // Step 6: Clear acceleration (it will be recalculated next frame by logic worker)
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
      e.data.sharedBuffer,
      e.data.inputBuffer,
      e.data.cameraBuffer
    );
  }
};
