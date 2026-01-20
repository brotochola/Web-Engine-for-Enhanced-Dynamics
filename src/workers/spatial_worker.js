// =============================================================================
// SPATIAL WORKER - Row-Based Partitioned Spatial Hashing & Neighbor Detection
// =============================================================================
//
// ARCHITECTURE: Each spatial worker owns specific grid rows (cellY % workerCount === workerId)
// - No double buffering (neither grid nor neighbors)
// - No Atomics, no locks, no coordination, no synchronization
// - Each worker rebuilds its own rows AND computes neighbors for entities in those rows
// - Workers can READ any cell but only WRITE to owned rows/entities
//
// FLOW PER FRAME:
// 1. Clear all cells in owned rows
// 2. Insert ALL active entities into grid (only to owned rows)
// 3. For each entity in owned rows: find neighbors using 3x3 cell search
//
// MEMORY MODEL (100% deterministic, zero synchronization):
// - Grid: Single buffer, row ownership prevents races
// - Neighbors: Single buffer, row ownership prevents races
// - "Torn reads" by logic workers just mix current + recent data (never garbage)
// - Distance checks filter any out-of-range neighbors
// - Transform.active[] check handles despawned entities
//
// =============================================================================

self.postMessage({
  msg: "log",
  message: "spatial_worker.js loaded (row-based partitioning)",
  when: Date.now(),
});

import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { Grid, MAX_ENTITIES_PER_CELL, MAX_NEIGHBORS, CELL_BYTE_SIZE } from "../core/Grid.js";
import { SPATIAL_STATS, createMultiWorkerStatsWriter } from "./workers-utils.js";

/**
 * SpatialWorker - Row-based spatial hashing and neighbor detection
 * 
 * KEY INSIGHT: By partitioning grid rows across workers, we eliminate ALL
 * race conditions without any synchronization overhead. Each worker is the
 * sole owner of its rows - no other worker can write to them.
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial worker doesn't create GameObject instances
    this.needsGameScripts = false;

    // Worker identity for row ownership
    this.workerId = 0;
    this.totalSpatialWorkers = 1;

    // Grid parameters (set during initialization)
    this.cellSize = 0;
    this.invCellSize = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.totalCells = 0;

    // Pre-computed owned rows for this worker
    this.ownedRows = null;  // Int32Array of row indices
    this.ownedRowCount = 0;

    // Pre-computed entity positions (shared buffer from particle_worker or computed locally)
    this.entityPosX = null;   // Float32Array
    this.entityPosY = null;   // Float32Array
    this.entityHalfExtent = null; // Float32Array

    // O(1) duplicate detection for multi-cell entities
    // processedThisFrame[j] = entityId means entity "entityId" already processed entity "j"
    this.processedMarker = null; // Int32Array

    // Performance stats
    this.entitiesProcessedThisFrame = 0;
    this.neighborsFoundThisFrame = 0;
    this.cellsCheckedThisFrame = 0;
  }

  /**
   * Initialize spatial worker
   * @param {Object} data - Initialization data from main thread
   */
  initialize(data) {
    // Set worker identity
    this.workerId = data.workerIndex || 0;
    this.totalSpatialWorkers = data.totalSpatialWorkers || 1;

    // Initialize stats buffer
    if (data.buffers.spatialStats) {
      this.stats = createMultiWorkerStatsWriter(
        data.buffers.spatialStats,
        SPATIAL_STATS,
        this.workerId
      );
    }

    // Get grid metadata
    const gridMetadata = data.gridMetadata;
    this.cellSize = gridMetadata.cellSize;
    this.invCellSize = gridMetadata.invCellSize;
    this.gridWidth = gridMetadata.gridCols;
    this.gridHeight = gridMetadata.gridRows;
    this.totalCells = gridMetadata.totalCells;

    // Store viewport for screen checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    // Pre-compute owned rows: worker i owns rows where row % totalWorkers === workerId
    const ownedRows = [];
    for (let row = this.workerId; row < this.gridHeight; row += this.totalSpatialWorkers) {
      ownedRows.push(row);
    }
    this.ownedRows = new Int32Array(ownedRows);
    this.ownedRowCount = ownedRows.length;

    // Initialize pre-computed entity position buffers
    // These are SHARED buffers - we compute them during grid rebuild
    if (data.buffers.entityPosX) {
      this.entityPosX = new Float32Array(data.buffers.entityPosX);
      this.entityPosY = new Float32Array(data.buffers.entityPosY);
      this.entityHalfExtent = new Float32Array(data.buffers.entityHalfExtent);
    } else {
      // Fallback: allocate local arrays
      this.entityPosX = new Float32Array(this.globalEntityCount);
      this.entityPosY = new Float32Array(this.globalEntityCount);
      this.entityHalfExtent = new Float32Array(this.globalEntityCount);
    }

    // Initialize duplicate detection marker
    this.processedMarker = new Int32Array(this.globalEntityCount);
    this.processedMarker.fill(-1);

    console.log(
      `SPATIAL WORKER ${this.workerId}: Initialized with ${this.ownedRowCount} rows ` +
      `(rows ${this.ownedRows[0]} to ${this.ownedRows[this.ownedRowCount - 1]} step ${this.totalSpatialWorkers})`
    );
  }

  /**
   * Main update - called each frame
   * Rebuilds owned grid rows and computes neighbors for entities in those rows
   */
  update(deltaTime, dtRatio, resuming) {
    // Reset stats
    this.entitiesProcessedThisFrame = 0;
    this.neighborsFoundThisFrame = 0;
    this.cellsCheckedThisFrame = 0;

    // STEP 1: Rebuild grid (only owned rows)
    this.rebuildOwnedRows();

    // STEP 2: Find neighbors (only for entities in owned rows)
    this.findNeighborsForOwnedEntities();

    // No synchronization needed - row ownership eliminates all races.
    // Grid and neighbor data are single-buffered. "Torn reads" by logic workers
    // just mix current + recent data (never garbage), and distance checks filter
    // any out-of-range neighbors.
  }

  /**
   * STEP 1: Rebuild owned rows of the spatial grid
   * 
   * - Clears all cells in owned rows
   * - Inserts ALL active entities, but only to cells in owned rows
   * - Pre-computes entity positions for neighbor detection
   * 
   * IMPORTANT: We iterate ALL entities because an entity at any position
   * might belong to one of our rows. But we only write to our owned cells.
   */
  rebuildOwnedRows() {
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

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const totalSpatialWorkers = this.totalSpatialWorkers;
    const workerId = this.workerId;

    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // Direct buffer access for grid (avoid Grid.addEntityToCell overhead in hot loop)
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const SHAPE_CIRCLE = 0;
    const maxCol = gridWidth - 1;
    const maxRow = gridHeight - 1;

    // =========================================================================
    // PHASE 1: Clear all cells in owned rows
    // =========================================================================
    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * CELL_BYTE_SIZE;
        gridCounts[byteOffset] = 0;  // Clear cell count
      }
    }

    // =========================================================================
    // PHASE 2: Insert all active entities into owned cells
    // =========================================================================
    // Use active entity list for efficiency (built by particle_worker)
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

      // Calculate collider position
      const posX = x[i] + (offsetX[i] || 0);
      const posY = y[i] + (offsetY[i] || 0);

      // Skip invalid positions (NaN check via self-comparison)
      if (posX !== posX || posY !== posY) continue;

      // Store pre-computed position for neighbor detection
      entityPosX[i] = posX;
      entityPosY[i] = posY;

      // Calculate half-extent based on collider type
      let halfW = 0, halfH = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          halfW = halfH = radius[i] || 0;
        } else {
          halfW = (width[i] || 0) * 0.5;
          halfH = (height[i] || 0) * 0.5;
        }
      }
      entityHalfExtent[i] = halfW > halfH ? halfW : halfH;

      // Calculate cell range this entity's bounding box covers
      let minCol = ((posX - halfW) * invCellSize) | 0;
      let maxColBB = ((posX + halfW) * invCellSize) | 0;
      let minRow = ((posY - halfH) * invCellSize) | 0;
      let maxRowBB = ((posY + halfH) * invCellSize) | 0;

      // Clamp to grid bounds
      minCol = minCol < 0 ? 0 : minCol > maxCol ? maxCol : minCol;
      maxColBB = maxColBB < 0 ? 0 : maxColBB > maxCol ? maxCol : maxColBB;
      minRow = minRow < 0 ? 0 : minRow > maxRow ? maxRow : minRow;
      maxRowBB = maxRowBB < 0 ? 0 : maxRowBB > maxRow ? maxRow : maxRowBB;

      // Insert entity into ALL cells it overlaps, but only if we own that row
      for (let row = minRow; row <= maxRowBB; row++) {
        // ROW OWNERSHIP CHECK: Only write to rows we own
        if (row % totalSpatialWorkers !== workerId) continue;

        const rowBase = row * gridWidth;

        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const byteOffset = cellIndex * CELL_BYTE_SIZE;
          const count = gridCounts[byteOffset];

          // Add entity if cell not full
          if (count < MAX_ENTITIES_PER_CELL) {
            // Entity data starts at byte 4 (Uint32 index 1 relative to cell)
            const uint32Offset = (byteOffset >> 2) + 1 + count;
            gridEntities[uint32Offset] = i;
            gridCounts[byteOffset] = count + 1;
          }
        }
      }
    }
  }

  /**
   * STEP 2: Find neighbors for all entities in owned cells
   * 
   * - Iterates through all owned cells
   * - For each entity in an owned cell, searches 3x3 neighborhood
   * - Writes neighbors to double-buffered neighbor array
   * 
   * IMPORTANT: We can READ any cell (3x3 search), but only compute
   * neighbors for entities that are in our owned cells.
   */
  findNeighborsForOwnedEntities() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;

    const entityPosX = this.entityPosX;
    const entityPosY = this.entityPosY;
    const entityHalfExtent = this.entityHalfExtent;

    // Single buffer - direct access (row ownership eliminates races)
    const neighborData = Grid.neighborData;
    const distanceData = Grid.distanceData;

    // Direct grid buffer access
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    // O(1) duplicate detection
    const processedMarker = this.processedMarker;
    processedMarker.fill(-1);  // Reset markers each frame

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;

    // =========================================================================
    // Iterate through all owned cells
    // =========================================================================
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * CELL_BYTE_SIZE;
        const cellCount = gridCounts[byteOffset];

        // Skip empty cells
        if (cellCount === 0) continue;

        // Process each entity in this cell
        const cellEntityBase = (byteOffset >> 2) + 1;

        for (let k = 0; k < cellCount; k++) {
          const entityA = gridEntities[cellEntityBase + k];

          // Sanity check (shouldn't happen but safety)
          if (!active[entityA]) continue;

          this.entitiesProcessedThisFrame++;

          const myX = entityPosX[entityA];
          const myY = entityPosY[entityA];
          const myVisualRange = visualRange[entityA];

          // Neighbor write offset
          const neighborOffset = entityA * stride;

          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0;
            if (distanceData) distanceData[neighborOffset] = 0;
            continue;
          }

          // Calculate cell search radius
          const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

          // Search bounds (3x3 or larger based on visual range)
          const startRow = row - cellRadius;
          const endRow = row + cellRadius;
          const startCol = col - cellRadius;
          const endCol = col + cellRadius;

          // Clamp bounds
          const clampedStartRow = startRow < 0 ? 0 : startRow;
          const clampedEndRow = endRow >= gridHeight ? gridHeight - 1 : endRow;
          const clampedStartCol = startCol < 0 ? 0 : startCol;
          const clampedEndCol = endCol >= gridWidth ? gridWidth - 1 : endCol;

          let neighborCount = 0;
          const visualRangeSq = myVisualRange * myVisualRange;

          // =================================================================
          // Search neighboring cells (can read ANY cell, not just owned ones)
          // =================================================================
          for (let checkRow = clampedStartRow; checkRow <= clampedEndRow; checkRow++) {
            const checkRowBase = checkRow * gridWidth;

            for (let checkCol = clampedStartCol; checkCol <= clampedEndCol; checkCol++) {
              const checkCellIndex = checkRowBase + checkCol;
              const checkByteOffset = checkCellIndex * CELL_BYTE_SIZE;
              const checkCellCount = gridCounts[checkByteOffset];

              if (checkCellCount === 0) continue;

              this.cellsCheckedThisFrame++;

              const checkEntityBase = (checkByteOffset >> 2) + 1;

              // Check all entities in this cell
              for (let j = 0; j < checkCellCount; j++) {
                const entityB = gridEntities[checkEntityBase + j];

                // Skip self
                if (entityA === entityB) continue;

                // O(1) duplicate check: multi-cell entities appear in multiple cells
                if (processedMarker[entityB] === entityA) continue;
                processedMarker[entityB] = entityA;

                // Calculate squared distance
                const bX = entityPosX[entityB];
                const bY = entityPosY[entityB];
                const dx = bX - myX;
                const dy = bY - myY;
                const distSq = dx * dx + dy * dy;

                // Expand effective range by target's half-extent
                const bHalfExtent = entityHalfExtent[entityB];
                const effectiveRange = myVisualRange + bHalfExtent;
                const effectiveRangeSq = effectiveRange * effectiveRange;

                // Check if within range and not at exact same position
                if (distSq < effectiveRangeSq && distSq > 0) {
                  // Write neighbor data
                  const writeIdx = neighborOffset + 1 + neighborCount;
                  neighborData[writeIdx] = entityB;
                  if (distanceData) distanceData[writeIdx] = distSq;

                  neighborCount++;
                  this.neighborsFoundThisFrame++;

                  // Stop at neighbor limit
                  if (neighborCount >= maxNeighbors) break;
                }
              }

              if (neighborCount >= maxNeighbors) break;
            }
            if (neighborCount >= maxNeighbors) break;
          }

          // Write neighbor count
          neighborData[neighborOffset] = neighborCount;
          if (distanceData) distanceData[neighborOffset] = neighborCount;
        }
      }
    }
  }

  /**
   * Report FPS and stats to SharedArrayBuffer
   */
  reportFPS() {
    if (this.stats) {
      this.stats[SPATIAL_STATS.FPS] = this.currentFPS;
      this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
      this.stats[SPATIAL_STATS.NEIGHBOR_CHECKS] = this.neighborsFoundThisFrame;
      this.stats[SPATIAL_STATS.GRID_CELLS_CHECKED] = this.cellsCheckedThisFrame;
    }
  }
}

// Create singleton instance
const spatialWorker = new SpatialWorker(self);
