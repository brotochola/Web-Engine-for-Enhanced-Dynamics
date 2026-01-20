// Grid.js - Row-Based Spatial Grid with Deterministic Memory Layout
// 
// ARCHITECTURE: Each spatial worker owns specific grid rows (cellY % workerCount === workerId)
// - No double buffering needed for grid (row ownership eliminates races)
// - No Atomics, no locks, no coordination between workers
// - Fixed memory layout like Excel spreadsheet - 100% deterministic
// - Neighbor data still uses double buffering for clean reads by logic workers
//
// MEMORY LAYOUT:
// SpatialGridSAB: Fixed cells with [count, pad, entities[MAX_ENTITIES_PER_CELL]]
// NeighborsSAB:   Fixed per-entity with [count, pad, neighbors[MAX_NEIGHBORS]]
// DistancesSAB:   Fixed per-entity with [dist2[MAX_NEIGHBORS]]

import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";

// ============================================================================
// CONSTANTS - Must match across all workers
// ============================================================================
const MAX_ENTITIES_PER_CELL = 16;  // Max entities that can occupy a single cell
const MAX_NEIGHBORS = 500;         // Max neighbors per entity

// Cell byte layout: 4 bytes (count + pad) + MAX_ENTITIES_PER_CELL * 4 bytes
const CELL_BYTE_SIZE = 4 + MAX_ENTITIES_PER_CELL * 4; // 68 bytes

// Neighbor byte layout per entity: 4 bytes (count + pad) + MAX_NEIGHBORS * 4 bytes
const NEIGHBOR_STRIDE = 1 + MAX_NEIGHBORS; // In Uint32 elements (count + neighbors)

/**
 * Grid - Static class for row-based spatial partitioning
 * 
 * ROW OWNERSHIP MODEL:
 * - Worker i owns all cells where: cellY % totalWorkers === workerId
 * - Each worker rebuilds its own rows from scratch each frame
 * - Each worker computes neighbors only for entities in its rows
 * - Workers can READ any cell (for 3x3 neighbor search) but only WRITE to owned rows
 *
 * Usage:
 *   // Get cell index from world position
 *   const cellIdx = Grid.getCellIndex(worldX, worldY);
 *   
 *   // Get entities in a cell
 *   const count = Grid.getCellCount(cellIdx);
 *   for (let i = 0; i < count; i++) {
 *     const entityId = Grid.getCellEntity(cellIdx, i);
 *   }
 *   
 *   // Get neighbors for an entity (from double-buffered read buffer)
 *   const neighborCount = Grid.getNeighborCount(entityId);
 *   for (let k = 0; k < neighborCount; k++) {
 *     const neighborId = Grid.getNeighbor(entityId, k);
 *     const distSq = Grid.getNeighborDistanceSq(entityId, k);
 *   }
 */
export class Grid {
  // ===== GRID METADATA =====
  static cellSize = 0;
  static invCellSize = 0;       // 1/cellSize for fast division
  static gridWidth = 0;         // Number of columns
  static gridHeight = 0;        // Number of rows
  static totalCells = 0;
  static maxEntitiesPerCell = MAX_ENTITIES_PER_CELL;
  static maxNeighbors = MAX_NEIGHBORS;

  // ===== SPATIAL GRID DATA (Single Buffer - Row Ownership) =====
  // Layout per cell: [count:Uint8, pad:3bytes, entities[16]:Uint32]
  static _gridBuffer = null;    // SharedArrayBuffer
  static _gridCounts = null;    // Uint8Array - count per cell
  static _gridEntities = null;  // Uint32Array - entity IDs (offset 4 per cell)

  // ===== NEIGHBOR DATA (Double Buffered for Clean Reads) =====
  // Layout per entity: [count:Uint16, pad:2bytes, neighbors[MAX_NEIGHBORS]:Uint32]
  static _neighborBufferA = null;
  static _neighborBufferB = null;
  static _neighborDataA = null;  // Int32Array
  static _neighborDataB = null;  // Int32Array

  // Layout per entity: [dist2[MAX_NEIGHBORS]:Float32]
  static _distanceBufferA = null;
  static _distanceBufferB = null;
  static _distanceDataA = null;  // Float32Array
  static _distanceDataB = null;  // Float32Array

  // ===== SYNCHRONIZATION =====
  // [0] = currentReadBuffer (0=A, 1=B)
  // [1] = workersFinished counter
  // [2] = totalWorkers
  static _syncBuffer = null;
  static _syncData = null;       // Int32Array

  // Internal stride for neighbor arrays
  static _stride = NEIGHBOR_STRIDE;

  // ===== INITIALIZATION =====

  /**
   * Initialize Grid with SharedArrayBuffers and metadata
   * Called once per worker during initialization
   * 
   * @param {Object} buffers - SharedArrayBuffers:
   *   - gridBuffer: Single buffer for spatial grid
   *   - neighborBufferA/B: Double-buffered neighbor indices
   *   - distanceBufferA/B: Double-buffered neighbor distances
   *   - syncBuffer: Synchronization data
   * @param {Object} metadata - Grid configuration:
   *   - cellSize, gridWidth, gridHeight, maxNeighbors
   */
  static initialize(buffers, metadata) {
    // Store metadata
    Grid.cellSize = metadata.cellSize || 128;
    Grid.invCellSize = 1 / Grid.cellSize;
    Grid.gridWidth = metadata.gridWidth || metadata.gridCols || 0;
    Grid.gridHeight = metadata.gridHeight || metadata.gridRows || 0;
    Grid.totalCells = Grid.gridWidth * Grid.gridHeight;
    Grid.maxNeighbors = metadata.maxNeighbors || MAX_NEIGHBORS;
    Grid._stride = 1 + Grid.maxNeighbors;

    // ===== SPATIAL GRID (Single Buffer) =====
    if (buffers.gridBuffer) {
      Grid._gridBuffer = buffers.gridBuffer;
      // Count array: 1 byte per cell at offset 0 of each cell
      Grid._gridCounts = new Uint8Array(buffers.gridBuffer);
      // Entity array: Uint32 starting at byte 4 of each cell
      Grid._gridEntities = new Uint32Array(buffers.gridBuffer);
    }

    // ===== NEIGHBOR DATA (Double Buffered) =====
    if (buffers.neighborBufferA) {
      Grid._neighborBufferA = buffers.neighborBufferA;
      Grid._neighborDataA = new Int32Array(buffers.neighborBufferA);
    }
    if (buffers.neighborBufferB) {
      Grid._neighborBufferB = buffers.neighborBufferB;
      Grid._neighborDataB = new Int32Array(buffers.neighborBufferB);
    }

    // ===== DISTANCE DATA (Double Buffered) =====
    if (buffers.distanceBufferA) {
      Grid._distanceBufferA = buffers.distanceBufferA;
      Grid._distanceDataA = new Float32Array(buffers.distanceBufferA);
    }
    if (buffers.distanceBufferB) {
      Grid._distanceBufferB = buffers.distanceBufferB;
      Grid._distanceDataB = new Float32Array(buffers.distanceBufferB);
    }

    // ===== SYNCHRONIZATION =====
    if (buffers.syncBuffer) {
      Grid._syncBuffer = buffers.syncBuffer;
      Grid._syncData = new Int32Array(buffers.syncBuffer);
    }

    // Legacy support: also accept old buffer names for backwards compatibility during transition
    if (buffers.gridEntitiesA && !Grid._gridBuffer) {
      // Old system - create views for backwards compatibility
      Grid._gridBuffer = buffers.gridEntitiesA;
      Grid._gridCounts = buffers.gridCountsA ? new Uint16Array(buffers.gridCountsA) : null;
      Grid._gridEntities = new Uint32Array(buffers.gridEntitiesA);
    }
    if (buffers.neighborDataA && !Grid._neighborBufferA) {
      Grid._neighborBufferA = buffers.neighborDataA;
      Grid._neighborDataA = new Int32Array(buffers.neighborDataA);
    }
    if (buffers.neighborDataB && !Grid._neighborBufferB) {
      Grid._neighborBufferB = buffers.neighborDataB;
      Grid._neighborDataB = new Int32Array(buffers.neighborDataB);
    }
    if (buffers.distanceDataA && !Grid._distanceBufferA) {
      Grid._distanceBufferA = buffers.distanceDataA;
      Grid._distanceDataA = new Float32Array(buffers.distanceDataA);
    }
    if (buffers.distanceDataB && !Grid._distanceBufferB) {
      Grid._distanceBufferB = buffers.distanceDataB;
      Grid._distanceDataB = new Float32Array(buffers.distanceDataB);
    }
    if (buffers.neighborSyncData && !Grid._syncBuffer) {
      Grid._syncBuffer = buffers.neighborSyncData;
      Grid._syncData = new Int32Array(buffers.neighborSyncData);
    }
  }

  // ===== CELL ACCESS (Read from Single Grid Buffer) =====

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
      row: (cellIndex / Grid.gridWidth) | 0
    };
  }

  /**
   * Get number of entities in a cell
   * @param {number} cellIndex - Cell index
   * @returns {number} Entity count (0-MAX_ENTITIES_PER_CELL)
   */
  static getCellCount(cellIndex) {
    if (!Grid._gridCounts || cellIndex < 0 || cellIndex >= Grid.totalCells) return 0;

    // For new layout: count is at byte offset = cellIndex * CELL_BYTE_SIZE
    const byteOffset = cellIndex * CELL_BYTE_SIZE;
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
    // Uint32 index = (cellIndex * CELL_BYTE_SIZE + 4) / 4 + k
    const uint32Offset = ((cellIndex * CELL_BYTE_SIZE) >> 2) + 1 + k;
    return Grid._gridEntities[uint32Offset];
  }

  /**
   * Get base byte offset for a cell (for direct buffer access in hot loops)
   * @param {number} cellIndex - Cell index
   * @returns {number} Byte offset into grid buffer
   */
  static getCellByteOffset(cellIndex) {
    return cellIndex * CELL_BYTE_SIZE;
  }

  /**
   * Get entity count in a cell (alias for getCellCount for Ray.js compatibility)
   * @param {number} cellIndex - Cell index
   * @returns {number} Entity count
   */
  static getCellEntityCount(cellIndex) {
    return Grid.getCellCount(cellIndex);
  }

  /**
   * Get base index for cell entities in gridEntities array (for Ray.js compatibility)
   * NOTE: This returns a Uint32 index offset, not a byte offset
   * Use with: gridEntities[cellBase + i]
   * @param {number} cellIndex - Cell index
   * @returns {number} Base Uint32 index into gridEntities
   */
  static getCellBase(cellIndex) {
    // Entity data starts at byte 4 of each cell (after count + padding)
    // Uint32 index = (byteOffset + 4) / 4 = byteOffset/4 + 1
    const byteOffset = cellIndex * CELL_BYTE_SIZE;
    return (byteOffset >> 2) + 1;
  }

  // ===== CELL WRITE (Only to Owned Rows) =====

  /**
   * Clear a cell's entity count (call before rebuilding)
   * IMPORTANT: Only call this for cells you own (cellRow % totalWorkers === workerId)
   * @param {number} cellIndex - Cell index
   */
  static clearCell(cellIndex) {
    if (!Grid._gridCounts) return;
    const byteOffset = cellIndex * CELL_BYTE_SIZE;
    Grid._gridCounts[byteOffset] = 0;
  }

  /**
   * Add an entity to a cell
   * IMPORTANT: Only call this for cells you own
   * @param {number} cellIndex - Cell index
   * @param {number} entityId - Entity ID to add
   * @returns {boolean} True if added, false if cell is full
   */
  static addEntityToCell(cellIndex, entityId) {
    if (!Grid._gridCounts || !Grid._gridEntities) return false;

    const byteOffset = cellIndex * CELL_BYTE_SIZE;
    const count = Grid._gridCounts[byteOffset];

    if (count >= MAX_ENTITIES_PER_CELL) return false;

    // Entity array starts at byte 4 (Uint32 index 1)
    const uint32Offset = (byteOffset >> 2) + 1 + count;
    Grid._gridEntities[uint32Offset] = entityId;
    Grid._gridCounts[byteOffset] = count + 1;

    return true;
  }

  // ===== NEIGHBOR DATA ACCESS (Double Buffered - Read from Current Read Buffer) =====

  /**
   * Get current read buffer for neighbors (dynamic getter)
   */
  static get neighborData() {
    if (!Grid._syncData || !Grid._neighborDataA) return Grid._neighborDataA;
    const readBuffer = Atomics.load(Grid._syncData, 0);
    return readBuffer === 0 ? Grid._neighborDataA : Grid._neighborDataB;
  }

  /**
   * Get current read buffer for distances (dynamic getter)
   */
  static get distanceData() {
    if (!Grid._syncData || !Grid._distanceDataA) return Grid._distanceDataA;
    const readBuffer = Atomics.load(Grid._syncData, 0);
    return readBuffer === 0 ? Grid._distanceDataA : Grid._distanceDataB;
  }

  /**
   * Get current write buffer for neighbors (opposite of read)
   */
  static get _neighborDataWrite() {
    if (!Grid._syncData || !Grid._neighborDataA) return Grid._neighborDataA;
    const readBuffer = Atomics.load(Grid._syncData, 0);
    return readBuffer === 0 ? Grid._neighborDataB : Grid._neighborDataA;
  }

  /**
   * Get current write buffer for distances (opposite of read)
   */
  static get _distanceDataWrite() {
    if (!Grid._syncData || !Grid._distanceDataA) return Grid._distanceDataA;
    const readBuffer = Atomics.load(Grid._syncData, 0);
    return readBuffer === 0 ? Grid._distanceDataB : Grid._distanceDataA;
  }

  /**
   * Get neighbor count for an entity (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @returns {number} Number of neighbors
   */
  static getNeighborCount(entityId) {
    const data = Grid.neighborData;
    if (!data) return 0;
    return data[entityId * Grid._stride];
  }

  /**
   * Get neighbor entity ID at index k (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to count-1)
   * @returns {number} Neighbor entity ID
   */
  static getNeighbor(entityId, k) {
    const data = Grid.neighborData;
    if (!data) return 0;
    return data[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get squared distance to neighbor at index k (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to count-1)
   * @returns {number} Squared distance
   */
  static getNeighborDistanceSq(entityId, k) {
    const data = Grid.distanceData;
    if (!data) return 0;
    return data[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get offset into neighbor/distance arrays for an entity
   * Use this for direct array access in performance-critical loops
   * @param {number} entityId - Entity index
   * @returns {number} Offset into arrays
   */
  static getNeighborOffset(entityId) {
    return entityId * Grid._stride;
  }

  // ===== NEIGHBOR DATA WRITE (Only for Entities You Own) =====

  /**
   * Set neighbor count for an entity (writes to current write buffer)
   * IMPORTANT: Only call for entities in cells you own
   * @param {number} entityId - Entity index
   * @param {number} count - Number of neighbors
   */
  static setNeighborCount(entityId, count) {
    const neighborData = Grid._neighborDataWrite;
    const distanceData = Grid._distanceDataWrite;
    if (!neighborData) return;

    const offset = entityId * Grid._stride;
    neighborData[offset] = count;
    if (distanceData) distanceData[offset] = count;
  }

  /**
   * Set neighbor data at index k (writes to current write buffer)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index
   * @param {number} neighborId - Neighbor entity ID
   * @param {number} distSq - Squared distance to neighbor
   */
  static setNeighbor(entityId, k, neighborId, distSq) {
    const neighborData = Grid._neighborDataWrite;
    const distanceData = Grid._distanceDataWrite;
    if (!neighborData) return;

    const idx = entityId * Grid._stride + 1 + k;
    neighborData[idx] = neighborId;
    if (distanceData) distanceData[idx] = distSq;
  }

  // ===== SYNCHRONIZATION =====

  /**
   * Signal that a spatial worker has finished computing neighbors
   * The LAST worker to finish will swap the read/write buffers
   * @returns {boolean} True if this worker performed the swap
   */
  static signalSpatialWorkerFinished() {
    if (!Grid._syncData) return false;

    // Atomically increment finished counter
    const finishedCount = Atomics.add(Grid._syncData, 1, 1) + 1;
    const totalWorkers = Atomics.load(Grid._syncData, 2);

    // Last worker to finish swaps buffers
    if (finishedCount === totalWorkers) {
      const currentReadBuffer = Atomics.load(Grid._syncData, 0);
      const newReadBuffer = 1 - currentReadBuffer;
      Atomics.store(Grid._syncData, 0, newReadBuffer);

      // Reset finished counter for next frame
      Atomics.store(Grid._syncData, 1, 0);

      return true;
    }

    return false;
  }

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

  // ===== LEGACY COMPATIBILITY =====
  // These properties maintain backwards compatibility with old double-buffered grid code

  static get gridEntities() {
    return Grid._gridEntities;
  }

  static get gridCounts() {
    return Grid._gridCounts;
  }

  static get gridCols() {
    return Grid.gridWidth;
  }

  static get gridRows() {
    return Grid.gridHeight;
  }

  // Legacy: swapGridBuffers is no longer needed (row ownership eliminates races)
  // Kept as no-op for backwards compatibility
  static swapGridBuffers() {
    // No-op: Grid is now single-buffered with row ownership
  }
}

// Export constants for use by other modules
export { MAX_ENTITIES_PER_CELL, MAX_NEIGHBORS, CELL_BYTE_SIZE, NEIGHBOR_STRIDE };
