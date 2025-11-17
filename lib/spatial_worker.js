// Spatial Worker - Builds spatial hash grid and finds neighbors
// Now uses per-entity visual ranges and accurate distance checking

// Import engine dependencies only
importScripts("gameObject.js");
importScripts("AbstractWorker.js");

// Note: Spatial worker doesn't need game-specific entity classes
// It only works with GameObject arrays for spatial partitioning

/**
 * SpatialWorker - Handles spatial partitioning and neighbor detection
 * Uses a spatial hash grid to efficiently find nearby entities
 * Extends AbstractWorker for common worker functionality
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial grid structure - initialized after receiving config
    this.grid = null;

    // Grid parameters - set during initialization
    this.cellSize = 0;
    this.gridCols = 0;
    this.gridRows = 0;
    this.totalCells = 0;
    this.maxNeighborsPerEntity = 0;

    // Update frequency (rebuild grid every N frames)
    this.spatialUpdateInterval = 2;
  }

  /**
   * Initialize spatial worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    // console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

    // Calculate grid parameters from config
    this.cellSize = this.config.cellSize;
    this.gridCols = Math.ceil(this.config.worldWidth / this.cellSize);
    this.gridRows = Math.ceil(this.config.worldHeight / this.cellSize);
    this.totalCells = this.gridCols * this.gridRows;
    this.maxNeighborsPerEntity = this.config.maxNeighbors;

    // Initialize spatial grid structure
    this.grid = Array.from({ length: this.totalCells }, () => []);

    // console.log(
    //   `SPATIAL WORKER: Grid is ${this.gridCols}x${this.gridRows} = ${this.totalCells} cells`
    // );
    // console.log(
    //   `SPATIAL WORKER: Max ${this.maxNeighborsPerEntity} neighbors per entity`
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
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);

    // Clamp to grid bounds
    const clampedCol = Math.max(0, Math.min(this.gridCols - 1, col));
    const clampedRow = Math.max(0, Math.min(this.gridRows - 1, row));

    return clampedRow * this.gridCols + clampedCol;
  }

  /**
   * Clear and rebuild spatial grid
   */
  rebuildGrid() {
    // Clear all cells efficiently - reuse arrays to avoid memory churn
    for (let i = 0; i < this.totalCells; i++) {
      this.grid[i].length = 0;
    }

    // Insert only active entities into grid
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;

    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - they don't participate in spatial queries
      if (!active[i]) continue;

      // Skip entities with invalid positions (race condition during initialization)
      const posX = x[i];
      const posY = y[i];
      if (isNaN(posX) || isNaN(posY)) continue;

      const cellIndex = this.getCellIndex(posX, posY);
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

      // Skip entities with invalid positions
      if (isNaN(x[i]) || isNaN(y[i])) continue;

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
    const cellRadius = Math.ceil(myVisualRange / this.cellSize);

    // Get entity's cell coordinates
    const col = Math.floor(myX / this.cellSize);
    const row = Math.floor(myY / this.cellSize);

    // Buffer offset for this entity's neighbor list
    const offset = i * (1 + this.maxNeighborsPerEntity);
    let neighborCount = 0;

    // Check grid cells within cellRadius
    for (let rowOffset = -cellRadius; rowOffset <= cellRadius; rowOffset++) {
      for (let colOffset = -cellRadius; colOffset <= cellRadius; colOffset++) {
        const checkCol = col + colOffset;
        const checkRow = row + rowOffset;

        // Skip if out of bounds
        if (
          checkCol < 0 ||
          checkCol >= this.gridCols ||
          checkRow < 0 ||
          checkRow >= this.gridRows
        ) {
          continue;
        }

        const cellIndex = checkRow * this.gridCols + checkCol;
        const cell = this.grid[cellIndex];
        const cellLength = cell.length;

        // Skip empty cells - common case optimization
        if (cellLength === 0) continue;

        // Check all entities in this cell
        for (let k = 0; k < cellLength; k++) {
          const j = cell[k];

          // Skip self
          if (i === j) continue;

          // Stop if we've hit the neighbor limit
          if (neighborCount >= this.maxNeighborsPerEntity) break;

          // Calculate squared distance (fixed variable names to avoid shadowing)
          const deltaX = x[j] - myX;
          const deltaY = y[j] - myY;
          const distSq = deltaX * deltaX + deltaY * deltaY;

          // Only add if within visual range
          if (distSq < visualRangeSq && distSq > 0) {
            this.neighborData[offset + 1 + neighborCount] = j;
            neighborCount++;
          }
        }

        if (neighborCount >= this.maxNeighborsPerEntity) break;
      }
      if (neighborCount >= this.maxNeighborsPerEntity) break;
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
