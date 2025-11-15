// Spatial Worker - Builds spatial hash grid and finds neighbors
importScripts("boid.js");

let arrays;
let FRAMENUM = 0;
let lastTime = performance.now();
let fps = 0;

// Spatial hash grid configuration
const CELL_SIZE = VISUAL_RANGE * 2; // Each cell covers the visual range
const GRID_COLS = Math.ceil(WIDTH / CELL_SIZE);
const GRID_ROWS = Math.ceil(HEIGHT / CELL_SIZE);
const TOTAL_CELLS = GRID_COLS * GRID_ROWS;

// Neighbor buffer layout:
// For each boid: [count, id1, id2, ..., id_MAX]
// Total size: ENTITY_COUNT * (1 + MAX_NEIGHBORS_PER_BOID) Int32s
let neighborBuffer;
let neighborData;

// Spatial grid structure
// Each cell contains a list of boid indices
const grid = Array.from({ length: TOTAL_CELLS }, () => []);

function initSpatialWorker(sharedBuffer, neighborsBuffer) {
  console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

  arrays = new BoidArrays(sharedBuffer);
  neighborBuffer = neighborsBuffer;
  neighborData = new Int32Array(neighborBuffer);

  console.log(
    `SPATIAL WORKER: Grid is ${GRID_COLS}x${GRID_ROWS} = ${TOTAL_CELLS} cells`
  );
  console.log(
    `SPATIAL WORKER: Max ${MAX_NEIGHBORS_PER_BOID} neighbors per boid`
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

  // Insert all boids into grid
  const x = arrays.x;
  const y = arrays.y;

  for (let i = 0; i < ENTITY_COUNT; i++) {
    const cellIndex = getCellIndex(x[i], y[i]);
    grid[cellIndex].push(i);
  }
}

// Find neighbors for all boids using spatial grid
function findAllNeighbors() {
  const x = arrays.x;
  const y = arrays.y;
  const rangeSq = VISUAL_RANGE * VISUAL_RANGE;

  for (let i = 0; i < ENTITY_COUNT; i++) {
    const myX = x[i];
    const myY = y[i];

    // Get cell coordinates
    const col = Math.floor(myX / CELL_SIZE);
    const row = Math.floor(myY / CELL_SIZE);

    // Buffer offset for this boid's neighbor list
    const offset = i * (1 + MAX_NEIGHBORS_PER_BOID);
    let neighborCount = 0;

    // Check 3x3 grid around boid (9 cells total)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
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

        // Check all boids in this cell
        for (let k = 0; k < cell.length; k++) {
          const j = cell[k];

          if (i === j) continue;
          if (neighborCount >= MAX_NEIGHBORS_PER_BOID) break;

          const dx = x[j] - myX;
          const dy = y[j] - myY;
          const distSq = dx * dx + dy * dy;

          if (distSq < rangeSq) {
            // Store neighbor ID
            neighborData[offset + 1 + neighborCount] = j;
            neighborCount++;
          }
        }

        if (neighborCount >= MAX_NEIGHBORS_PER_BOID) break;
      }
      if (neighborCount >= MAX_NEIGHBORS_PER_BOID) break;
    }

    // Store neighbor count at the beginning
    neighborData[offset] = neighborCount;
  }
}

function gameLoop() {
  FRAMENUM++;
  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;
  fps = 1000 / deltaTime;

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
    initSpatialWorker(e.data.sharedBuffer, e.data.neighborBuffer);
  }
};
