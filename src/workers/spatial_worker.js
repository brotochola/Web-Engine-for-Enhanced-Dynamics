self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// Spatial Worker - Builds spatial hash grid and finds neighbors
// OPTIMIZED: Uses flat grid, processed bitmask, and pre-computed entity data

// Import engine dependencies
import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { AbstractWorker } from "./AbstractWorker.js";
import {
  SPATIAL_STATS,
  createMultiWorkerStatsWriter,
} from "./workers-utils.js";

/**
 * SpatialWorker - Handles spatial partitioning and neighbor detection
 * Uses a spatial hash grid to efficiently find nearby entities
 * Extends AbstractWorker for common worker functionality
 *
 * OPTIMIZATIONS:
 * 1. Flat grid structure (TypedArrays) - eliminates GC pressure from Array-of-Arrays
 * 2. Processed bitmask - prevents duplicate neighbor searches for multi-cell entities
 * 3. Pre-computed entity data - avoids redundant calculations per cell appearance
 * 4. SHARED GRID, SPLIT WORK: Each worker builds FULL grid but only processes its assigned entities
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial worker doesn't create GameObject instances (but has access to all components)
    this.needsGameScripts = false;

    // WORKER INDEX AND ENTITY RANGE (for parallel processing)
    this.workerIndex = 0; // Which spatial worker is this? (0, 1, 2, ...)
    this.totalSpatialWorkers = 1; // Total number of spatial workers
    this.entityStartIndex = 0; // First entity this worker processes
    this.entityEndIndex = 0; // Last entity this worker processes (exclusive)

    // FLAT GRID STRUCTURE (replaces Array-of-Arrays)
    // gridEntities: flat array storing entity IDs per cell
    // gridCounts: number of entities in each cell
    this.gridEntities = null; // Uint32Array - [cell0_ent0, cell0_ent1, ..., cell1_ent0, ...]
    this.gridCounts = null; // Uint16Array - count per cell
    this.maxEntitiesPerCell = 64; // Max entities that can share a cell

    // Grid parameters - set during initialization
    this.cellSize = 0;
    this.invCellSize = 0; // 1/cellSize - multiply instead of divide
    this.gridCols = 0;
    this.gridRows = 0;
    this.totalCells = 0;
    this.maxNeighborsPerEntity = 0;

    // Track which cells are occupied - only clear these instead of all cells
    this.occupiedCells = null; // Uint32Array - stores cell indices
    this.occupiedCount = 0;

    // PROCESSED BITMASK - prevents duplicate processing of multi-cell entities
    this.processedThisFrame = null; // Uint8Array

    // PRE-COMPUTED ENTITY DATA - avoid redundant calculations
    this.entityPosX = null; // Float32Array - collider position X
    this.entityPosY = null; // Float32Array - collider position Y
    this.entityHalfExtent = null; // Float32Array - max half-extent for distance checks

    // Update frequency (rebuild grid every N frames)
    this.spatialUpdateInterval = 2;

    // Stats tracking
    this.neighborChecksThisFrame = 0;
    this.gridCellsCheckedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;
  }

  /**
   * Initialize spatial worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    // Note: Component arrays are automatically initialized by AbstractWorker.initializeAllComponents()
    // This includes Transform, Collider, SpriteRenderer, and all other components

    // Set worker index and total workers for parallel processing
    this.workerIndex = data.workerIndex || 0;
    this.totalSpatialWorkers = data.totalSpatialWorkers || 1;

    // Initialize stats buffer for writing metrics (strided access for multi-worker)
    if (data.buffers.spatialStats) {
      this.stats = createMultiWorkerStatsWriter(
        data.buffers.spatialStats,
        SPATIAL_STATS,
        this.workerIndex
      );
      console.log(
        `SPATIAL WORKER ${this.workerIndex}: Stats buffer initialized`
      );
    }

    // Calculate entity range for this worker
    // SHARED GRID, SPLIT WORK: Each worker processes a subset of entities
    const entitiesPerWorker = Math.ceil(
      this.entityCount / this.totalSpatialWorkers
    );
    this.entityStartIndex = this.workerIndex * entitiesPerWorker;
    this.entityEndIndex = Math.min(
      this.entityStartIndex + entitiesPerWorker,
      this.entityCount
    );

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

    // FLAT GRID STRUCTURE - single allocation, no GC pressure
    // Each cell has maxEntitiesPerCell slots
    // NOTE: Each worker builds the FULL grid (reads ALL entity positions)
    this.gridEntities = new Uint32Array(
      this.totalCells * this.maxEntitiesPerCell
    );
    this.gridCounts = new Uint16Array(this.totalCells);

    // Track occupied cells - worst case is ALL cells occupied
    this.occupiedCells =
      this.totalCells <= 65535
        ? new Uint16Array(this.totalCells)
        : new Uint32Array(this.totalCells);
    this.occupiedCount = 0;

    // PROCESSED BITMASK - one bit per entity to track if already processed
    this.processedThisFrame = new Uint8Array(this.entityCount);

    // PRE-COMPUTED ENTITY DATA - calculated once per frame in rebuildGrid
    // NOTE: Pre-compute for ALL entities (needed for full grid awareness)
    this.entityPosX = new Float32Array(this.entityCount);
    this.entityPosY = new Float32Array(this.entityCount);
    this.entityHalfExtent = new Float32Array(this.entityCount);
  }

  /**
   * Clear and rebuild spatial grid
   * OPTIMIZED: Uses flat grid structure with TypedArrays
   * - Zero GC pressure (no array allocations)
   * - Cache-friendly sequential access
   * - Pre-computes entity positions and half-extents for findAllNeighbors
   */
  rebuildGrid() {
    const gridEntities = this.gridEntities;
    const gridCounts = this.gridCounts;
    const occupiedCells = this.occupiedCells;
    const maxEntitiesPerCell = this.maxEntitiesPerCell;

    // Clear only cells that were occupied last frame - O(occupiedCells) not O(totalCells)
    for (let i = 0; i < this.occupiedCount; i++) {
      gridCounts[occupiedCells[i]] = 0;
    }
    this.occupiedCount = 0;

    // Cache frequently accessed values
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const invCellSize = this.invCellSize;
    const gridCols = this.gridCols;
    const gridRows = this.gridRows;
    const maxCol = gridCols - 1;
    const maxRow = gridRows - 1;
    const entityCount = this.entityCount;

    // Pre-computed entity data arrays
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // Shape type constants
    const SHAPE_CIRCLE = 0;

    let occupiedIdx = 0;

    // Insert only active entities into grid
    for (let i = 0; i < entityCount; i++) {
      // Skip inactive entities - they don't participate in spatial queries
      if (!active[i]) continue;

      // Use collider position (transform + offset) for grid placement
      const posX = x[i] + (offsetX[i] || 0);
      const posY = y[i] + (offsetY[i] || 0);

      // Skip entities with invalid positions (NaN check via self-comparison)
      if (posX !== posX || posY !== posY) continue;

      // PRE-COMPUTE: Store collider position for findAllNeighbors
      entityPosX[i] = posX;
      entityPosY[i] = posY;

      // Calculate entity's bounding box half-extents based on collider type
      let halfW = 0,
        halfH = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          // Circle: use radius for both dimensions
          halfW = halfH = radius[i] || 0;
        } else {
          // Box: use half width/height
          halfW = (width[i] || 0) * 0.5;
          halfH = (height[i] || 0) * 0.5;
        }
      }

      // PRE-COMPUTE: Store max half-extent for neighbor distance checks
      entityHalfExtent[i] = halfW > halfH ? halfW : halfH;

      // Calculate cell range the entity's bounding box covers
      let minCol = ((posX - halfW) * invCellSize) | 0;
      let maxColBB = ((posX + halfW) * invCellSize) | 0;
      let minRow = ((posY - halfH) * invCellSize) | 0;
      let maxRowBB = ((posY + halfH) * invCellSize) | 0;

      // Clamp to grid bounds
      minCol = minCol < 0 ? 0 : minCol > maxCol ? maxCol : minCol;
      maxColBB = maxColBB < 0 ? 0 : maxColBB > maxCol ? maxCol : maxColBB;
      minRow = minRow < 0 ? 0 : minRow > maxRow ? maxRow : minRow;
      maxRowBB = maxRowBB < 0 ? 0 : maxRowBB > maxRow ? maxRow : maxRowBB;

      // Add entity to ALL cells its bounding box overlaps
      for (let r = minRow; r <= maxRowBB; r++) {
        for (let c = minCol; c <= maxColBB; c++) {
          const cellIndex = r * gridCols + c;
          const count = gridCounts[cellIndex];

          // Track newly occupied cells (only when first entity enters)
          if (count === 0) {
            occupiedCells[occupiedIdx++] = cellIndex;
          }

          // Add entity to cell if not full
          if (count < maxEntitiesPerCell) {
            gridEntities[cellIndex * maxEntitiesPerCell + count] = i;
            gridCounts[cellIndex] = count + 1;
          }
        }
      }
    }

    this.occupiedCount = occupiedIdx;
  }

  /**
   * Find neighbors for all entities using spatial grid
   * OPTIMIZED:
   * 1. Uses processed bitmask to skip duplicate processing of multi-cell entities
   * 2. Uses pre-computed entity positions and half-extents
   * 3. Flat grid access is cache-friendly
   * 4. SHARED GRID, SPLIT WORK: Processes only assigned entity range
   */
  findAllNeighbors() {
    const active = Transform.active;
    const visualRange = Collider.visualRange;
    const gridEntities = this.gridEntities;
    const gridCounts = this.gridCounts;
    const occupiedCells = this.occupiedCells;
    const occupiedCount = this.occupiedCount;
    const neighborData = this.neighborData;
    const distanceData = this.distanceData;
    const invCellSize = this.invCellSize;
    const gridCols = this.gridCols;
    const gridRows = this.gridRows;
    const maxNeighbors = this.maxNeighborsPerEntity;
    const stride = 1 + maxNeighbors;
    const maxEntitiesPerCell = this.maxEntitiesPerCell;

    // Pre-computed entity data (filled in rebuildGrid)
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // WORKER ENTITY RANGE - only process our assigned entities
    const entityStartIndex = this.entityStartIndex;
    const entityEndIndex = this.entityEndIndex;

    // Reset stats for this frame
    this.neighborChecksThisFrame = 0;
    this.gridCellsCheckedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;

    // PROCESSED BITMASK - clear at start of frame
    const processed = this.processedThisFrame;
    processed.fill(0);

    // Process only entities in occupied cells
    for (let cellIdx = 0; cellIdx < occupiedCount; cellIdx++) {
      const centerCellIndex = occupiedCells[cellIdx];
      const centerCellLen = gridCounts[centerCellIndex];
      const centerCellBase = centerCellIndex * maxEntitiesPerCell;

      // Process each entity in this cell
      for (let e = 0; e < centerCellLen; e++) {
        const i = gridEntities[centerCellBase + e];

        // BOUNDARY FIX: Skip if entity is not in our assigned range
        // This is the key to solving the boundary problem!
        if (i < entityStartIndex || i >= entityEndIndex) continue;

        // BITMASK CHECK: Skip if already processed this frame
        // This eliminates duplicate processing for multi-cell entities
        if (processed[i]) continue;
        processed[i] = 1;

        // Track entity processed
        this.entitiesProcessedThisFrame++;

        // Use PRE-COMPUTED collider position
        const myX = entityPosX[i];
        const myY = entityPosY[i];
        const myVisualRange = visualRange[i];

        // Skip entities with no visual range - they don't need neighbors
        if (myVisualRange <= 0) {
          neighborData[i * stride] = 0;
          distanceData[i * stride] = 0;
          continue;
        }

        // Cell radius for neighbor search (integer math faster than Math.ceil)
        const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

        // Entity's cell coordinates (using collider position)
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
            const checkCellIndex = rowBase + checkCol;
            const cellLength = gridCounts[checkCellIndex];

            // Skip empty cells
            if (cellLength === 0) continue;

            // Track grid cell checked
            this.gridCellsCheckedThisFrame++;

            const cellBase = checkCellIndex * maxEntitiesPerCell;

            // Check all entities in this cell
            for (let k = 0; k < cellLength; k++) {
              const j = gridEntities[cellBase + k];

              // Skip self
              if (i === j) continue;

              // Track neighbor check
              this.neighborChecksThisFrame++;

              // Use PRE-COMPUTED positions for distance calculation
              const jX = entityPosX[j];
              const jY = entityPosY[j];
              const deltaX = jX - myX;
              const deltaY = jY - myY;
              const distSq = deltaX * deltaX + deltaY * deltaY;

              // Use PRE-COMPUTED half-extent
              // Expand effective range by target's half-extent to detect large entities
              const jHalfExtent = entityHalfExtent[j];
              const effectiveRange = myVisualRange + jHalfExtent;
              const effectiveRangeSq = effectiveRange * effectiveRange;

              // Only add if within effective range and not at same position
              if (distSq < effectiveRangeSq && distSq > 0) {
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

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // Write stats to SharedArrayBuffer every frame
    if (this.stats) {
      this.stats[SPATIAL_STATS.FPS] = this.currentFPS;
      this.stats[SPATIAL_STATS.NEIGHBOR_CHECKS] = this.neighborChecksThisFrame;
      this.stats[SPATIAL_STATS.GRID_CELLS_CHECKED] =
        this.gridCellsCheckedThisFrame;
      this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] =
        this.entitiesProcessedThisFrame;
    }
  }
}

// Create singleton instance and setup message handler
const spatialWorker = new SpatialWorker(self);
