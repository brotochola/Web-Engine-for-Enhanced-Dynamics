// Physics Worker - Integrates physics (SoA version)
importScripts("boid.js");

let arrays;
let inputData;
let cameraData;
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

function initPhysicsWorker(buffer, inputBuffer, camBuffer) {
  console.log("PHYSICS WORKER: Initializing with SharedArrayBuffer (SoA)");

  arrays = new BoidArrays(buffer);
  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  console.log(`PHYSICS WORKER: Ready to process ${ENTITY_COUNT} boids`);

  // Start the physics loop
  gameLoop();
}

function gameLoop() {
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  const dtRatio = deltaTime / 16.67;

  // Cache-friendly sequential access!
  const x = arrays.x;
  const y = arrays.y;
  const vx = arrays.vx;
  const vy = arrays.vy;
  const ax = arrays.ax;
  const ay = arrays.ay;
  const rotation = arrays.rotation;

  // Apply physics integration to all boids
  for (let i = 0; i < ENTITY_COUNT; i++) {
    // Limit acceleration
    const acceleration = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i]);

    if (acceleration > MAX_ACCELERATION) {
      ax[i] = (ax[i] / acceleration) * MAX_ACCELERATION;
      ay[i] = (ay[i] / acceleration) * MAX_ACCELERATION;
    }

    // Apply acceleration to velocity
    vx[i] += ax[i] * dtRatio;
    vy[i] += ay[i] * dtRatio;

    // Limit speed
    const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);

    if (speed > MAX_SPEED) {
      vx[i] = (vx[i] / speed) * MAX_SPEED;
      vy[i] = (vy[i] / speed) * MAX_SPEED;
    } else if (speed < MIN_SPEED && speed > 0) {
      vx[i] = (vx[i] / speed) * MIN_SPEED;
      vy[i] = (vy[i] / speed) * MIN_SPEED;
    }

    // Apply velocity to position
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;

    // Update rotation
    rotation[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;

    // Clear acceleration (so it's not re-applied next frame)
    ax[i] = 0;
    ay[i] = 0;
  }

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }

  requestAnimationFrame(gameLoop);
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    initPhysicsWorker(
      e.data.sharedBuffer,
      e.data.inputBuffer,
      e.data.cameraBuffer
    );
  }
};
