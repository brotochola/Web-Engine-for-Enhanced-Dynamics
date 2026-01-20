self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// Spatial Worker - Builds spatial hash grid and finds neighbors
// ROW-PARTITIONED: Each worker owns rows where (row % numWorkers == workerIndex)

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
 * ARCHITECTURE (ROW-PARTITIONED):
 * - Each spatial worker owns grid rows where (row % numWorkers == workerIndex)
 * - Each worker builds AND uses its own rows (no cross-worker races!)
 * - Single shared grid buffer - workers write to non-overlapping rows
 * - Neighbor data is still quadruple-buffered for consumer reads
 *
 * OPTIMIZATIONS:
 * 1. No grid double-buffering needed - row partitioning eliminates races
 * 2. Build and use in same frame - better cache locality
 * 3. O(1) duplicate detection - uses entity ID as marker
 * 4. Flat grid structure with TypedArrays - zero GC pressure
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial worker doesn't create GameObject instances (but has access to all components)
    this.needsGameScripts = false;

    // WORKER INDEX AND ROW OWNERSHIP (for parallel processing)
    this.workerIndex = 0; // Which spatial worker is this? (0, 1, 2, ...)
    this.totalSpatialWorkers = 1; // Total number of spatial workers

    // Note: activeEntitiesData is now initialized in AbstractWorker.initializeCommonBuffers

    // Grid parameters - set during initialization
    this.cellSize = 0;
    this.invCellSize = 0; // 1/cellSize - multiply instead of divide
    this.gridCols = 0;
    this.gridRows = 0;
    this.totalCells = 0;
    this.maxEntitiesPerCell = 64; // Max entities that can share a cell
    this.maxNeighborsPerEntity = 0;

    // PROCESSED MARKER - O(1) duplicate detection for multi-cell entities
    this.processedThisFrame = null; // Int32Array

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

    // Set worker index and total workers for row partitioning
    this.workerIndex = data.workerIndex || 0;
    this.totalSpatialWorkers = data.totalSpatialWorkers || 1;

    // Initialize stats buffer for writing metrics (strided access for multi-worker)
    if (data.buffers.spatialStats) {
      this.stats = createMultiWorkerStatsWriter(
        data.buffers.spatialStats,
        SPATIAL_STATS,
        this.workerIndex
      );
    }

    // Note: activeEntitiesData is initialized in AbstractWorker.initializeCommonBuffers

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

    // ROW OWNERSHIP: This worker owns rows where (row % totalWorkers == workerIndex)
    // Pre-calculate which rows we own for faster iteration
    this.myRows = [];
    for (let row = this.workerIndex; row < this.gridRows; row += this.totalSpatialWorkers) {
      this.myRows.push(row);
    }
    console.log(`SPATIAL WORKER ${this.workerIndex}: Owns ${this.myRows.length} rows out of ${this.gridRows}`);

    // PROCESSED MARKER - O(1) duplicate detection for multi-cell entities
    // processedThisFrame[j] = i means entity i already found entity j as a neighbor
    this.processedThisFrame = new Int32Array(this.globalEntityCount);
    this.processedThisFrame.fill(-1);
  }

  /**
   * Rebuild grid for rows this worker owns
   * ROW PARTITIONING: Worker N owns rows where (row % numWorkers == N)
   * Each worker clears and rebuilds its own rows - no cross-worker races!
   */
  rebuildGridForMyRows() {
    const gridEntities = Grid.gridEntities;
    const gridCounts = Grid.gridCounts;
    if (!gridEntities || !gridCounts) return;

    const gridCols = this.gridCols;
    const maxEntitiesPerCell = this.maxEntitiesPerCell;
    const invCellSize = this.invCellSize;
    const totalWorkers = this.totalSpatialWorkers;
    const workerIndex = this.workerIndex;
    const gridRows = this.gridRows;

    // Cache component arrays
    const x = Transform.x;
    const y = Transform.y;
    const active = Transform.active;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;

    // Shape type constants
    const SHAPE_CIRCLE = 0;

    // STEP 1: Clear only the rows we own
    // for (let rowIdx = 0; rowIdx < this.myRows.length; rowIdx++) {
    //   const row = this.myRows[rowIdx];
    //   const rowBase = row * gridCols;
    //   for (let col = 0; col < gridCols; col++) {
    //     gridCounts[rowBase + col] = 0;
    //   }
    // }

    // STEP 2: Insert ALL active entities into cells we own
    // An entity belongs to us if ANY of its bounding box cells are in our rows
    const globalEntityCount = this.globalEntityCount;
    const maxCol = gridCols - 1;
    const maxRow = gridRows - 1;

    for (let i = 0; i < globalEntityCount; i++) {
      if (!active[i]) continue;

      // Calculate entity position (collider center)
      const posX = x[i] + (offsetX[i] || 0);
      const posY = y[i] + (offsetY[i] || 0);

      // Skip NaN positions
      if (posX !== posX || posY !== posY) continue;

      // Calculate half-extents based on collider type
      let halfW = 0, halfH = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          halfW = halfH = radius[i] || 0;
        } else {
          halfW = (width[i] || 0) * 0.5;
          halfH = (height[i] || 0) * 0.5;
        }
      }

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

      // Add entity to cells we own within its bounding box
      for (let r = minRow; r <= maxRowBB; r++) {
        // ROW OWNERSHIP CHECK: Only process rows we own
        if (r % totalWorkers !== workerIndex) continue;

        const rowBase = r * gridCols;
        for (let c = minCol; c <= maxColBB; c++) {
          const cellIndex = rowBase + c;
          const count = gridCounts[cellIndex];

          // Add entity to cell if not full
          if (count < maxEntitiesPerCell) {
            gridEntities[cellIndex * maxEntitiesPerCell + count] = i;
            gridCounts[cellIndex] = count + 1;
          }
        }
      }
    }
  }

  /**
   * Find neighbors for entities in rows this worker owns
   * ROW PARTITIONING: Process entities whose CENTER cell row we own
   *
   * @param {number} writeBufferIndex - Which neighbor buffer to write to (0=A, 1=B)
   */
  findAllNeighbors(writeBufferIndex) {
    const active = Transform.active;
    const visualRange = Collider.visualRange;

    // Grid data (single buffer, row-partitioned)
    const gridEntities = Grid.gridEntities;
    const gridCounts = Grid.gridCounts;
    if (!gridEntities || !gridCounts) return;

    // Get write buffer directly based on index
    const neighborData = writeBufferIndex === 0 ? Grid.neighborDataA : Grid.neighborDataB;
    const distanceData = writeBufferIndex === 0 ? Grid.distanceDataA : Grid.distanceDataB;
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridCols;
    const gridRows = Grid.gridRows;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const maxEntitiesPerCell = Grid.maxEntitiesPerCell;

    // Component arrays for position calculation
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;

    const SHAPE_CIRCLE = 0;

    // O(1) duplicate detection marker
    const processedThisFrame = this.processedThisFrame;
    const totalWorkers = this.totalSpatialWorkers;
    const workerIndex = this.workerIndex;

    // Reset stats for this frame
    this.neighborChecksThisFrame = 0;
    this.gridCellsCheckedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;

    // Reset processed markers
    processedThisFrame.fill(-1);

    // Process ALL entities - but only find neighbors for those whose center is in our rows
    const globalEntityCount = this.globalEntityCount;

    for (let i = 0; i < globalEntityCount; i++) {
      if (!active[i]) continue;

      // Calculate entity position (collider center)
      const myX = x[i] + (offsetX[i] || 0);
      const myY = y[i] + (offsetY[i] || 0);

      // Skip NaN positions
      if (myX !== myX || myY !== myY) continue;

      // Determine entity's center row
      const centerRow = (myY * invCellSize) | 0;

      // ROW OWNERSHIP: Only process entities whose CENTER is in our rows
      if (centerRow < 0 || centerRow >= gridRows) continue;
      if (centerRow % totalWorkers !== workerIndex) continue;

      // This entity belongs to us - find its neighbors
      this.entitiesProcessedThisFrame++;

      const myVisualRange = visualRange[i];
      const offset = i * stride;

      // Skip entities with no visual range
      if (myVisualRange <= 0) {
        neighborData[offset] = 0;
        distanceData[offset] = 0;
        continue;
      }

      // Calculate half-extent for this entity
      let myHalfExtent = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          myHalfExtent = radius[i] || 0;
        } else {
          const hw = (width[i] || 0) * 0.5;
          const hh = (height[i] || 0) * 0.5;
          myHalfExtent = hw > hh ? hw : hh;
        }
      }

      // Cell radius for neighbor search
      const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

      // Entity's cell coordinates
      const col = (myX * invCellSize) | 0;

      let neighborCount = 0;

      // Calculate search bounds
      const rowMin = centerRow - cellRadius;
      const rowMax = centerRow + cellRadius;
      const colMin = col - cellRadius;
      const colMax = col + cellRadius;

      // Clamp bounds
      const startRow = rowMin < 0 ? 0 : rowMin;
      const endRow = rowMax >= gridRows ? gridRows - 1 : rowMax;
      const startCol = colMin < 0 ? 0 : colMin;
      const endCol = colMax >= gridCols ? gridCols - 1 : colMax;

      // Check grid cells within cellRadius (ALL cells, not just our rows)
      for (let checkRow = startRow; checkRow <= endRow; checkRow++) {
        const rowBase = checkRow * gridCols;

        for (let checkCol = startCol; checkCol <= endCol; checkCol++) {
          const checkCellIndex = rowBase + checkCol;
          const cellLength = gridCounts[checkCellIndex];

          if (cellLength === 0) continue;

          this.gridCellsCheckedThisFrame++;

          const cellBase = checkCellIndex * maxEntitiesPerCell;

          // Check all entities in this cell
          for (let k = 0; k < cellLength; k++) {
            const j = gridEntities[cellBase + k];

            // Skip self
            if (i === j) continue;

            this.neighborChecksThisFrame++;

            // O(1) duplicate check
            if (processedThisFrame[j] === i) continue;
            processedThisFrame[j] = i;

            // Calculate distance
            const jX = x[j] + (offsetX[j] || 0);
            const jY = y[j] + (offsetY[j] || 0);
            const deltaX = jX - myX;
            const deltaY = jY - myY;
            const distSq = deltaX * deltaX + deltaY * deltaY;

            // Calculate j's half-extent
            let jHalfExtent = 0;
            if (colliderActive[j]) {
              if (shapeType[j] === SHAPE_CIRCLE) {
                jHalfExtent = radius[j] || 0;
              } else {
                const hw = (width[j] || 0) * 0.5;
                const hh = (height[j] || 0) * 0.5;
                jHalfExtent = hw > hh ? hw : hh;
              }
            }

            // Expand effective range by target's half-extent
            const effectiveRange = myVisualRange + jHalfExtent;
            const effectiveRangeSq = effectiveRange * effectiveRange;

            // Only add if within effective range and not at same position
            if (distSq < effectiveRangeSq && distSq > 0) {
              const writeIdx = offset + 1 + neighborCount;
              neighborData[writeIdx] = j;
              distanceData[writeIdx] = distSq;
              neighborCount++;

              if (neighborCount >= maxNeighbors) break;
            }
          }

          if (neighborCount >= maxNeighbors) break;
        }
        if (neighborCount >= maxNeighbors) break;
      }

      // Write neighbor count (no race protection needed - we own this entity)
      neighborData[offset] = neighborCount;
      distanceData[offset] = neighborCount;
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // BACKGROUND TAB RECOVERY: When Chrome throttles/resumes tabs, workers pause
    // at different times causing counter corruption. Detect via large deltaTime.
    // ALL workers must skip this frame and worker 0 resets counters.
    const isResuming = deltaTime > 500;
    if (isResuming) {
      if (this.workerIndex === 0) {
        Grid.resetNeighborSyncCounters();
      }
      return;
    }

    // CRITICAL: Get write buffer index at START of frame and remember it
    const writeBufferIndex = Grid.getCurrentWriteBuffer();

    // ROW-PARTITIONED ARCHITECTURE:
    // 1. Rebuild grid for rows we own (clear + insert entities)
    // 2. Find neighbors for entities whose center is in our rows
    // 3. Signal completion for neighbor buffer coordination
    //
    // No grid double-buffering needed - each worker writes to non-overlapping rows
    // Better cache locality: build cell → immediately use for neighbors

    // Step 1: Rebuild grid for our rows
    this.rebuildGridForMyRows();

    // Step 2: Find neighbors for entities in our rows
    this.findAllNeighbors(writeBufferIndex);

    // Step 3: Signal completion for quadruple-buffered neighbor data
    Grid.signalSpatialWorkerFinished(writeBufferIndex);
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
