// Spatial Worker - Builds spatial hash grid and finds neighbors
// Now uses per-entity visual ranges and accurate distance checking

importScripts("config.js");
importScripts("gameObject.js");

let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;
let pause = true;
let entityCount = 0;

// Neighbor buffer layout:
// For each entity: [count, id1, id2, ..., id_MAX]
let neighborBuffer;
let neighborData;

// Spatial grid structure
// Each cell contains a list of entity indices
const grid = Array.from({ length: TOTAL_CELLS }, () => []);

function initSpatialWorker(gameObjectBuffer, neighborsBuffer, count) {
  console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

  entityCount = count;

  // Initialize GameObject arrays
  GameObject.initializeArrays(gameObjectBuffer, count);

  neighborBuffer = neighborsBuffer;
  neighborData = new Int32Array(neighborBuffer);

  console.log(
    `SPATIAL WORKER: Grid is ${GRID_COLS}x${GRID_ROWS} = ${TOTAL_CELLS} cells`
  );
  console.log(
    `SPATIAL WORKER: Max ${MAX_NEIGHBORS_PER_ENTITY} neighbors per entity`
  );
  console.log(
    `SPATIAL WORKER: Using per-entity visual ranges with accurate distance checking`
  );

  // Start the spatial partitioning loop
  gameLoop();
}

// Get cell index from position
function getCellIndex(x, y) {
  const col = Math.floor(x / CELL_SIZE);
  const row = Math.floor(y / CELL_SIZE);

  // Clamp to grid bounds
  const clampedCol = Math.max(0, Math.min(GRID_COLS - 1, col));
  const clampedRow = Math.max(0, Math.min(GRID_ROWS - 1, row));

  return clampedRow * GRID_COLS + clampedCol;
}

// Clear and rebuild spatial grid
function rebuildGrid() {
  // Clear all cells
  for (let i = 0; i < TOTAL_CELLS; i++) {
    grid[i].length = 0;
  }

  // Insert all entities into grid
  const x = GameObject.x;
  const y = GameObject.y;

  for (let i = 0; i < entityCount; i++) {
    const cellIndex = getCellIndex(x[i], y[i]);
    grid[cellIndex].push(i);
  }
}

// Find neighbors for all entities using spatial grid
// Now uses per-entity visual ranges and checks actual distances!
function findAllNeighbors() {
  const x = GameObject.x;
  const y = GameObject.y;
  const visualRange = GameObject.visualRange;

  for (let i = 0; i < entityCount; i++) {
    const myX = x[i];
    const myY = y[i];
    const myVisualRange = visualRange[i];
    const visualRangeSq = myVisualRange * myVisualRange;

    // Calculate how many cells we need to check based on visual range
    // If visual range is 25 and cell size is 50, we check 1 cell in each direction (3x3)
    // If visual range is 75 and cell size is 50, we check 2 cells in each direction (5x5)
    const cellRadius = Math.ceil(myVisualRange / CELL_SIZE);

    // Get entity's cell coordinates
    const col = Math.floor(myX / CELL_SIZE);
    const row = Math.floor(myY / CELL_SIZE);

    // Buffer offset for this entity's neighbor list
    const offset = i * (1 + MAX_NEIGHBORS_PER_ENTITY);
    let neighborCount = 0;

    // Check grid cells within cellRadius
    for (let dy = -cellRadius; dy <= cellRadius; dy++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const checkCol = col + dx;
        const checkRow = row + dy;

        // Skip if out of bounds
        if (
          checkCol < 0 ||
          checkCol >= GRID_COLS ||
          checkRow < 0 ||
          checkRow >= GRID_ROWS
        ) {
          continue;
        }

        const cellIndex = checkRow * GRID_COLS + checkCol;
        const cell = grid[cellIndex];

        // Check all entities in this cell
        for (let k = 0; k < cell.length; k++) {
          const j = cell[k];

          // Skip self
          if (i === j) continue;

          // Stop if we've hit the neighbor limit
          if (neighborCount >= MAX_NEIGHBORS_PER_ENTITY) break;

          // Calculate squared distance
          const dx = x[j] - myX;
          const dy = y[j] - myY;
          const distSq = dx * dx + dy * dy;

          // Only add if within visual range
          if (distSq < visualRangeSq && distSq > 0) {
            neighborData[offset + 1 + neighborCount] = j;
            neighborCount++;
          }
        }

        if (neighborCount >= MAX_NEIGHBORS_PER_ENTITY) break;
      }
      if (neighborCount >= MAX_NEIGHBORS_PER_ENTITY) break;
    }

    // Store neighbor count at the beginning
    neighborData[offset] = neighborCount;
  }
}

function gameLoop(resuming = false) {
  if (pause) return;
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;
  const dtRatio = resuming ? 1 : deltaTime / 16.67;

  // Rebuild spatial grid and find neighbors every 2 frames
  if (FRAMENUM % 2 === 0) {
    rebuildGrid();
    findAllNeighbors();
  }

  // Log FPS every 30 frames
  if (FRAMENUM % 30 === 0) {
    self.postMessage({ msg: "fps", fps: fps.toFixed(2) });
  }

  requestAnimationFrame(gameLoop);
}

self.onmessage = (e) => {
  if (e.data.msg === "init") {
    pause = false;
    initSpatialWorker(
      e.data.gameObjectBuffer,
      e.data.neighborBuffer,
      e.data.entityCount
    );
  }
  if (e.data.msg === "pause") {
    pause = true;
  }
  if (e.data.msg === "resume") {
    pause = false;
    gameLoop(true);
  }
};
