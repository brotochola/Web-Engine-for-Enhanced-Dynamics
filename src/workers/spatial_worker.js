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
import { Grid } from "../core/Grid.js";
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

    // Note: activeEntitiesData is now initialized in AbstractWorker.initializeCommonBuffers

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

    // Note: activeEntitiesData is initialized in AbstractWorker.initializeCommonBuffers
    // Active entity range is calculated dynamically each frame in findAllNeighbors()
    // based on the current active entity count from activeEntitiesData[0]

    // Get grid metadata from main thread
    const gridMetadata = data.gridMetadata;
    this.cellSize = gridMetadata.cellSize;
    this.invCellSize = gridMetadata.invCellSize;
    this.gridCols = gridMetadata.gridCols;
    this.gridRows = gridMetadata.gridRows;
    this.totalCells = gridMetadata.totalCells;
    this.maxEntitiesPerCell = gridMetadata.maxEntitiesPerCell;

    this.maxNeighborsPerEntity =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors;

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    // SHARED GRID STRUCTURE - use SharedArrayBuffers from main thread
    // All workers write to same grid (spatial worker 0 writes, others read for raycasting)
    this.gridEntities = new Uint32Array(data.buffers.gridEntities);
    this.gridCounts = new Uint16Array(data.buffers.gridCounts);

    // Track occupied cells - worst case is ALL cells occupied (local to each worker)
    this.occupiedCells =
      this.totalCells <= 65535
        ? new Uint16Array(this.totalCells)
        : new Uint32Array(this.totalCells);
    this.occupiedCount = 0;

    // PROCESSED BITMASK - one bit per entity to track if already processed (local to each worker)
    this.processedThisFrame = new Uint8Array(this.globalEntityCount);

    // PRE-COMPUTED ENTITY DATA - calculated once per frame in rebuildGrid (local to each worker)
    // NOTE: Pre-compute for ALL entities (needed for full grid awareness)
    this.entityPosX = new Float32Array(this.globalEntityCount);
    this.entityPosY = new Float32Array(this.globalEntityCount);
    this.entityHalfExtent = new Float32Array(this.globalEntityCount);

    console.log(
      `SPATIAL WORKER ${this.workerIndex}: Grid initialized with ${this.totalCells} cells (${this.gridCols}x${this.gridRows})`
    );
  }

  /**
   * Clear and rebuild spatial grid
   * OPTIMIZED: Uses flat grid structure with TypedArrays
   * - Zero GC pressure (no array allocations)
   * - Cache-friendly sequential access
   * - Pre-computes entity positions and half-extents for findAllNeighbors
   * - Uses Grid class for unified grid data access
   */
  rebuildGrid() {
    // Use Grid class for grid data access
    const gridEntities = Grid.gridEntities;
    const gridCounts = Grid.gridCounts;
    const occupiedCells = this.occupiedCells;
    const maxEntitiesPerCell = Grid.maxEntitiesPerCell;

    // Clear only cells that were occupied last frame - O(occupiedCells) not O(totalCells)
    for (let i = 0; i < this.occupiedCount; i++) {
      gridCounts[occupiedCells[i]] = 0;
    }
    this.occupiedCount = 0;

    // Cache frequently accessed values
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridCols;
    const gridRows = Grid.gridRows;
    const maxCol = gridCols - 1;
    const maxRow = gridRows - 1;

    // Pre-computed entity data arrays
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // Shape type constants
    const SHAPE_CIRCLE = 0;

    let occupiedIdx = 0;

    // OPTIMIZED: Use active entity list instead of iterating all entities
    // This eliminates the need to check active[i] for every entity
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    // Insert only active entities into grid (iterate active list)
    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

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
   * 4. LOAD BALANCED: Processes slice of active entity list for even distribution
   * 5. Uses Grid class for unified neighbor data access
   */
  findAllNeighbors() {
    const active = Transform.active;
    const visualRange = Collider.visualRange;

    // Use Grid class for spatial and neighbor data access
    const gridEntities = Grid.gridEntities;
    const gridCounts = Grid.gridCounts;
    const neighborData = Grid.neighborData;
    const distanceData = Grid.distanceData;
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridCols;
    const gridRows = Grid.gridRows;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const maxEntitiesPerCell = Grid.maxEntitiesPerCell;

    // Pre-computed entity data (filled in rebuildGrid)
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // ACTIVE ENTITY LIST - read current count and calculate our slice
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    // Calculate which slice of active entities this worker processes
    const activePerWorker = Math.ceil(
      totalActiveEntities / this.totalSpatialWorkers
    );
    const activeStartIdx = this.workerIndex * activePerWorker;
    const activeEndIdx = Math.min(
      activeStartIdx + activePerWorker,
      totalActiveEntities
    );

    // Reset stats for this frame
    this.neighborChecksThisFrame = 0;
    this.gridCellsCheckedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;

    // Early exit if no active entities or no work for this worker
    if (totalActiveEntities === 0 || activeStartIdx >= totalActiveEntities) {
      return;
    }

    // Process only our assigned slice of active entities
    for (
      let activeIdx = activeStartIdx;
      activeIdx < activeEndIdx;
      activeIdx++
    ) {
      // Get actual entity index from active list (offset by 1 since count is at index 0)
      const i = activeEntitiesData[1 + activeIdx];

      // Sanity check - should not happen if particle_worker built list correctly
      if (!active[i]) continue;

      // Track entity processed
      this.entitiesProcessedThisFrame++;

      // Use PRE-COMPUTED collider position
      const myX = entityPosX[i];
      const myY = entityPosY[i];
      const myVisualRange = visualRange[i];

      // Skip entities with no visual range - they don't need neighbors
      if (myVisualRange <= 0) {
        Grid.setNeighborCount(i, 0);
        continue;
      }

      // Cell radius for neighbor search (integer math faster than Math.ceil)
      const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

      // Entity's cell coordinates (using collider position)
      const col = (myX * invCellSize) | 0;
      const row = (myY * invCellSize) | 0;

      // Buffer offset for this entity's neighbor list (for direct array access in hot loop)
      const offset = Grid.getNeighborOffset(i);
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
              // Direct array write for performance in hot loop
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

      // Store neighbor count using Grid method
      Grid.setNeighborCount(i, neighborCount);
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
