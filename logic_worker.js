// Logic Worker - Calculates accelerations using precomputed neighbors (SoA version)
importScripts("boid.js");

let arrays;
let neighborData;
let inputData;
let cameraData;
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

function initLogicWorker(
  sharedBuffer,
  neighborsBuffer,
  inputBuffer,
  camBuffer
) {
  console.log(
    "LOGIC WORKER: Initializing with SharedArrayBuffer (SoA + Spatial)"
  );

  arrays = new BoidArrays(sharedBuffer);
  neighborData = new Int32Array(neighborsBuffer);
  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  console.log(
    `LOGIC WORKER: Ready to process ${ENTITY_COUNT} boids with spatial neighbors`
  );

  // Start the logic loop
  gameLoop();
}

function avoidMouse(i, dtRatio) {
  const x = arrays.x;
  const y = arrays.y;
  const ax = arrays.ax;
  const ay = arrays.ay;
  const myX = x[i];
  const myY = y[i];

  // Read mouse position from shared input buffer
  const mouseX = inputData[0];
  const mouseY = inputData[1];

  const dx = myX - mouseX;
  const dy = myY - mouseY;

  const dist2 = dx * dx + dy * dy;
  if (dist2 < 1e-4) return; // prevent division by zero or extremely strong force
  if (dist2 > 10000) return; // prevent division by zero or extremely strong force

  const strength = 4;

  ax[i] += (dx / dist2) * strength * dtRatio;
  ay[i] += (dy / dist2) * strength * dtRatio;
}

// Rule 1: Cohesion - move towards center of mass
function cohesion(i, neighborCount, neighbors, dtRatio) {
  if (neighborCount === 0) return;

  const x = arrays.x;
  const y = arrays.y;
  const ax = arrays.ax;
  const ay = arrays.ay;

  let centerX = 0;
  let centerY = 0;

  for (let n = 0; n < neighborCount; n++) {
    const j = neighbors[n];
    centerX += x[j];
    centerY += y[j];
  }

  centerX /= neighborCount;
  centerY /= neighborCount;

  ax[i] += (centerX - x[i]) * CENTERING_FACTOR * dtRatio;
  ay[i] += (centerY - y[i]) * CENTERING_FACTOR * dtRatio;
}

// Rule 2: Separation - avoid crowding
function separation(i, neighborCount, neighbors, dtRatio) {
  const x = arrays.x;
  const y = arrays.y;
  const ax = arrays.ax;
  const ay = arrays.ay;
  const myX = x[i];
  const myY = y[i];

  let moveX = 0;
  let moveY = 0;

  for (let n = 0; n < neighborCount; n++) {
    const j = neighbors[n];
    const dx = x[j] - myX;
    const dy = y[j] - myY;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < PROTECTED_RANGE * PROTECTED_RANGE && dist2 > 0) {
      moveX -= dx / dist2;
      moveY -= dy / dist2;
    }
  }

  ax[i] += moveX * AVOID_FACTOR * dtRatio;
  ay[i] += moveY * AVOID_FACTOR * dtRatio;
}

// Rule 3: Alignment - match velocity
function alignment(i, neighborCount, neighbors, dtRatio) {
  if (neighborCount === 0) return;

  const vx = arrays.vx;
  const vy = arrays.vy;
  const ax = arrays.ax;
  const ay = arrays.ay;

  let avgVX = 0;
  let avgVY = 0;

  for (let n = 0; n < neighborCount; n++) {
    const j = neighbors[n];
    avgVX += vx[j];
    avgVY += vy[j];
  }

  avgVX /= neighborCount;
  avgVY /= neighborCount;

  ax[i] += (avgVX - vx[i]) * MATCHING_FACTOR * dtRatio;
  ay[i] += (avgVY - vy[i]) * MATCHING_FACTOR * dtRatio;
}

// Keep within bounds
function keepWithinBounds(i, dtRatio) {
  const x = arrays.x;
  const y = arrays.y;
  const ax = arrays.ax;
  const ay = arrays.ay;

  if (x[i] < MARGIN) ax[i] += TURN_FACTOR * dtRatio;
  if (x[i] > WIDTH - MARGIN) ax[i] -= TURN_FACTOR * dtRatio;
  if (y[i] < MARGIN) ay[i] += TURN_FACTOR * dtRatio;
  if (y[i] > HEIGHT - MARGIN) ay[i] -= TURN_FACTOR * dtRatio;
}

function gameLoop() {
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  const dtRatio = deltaTime / 16.67;

  // Process all boids using precomputed neighbors from spatial worker
  for (let i = 0; i < ENTITY_COUNT; i++) {
    // Get neighbor data for this boid
    const offset = i * (1 + MAX_NEIGHBORS_PER_BOID);
    const neighborCount = neighborData[offset];

    // Create a view into the neighbor IDs (avoid copying)
    const neighborsStart = offset + 1;

    // Apply boid rules with precomputed neighbors
    cohesion(
      i,
      neighborCount,
      neighborData.subarray(neighborsStart, neighborsStart + neighborCount),
      dtRatio
    );
    separation(
      i,
      neighborCount,
      neighborData.subarray(neighborsStart, neighborsStart + neighborCount),
      dtRatio
    );
    alignment(
      i,
      neighborCount,
      neighborData.subarray(neighborsStart, neighborsStart + neighborCount),
      dtRatio
    );
    avoidMouse(i, dtRatio);
    keepWithinBounds(i, dtRatio);
  }

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }

  requestAnimationFrame(gameLoop);
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    initLogicWorker(
      e.data.sharedBuffer,
      e.data.neighborBuffer,
      e.data.inputBuffer,
      e.data.cameraBuffer
    );
  }
};
