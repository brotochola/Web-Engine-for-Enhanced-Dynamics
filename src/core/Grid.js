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
// NeighborsSAB:   Fixed per-entity with [count:Uint16, pad:2, neighbors[MAX_NEIGHBORS]:Uint32]
// DistancesSAB:   Fixed per-entity with [dist2[MAX_NEIGHBORS]:Float32]
//
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

// =============================================================================
// CONSTANTS - Configurable via scene (defaults shown)
// =============================================================================
// These are defaults - actual values come from metadata.maxEntitiesPerCell and metadata.maxNeighbors
const DEFAULT_MAX_ENTITIES_PER_CELL = 64; // Max entities per grid cell (matches ConfigDefaults.js)
const DEFAULT_MAX_NEIGHBORS = 500; // Max neighbors per entity (matches ConfigDefaults.js)

/**
 * Grid - Static class for row-based spatial partitioning
 *
 * ROW OWNERSHIP MODEL:
 * - Worker i owns all cells where: cellY % totalWorkers === workerId
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
  static maxEntitiesPerCell = DEFAULT_MAX_ENTITIES_PER_CELL; // Configured from scene
  static maxNeighbors = DEFAULT_MAX_NEIGHBORS; // Configured from scene

  // Computed from maxEntitiesPerCell (set during initialize)
  static cellByteSize = 0; // Bytes per cell
  static neighborStride = 0; // Elements per entity in neighbor arrays

  // ===== SPATIAL GRID DATA (Single Buffer - Row Ownership) =====
  // Layout per cell: [count:Uint8, pad:3bytes, entities[16]:Uint32]
  static _gridBuffer = null; // SharedArrayBuffer
  static _gridCounts = null; // Uint8Array view - count at byte 0 of each cell
  static _gridEntities = null; // Uint32Array view - entities starting at byte 4

  // ===== NEIGHBOR DATA (Single Buffer - Row Ownership) =====
  // Layout per entity: [count:Int32, neighbors[MAX_NEIGHBORS]:Int32]
  static _neighborBuffer = null; // SharedArrayBuffer
  static _neighborData = null; // Int32Array view

  // Layout per entity: [dist2[MAX_NEIGHBORS]:Float32]
  static _distanceBuffer = null; // SharedArrayBuffer
  static _distanceData = null; // Float32Array view

  // Internal stride for neighbor arrays (computed as 1 + maxNeighbors during initialize)
  static _stride = 1 + DEFAULT_MAX_NEIGHBORS;

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
   *   - distanceBuffer: Neighbor distances per entity
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
    Grid.maxNeighbors = metadata.maxNeighbors || DEFAULT_MAX_NEIGHBORS;
    Grid.maxEntitiesPerCell = metadata.maxEntitiesPerCell || DEFAULT_MAX_ENTITIES_PER_CELL;

    // Compute derived values
    Grid.cellByteSize = 4 + Grid.maxEntitiesPerCell * 4;
    Grid.neighborStride = 1 + Grid.maxNeighbors;
    Grid._stride = Grid.neighborStride;

    // ===== SPATIAL GRID (Single Buffer) =====
    if (buffers.gridBuffer) {
      Grid._gridBuffer = buffers.gridBuffer;
      Grid._gridCounts = new Uint8Array(buffers.gridBuffer);
      Grid._gridEntities = new Uint32Array(buffers.gridBuffer);
    }

    // ===== NEIGHBOR DATA (Single Buffer) =====
    if (buffers.neighborBuffer) {
      Grid._neighborBuffer = buffers.neighborBuffer;
      Grid._neighborData = new Int32Array(buffers.neighborBuffer);
    }

    // ===== DISTANCE DATA (Single Buffer) =====
    if (buffers.distanceBuffer) {
      Grid._distanceBuffer = buffers.distanceBuffer;
      Grid._distanceData = new Float32Array(buffers.distanceBuffer);
    }
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
   * Get the distance data array (single buffer, always current)
   * Use Grid.distanceData in performance-critical loops
   */
  static get distanceData() {
    return Grid._distanceData;
  }

  /**
   * Get neighbor count for an entity
   * @param {number} entityId - Entity index
   * @returns {number} Number of neighbors
   */
  static getNeighborCount(entityId) {
    if (!Grid._neighborData) return 0;
    return Grid._neighborData[entityId * Grid._stride];
  }

  /**
   * Get neighbor entity ID at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to count-1)
   * @returns {number} Neighbor entity ID
   */
  static getNeighbor(entityId, k) {
    if (!Grid._neighborData) return 0;
    return Grid._neighborData[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get squared distance to neighbor at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to count-1)
   * @returns {number} Squared distance
   */
  static getNeighborDistanceSq(entityId, k) {
    if (!Grid._distanceData) return 0;
    return Grid._distanceData[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get offset into neighbor/distance arrays for an entity
   * @param {number} entityId - Entity index
   * @returns {number} Offset into arrays
   */
  static getNeighborOffset(entityId) {
    return entityId * Grid._stride;
  }

  // =============================================================================
  // NEIGHBOR DATA WRITE (Only for Entities You Own)
  // =============================================================================

  /**
   * Set neighbor count for an entity
   * IMPORTANT: Only call for entities in cells you own
   * @param {number} entityId - Entity index
   * @param {number} count - Number of neighbors
   */
  static setNeighborCount(entityId, count) {
    if (!Grid._neighborData) return;
    const offset = entityId * Grid._stride;
    Grid._neighborData[offset] = count;
    if (Grid._distanceData) Grid._distanceData[offset] = count;
  }

  /**
   * Set neighbor data at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index
   * @param {number} neighborId - Neighbor entity ID
   * @param {number} distSq - Squared distance to neighbor
   */
  static setNeighbor(entityId, k, neighborId, distSq) {
    if (!Grid._neighborData) return;
    const idx = entityId * Grid._stride + 1 + k;
    Grid._neighborData[idx] = neighborId;
    if (Grid._distanceData) Grid._distanceData[idx] = distSq;
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
  static _queryResults = new Uint16Array(4096); // Pre-allocated results buffer (Uint16 since entity IDs < 65536)
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
          const dx = ex - x;
          const dy = ey - y;
          const distSq = dx * dx + dy * dy;

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
   * @param {Set<string>|null} excludeTypes - Set of entity class names to exclude (optional)
   * @returns {{entityId: number, distSq: number}|null} Nearest entity or null
   */
  static getNearestEntity(x, y, radius, excludeTypes = null) {
    const { count, entities } = Grid.getEntitiesInRadius(x, y, radius);
    if (count === 0) return null;

    const transformX = Transform?.x;
    const transformY = Transform?.y;
    const entityType = Transform?.entityType;
    if (!transformX || !transformY) return null;

    let nearestId = -1;
    let nearestDistSq = radius * radius;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];

      // Optional type filtering (for DebugUI to skip internal entities)
      if (excludeTypes && entityType) {
        // This requires registeredClasses lookup - caller should handle filtering
      }

      const dx = transformX[entityId] - x;
      const dy = transformY[entityId] - y;
      const distSq = dx * dx + dy * dy;

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
    return row % totalWorkers === workerId;
  }

  /**
   * Get all rows owned by a specific worker
   * @param {number} workerId - Worker index
   * @param {number} totalWorkers - Total spatial workers
   * @returns {Array<number>} Array of row indices
   */
  static getOwnedRows(workerId, totalWorkers) {
    const rows = [];
    for (let row = workerId; row < Grid.gridHeight; row += totalWorkers) {
      rows.push(row);
    }
    return rows;
  }
}

// Export default constants for use by other modules (actual values configured via Grid.initialize)
export { DEFAULT_MAX_ENTITIES_PER_CELL, DEFAULT_MAX_NEIGHBORS };
