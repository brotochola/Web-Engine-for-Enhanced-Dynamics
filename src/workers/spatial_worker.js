// =============================================================================
// SPATIAL WORKER - Row-Based Partitioned Spatial Hashing & Neighbor Detection
// =============================================================================
//
// ARCHITECTURE: Each spatial worker owns specific grid rows (cellY % workerCount === workerId)
// - No double buffering (neither grid nor neighbors)
// - Each worker rebuilds its own rows AND computes neighbors for entities in those rows
// - Workers can READ any cell but only WRITE to owned rows/entities
//
// FLOW PER FRAME:
// 1. Clear LOCAL cell counts (not shared buffer - avoids mid-clear race)
// 2. Insert ALL active entities into grid (only to owned rows)
// 3. Copy local counts to shared gridCounts (single write per cell)
// 4. For each entity in owned rows: find neighbors using precomputed circle patterns
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
    // processedThisFrame[j] = entityId means entity "entityId" already processed entity "j"
    // Uses Uint16 since max entities = 65535 (fits in 16 bits), sentinel = 65535
    this.processedMarker = null; // Uint16Array

    // O(1) deduplication for entityA (source entity) - prevents processing same entity twice
    // when it appears in multiple cells owned by this worker
    // Uses frame counter approach to avoid fill() every frame
    this._entityProcessedMarker = null; // Uint32Array
    this._entityFrameCounter = 0;

    // Scratch array for visual-only neighbors (partitioned after collision candidates)
    // Pre-allocated to avoid per-frame allocation
    this._visualOnlyBuffer = null; // Int32Array
    this._visualOnlyCount = 0;

    // Collision buffer: extra distance added to collision range to account for entity movement
    // between spatial worker and physics worker (roughly half a cell size worth of movement)
    this._collisionBuffer = 0;

    // Local cell counts for race-free grid rebuilding
    // We build counts locally, then copy to grid at the end (avoids mid-clear races)
    this._localCellCounts = null; // Uint8Array(totalCells)

    // Precomputed circle patterns: cellRadius -> Int32Array of [dr, dc, dr, dc, ...]
    this._circlePatterns = new Map();
    // Pattern lengths cache: cellRadius -> length (number of cell pairs)
    this._patternLengths = new Map();

    // Cached neighbor cells: (cellIndex * MAX_CELL_RADIUS + cellRadius) -> Uint16Array of neighbor cell indices
    // Uint16Array since cell indices are always positive and < 65535
    this._cellNeighborCache = new Map();
    this._maxCellRadius = 12; // Support visual ranges up to ~1500px with cellSize=128

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
    // Uses Uint16 since max entities = 65535 (fits in 16 bits), sentinel = 65535
    this.processedMarker = new Uint16Array(this.globalEntityCount);
    this.processedMarker.fill(65535); // 65535 = no entity (sentinel)

    // Initialize deduplication marker for source entities (entityA)
    // Prevents same entity from being processed multiple times when it spans multiple cells
    this._entityProcessedMarker = new Uint32Array(this.globalEntityCount);

    // Initialize visual-only buffer (max size = maxNeighbors)
    // Uses Uint16 since it stores entity IDs (max 65535)
    const maxNeighbors = Grid.maxNeighbors || SPATIAL_DEFAULTS.maxNeighbors;
    this._visualOnlyBuffer = new Uint16Array(maxNeighbors);

    // DEBUG: Check if visualOnlyBuffer was created with correct size
    // console.log(`SPATIAL WORKER ${this.workerId}: visualOnlyBuffer size = ${this._visualOnlyBuffer.length}, Grid.maxNeighbors = ${Grid.maxNeighbors}, SPATIAL_DEFAULTS.maxNeighbors = ${SPATIAL_DEFAULTS.maxNeighbors}`);

    // Collision buffer: extra distance for entity movement between spatial and physics
    const collisionMargin = this.config.spatial?.collisionCandidateSearchMargin ?? SPATIAL_DEFAULTS.collisionCandidateSearchMargin;
    this._collisionBuffer = this.cellSize * collisionMargin;

    // Initialize local cell counts array for race-free grid rebuilding
    this._localCellCounts = new Uint8Array(this.totalCells);

    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius)
    this._precomputeCirclePatterns();

    if (this.ownedRowCount > 0) {
      console.log(
        `SPATIAL WORKER ${this.workerId}: Initialized with ${this.ownedRowCount} rows ` +
        `(rows ${this.ownedRows[0]} to ${this.ownedRows[this.ownedRowCount - 1]} step ${this.totalSpatialWorkers}), ` +
        `precomputed ${this._circlePatterns.size} circle patterns`
      );
    } else {
      console.log(
        `SPATIAL WORKER ${this.workerId}: Initialized with 0 rows, ` +
        `precomputed ${this._circlePatterns.size} circle patterns`
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
      this._circlePatterns.set(cellRadius, pattern);
      // Cache pattern length (number of cell pairs, so pattern.length / 2)
      this._patternLengths.set(cellRadius, pattern.length >> 1);
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
    return this._circlePatterns.get(clampedRadius) || this._circlePatterns.get(0);
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
    // Cache key: cellIndex * MAX_RADIUS + cellRadius
    const cacheKey = cellIndex * (this._maxCellRadius + 1) + cellRadius;

    // Check cache
    if (this._cellNeighborCache.has(cacheKey)) {
      return this._cellNeighborCache.get(cacheKey);
    }

    // Generate neighbor cells from pattern
    const pattern = this._getCirclePattern(cellRadius);
    const patternLength = pattern.length;
    const maxNeighborCells = this._patternLengths.get(cellRadius) || (patternLength >> 1);

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

    // STEP 1: Rebuild grid (only owned rows)
    this.rebuildOwnedRows();

    // STEP 2: Find neighbors (only for entities in owned rows)
    this.findNeighborsForOwnedEntities();
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
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const totalSpatialWorkers = this.totalSpatialWorkers;
    const workerId = this.workerId;

    // Interleaved position data: [x, y, halfExtent, pad] per entity (stride 4)
    const entityPosData = this.entityPosData;

    // Direct buffer access for grid (avoid Grid.addEntityToCell overhead in hot loop)
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const SHAPE_CIRCLE = 0;
    const maxCol = gridWidth - 1;
    const maxRow = gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    // =========================================================================
    // PHASE 1: Clear LOCAL counts only (not grid counts!)
    // Grid counts remain unchanged - other workers can safely read them
    // =========================================================================
    const localCounts = this._localCellCounts;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        localCounts[rowBase + col] = 0;
      }
    }

    // =========================================================================
    // PHASE 2: Insert all active entities into owned cells
    // Use local counts for indexing, write entity data directly to grid
    // =========================================================================
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

      // Insert entities that need to be in the grid for:
      // - Collider: physics, neighbor queries
      // - SpriteRenderer: visibility culling (particle_worker uses Grid.getEntitiesInRect)
      // Flash has neither, so it is skipped.
      if (!colliderActive[i] && !spriteRendererActive[i]) continue;

      // Calculate collider position
      const posX = x[i] + (offsetX[i] || 0);
      const posY = y[i] + (offsetY[i] || 0);

      // Skip invalid positions (NaN check via self-comparison)
      if (posX !== posX || posY !== posY) continue;

      // Calculate half-extent based on collider type
      let halfW = 0,
        halfH = 0;
      if (colliderActive[i]) {
        if (shapeType[i] === SHAPE_CIRCLE) {
          halfW = halfH = radius[i] || 0;
        } else {
          halfW = (width[i] || 0) * 0.5;
          halfH = (height[i] || 0) * 0.5;
        }
      }

      // Store pre-computed position for neighbor detection (interleaved layout)
      // All 3 values in single cache line: [x, y, halfExtent, pad]
      const baseIdx = i * 4;
      entityPosData[baseIdx] = posX;
      entityPosData[baseIdx + 1] = posY;
      entityPosData[baseIdx + 2] = halfW > halfH ? halfW : halfH;

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
        // ROW OWNERSHIP CHECK: O(1) lookup replaces division + modulo
        if (rowOwnership[row] !== workerId) continue;

        const rowBase = row * gridWidth;

        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];

          // Add entity if cell not full
          if (localCount < Grid.maxEntitiesPerCell) {
            // Write entity data to grid immediately (overwrites old data)
            const byteOffset = cellIndex * Grid.cellByteSize;
            const uint32Offset = (byteOffset >> 2) + 1 + localCount;
            gridEntities[uint32Offset] = i;
            localCounts[cellIndex] = localCount + 1;
          }
        }
      }
    }

    // =========================================================================
    // PHASE 3: Copy local counts to grid (single write per cell)
    // This is the ONLY time we modify gridCounts - with final values
    // Readers see either old count or new count, never 0 mid-clear
    // =========================================================================
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
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
  findNeighborsForOwnedEntities() {
    const visualRange = Collider.visualRange;
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
    const SHAPE_CIRCLE = 0;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const totalSpatialWorkers = this.totalSpatialWorkers;
    const workerId = this.workerId;

    // Single buffer - direct access (row ownership eliminates races)
    const neighborData = Grid.neighborData;

    // Direct grid buffer access
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    // O(1) duplicate detection for neighbor search (prevents counting same neighbor twice)
    const processedMarker = this.processedMarker;
    processedMarker.fill(65535); // Reset markers each frame (65535 = sentinel)

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
        const cellEntityBase = (byteOffset >> 2) + 1;

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
          // Read position from Transform (source of truth) - entityPosData can be stale/race
          const myX = x[entityA] + (offsetX[entityA] || 0);
          const myY = y[entityA] + (offsetY[entityA] || 0);

          // Calculate halfExtent from Collider data (avoid stale entityPosData)
          let myHalfExtent = 0;
          if (colliderActive[entityA]) {
            if (shapeType[entityA] === SHAPE_CIRCLE) {
              myHalfExtent = radius[entityA] || 0;
            } else {
              const halfW = (width[entityA] || 0) * 0.5;
              const halfH = (height[entityA] || 0) * 0.5;
              myHalfExtent = halfW > halfH ? halfW : halfH;
            }
          }

          let homeRow = (myY * invCellSize) | 0;
          // Clamp to grid bounds
          homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

          // Skip if another worker owns this entity's home row (O(1) lookup)
          if (rowOwnership[homeRow] !== workerId) continue;

          this.entitiesProcessedThisFrame++;

          const myVisualRange = visualRange[entityA];

          // Neighbor write offset
          const neighborOffset = entityA * stride;

          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0;     // totalCount
            neighborData[neighborOffset + 1] = 0; // collisionCount
            continue;
          }

          // NOTE: Sleeping optimization removed - stale RigidBody data from entity pooling
          // caused false positives (entities without RigidBody were incorrectly detected
          // as sleeping because their slot had old data from a previous entity).
          // TODO: Re-enable once component data is properly cleared on entity despawn.

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

          // =============================================================
          // NEIGHBOR DETECTION with PARTITIONING
          // =============================================================
          // Partition neighbors into: collision candidates (first) + visual-only (after)
          // Physics only iterates collision candidates, logic iterates all
          // =============================================================
          let collisionCount = 0;
          let visualOnlyCount = 0;
          const visualOnlyBuffer = this._visualOnlyBuffer;
          const collisionBuffer = this._collisionBuffer;

          for (let i = 0; i < neighborCellsLength; i++) {
            const checkCellIndex = neighborCells[i];
            const checkByteOffset = checkCellIndex * Grid.cellByteSize;
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

              // Calculate squared distance for range check
              // Read from Transform/Collider (source of truth) - entityPosData can be stale/race
              const bX = x[entityB] + (offsetX[entityB] || 0);
              const bY = y[entityB] + (offsetY[entityB] || 0);

              // Calculate halfExtent from Collider data
              let bHalfExtent = 0;
              if (colliderActive[entityB]) {
                if (shapeType[entityB] === SHAPE_CIRCLE) {
                  bHalfExtent = radius[entityB] || 0;
                } else {
                  const bHalfW = (width[entityB] || 0) * 0.5;
                  const bHalfH = (height[entityB] || 0) * 0.5;
                  bHalfExtent = bHalfW > bHalfH ? bHalfW : bHalfH;
                }
              }

              const dxAB = bX - myX;
              const dyAB = bY - myY;
              const distSq = dxAB * dxAB + dyAB * dyAB;

              // Early rejection: if distSq is 0, skip (same position)
              if (distSq === 0) continue;
              const effectiveRange = myVisualRange + bHalfExtent;
              const effectiveRangeSq = effectiveRange * effectiveRange;

              // Check if within visual range
              if (distSq < effectiveRangeSq) {
                // Check if within collision range (smaller, for physics)
                // Collision range = sum of half-extents + buffer for entity movement
                const collisionRange = myHalfExtent + bHalfExtent + collisionBuffer;
                const collisionRangeSq = collisionRange * collisionRange;

                if (distSq < collisionRangeSq) {
                  // COLLISION CANDIDATE: Write directly to neighborData (first section)
                  if (collisionCount < maxNeighbors) {
                    neighborData[neighborOffset + 2 + collisionCount] = entityB;
                    collisionCount++;
                    this.neighborsFoundThisFrame++;
                  }
                } else {
                  // VISUAL-ONLY: Buffer for later (will be written after collision candidates)
                  if (collisionCount + visualOnlyCount < maxNeighbors) {
                    visualOnlyBuffer[visualOnlyCount] = entityB;
                    visualOnlyCount++;
                    this.neighborsFoundThisFrame++;
                  }
                }

                // Stop if we've hit the neighbor limit
                if (collisionCount + visualOnlyCount >= maxNeighbors) break;
              }
            }

            // Warn developer when neighbor limit is reached (throttled)
            if (collisionCount + visualOnlyCount >= maxNeighbors) {
              const now = performance.now();
              if (!this._lastNeighborWarnTime || now - this._lastNeighborWarnTime > 5000) {
                this._lastNeighborWarnTime = now;
                console.warn(
                  `⚠️ SPATIAL WORKER ${this.workerId}: Entity ${entityA} hit neighbor limit ` +
                  `(${maxNeighbors} max). Some neighbors are being dropped. ` +
                  `Consider increasing spatial.maxNeighbors or reducing entity density.`
                );
              }
            }

            // Copy visual-only neighbors to after collision candidates
            for (let i = 0; i < visualOnlyCount; i++) {
              neighborData[neighborOffset + 2 + collisionCount + i] = visualOnlyBuffer[i];
            }

            const neighborCount = collisionCount + visualOnlyCount;

            // Write counts: [totalCount, collisionCount, neighbors...]
            neighborData[neighborOffset] = neighborCount;
            neighborData[neighborOffset + 1] = collisionCount;
          }
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
self.spatialWorker = spatialWorker;
