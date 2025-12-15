self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// Spatial Worker - Builds spatial hash grid and finds neighbors
// Now uses per-entity visual ranges and accurate distance checking

// Import engine dependencies
import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { AbstractWorker } from "./AbstractWorker.js";

/**
 * SpatialWorker - Handles spatial partitioning and neighbor detection
 * Uses a spatial hash grid to efficiently find nearby entities
 * Extends AbstractWorker for common worker functionality
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial worker is generic - doesn't need game-specific classes
    this.needsGameScripts = false;

    // Spatial grid structure - initialized after receiving config
    this.grid = null;

    // Grid parameters - set during initialization
    this.cellSize = 0;
    this.invCellSize = 0; // 1/cellSize - multiply instead of divide
    this.gridCols = 0;
    this.gridRows = 0;
    this.totalCells = 0;
    this.maxNeighborsPerEntity = 0;

    // Track which cells are occupied - only clear these instead of all cells
    this.occupiedCells = null; // Uint16Array - stores cell indices
    this.occupiedCount = 0;

    // Update frequency (rebuild grid every N frames)
    this.spatialUpdateInterval = 2;
  }

  /**
   * Initialize spatial worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    // console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

    // Initialize component arrays from SharedArrayBuffers
    // These are needed for spatial queries (position, collision, visibility)
    if (data.buffers?.componentData) {
      if (data.buffers.componentData.Transform) {
        Transform.initializeArrays(
          data.buffers.componentData.Transform,
          data.componentPools?.Transform?.count || this.entityCount
        );
        // console.log(`SPATIAL WORKER: ✅ Transform initialized`);
      }
      // DENSE ALLOCATION: All components have slots for all entities
      // entityIndex === componentIndex for all components
      if (data.buffers.componentData.Collider) {
        Collider.initializeArrays(
          data.buffers.componentData.Collider,
          this.entityCount // DENSE: all entities have slots
        );
      }
      if (data.buffers.componentData.SpriteRenderer) {
        SpriteRenderer.initializeArrays(
          data.buffers.componentData.SpriteRenderer,
          this.entityCount // DENSE: all entities have slots
        );
      }
    }

    // Calculate grid parameters from config
    // Check spatial-specific config first, then fall back to root for backwards compatibility
    this.cellSize = this.config.spatial?.cellSize || this.config.cellSize;
    this.invCellSize = 1 / this.cellSize; // Pre-compute for faster multiply vs divide
    this.gridCols = Math.ceil(this.config.worldWidth / this.cellSize);
    this.gridRows = Math.ceil(this.config.worldHeight / this.cellSize);
    this.totalCells = this.gridCols * this.gridRows;
    this.maxNeighborsPerEntity =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors;

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    // Initialize spatial grid structure
    this.grid = Array.from({ length: this.totalCells }, () => []);

    // Track occupied cells - worst case is all entities in different cells
    // Use Uint16Array for better cache performance (supports up to 65535 cells)
    this.occupiedCells = new Uint16Array(
      Math.min(this.entityCount, this.totalCells)
    );
    this.occupiedCount = 0;

    // console.log(
    //   `SPATIAL WORKER: Grid is ${this.gridCols}x${this.gridRows} = ${this.totalCells} cells`
    // );
    // console.log(
    //   `SPATIAL WORKER: Max ${this.maxNeighborsPerEntity} neighbors per entity`
    // );
    // console.log(
    //   `SPATIAL WORKER: Using per-entity visual ranges with accurate distance checking`
    // );

    // console.log(
    //   "SPATIAL WORKER: Initialization complete, waiting for start signal..."
    // );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Clear and rebuild spatial grid
   * Optimized: only clears previously occupied cells, uses multiply instead of divide
   */
  rebuildGrid() {
    const grid = this.grid;
    const occupiedCells = this.occupiedCells;

    // Clear only cells that were occupied last frame - huge win for sparse grids
    for (let i = 0; i < this.occupiedCount; i++) {
      grid[occupiedCells[i]].length = 0;
    }
    this.occupiedCount = 0;

    // Cache frequently accessed values
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const invCellSize = this.invCellSize;
    const gridCols = this.gridCols;
    const gridRows = this.gridRows;
    const maxCol = gridCols - 1;
    const maxRow = gridRows - 1;
    const entityCount = this.entityCount;

    let occupiedIdx = 0;

    // Insert only active entities into grid
    for (let i = 0; i < entityCount; i++) {
      // Skip inactive entities - they don't participate in spatial queries
      if (!active[i]) continue;

      // Skip entities with invalid positions (NaN check via self-comparison)
      const posX = x[i];
      const posY = y[i];
      if (posX !== posX || posY !== posY) continue;

      // Inline cell calculation - multiply instead of divide, avoid function call
      // Clamp with branchless min/max using ternary (often compiled to CMOV)
      let col = (posX * invCellSize) | 0; // Faster than Math.floor for positive numbers
      let row = (posY * invCellSize) | 0;
      col = col < 0 ? 0 : col > maxCol ? maxCol : col;
      row = row < 0 ? 0 : row > maxRow ? maxRow : row;
      const cellIndex = row * gridCols + col;

      const cell = grid[cellIndex];
      // Track newly occupied cells (only when first entity enters)
      if (cell.length === 0) {
        occupiedCells[occupiedIdx++] = cellIndex;
      }
      cell.push(i);
    }

    this.occupiedCount = occupiedIdx;
  }

  /**
   * Find neighbors for all entities using spatial grid
   * Optimized: processes by occupied cell to improve cache locality
   */
  findAllNeighbors() {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const visualRange = Collider.visualRange;
    const grid = this.grid;
    const occupiedCells = this.occupiedCells;
    const occupiedCount = this.occupiedCount;
    const neighborData = this.neighborData;
    const distanceData = this.distanceData;
    const invCellSize = this.invCellSize;
    const gridCols = this.gridCols;
    const gridRows = this.gridRows;
    const maxNeighbors = this.maxNeighborsPerEntity;
    const stride = 1 + maxNeighbors;

    // Process only entities in occupied cells - better cache locality
    for (let cellIdx = 0; cellIdx < occupiedCount; cellIdx++) {
      const centerCellIndex = occupiedCells[cellIdx];
      const centerCell = grid[centerCellIndex];
      const centerCellLen = centerCell.length;

      // Process each entity in this cell
      for (let e = 0; e < centerCellLen; e++) {
        const i = centerCell[e];

        // Entity data (skip inactive check - already filtered in rebuildGrid)
        const myX = x[i];
        const myY = y[i];
        const myVisualRange = visualRange[i];
        const visualRangeSq = myVisualRange * myVisualRange;

        // Cell radius for neighbor search
        const cellRadius = Math.ceil(myVisualRange * invCellSize);

        // Entity's cell coordinates
        const col = (myX * invCellSize) | 0;
        const row = (myY * invCellSize) | 0;

        // Buffer offset for this entity's neighbor list
        const offset = i * stride;
        let neighborCount = 0;

        // Pre-calculate row bounds (avoid repeated bound checks)
        const rowMin = row - cellRadius;
        const rowMax = row + cellRadius;
        const colMin = col - cellRadius;
        const colMax = col + cellRadius;

        // Clamp bounds once
        const startRow = rowMin < 0 ? 0 : rowMin;
        const endRow = rowMax >= gridRows ? gridRows - 1 : rowMax;
        const startCol = colMin < 0 ? 0 : colMin;
        const endCol = colMax >= gridCols ? gridCols - 1 : colMax;

        // Check grid cells within cellRadius
        for (let checkRow = startRow; checkRow <= endRow; checkRow++) {
          const rowBase = checkRow * gridCols;

          for (let checkCol = startCol; checkCol <= endCol; checkCol++) {
            const cell = grid[rowBase + checkCol];
            const cellLength = cell.length;

            // Skip empty cells
            if (cellLength === 0) continue;

            // Check all entities in this cell
            for (let k = 0; k < cellLength; k++) {
              const j = cell[k];

              // Skip self
              if (i === j) continue;

              // Calculate squared distance
              const deltaX = x[j] - myX;
              const deltaY = y[j] - myY;
              const distSq = deltaX * deltaX + deltaY * deltaY;

              // Only add if within visual range and not at same position
              if (distSq < visualRangeSq && distSq > 0) {
                const writeIdx = offset + 1 + neighborCount;
                neighborData[writeIdx] = j;
                distanceData[writeIdx] = distSq;
                neighborCount++;

                // Stop if we've hit the neighbor limit
                if (neighborCount >= maxNeighbors) break;
              }
            }

            if (neighborCount >= maxNeighbors) break;
          }
          if (neighborCount >= maxNeighbors) break;
        }

        // Store neighbor count at the beginning
        neighborData[offset] = neighborCount;
        distanceData[offset] = neighborCount;
      }
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Mouse position is now written directly to Transform by main thread
    // No special syncing needed - spatial grid will see current position

    // Rebuild spatial grid and find neighbors every frame for physics stability!
    // Was previously skipping frames which causes physics objects to "pass through" each other
    // if they move fast enough to cross cells in the skipped frames.
    this.rebuildGrid();
    this.findAllNeighbors();

    // Screen visibility is now handled by particle_worker to balance workload
  }
}

// Create singleton instance and setup message handler
const spatialWorker = new SpatialWorker(self);
