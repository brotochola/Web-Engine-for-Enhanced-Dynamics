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
 * SpatialWorker - Handles neighbor detection using spatial hash grid
 * Extends AbstractWorker for common worker functionality
 *
 * ARCHITECTURE:
 * - Grid is rebuilt by particle_worker (has spare capacity ~125 FPS)
 * - Spatial workers read shared grid and compute neighbors (bottlenecked at ~40 FPS)
 * - Load balancing: moved 1.6ms grid rebuild to idle worker, freeing spatial workers
 *
 * OPTIMIZATIONS:
 * 1. Flat grid structure (TypedArrays) - eliminates GC pressure from Array-of-Arrays
 * 2. Pre-computed entity data from particle_worker - avoids redundant calculations
 * 3. Load-balanced entity slicing - each worker processes subset of active entities
 * 4. Single grid writer - no race conditions, grid available for raycasting
 * 5. O(1) duplicate detection - uses entity ID as marker (not O(n) linear search!)
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
    this.entityPosX = null; // Float32Array - collider position X (from particle_worker)
    this.entityPosY = null; // Float32Array - collider position Y (from particle_worker)
    this.entityHalfExtent = null; // Float32Array - max half-extent (from particle_worker)

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

    // SHARED GRID STRUCTURE - written by particle_worker, read by spatial_workers
    // No race conditions since particle_worker is the single writer
    // Grid data is used for both neighbor detection and raycasting

    // NOTE: Grid arrays are set in AbstractWorker.initializeCommonBuffers via Grid.initialize
    // We just verify they're available here

    // PRE-COMPUTED ENTITY DATA - written by particle_worker, read by spatial_workers
    // These SHARED arrays contain positions and half-extents computed during grid rebuild
    if (data.buffers.entityPosX) {
      this.entityPosX = new Float32Array(data.buffers.entityPosX);
      this.entityPosY = new Float32Array(data.buffers.entityPosY);
      this.entityHalfExtent = new Float32Array(data.buffers.entityHalfExtent);
    } else {
      console.warn(
        "SPATIAL WORKER: Pre-computed entity data not available - performance may be degraded"
      );
      // Fallback: allocate local arrays (will need to compute ourselves)
      this.entityPosX = new Float32Array(this.globalEntityCount);
      this.entityPosY = new Float32Array(this.globalEntityCount);
      this.entityHalfExtent = new Float32Array(this.globalEntityCount);
    }

    // PROCESSED MARKER - O(1) duplicate detection for multi-cell entities
    // Each entity uses its own index as a marker value (no cleanup needed!)
    // processedThisFrame[j] = i means entity i already found entity j as a neighbor
    this.processedThisFrame = new Int32Array(this.globalEntityCount);
    // Initialize to -1 (no entity has processed any other entity yet)
    this.processedThisFrame.fill(-1);

    console.log(
      `SPATIAL WORKER ${this.workerIndex}: Grid initialized with ${this.totalCells} cells (${this.gridCols}x${this.gridRows})`
    );
  }

  /**
   * Find neighbors for all entities using spatial grid
   * OPTIMIZED:
   * 1. O(1) duplicate detection using processedThisFrame marker (not O(n) linear search!)
   * 2. Uses pre-computed entity positions and half-extents from particle_worker
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

    // Pre-computed entity data (filled in rebuildGrid by particle_worker)
    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // O(1) duplicate detection marker (local to each worker)
    const processedThisFrame = this.processedThisFrame;

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

      // Buffer offset for this entity's neighbor list (calculate once, used for both zero and full writes)
      const offset = i * stride;

      // Skip entities with no visual range - they don't need neighbors
      if (myVisualRange <= 0) {
        // Direct array write (no method call overhead)
        neighborData[offset] = 0;
        distanceData[offset] = 0;
        continue;
      }

      // Cell radius for neighbor search (integer math faster than Math.ceil)
      const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

      // Entity's cell coordinates (using collider position)
      const col = (myX * invCellSize) | 0;
      const row = (myY * invCellSize) | 0;

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

            // O(1) DUPLICATE CHECK: Multi-cell entities appear in multiple cells
            // Use entity i's index as marker: if processedThisFrame[j] === i, already processed
            // No cleanup needed - each entity uses its own ID as the marker value
            if (processedThisFrame[j] === i) continue;
            processedThisFrame[j] = i; // Mark j as processed by entity i

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

      // Store neighbor count using direct array access (no method call overhead)
      neighborData[offset] = neighborCount;
      distanceData[offset] = neighborCount;
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Mouse position is now written directly to Transform by main thread
    // No special syncing needed - spatial grid will see current position

    // Grid is now rebuilt by particle_worker (has spare capacity)
    // We just read the shared grid and compute neighbors for our entity slice
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
