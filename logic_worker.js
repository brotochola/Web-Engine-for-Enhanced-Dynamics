// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import dependencies
importScripts("config.js");
importScripts("gameObject.js");
importScripts("boid.js");

// Shared memory references
let neighborData; // Int32Array - precomputed neighbors from spatial worker
let inputData; // Int32Array - mouse and keyboard input
let cameraData; // Float32Array - camera position and zoom

// Game objects - one per entity
let gameObjects = [];
let entityCount = 0;

// Frame timing and FPS tracking
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

/**
 * Initialize the logic worker
 * Sets up shared memory and creates GameObject instances
 */
function initLogicWorker(
  gameObjectBuffer,
  boidBuffer,
  neighborsBuffer,
  inputBuffer,
  camBuffer,
  count,
  registeredClasses
) {
  console.log("LOGIC WORKER: Initializing with GameObject pattern");

  entityCount = count;

  // Initialize GameObject arrays
  GameObject.initializeArrays(gameObjectBuffer, count);

  // Initialize subclass arrays
  for (const classInfo of registeredClasses) {
    if (classInfo.name === "Boid") {
      Boid.initializeArrays(boidBuffer, classInfo.count);
    }
    // Add more entity types here as needed
  }

  neighborData = new Int32Array(neighborsBuffer);
  inputData = new Int32Array(inputBuffer);
  cameraData = new Float32Array(camBuffer);

  // Create GameObject instances
  // Each GameObject just holds its index - data stays in shared arrays!
  for (const classInfo of registeredClasses) {
    const { name, count, startIndex } = classInfo;

    if (name === "Boid") {
      for (let i = 0; i < count; i++) {
        const index = startIndex + i;
        gameObjects[index] = new Boid(index);
      }
      console.log(`LOGIC WORKER: Created ${count} Boid GameObjects`);
    }
    // Add more entity types here as needed
  }

  console.log(`LOGIC WORKER: Total ${entityCount} GameObjects ready`);

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
  const dtRatio = deltaTime / 16.67;

  // Tick all game objects
  // Each GameObject applies its logic, reading/writing directly to shared arrays
  for (let i = 0; i < entityCount; i++) {
    if (gameObjects[i] && gameObjects[i].active) {
      gameObjects[i].tick(dtRatio, neighborData, inputData);
    }
  }

  // Report FPS to main thread every 30 frames
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
      e.data.gameObjectBuffer,
      e.data.boidBuffer,
      e.data.neighborBuffer,
      e.data.inputBuffer,
      e.data.cameraBuffer,
      e.data.entityCount,
      e.data.registeredClasses
    );
  }
};
