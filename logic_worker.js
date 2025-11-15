// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import dependencies
importScripts("config.js");
importScripts("sharedArrays.js");
importScripts("gameObject.js");
importScripts("boid.js");

// Shared memory references
let arrays; // BoidArrays - typed views into SharedArrayBuffer
let neighborData; // Int32Array - precomputed neighbors from spatial worker
let inputData; // Int32Array - mouse and keyboard input
let cameraData; // Float32Array - camera position and zoom

// Game objects - one per entity
let gameObjects = [];

// Frame timing and FPS tracking
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

/**
 * Initialize the logic worker
 * Sets up shared memory and creates GameObject instances
 */
function initLogicWorker(
  sharedBuffer,
  neighborsBuffer,
  inputBuffer,
  camBuffer
) {
  console.log("LOGIC WORKER: Initializing with GameObject pattern");

  // Create typed array views into shared memory
  arrays = new BoidArrays(sharedBuffer);
  neighborData = new Int32Array(neighborsBuffer);
  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  // Create GameObject instances
  // Each GameObject just holds its index - data stays in shared arrays!
  for (let i = 0; i < ENTITY_COUNT; i++) {
    gameObjects[i] = new Boid(i);
  }

  console.log(`LOGIC WORKER: Created ${ENTITY_COUNT} Boid GameObjects`);

  // Start the game loop
  gameLoop();
}

/**
 * Main game loop - runs every frame
 * Calls tick() on all game objects
 */
function gameLoop() {
  FRAMENUM++;

  // Calculate delta time
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

  // Normalize delta time to 60fps (16.67ms per frame)
  // dtRatio = 1.0 means perfect 60fps
  // dtRatio = 2.0 means 30fps (compensate for slow frame)
  const dtRatio = deltaTime / 16.67;

  // Tick all game objects
  // This is where the magic happens - each GameObject applies its logic
  // Data is read/written directly to shared arrays (cache-friendly!)
  for (let i = 0; i < ENTITY_COUNT; i++) {
    if (gameObjects[i].active) {
      gameObjects[i].tick(dtRatio, arrays, neighborData, inputData);
    }
  }

  // Report FPS to main thread every 30 frames (twice per second at 60fps)
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }

  // Schedule next frame
  requestAnimationFrame(gameLoop);
}

/**
 * Message handler - receives initialization data from main thread
 */
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
