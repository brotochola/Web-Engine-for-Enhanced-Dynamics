// Spatial Worker - Builds spatial hash grid and finds neighbors
// Now uses per-entity visual ranges and accurate distance checking

importScripts("config.js");
importScripts("gameObject.js");
importScripts("AbstractWorker.js");

/**
 * SpatialWorker - Handles spatial partitioning and neighbor detection
 * Uses a spatial hash grid to efficiently find nearby entities
 * Extends AbstractWorker for common worker functionality
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Neighbor buffer layout: For each entity: [count, id1, id2, ..., id_MAX]
    this.neighborBuffer = null;
    this.neighborData = null;

    // Spatial grid structure - each cell contains a list of entity indices
    this.grid = Array.from({ length: TOTAL_CELLS }, () => []);

    // Update frequency (rebuild grid every N frames)
    this.spatialUpdateInterval = 2;
  }

  /**
   * Initialize spatial worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    // console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

    // Initialize common buffers from AbstractWorker
    this.initializeCommonBuffers(data);

    // Initialize neighbor buffer
    this.neighborBuffer = data.neighborBuffer;
    this.neighborData = new Int32Array(this.neighborBuffer);

    // console.log(
    //   `SPATIAL WORKER: Grid is ${GRID_COLS}x${GRID_ROWS} = ${TOTAL_CELLS} cells`
    // );
    // console.log(
    //   `SPATIAL WORKER: Max ${MAX_NEIGHBORS_PER_ENTITY} neighbors per entity`
    // );
    // console.log(
    //   `SPATIAL WORKER: Using per-entity visual ranges with accurate distance checking`
    // );

    // Start the spatial partitioning loop
    this.startGameLoop();
  }

  /**
   * Get cell index from world position
   */
  getCellIndex(x, y) {
    const col = Math.floor(x / CELL_SIZE);
    const row = Math.floor(y / CELL_SIZE);

    // Clamp to grid bounds
    const clampedCol = Math.max(0, Math.min(GRID_COLS - 1, col));
    const clampedRow = Math.max(0, Math.min(GRID_ROWS - 1, row));

    return clampedRow * GRID_COLS + clampedCol;
  }

  /**
   * Clear and rebuild spatial grid
   */
  rebuildGrid() {
    // Clear all cells
    for (let i = 0; i < TOTAL_CELLS; i++) {
      this.grid[i].length = 0;
    }

    // Insert only active entities into grid
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;

    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - they don't participate in spatial queries
      if (!active[i]) continue;

      const cellIndex = this.getCellIndex(x[i], y[i]);
      this.grid[cellIndex].push(i);
    }
  }

  /**
   * Find neighbors for all entities using spatial grid
   * Uses per-entity visual ranges and checks actual distances
   */
  findAllNeighbors() {
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const visualRange = GameObject.visualRange;

    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - they don't need neighbor updates
      if (!active[i]) continue;

      this.findNeighborsForEntity(i, x, y, visualRange);
    }
  }

  /**
   * Find neighbors for a single entity
   */
  findNeighborsForEntity(i, x, y, visualRange) {
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
        const cell = this.grid[cellIndex];

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
            this.neighborData[offset + 1 + neighborCount] = j;
            neighborCount++;
          }
        }

        if (neighborCount >= MAX_NEIGHBORS_PER_ENTITY) break;
      }
      if (neighborCount >= MAX_NEIGHBORS_PER_ENTITY) break;
    }

    // Store neighbor count at the beginning
    this.neighborData[offset] = neighborCount;
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Rebuild spatial grid and find neighbors every N frames
    if (this.frameNumber % this.spatialUpdateInterval === 0) {
      this.rebuildGrid();
      this.findAllNeighbors();
    }
  }
}

// Create singleton instance and setup message handler
const spatialWorker = new SpatialWorker(self);
