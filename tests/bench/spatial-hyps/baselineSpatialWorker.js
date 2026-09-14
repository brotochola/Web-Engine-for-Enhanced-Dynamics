// =============================================================================
// SPATIAL WORKER - Row-Based Partitioned Spatial Hashing & Neighbor Detection
// =============================================================================
//
// ARCHITECTURE: Each spatial worker owns row blocks where floor(row / rowsPerBlock) % workerCount === workerId
// - No double buffering (neither grid nor neighbors)
// - Each worker rebuilds its own rows AND computes neighbors for entities in those rows
// - Workers can READ any cell but only WRITE to owned rows/entities
//
// FLOW PER FRAME:
// 1. Clear LOCAL cell counts (not shared buffer - avoids mid-clear race)
// 2. Insert ALL active entities into grid (only to owned rows)
// 3. Copy local counts to shared gridCounts (single write per cell)
// 4. For each entity in owned rows: find visual-range neighbors
//    (Box2D owns contacts; no collision-candidate partition)
//
// MEMORY MODEL (1-frame eventual consistency):
// - Grid: Single buffer, row ownership prevents write races
// - Neighbors: Single buffer, row ownership prevents write races
// - Reading cells owned by other workers may return 1-frame-stale data (acceptable)
// - "Torn reads" by logic workers just mix current + recent data (never garbage)
// - Distance checks filter any out-of-range neighbors
// - Transform.active[] check handles despawned entities
//
// IMPORTANT: Entity ownership (home row) must be determined from Transform.x/y,
// NOT from entityPosData, because entityPosData is written by the owning worker
// and may be stale/zero if read by a different worker before it runs.
//
// =============================================================================

self.postMessage({
  msg: 'log',
  message: 'spatial_worker.js loaded (row-based partitioning)',
  when: Date.now(),
});

import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import {
  SPATIAL_STATS,
  createMultiWorkerStatsWriter,
  getEntityHomeCellIndex,
} from './workers-utils.js';
import { generateSymmetricalCirclePattern } from '../core/utils.js';
import { SPATIAL_DEFAULTS } from '../core/ConfigDefaults.js';
import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult } from '../core/ColliderUtils.js';

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
    this.ownedRows = null; // Int32Array of row indices
    this.ownedRowCount = 0;

    // O(1) row ownership lookup: rowOwnership[row] → workerId
    // Replaces expensive (row / rowsPerBlock | 0) % totalWorkers in hot loops
    this.rowOwnership = null; // Uint8Array(gridHeight)

    // Pre-computed entity positions (interleaved for cache locality)
    // Layout: [x, y, halfExtent, pad] per entity (stride 4, 16 bytes each)
    // Access: entityPosData[i * 4 + 0] = x, [i * 4 + 1] = y, [i * 4 + 2] = halfExtent
    this.entityPosData = null; // Float32Array

    // O(1) duplicate detection for multi-cell entities
    // processedMarker[entityB] = (frameStamp | entityA) encodes both frame and source entity
    // Upper 16 bits = frame counter, lower 16 bits = entityA. Avoids fill() every frame.
    this.processedMarker = null; // Uint32Array
    this._processedFrameCounter = 0;

    // O(1) deduplication for entityA (source entity) - prevents processing same entity twice
    // when it appears in multiple cells owned by this worker
    // Uses frame counter approach to avoid fill() every frame
    this._entityProcessedMarker = null; // Uint32Array
    this._entityFrameCounter = 0;

    // Local cell counts for race-free grid rebuilding
    // We build counts locally, then copy to grid at the end (avoids mid-clear races)
    this._localCellCounts = null; // Uint8Array(totalCells)
    this._localCellHashes = null; // Uint32Array(totalCells)
    this._cellHashes = null; // Uint32Array(totalCells)
    this._entityLastX = null;
    this._entityLastY = null;
    this._entityLastHalfExtent = null;
    this._entityLastVisualRange = null;
    this._entityLastCellIndex = null;
    this._entityLastCellRadius = null;
    this._entityLastDependencyHash = null;
    this._entityReuseInitialized = null;

    this._maxCellRadius = 12; // Support visual ranges up to ~1500px with cellSize=128
    // Precomputed circle patterns: cellRadius -> Int32Array of [dr, dc, dr, dc, ...]
    this._circlePatterns = new Array(this._maxCellRadius + 1);
    // Pattern lengths cache: cellRadius -> length (number of cell pairs)
    this._patternLengths = new Uint16Array(this._maxCellRadius + 1);

    // Cached neighbor cells: (cellIndex * MAX_CELL_RADIUS + cellRadius) -> Uint16Array of neighbor cell indices
    // Uint16Array since cell indices are always positive and < 65535
    this._cellNeighborCache = new Map();
    this._maxNeighborCacheEntries = 8192;

    // Performance stats
    this.entitiesProcessedThisFrame = 0;
    this.neighborsFoundThisFrame = 0;
    this.cellsCheckedThisFrame = 0;
    this.rebuildTimeThisFrame = 0;
    this.neighborSearchTimeThisFrame = 0;
    this.neighborsReusedThisFrame = 0;

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
    this.rowsPerBlock = gridMetadata.rowsPerBlock || SPATIAL_DEFAULTS.rowsPerBlock;

    // Store viewport for screen checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    // Pre-compute row ownership lookup: rowOwnership[row] → workerId
    // This replaces expensive (row / rowsPerBlock | 0) % totalWorkers in hot loops
    this.rowOwnership = new Uint8Array(this.gridHeight);
    const ownedRows = [];
    for (let row = 0; row < this.gridHeight; row++) {
      const blockIndex = (row / this.rowsPerBlock) | 0;
      const owner = blockIndex % this.totalSpatialWorkers;
      this.rowOwnership[row] = owner;
      if (owner === this.workerId) {
        ownedRows.push(row);
      }
    }
    this.ownedRows = new Int32Array(ownedRows);
    this.ownedRowCount = ownedRows.length;

    // Initialize pre-computed entity position buffer (interleaved for cache locality)
    // Layout: [x, y, halfExtent, pad] per entity (stride 4, 16 bytes each)
    if (data.buffers.entityPosData) {
      this.entityPosData = new Float32Array(data.buffers.entityPosData);
    }
    // Initialize duplicate detection marker for neighbors (entityB)
    // Uint32Array: upper 16 bits = frame counter, lower 16 bits = entityA
    this.processedMarker = new Uint32Array(this.globalEntityCount);

    // Initialize deduplication marker for source entities (entityA)
    // Prevents same entity from being processed multiple times when it spans multiple cells
    this._entityProcessedMarker = new Uint32Array(this.globalEntityCount);

    // Initialize local cell counts array for race-free grid rebuilding
    this._localCellCounts = new Uint8Array(this.totalCells);
    this._localCellHashes = new Uint32Array(this.totalCells);
    this._cellHashes = new Uint32Array(this.totalCells);
    this._entityLastX = new Float32Array(this.globalEntityCount);
    this._entityLastY = new Float32Array(this.globalEntityCount);
    this._entityLastHalfExtent = new Float32Array(this.globalEntityCount);
    this._entityLastVisualRange = new Float32Array(this.globalEntityCount);
    this._entityLastCellIndex = new Uint32Array(this.globalEntityCount);
    this._entityLastCellRadius = new Uint16Array(this.globalEntityCount);
    this._entityLastDependencyHash = new Uint32Array(this.globalEntityCount);
    this._entityReuseInitialized = new Uint8Array(this.globalEntityCount);

    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius)
    this._precomputeCirclePatterns();

    if (this.ownedRowCount > 0) {
      console.log(
        `SPATIAL WORKER ${this.workerId}: Initialized with ${this.ownedRowCount} rows ` +
        `(rows ${this.ownedRows[0]} to ${this.ownedRows[this.ownedRowCount - 1]} step ${this.totalSpatialWorkers}), ` +
        `precomputed ${this._circlePatterns.length} circle patterns`
      );
    } else {
      console.log(
        `SPATIAL WORKER ${this.workerId}: Initialized with 0 rows, ` +
        `precomputed ${this._circlePatterns.length} circle patterns`
      );
    }

    // Log that initialize() is completing (reportReady() will be called by AbstractWorker)
    this.reportLog('initialize() method completed successfully');
  }

  /**
   * Precompute circle patterns for all possible cellRadius values
   * Called once during initialization
   */
  _precomputeCirclePatterns() {
    if (!this.cellSize || this.cellSize <= 0) {
      console.error(`SPATIAL WORKER ${this.workerId}: Invalid cellSize: ${this.cellSize}`);
      return;
    }

    for (let cellRadius = 0; cellRadius <= this._maxCellRadius; cellRadius++) {
      const pattern = generateSymmetricalCirclePattern(cellRadius, this.cellSize);
      this._circlePatterns[cellRadius] = pattern;
      // Cache pattern length (number of cell pairs, so pattern.length / 2)
      this._patternLengths[cellRadius] = pattern.length >> 1;
    }
  }

  /**
   * Get circle pattern for a specific cellRadius
   * @param {number} cellRadius - Radius in cells
   * @returns {Int32Array} Pattern array with [dr, dc, dr, dc, ...] pairs
   */
  _getCirclePattern(cellRadius) {
    // Clamp to max supported radius
    const clampedRadius = cellRadius > this._maxCellRadius ? this._maxCellRadius : cellRadius;
    return this._circlePatterns[clampedRadius] || this._circlePatterns[0];
  }

  /**
   * Get cached neighbor cells for a cell+radius combination, or generate and cache it
   * @param {number} cellIndex - Source cell index
   * @param {number} cellRadius - Search radius in cells
   * @param {number} centerRow - Center row of the entity's cell
   * @param {number} centerCol - Center column of the entity's cell
   * @returns {Uint16Array} Array of neighbor cell indices (Uint16 since cell indices < 65535)
   */
  _getNeighborCells(cellIndex, cellRadius, centerRow, centerCol) {
    const clampedRadius = cellRadius > this._maxCellRadius ? this._maxCellRadius : cellRadius;
    // Cache key: cellIndex * MAX_RADIUS + cellRadius
    const cacheKey = cellIndex * (this._maxCellRadius + 1) + clampedRadius;

    // Single lookup avoids an extra Map probe in the hot path.
    const cached = this._cellNeighborCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Generate neighbor cells from pattern
    const pattern = this._circlePatterns[clampedRadius];
    const patternLength = pattern.length;
    const maxNeighborCells = this._patternLengths[clampedRadius] || (patternLength >> 1);

    // Pre-allocate array (worst case: all cells in pattern are valid)
    const neighborCells = new Uint16Array(maxNeighborCells);
    let count = 0;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    for (let i = 0; i < patternLength; i += 2) {
      const dr = pattern[i];
      const dc = pattern[i + 1];

      const checkRow = centerRow + dr;
      const checkCol = centerCol + dc;

      // Bounds check (optimized: check both axes in single condition)
      if (checkRow >= 0 && checkRow < gridHeight && checkCol >= 0 && checkCol < gridWidth) {
        neighborCells[count++] = checkRow * gridWidth + checkCol;
      }
    }

    // Return subarray if we didn't use full allocation (creates view, no copy)
    const result = count === maxNeighborCells
      ? neighborCells
      : neighborCells.subarray(0, count);

    // Bound cache growth: this memoization is only a performance hint.
    if (this._cellNeighborCache.size >= this._maxNeighborCacheEntries) {
      this._cellNeighborCache.clear();
    }
    this._cellNeighborCache.set(cacheKey, result);
    return result;
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
    this.rebuildTimeThisFrame = 0;
    this.neighborSearchTimeThisFrame = 0;
    this.neighborsReusedThisFrame = 0;

    // STEP 1: Rebuild grid (only owned rows)
    let startTime = this.stats ? performance.now() : 0;
    this.rebuildOwnedRows();
    if (this.stats) {
      this.rebuildTimeThisFrame = performance.now() - startTime;
    }

    // STEP 2: Find neighbors (only for entities in owned rows)
    startTime = this.stats ? performance.now() : 0;
    this.findNeighborsForOwnedEntities();
    if (this.stats) {
      this.neighborSearchTimeThisFrame = performance.now() - startTime;
    }
  }

  /**
   * STEP 1: Rebuild owned rows of the spatial grid (RACE-FREE)
   *
   * STRATEGY: Build counts locally, then copy to grid at the end.
   * This ensures gridCounts is never 0 during rebuild - other workers
   * reading cells either see old data or new final data, never mid-clear.
   *
   * - Phase 1: Clear LOCAL counts (not grid counts!)
   * - Phase 2: Insert entities using local counts, write entity data to grid
   * - Phase 3: Copy local counts to gridCounts (single atomic-ish write per cell)
   *
   * IMPORTANT: We iterate ALL entities because an entity at any position
   * might belong to one of our rows. But we only write to our owned cells.
   */
  rebuildOwnedRows() {
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const localHashes = this._localCellHashes;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }

    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

      if (!colliderActive[i] && !spriteRendererActive[i]) continue;

      let posX;
      let posY;
      let halfW = 0;
      let halfH = 0;
      if (colliderActive[i]) {
        getColliderBounds(i, _boundsResult);
        posX = _boundsResult.posX;
        posY = _boundsResult.posY;
        halfW = _boundsResult.halfW;
        halfH = _boundsResult.halfH;
      } else {
        posX = x[i] + offsetX[i];
        posY = y[i] + offsetY[i];
      }

      if (posX !== posX || posY !== posY) continue;

      const maxHalfExtent = halfW > halfH ? halfW : halfH;

      getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);
      const minCol = _cellRangeResult.minCol;
      const maxColBB = _cellRangeResult.maxCol;
      const minRow = _cellRangeResult.minRow;
      const maxRowBB = _cellRangeResult.maxRow;

      let wroteEntityPos = false;
      for (let row = minRow; row <= maxRowBB; row++) {
        if (rowOwnership[row] !== workerId) continue;

        if (!wroteEntityPos) {
          const baseIdx = i * 4;
          entityPosData[baseIdx] = posX;
          entityPosData[baseIdx + 1] = posY;
          entityPosData[baseIdx + 2] = maxHalfExtent;
          wroteEntityPos = true;
        }

        const rowBase = row * gridWidth;

        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[Grid.getCellBase(cellIndex) + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
            localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (i + 1), 16777619) >>> 0;
          }
        }
      }
    }

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;
      const cellVersions = Grid._cellVersionData;
      const cellHashes = this._cellHashes;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
        const nextCount = localCounts[cellIndex];
        const nextHash = localHashes[cellIndex];
        if (gridCounts[byteOffset] !== nextCount || cellHashes[cellIndex] !== nextHash) {
          cellHashes[cellIndex] = nextHash;
          if (cellVersions) cellVersions[cellIndex] = (cellVersions[cellIndex] + 1) >>> 0;
        }
        gridCounts[byteOffset] = localCounts[cellIndex];
      }
    }
  }

  /**
   * STEP 2: Find neighbors for all entities owned by this worker
   *
   * - Iterates through all owned cells
   * - For each entity, checks if this worker owns it (based on entity's home row)
   * - Only processes entities whose center Y falls in a row owned by this worker
   * - Searches 3x3+ neighborhood (can read ANY cell) and writes neighbor data
   *
   * ENTITY OWNERSHIP: Each entity is owned by exactly ONE worker based on its
   * "home row" (the row containing its center Y position). This prevents race
   * conditions when entities span multiple rows due to their bounding box.
   */
  _computeDependencyHash(neighborCells) {
    const versions = Grid._cellVersionData;
    if (!versions) return 0;

    let hash = 2166136261;
    for (let i = 0; i < neighborCells.length; i++) {
      const cellIndex = neighborCells[i];
      hash = Math.imul(hash ^ versions[cellIndex], 16777619) >>> 0;
    }
    return hash;
  }

  _canReuseNeighbors(entityId, myX, myY, myHalfExtent, myVisualRange, entityCellIndex, cellRadius, dependencyHash) {
    return (
      this._entityReuseInitialized[entityId] === 1 &&
      this._entityLastX[entityId] === myX &&
      this._entityLastY[entityId] === myY &&
      this._entityLastHalfExtent[entityId] === myHalfExtent &&
      this._entityLastVisualRange[entityId] === myVisualRange &&
      this._entityLastCellIndex[entityId] === entityCellIndex &&
      this._entityLastCellRadius[entityId] === cellRadius &&
      this._entityLastDependencyHash[entityId] === dependencyHash
    );
  }

  _storeNeighborReuseSignature(entityId, myX, myY, myHalfExtent, myVisualRange, entityCellIndex, cellRadius, dependencyHash) {
    this._entityReuseInitialized[entityId] = 1;
    this._entityLastX[entityId] = myX;
    this._entityLastY[entityId] = myY;
    this._entityLastHalfExtent[entityId] = myHalfExtent;
    this._entityLastVisualRange[entityId] = myVisualRange;
    this._entityLastCellIndex[entityId] = entityCellIndex;
    this._entityLastCellRadius[entityId] = cellRadius;
    this._entityLastDependencyHash[entityId] = dependencyHash;
  }

  findNeighborsForOwnedEntities() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const totalSpatialWorkers = this.totalSpatialWorkers;
    const workerId = this.workerId;

    // Single buffer - direct access (row ownership eliminates races)
    const neighborData = Grid.neighborData;
    const entityPosData = this.entityPosData;

    // Direct grid buffer access
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    // O(1) duplicate detection for neighbor search (prevents counting same neighbor twice)
    // Uses packed stamp (frameCounter << 16 | entityA) to avoid fill() every frame
    const processedMarker = this.processedMarker;
    this._processedFrameCounter++;
    if (this._processedFrameCounter >= 65536) {
      this._processedFrameCounter = 1;
      processedMarker.fill(0);
    }
    const processedFrameStamp = this._processedFrameCounter << 16;

    // Frame counter for entityA deduplication (avoids fill() every frame)
    this._entityFrameCounter++;
    const entityFrameMarker = this._entityFrameCounter;
    const entityProcessedMarker = this._entityProcessedMarker;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    // Clamp helpers for home row calculation
    const maxRow = gridHeight - 1;

    // =========================================================================
    // Iterate through all owned cells
    // =========================================================================
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
        const cellCount = gridCounts[byteOffset];

        // Skip empty cells
        if (cellCount === 0) continue;

        // Process each entity in this cell
        const cellEntityBase = Grid.getCellBase(cellIndex);

        for (let k = 0; k < cellCount; k++) {
          const entityA = gridEntities[cellEntityBase + k];

          // Sanity check (shouldn't happen but safety)
          if (!active[entityA]) continue;

          // O(1) deduplication: skip if this entity was already processed this frame
          // (entity can appear in multiple cells due to bounding box spanning cells)
          if (entityProcessedMarker[entityA] === entityFrameMarker) continue;
          entityProcessedMarker[entityA] = entityFrameMarker;

          // =====================================================================
          // ENTITY OWNERSHIP CHECK: Only process if this worker owns entity's home row
          // This prevents race conditions when entities span multiple rows
          // Home row = row containing entity's center Y position
          // =====================================================================
          // Read perfectly contiguous cache (built immediately prior by this worker)
          const baseIdxA = entityA * 4;
          const myX = entityPosData[baseIdxA];
          const myY = entityPosData[baseIdxA + 1];
          const myHalfExtent = entityPosData[baseIdxA + 2];

          let homeRow = (myY * invCellSize) | 0;
          // Clamp to grid bounds
          homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

          // Skip if another worker owns this entity's home row (O(1) lookup)
          if (rowOwnership[homeRow] !== workerId) continue;

          this.entitiesProcessedThisFrame++;

          const stampedA = processedFrameStamp | entityA;
          const myVisualRange = visualRange[entityA];

          // Neighbor write offset
          const neighborOffset = entityA * stride;

          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0; // totalCount
            continue;
          }

          // Calculate cell search radius (bitwise ceiling - avoids Math.ceil overhead in hot path)
          // Using (x | 0) + 1 always rounds up, may add one extra cell ring but negligible impact
          const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;

          // Calculate entity's actual cell position (based on center, not storage cell)
          let homeCol = (myX * invCellSize) | 0;
          const maxCol = gridWidth - 1;
          homeCol = homeCol < 0 ? 0 : homeCol > maxCol ? maxCol : homeCol;
          const entityCellIndex = homeRow * gridWidth + homeCol;

          // Get neighbor cells using precomputed circle pattern (cached per cell+radius)
          const neighborCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
          const neighborCellsLength = neighborCells.length;
          const dependencyHash = this._computeDependencyHash(neighborCells);

          if (this._canReuseNeighbors(
            entityA,
            myX,
            myY,
            myHalfExtent,
            myVisualRange,
            entityCellIndex,
            cellRadius,
            dependencyHash
          )) {
            this.neighborsReusedThisFrame++;
            continue;
          }

          // STOP 5: visual-range neighbors only (no collision-candidate partition)
          let neighborCount = 0;

          for (let i = 0; i < neighborCellsLength; i++) {
            const checkCellIndex = neighborCells[i];
            const checkByteOffset = checkCellIndex * Grid.cellByteSize;
            const checkCellCount = gridCounts[checkByteOffset];

            if (checkCellCount === 0) continue;

            this.cellsCheckedThisFrame++;

            const checkEntityBase = Grid.getCellBase(checkCellIndex);

            for (let j = 0; j < checkCellCount; j++) {
              const entityB = gridEntities[checkEntityBase + j];

              if (entityA === entityB) continue;

              if (processedMarker[entityB] === stampedA) continue;
              processedMarker[entityB] = stampedA;

              const baseIdxB = entityB * 4;
              const bX = entityPosData[baseIdxB];
              const bY = entityPosData[baseIdxB + 1];
              const bHalfExtent = entityPosData[baseIdxB + 2];

              const dxAB = bX - myX;
              const dyAB = bY - myY;
              const distSq = dxAB * dxAB + dyAB * dyAB;

              const effectiveRange = myVisualRange + bHalfExtent;
              const effectiveRangeSq = effectiveRange * effectiveRange;

              if (distSq < effectiveRangeSq) {
                if (neighborCount < maxNeighbors) {
                  neighborData[neighborOffset + 1 + neighborCount] = entityB;
                  neighborCount++;
                  this.neighborsFoundThisFrame++;
                }
                if (neighborCount >= maxNeighbors) break;
              }
            }

            if (neighborCount >= maxNeighbors) break;
          }

          neighborData[neighborOffset] = neighborCount;
          this._storeNeighborReuseSignature(
            entityA,
            myX,
            myY,
            myHalfExtent,
            myVisualRange,
            entityCellIndex,
            cellRadius,
            dependencyHash
          );
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
      this.stats[SPATIAL_STATS.STEP_MS] = this.stepTimeThisFrame;
      this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
      this.stats[SPATIAL_STATS.NEIGHBOR_CHECKS] = this.neighborsFoundThisFrame;
      this.stats[SPATIAL_STATS.GRID_CELLS_CHECKED] = this.cellsCheckedThisFrame;
      this.stats[SPATIAL_STATS.REBUILD_MS] = this.rebuildTimeThisFrame;
      this.stats[SPATIAL_STATS.NEIGHBOR_MS] = this.neighborSearchTimeThisFrame;
      this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
      this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    }
  }
}

// Create singleton instance
const spatialWorker = new SpatialWorker(self);
self.spatialWorker = spatialWorker;
