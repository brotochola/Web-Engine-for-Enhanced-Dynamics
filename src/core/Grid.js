// =============================================================================
// Grid.js - Row-Based Spatial Grid with Deterministic Memory Layout
// =============================================================================
//
// ARCHITECTURE: Pure row-based partitioning with ZERO synchronization
// - Grid: Single buffer, each spatial worker owns specific rows
// - Neighbors: Single buffer, each spatial worker writes neighbors for its entities
// - No double buffering, no Atomics, no locks, no coordination
// - Fixed memory layout like Excel spreadsheet - 100% deterministic
// - Accepts stale data by design (imperceptible, filtered by distance checks)
//
// MEMORY LAYOUT:
// SpatialGridSAB: Fixed cells with [count:Uint8, pad:3, entities[MAX_ENTITIES_PER_CELL]:Uint32]
// NeighborsSAB:   Fixed per-entity with [totalCount:Uint16, collisionCount:Uint16, neighbors[MAX_NEIGHBORS]:Uint16]
//                 Neighbors are partitioned: [collision candidates..., visual-only neighbors...]
//                 Physics only iterates collisionCount, logic iterates totalCount
//                 Uses Uint16 since max entities = 65535 (fits in 16 bits)
// WHY NO DOUBLE BUFFERING FOR NEIGHBORS?
// - "Torn reads" only mix current + recent-frame data (never garbage)
// - All neighbor entries are valid entity IDs (deterministic memory)
// - Distance checks filter out-of-range entities anyway
// - Transform.active[] check handles despawned entities
// - Same guarantees as 1-frame latency, simpler implementation
//
// =============================================================================

import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { distanceSq2D } from './utils.js';
import { SPATIAL_DEFAULTS } from './ConfigDefaults.js';

// =============================================================================
// CONSTANTS - Configurable via scene (defaults shown)
// =============================================================================
// These are defaults - actual values come from metadata.maxEntitiesPerCell and metadata.maxNeighbors

const DEFAULT_MAX_NEIGHBORS = SPATIAL_DEFAULTS.maxNeighbors; // Max neighbors per entity (matches ConfigDefaults.js)

/**
 * Grid - Static class for row-based spatial partitioning
 *
 * ROW OWNERSHIP MODEL:
 * - Worker i owns row blocks where: floor(row / rowsPerBlock) % totalWorkers === workerId
 * - Each worker rebuilds its own rows and computes neighbors for entities in those rows
 * - Workers can READ any cell/neighbor but only WRITE to owned data
 * - No synchronization needed - row ownership prevents all races
 *
 * Usage:
 *   // Cell queries
 *   const cellIdx = Grid.getCellIndex(worldX, worldY);
 *   const count = Grid.getCellCount(cellIdx);
 *   const entityId = Grid.getCellEntity(cellIdx, k);
 *
 *   // Neighbor queries (single buffer - always current/recent data)
 *   const neighborCount = Grid.getNeighborCount(entityId);
 *   const neighborId = Grid.getNeighbor(entityId, k);
 *   const distSq = Grid.getNeighborDistanceSq(entityId, k);
 */
export class Grid {
  // ===== GRID METADATA =====
  static cellSize = 0;
  static invCellSize = 0; // 1/cellSize for fast division
  static gridWidth = 0; // Number of columns
  static gridHeight = 0; // Number of rows
  static totalCells = 0;
  static maxEntitiesPerCell = SPATIAL_DEFAULTS.maxEntitiesPerCell; // Configured from scene
  static maxNeighbors = SPATIAL_DEFAULTS.maxNeighbors; // Configured from scene
  static rowsPerBlock = SPATIAL_DEFAULTS.rowsPerBlock; // Default to 1 (interleaved)

  // Computed from maxEntitiesPerCell (set during initialize)
  static cellByteSize = 0; // Bytes per cell
  static neighborStride = 0; // Elements per entity in neighbor arrays

  // ===== SPATIAL GRID DATA (Single Buffer - Row Ownership) =====
  // Layout per cell: [count:Uint8, pad:3bytes, entities[16]:Uint32]
  static _gridBuffer = null; // SharedArrayBuffer
  static _gridCounts = null; // Uint8Array view - count at byte 0 of each cell
  static _gridEntities = null; // Uint32Array view - entities starting at byte 4

  // ===== NEIGHBOR DATA (Single Buffer - Row Ownership) =====
  // Layout per entity: [totalCount:Uint16, collisionCount:Uint16, neighbors[MAX_NEIGHBORS]:Uint16]
  // Neighbors are partitioned: collision candidates first (for physics), then visual-only (for logic)
  // Uses Uint16 since max entities = 65535 (fits in 16 bits)
  static _neighborBuffer = null; // SharedArrayBuffer
  static _neighborData = null; // Uint16Array view

  // ===== CELL SLEEPING STATE (Single Buffer - Written by particle_worker) =====
  // Layout: One Uint8 per cell (0 = awake, 1 = sleeping)
  // A cell is sleeping if ALL entities in it are either sleeping or static
  // Written by particle_worker, read by all workers for optimization
  static _cellSleepingBuffer = null; // SharedArrayBuffer
  static _cellSleepingData = null; // Uint8Array view

  // ===== CELL VERSION STATE (Single Buffer - Written by row owner) =====
  // Incremented when a cell's count/hash changes so spatial workers can reuse
  // neighbor lists only when every searched cell is unchanged.
  static _cellVersionBuffer = null; // SharedArrayBuffer
  static _cellVersionData = null; // Uint32Array view

  // Internal stride for neighbor arrays (computed as 2 + maxNeighbors during initialize)
  // Layout: [totalCount, collisionCount, neighbor0, neighbor1, ...]
  static _stride = 2 + DEFAULT_MAX_NEIGHBORS;

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  /**
   * Initialize Grid with SharedArrayBuffers and metadata
   * Called once per worker during initialization
   *
   * @param {Object} buffers - SharedArrayBuffers:
   *   - gridBuffer: Spatial grid cells
   *   - neighborBuffer: Neighbor indices per entity
   *   - cellSleepingBuffer: Cell sleeping state (optional)
   * @param {Object} metadata - Grid configuration
   */
  static initialize(buffers, metadata) {
    // Store metadata - read from scene configuration
    Grid.cellSize = metadata.cellSize || 128;
    Grid.invCellSize = 1 / Grid.cellSize;
    Grid.gridWidth = metadata.gridWidth || metadata.gridCols || 0;
    Grid.gridHeight = metadata.gridHeight || metadata.gridRows || 0;
    Grid.totalCells = Grid.gridWidth * Grid.gridHeight;

    // Configure spatial limits from scene
    Grid.maxNeighbors = metadata.maxNeighbors || SPATIAL_DEFAULTS.maxNeighbors;
    Grid.maxEntitiesPerCell = metadata.maxEntitiesPerCell || SPATIAL_DEFAULTS.maxEntitiesPerCell;
    Grid.rowsPerBlock = metadata.rowsPerBlock || SPATIAL_DEFAULTS.rowsPerBlock;

    // Compute derived values
    Grid.cellByteSize = 4 + Grid.maxEntitiesPerCell * 4;
    // Stride = 2 (totalCount + collisionCount) + maxNeighbors
    Grid.neighborStride = 2 + Grid.maxNeighbors;
    Grid._stride = Grid.neighborStride;

    // ===== SPATIAL GRID (Single Buffer) =====
    if (buffers.gridBuffer) {
      Grid._gridBuffer = buffers.gridBuffer;
      Grid._gridCounts = new Uint8Array(buffers.gridBuffer);
      Grid._gridEntities = new Uint32Array(buffers.gridBuffer);
    }

    // ===== NEIGHBOR DATA (Single Buffer) =====
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (buffers.neighborBuffer) {
      Grid._neighborBuffer = buffers.neighborBuffer;
      Grid._neighborData = new Uint16Array(buffers.neighborBuffer);
    }

    // ===== CELL SLEEPING STATE (Single Buffer) =====
    if (buffers.cellSleepingBuffer) {
      Grid._cellSleepingBuffer = buffers.cellSleepingBuffer;
      Grid._cellSleepingData = new Uint8Array(buffers.cellSleepingBuffer);
      // Initialize all cells as awake (0)
      Grid._cellSleepingData.fill(0);
    }

    if (buffers.cellVersionBuffer) {
      Grid._cellVersionBuffer = buffers.cellVersionBuffer;
      Grid._cellVersionData = new Uint32Array(buffers.cellVersionBuffer);
    }
  }

  /**
   * Reset Grid state (called when unloading a scene to prevent memory leaks)
   * Clears buffer references so old SharedArrayBuffers can be GC'd
   */
  static reset() {
    Grid._gridBuffer = null;
    Grid._gridCounts = null;
    Grid._gridEntities = null;
    Grid._neighborBuffer = null;
    Grid._neighborData = null;
    Grid._cellSleepingBuffer = null;
    Grid._cellSleepingData = null;
    Grid._cellVersionBuffer = null;
    Grid._cellVersionData = null;
    Grid._markerArray = null;
    Grid._processedSet = null;
  }

  // =============================================================================
  // CELL ACCESS (Read from Single Grid Buffer)
  // =============================================================================

  /**
   * Get cell index from world position
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @returns {number} Cell index, or -1 if out of bounds
   */
  static getCellIndex(x, y) {
    const col = (x * Grid.invCellSize) | 0;
    const row = (y * Grid.invCellSize) | 0;

    if (col < 0 || col >= Grid.gridWidth || row < 0 || row >= Grid.gridHeight) {
      return -1;
    }

    return row * Grid.gridWidth + col;
  }

  /**
   * Get cell coordinates from cell index
   * @param {number} cellIndex - Cell index
   * @returns {Object} {col, row}
   */
  static getCellCoords(cellIndex) {
    return {
      col: cellIndex % Grid.gridWidth,
      row: (cellIndex / Grid.gridWidth) | 0,
    };
  }

  /**
   * Get number of entities in a cell
   * @param {number} cellIndex - Cell index
   * @returns {number} Entity count (0-maxEntitiesPerCell)
   */
  static getCellCount(cellIndex) {
    if (!Grid._gridCounts || cellIndex < 0 || cellIndex >= Grid.totalCells) return 0;
    const byteOffset = cellIndex * Grid.cellByteSize;
    return Grid._gridCounts[byteOffset];
  }

  /**
   * Get entity ID at position k in a cell
   * @param {number} cellIndex - Cell index
   * @param {number} k - Position in cell (0 to count-1)
   * @returns {number} Entity ID
   */
  static getCellEntity(cellIndex, k) {
    if (!Grid._gridEntities) return 0;
    // Entity array starts at byte 4 of each cell
    const uint32Offset = ((cellIndex * Grid.cellByteSize) >> 2) + 1 + k;
    return Grid._gridEntities[uint32Offset];
  }

  /**
   * Get base byte offset for a cell
   * @param {number} cellIndex - Cell index
   * @returns {number} Byte offset into grid buffer
   */
  static getCellByteOffset(cellIndex) {
    return cellIndex * Grid.cellByteSize;
  }

  /**
   * Get entity count in a cell (alias for Ray.js compatibility)
   * @param {number} cellIndex - Cell index
   * @returns {number} Entity count
   */
  static getCellEntityCount(cellIndex) {
    return Grid.getCellCount(cellIndex);
  }

  /**
   * Get base Uint32 index for cell entities (for Ray.js compatibility)
   * @param {number} cellIndex - Cell index
   * @returns {number} Base Uint32 index into gridEntities
   */
  static getCellBase(cellIndex) {
    const byteOffset = cellIndex * Grid.cellByteSize;
    return (byteOffset >> 2) + 1;
  }

  // =============================================================================
  // CELL WRITE (Only to Owned Rows)
  // =============================================================================

  /**
   * Clear a cell's entity count
   * IMPORTANT: Only call for cells you own (cellRow % totalWorkers === workerId)
   * @param {number} cellIndex - Cell index
   */
  static clearCell(cellIndex) {
    if (!Grid._gridCounts) return;
    const byteOffset = cellIndex * Grid.cellByteSize;
    Grid._gridCounts[byteOffset] = 0;
  }

  /**
   * Add an entity to a cell
   * IMPORTANT: Only call for cells you own
   * @param {number} cellIndex - Cell index
   * @param {number} entityId - Entity ID to add
   * @returns {boolean} True if added, false if cell is full
   */
  static addEntityToCell(cellIndex, entityId) {
    if (!Grid._gridCounts || !Grid._gridEntities) return false;

    const byteOffset = cellIndex * Grid.cellByteSize;
    const count = Grid._gridCounts[byteOffset];

    if (count >= Grid.maxEntitiesPerCell) return false;

    const uint32Offset = (byteOffset >> 2) + 1 + count;
    Grid._gridEntities[uint32Offset] = entityId;
    Grid._gridCounts[byteOffset] = count + 1;

    return true;
  }

  // =============================================================================
  // NEIGHBOR DATA ACCESS (Single Buffer - Direct Read/Write)
  // =============================================================================

  /**
   * Get the neighbor data array (single buffer, always current)
   * Use Grid.neighborData in performance-critical loops
   */
  static get neighborData() {
    return Grid._neighborData;
  }

  /**
   * Get total neighbor count for an entity (all neighbors within visual range)
   * @param {number} entityId - Entity index
   * @returns {number} Total number of neighbors
   */
  static getNeighborCount(entityId) {
    if (!Grid._neighborData) return 0;
    return Grid._neighborData[entityId * Grid._stride];
  }

  /**
   * Get collision candidate count for an entity (neighbors within collision range)
   * Physics should only iterate these; they appear first in the neighbor list.
   * @param {number} entityId - Entity index
   * @returns {number} Number of collision candidates
   */
  static getCollisionCandidateCount(entityId) {
    if (!Grid._neighborData) return 0;
    return Grid._neighborData[entityId * Grid._stride + 1];
  }

  /**
   * Get neighbor entity ID at index k
   * Note: Collision candidates are stored first (indices 0 to collisionCount-1)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to count-1)
   * @returns {number} Neighbor entity ID
   */
  static getNeighbor(entityId, k) {
    if (!Grid._neighborData) return 0;
    return Grid._neighborData[entityId * Grid._stride + 2 + k];
  }

  /**
   * Get offset into neighbor array for an entity
   * @param {number} entityId - Entity index
   * @returns {number} Offset into arrays
   */
  static getNeighborOffset(entityId) {
    return entityId * Grid._stride;
  }

  /**
   * Get all neighbors of an entity as a typed array view (zero-allocation)
   * Returns a Uint16Array subarray pointing directly into the neighbor buffer
   * @param {number} idx - Entity index
   * @returns {Uint16Array} View of valid neighbor entity IDs (zero-GC subarray)
   */
  static getNeighborsOfEntityId(idx) {
    if (!Grid._neighborData) return new Uint16Array(0);
    const offset = idx * Grid._stride;
    const count = Grid._neighborData[offset];
    return Grid._neighborData.subarray(offset + 2, offset + 2 + count);
  }

  // =============================================================================
  // NEIGHBOR DATA WRITE (Only for Entities You Own)
  // =============================================================================

  /**
   * Set total neighbor count for an entity
   * IMPORTANT: Only call for entities in cells you own
   * @param {number} entityId - Entity index
   * @param {number} count - Total number of neighbors
   */
  static setNeighborCount(entityId, count) {
    if (!Grid._neighborData) return;
    const offset = entityId * Grid._stride;
    Grid._neighborData[offset] = count;
  }

  /**
   * Set collision candidate count for an entity
   * IMPORTANT: Only call for entities in cells you own
   * @param {number} entityId - Entity index
   * @param {number} count - Number of collision candidates (stored first in neighbor list)
   */
  static setCollisionCandidateCount(entityId, count) {
    if (!Grid._neighborData) return;
    const offset = entityId * Grid._stride;
    Grid._neighborData[offset + 1] = count;
  }

  /**
   * Set neighbor data at index k
   * Note: Collision candidates should be written first (indices 0 to collisionCount-1)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index
   * @param {number} neighborId - Neighbor entity ID
   */
  static setNeighbor(entityId, k, neighborId) {
    if (!Grid._neighborData) return;
    const idx = entityId * Grid._stride + 2 + k;
    Grid._neighborData[idx] = neighborId;
  }

  // =============================================================================
  // SPATIAL QUERIES
  // =============================================================================

  /**
   * Find all active entities within a radius of a point
   * Zero-allocation: reuses pre-allocated results array
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @param {number} radius - Search radius in world units
   * @param {Uint16Array|null} resultsBuffer - Pre-allocated buffer for results (optional)
   * @returns {{count: number, entities: Uint16Array}} Count and entities array
   */
  static _queryResults = new Uint16Array(16384); // Pre-allocated results buffer (Uint16 since entity IDs < 65536)
  static _queryResultCount = 0;

  // Zero-GC marker array for deduplication (lazy-initialized)
  static _markerArray = null; // Int32Array for marking processed entities
  static _markerCounter = 1; // Increments each query to avoid clearing array

  static getEntitiesInRadius(x, y, radius) {
    const results = Grid._queryResults;
    let count = 0;
    const maxResults = results.length;
    const radiusSq = radius * radius;

    // Get grid bounds to check
    const cellRadius = Math.ceil(radius * Grid.invCellSize);
    const centerCol = (x * Grid.invCellSize) | 0;
    const centerRow = (y * Grid.invCellSize) | 0;

    const startCol = Math.max(0, centerCol - cellRadius);
    const endCol = Math.min(Grid.gridWidth - 1, centerCol + cellRadius);
    const startRow = Math.max(0, centerRow - cellRadius);
    const endRow = Math.min(Grid.gridHeight - 1, centerRow + cellRadius);

    // Import Transform for active check (avoid circular dep by checking existence)
    const transformX = Transform?.x;
    const transformY = Transform?.y;
    const transformActive = Transform?.active;
    if (!transformX || !transformY || !transformActive) {
      Grid._queryResultCount = 0;
      return { count: 0, entities: results };
    }

    // Track processed entities to avoid duplicates (entities can span multiple cells)
    // Use a simple Set since we're in main thread and this is called infrequently
    const processed = Grid._processedSet || (Grid._processedSet = new Set());
    processed.clear();

    // Iterate cells
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cellIndex = row * Grid.gridWidth + col;
        const cellCount = Grid.getCellCount(cellIndex);

        for (let k = 0; k < cellCount; k++) {
          const entityId = Grid.getCellEntity(cellIndex, k);

          // Skip if already processed or inactive
          if (processed.has(entityId)) continue;
          if (!transformActive[entityId]) continue;
          processed.add(entityId);

          // Distance check
          const ex = transformX[entityId];
          const ey = transformY[entityId];
          const distSq = distanceSq2D(x, y, ex, ey);

          if (distSq <= radiusSq) {
            if (count < maxResults) {
              results[count++] = entityId;
            }
          }
        }
      }
    }

    Grid._queryResultCount = count;
    return { count, entities: results };
  }

  /**
   * Find all active entities within a rectangular region
   * Zero-allocation: reuses pre-allocated results array and marker array
   * @param {number} minX - Minimum X world coordinate
   * @param {number} minY - Minimum Y world coordinate
   * @param {number} maxX - Maximum X world coordinate
   * @param {number} maxY - Maximum Y world coordinate
   * @returns {{count: number, entities: Uint16Array}} Count and entities array
   */
  static getEntitiesInRect(minX, minY, maxX, maxY) {
    const results = Grid._queryResults;
    let count = 0;
    const maxResults = results.length;

    // Clamp and convert to cell coordinates
    const startCol = Math.max(0, (minX * Grid.invCellSize) | 0);
    const endCol = Math.min(Grid.gridWidth - 1, (maxX * Grid.invCellSize) | 0);
    const startRow = Math.max(0, (minY * Grid.invCellSize) | 0);
    const endRow = Math.min(Grid.gridHeight - 1, (maxY * Grid.invCellSize) | 0);

    // Early exit if no cells to check
    if (startCol > endCol || startRow > endRow) {
      Grid._queryResultCount = 0;
      return { count: 0, entities: results };
    }

    // Import Transform for active check (avoid circular dep by checking existence)
    const transformX = Transform?.x;
    const transformY = Transform?.y;
    const transformActive = Transform?.active;
    if (!transformX || !transformY || !transformActive) {
      Grid._queryResultCount = 0;
      return { count: 0, entities: results };
    }

    // Lazy-initialize marker array (zero-GC deduplication)
    // Size it to match Transform array length if available, otherwise use large default
    if (!Grid._markerArray) {
      const arrayLength = transformX?.length || 65536;
      Grid._markerArray = new Int32Array(arrayLength);
      Grid._markerArray.fill(0);
    }

    // Increment marker counter (wraps at 2^31, but that's 2 billion queries)
    const currentMarker = ++Grid._markerCounter;
    if (Grid._markerCounter >= 2147483647) {
      Grid._markerCounter = 1;
      // If counter wrapped, we need to clear array (rare, but handle it)
      Grid._markerArray.fill(0);
    }

    const markerArray = Grid._markerArray;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellByteSize = Grid.cellByteSize;
    const gridWidth = Grid.gridWidth;

    // Iterate cells in rectangular region
    for (let row = startRow; row <= endRow; row++) {
      const rowBase = row * gridWidth;

      for (let col = startCol; col <= endCol; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * cellByteSize;
        const cellCount = gridCounts[byteOffset];

        // Skip empty cells
        if (cellCount === 0) continue;

        // Direct buffer access for performance
        const cellEntityBase = (byteOffset >> 2) + 1;

        for (let k = 0; k < cellCount; k++) {
          const entityId = gridEntities[cellEntityBase + k];

          // Skip if already processed this query (zero-GC marker check)
          if (markerArray[entityId] === currentMarker) continue;
          markerArray[entityId] = currentMarker;

          // Skip inactive entities
          if (!transformActive[entityId]) continue;

          // Check if entity position is within rectangle bounds
          const ex = transformX[entityId];
          const ey = transformY[entityId];

          if (ex >= minX && ex <= maxX && ey >= minY && ey <= maxY) {
            if (count < maxResults) {
              results[count++] = entityId;
            }
          }
        }
      }
    }

    Grid._queryResultCount = count;
    return { count, entities: results };
  }

  /**
   * Find the nearest entity to a point within a radius
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @param {number} radius - Max search radius
   * @returns {{entityId: number, distSq: number}|null} Nearest entity or null
   */
  static getNearestEntity(x, y, radius) {
    const { count, entities } = Grid.getEntitiesInRadius(x, y, radius);
    if (count === 0) return null;

    const transformX = Transform?.x;
    const transformY = Transform?.y;
    if (!transformX || !transformY) return null;

    let nearestId = -1;
    let nearestDistSq = radius * radius;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];

      const distSq = distanceSq2D(x, y, transformX[entityId], transformY[entityId]);

      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestId = entityId;
      }
    }

    return nearestId >= 0 ? { entityId: nearestId, distSq: nearestDistSq } : null;
  }

  // =============================================================================
  // ROW OWNERSHIP UTILITIES
  // =============================================================================

  /**
   * Check if a row belongs to a specific worker
   * @param {number} row - Grid row (0 to gridHeight-1)
   * @param {number} workerId - Worker index (0 to totalWorkers-1)
   * @param {number} totalWorkers - Total number of spatial workers
   * @returns {boolean} True if this worker owns this row
   */
  static isRowOwnedBy(row, workerId, totalWorkers) {
    const blockIndex = (row / Grid.rowsPerBlock) | 0;
    return blockIndex % totalWorkers === workerId;
  }

  /**
   * Get all rows owned by a specific worker
   * @param {number} workerId - Worker index
   * @param {number} totalWorkers - Total spatial workers
   * @returns {Array<number>} Array of row indices
   */
  static getOwnedRows(workerId, totalWorkers) {
    const rows = [];
    for (let row = 0; row < Grid.gridHeight; row++) {
      const blockIndex = (row / Grid.rowsPerBlock) | 0;
      if (blockIndex % totalWorkers === workerId) {
        rows.push(row);
      }
    }
    return rows;
  }

  // =============================================================================
  // CELL SLEEPING STATE ACCESS (Written by particle_worker, Read by all workers)
  // =============================================================================

  /**
   * Get the cell sleeping state array (direct access for performance)
   * Use Grid.cellSleepingData in performance-critical loops
   * @returns {Uint8Array|null} Cell sleeping state array (0=awake, 1=sleeping)
   */
  static get cellSleepingData() {
    return Grid._cellSleepingData;
  }

  /**
   * Get sleeping state of a cell
   * @param {number} cellIndex - Cell index
   * @returns {number} 0 = awake, 1 = sleeping, 0 if buffer not initialized
   */
  static getCellSleeping(cellIndex) {
    if (!Grid._cellSleepingData || cellIndex < 0 || cellIndex >= Grid.totalCells) return 0;
    return Grid._cellSleepingData[cellIndex];
  }

  /**
   * Set sleeping state of a cell
   * IMPORTANT: Only particle_worker should write to this buffer
   * @param {number} cellIndex - Cell index
   * @param {number} sleeping - 0 = awake, 1 = sleeping
   */
  static setCellSleeping(cellIndex, sleeping) {
    if (!Grid._cellSleepingData || cellIndex < 0 || cellIndex >= Grid.totalCells) return;
    Grid._cellSleepingData[cellIndex] = sleeping ? 1 : 0;
  }

  /**
   * Get statistics about cell sleeping states
   * Useful for debugging and monitoring from Chrome DevTools
   * @returns {Object} Statistics object with counts and percentages
   */
  static getCellSleepingStats() {
    if (!Grid._cellSleepingData || Grid.totalCells === 0) {
      return {
        totalCells: 0,
        sleepingCells: 0,
        awakeCells: 0,
        sleepingPercentage: 0,
        awakePercentage: 0,
      };
    }

    let sleepingCount = 0;
    const totalCells = Grid.totalCells;

    // Count sleeping cells (value === 1)
    for (let i = 0; i < totalCells; i++) {
      if (Grid._cellSleepingData[i] === 1) {
        sleepingCount++;
      }
    }

    const awakeCount = totalCells - sleepingCount;
    const sleepingPercentage = totalCells > 0 ? (sleepingCount / totalCells) * 100 : 0;
    const awakePercentage = totalCells > 0 ? (awakeCount / totalCells) * 100 : 0;

    return {
      totalCells,
      sleepingCells: sleepingCount,
      awakeCells: awakeCount,
      sleepingPercentage: sleepingPercentage.toFixed(2),
      awakePercentage: awakePercentage.toFixed(2),
    };
  }

  /**
   * Get the count of sleeping cells (quick access for console)
   * @returns {number} Number of sleeping cells
   */
  static getSleepingCellCount() {
    if (!Grid._cellSleepingData || Grid.totalCells === 0) return 0;

    let count = 0;
    for (let i = 0; i < Grid.totalCells; i++) {
      if (Grid._cellSleepingData[i] === 1) count++;
    }
    return count;
  }
}
