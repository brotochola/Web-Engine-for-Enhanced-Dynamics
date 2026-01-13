// Grid.js - Unified spatial grid and neighbor data access
// Used by all workers for spatial queries and neighbor access
// Provides a clean API while hiding internal stride/offset calculations

import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";

/**
 * Grid - Static class for spatial grid and neighbor data access
 *
 * Usage:
 *   // Cell queries
 *   const cellIdx = Grid.getCellIndex(worldX, worldY);
 *   const cellIdx = Grid.getEntityCell(entityId);
 *   const count = Grid.getCellEntityCount(cellIdx);
 *
 *   // Iterate entities in a cell
 *   const base = Grid.getCellBase(cellIdx);
 *   for (let i = 0; i < count; i++) {
 *     const entityId = Grid.gridEntities[base + i];
 *   }
 *
 *   // Neighbor queries (stride logic hidden)
 *   const neighborCount = Grid.getNeighborCount(entityId);
 *   for (let k = 0; k < neighborCount; k++) {
 *     const neighborId = Grid.getNeighbor(entityId, k);
 *     const distSq = Grid.getNeighborDistanceSq(entityId, k);
 *   }
 */
export class Grid {
  // ===== GRID DATA (SAB views) =====
  static gridEntities = null; // Uint32Array - entity IDs per cell
  static gridCounts = null; // Uint16Array - count per cell

  // ===== NEIGHBOR DATA - DOUBLE BUFFERED (SAB views) =====
  // Store both buffers - dynamically select which to read/write based on sync flag
  static neighborDataA = null; // Int32Array - Buffer A
  static neighborDataB = null; // Int32Array - Buffer B
  static distanceDataA = null; // Float32Array - Buffer A
  static distanceDataB = null; // Float32Array - Buffer B

  // SYNCHRONIZATION - for buffer swapping
  static neighborSyncData = null; // Int32Array - [currentReadBuffer, workersFinished, totalWorkers]

  // LEGACY GETTERS - dynamically return correct buffer based on sync flag
  static get neighborData() {
    if (!Grid.neighborSyncData || !Grid.neighborDataA)
      return Grid.neighborDataA;
    try {
      const readBuffer = Atomics.load(Grid.neighborSyncData, 0);
      return readBuffer === 0 ? Grid.neighborDataA : Grid.neighborDataB;
    } catch (e) {
      console.error("[Grid] Error in neighborData getter:", e);
      return Grid.neighborDataA;
    }
  }

  static get distanceData() {
    if (!Grid.neighborSyncData || !Grid.distanceDataA)
      return Grid.distanceDataA;
    try {
      const readBuffer = Atomics.load(Grid.neighborSyncData, 0);
      return readBuffer === 0 ? Grid.distanceDataA : Grid.distanceDataB;
    } catch (e) {
      console.error("[Grid] Error in distanceData getter:", e);
      return Grid.distanceDataA;
    }
  }

  // INTERNAL: Get write buffer (opposite of read buffer)
  static get _neighborDataWrite() {
    if (!Grid.neighborSyncData || !Grid.neighborDataA)
      return Grid.neighborDataA;
    try {
      const readBuffer = Atomics.load(Grid.neighborSyncData, 0);
      return readBuffer === 0 ? Grid.neighborDataB : Grid.neighborDataA;
    } catch (e) {
      console.error("[Grid] Error in _neighborDataWrite getter:", e);
      return Grid.neighborDataA;
    }
  }

  static get _distanceDataWrite() {
    if (!Grid.neighborSyncData || !Grid.distanceDataA)
      return Grid.distanceDataA;
    try {
      const readBuffer = Atomics.load(Grid.neighborSyncData, 0);
      return readBuffer === 0 ? Grid.distanceDataB : Grid.distanceDataA;
    } catch (e) {
      console.error("[Grid] Error in _distanceDataWrite getter:", e);
      return Grid.distanceDataA;
    }
  }

  // ===== GRID METADATA =====
  static cellSize = 0;
  static invCellSize = 0;
  static gridCols = 0;
  static gridRows = 0;
  static totalCells = 0;
  static maxEntitiesPerCell = 0;

  // ===== NEIGHBOR METADATA =====
  static maxNeighbors = 0;
  static _stride = 0; // internal: 1 + maxNeighbors

  // ===== INITIALIZATION =====

  /**
   * Initialize Grid with SharedArrayBuffer views and metadata
   * Called once per worker during initialization
   *
   * @param {Object} buffers - Object containing SABs:
   *   - gridEntities: SharedArrayBuffer for entity IDs per cell
   *   - gridCounts: SharedArrayBuffer for entity counts per cell
   *   - neighborDataA/B: SharedArrayBuffers for neighbor indices (double buffered)
   *   - distanceDataA/B: SharedArrayBuffers for neighbor distances (double buffered)
   *   - neighborSyncData: SharedArrayBuffer for synchronization
   * @param {Object} metadata - Grid configuration:
   *   - cellSize, invCellSize, gridCols, gridRows, totalCells, maxEntitiesPerCell, maxNeighbors
   */
  static initialize(buffers, metadata) {
    // Grid buffers
    if (buffers.gridEntities) {
      Grid.gridEntities = new Uint32Array(buffers.gridEntities);
    }
    if (buffers.gridCounts) {
      Grid.gridCounts = new Uint16Array(buffers.gridCounts);
    }

    // Double-buffered neighbor data
    // Store both buffers A and B
    // All workers dynamically select correct buffer based on neighborSyncData[0]
    // This ensures all workers automatically see buffer swaps without local pointer updates
    Grid.neighborDataA = buffers.neighborDataA
      ? new Int32Array(buffers.neighborDataA)
      : null;
    Grid.neighborDataB = buffers.neighborDataB
      ? new Int32Array(buffers.neighborDataB)
      : null;
    Grid.distanceDataA = buffers.distanceDataA
      ? new Float32Array(buffers.distanceDataA)
      : null;
    Grid.distanceDataB = buffers.distanceDataB
      ? new Float32Array(buffers.distanceDataB)
      : null;

    // Synchronization buffer for double buffering
    Grid.neighborSyncData = buffers.neighborSyncData
      ? new Int32Array(buffers.neighborSyncData)
      : null;

    // Grid metadata
    Grid.cellSize = metadata.cellSize || 0;
    Grid.invCellSize = metadata.invCellSize || 0;
    Grid.gridCols = metadata.gridCols || 0;
    Grid.gridRows = metadata.gridRows || 0;
    Grid.totalCells = metadata.totalCells || 0;
    Grid.maxEntitiesPerCell = metadata.maxEntitiesPerCell || 0;

    // Neighbor metadata
    Grid.maxNeighbors = metadata.maxNeighbors || 0;
    Grid._stride = 1 + Grid.maxNeighbors;
  }

  // ===== CELL METHODS =====

  /**
   * Get cell index from world position
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @returns {number} Cell index, or -1 if out of bounds
   */
  static getCellIndex(x, y) {
    const col = (x * Grid.invCellSize) | 0;
    const row = (y * Grid.invCellSize) | 0;

    if (col < 0 || col >= Grid.gridCols || row < 0 || row >= Grid.gridRows) {
      return -1;
    }

    return row * Grid.gridCols + col;
  }

  /**
   * Get cell index for an entity (uses Transform + Collider offset)
   * @param {number} entityId - Entity index
   * @returns {number} Cell index, or -1 if out of bounds
   */
  static getEntityCell(entityId) {
    const x = Transform.x[entityId] + (Collider.offsetX[entityId] || 0);
    const y = Transform.y[entityId] + (Collider.offsetY[entityId] || 0);
    return Grid.getCellIndex(x, y);
  }

  /**
   * Get number of entities in a cell
   * @param {number} cellIndex - Cell index
   * @returns {number} Entity count in cell
   */
  static getCellEntityCount(cellIndex) {
    if (cellIndex < 0 || cellIndex >= Grid.totalCells) return 0;
    return Grid.gridCounts[cellIndex];
  }

  /**
   * Get base offset for a cell's entities in gridEntities array
   * Use this for direct array access in performance-critical loops
   * @param {number} cellIndex - Cell index
   * @returns {number} Base offset into gridEntities
   */
  static getCellBase(cellIndex) {
    return cellIndex * Grid.maxEntitiesPerCell;
  }

  // ===== NEIGHBOR METHODS (stride logic hidden) =====

  /**
   * Get neighbor count for an entity (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @returns {number} Number of neighbors
   */
  static getNeighborCount(entityId) {
    const neighborData = Grid.neighborData; // Dynamic getter
    if (!neighborData) return 0;
    return neighborData[entityId * Grid._stride];
  }

  /**
   * Get neighbor entity ID at index k (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to getNeighborCount-1)
   * @returns {number} Neighbor entity ID
   */
  static getNeighbor(entityId, k) {
    const neighborData = Grid.neighborData; // Dynamic getter
    return neighborData[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get squared distance to neighbor at index k (reads from current read buffer)
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to getNeighborCount-1)
   * @returns {number} Squared distance to neighbor
   */
  static getNeighborDistanceSq(entityId, k) {
    const distanceData = Grid.distanceData; // Dynamic getter
    return distanceData[entityId * Grid._stride + 1 + k];
  }

  // ===== WRITE METHODS (for spatial_worker) =====

  /**
   * Get the offset into neighborData/distanceData for an entity
   * Use this for bulk writes in spatial_worker
   * @param {number} entityId - Entity index
   * @returns {number} Offset into neighbor arrays
   */
  static getNeighborOffset(entityId) {
    return entityId * Grid._stride;
  }

  /**
   * Set neighbor count for an entity (writes to current write buffer)
   * Used by spatial workers
   * @param {number} entityId - Entity index
   * @param {number} count - Number of neighbors
   */
  static setNeighborCount(entityId, count) {
    const offset = entityId * Grid._stride;
    const neighborDataWrite = Grid._neighborDataWrite; // Dynamic getter
    const distanceDataWrite = Grid._distanceDataWrite; // Dynamic getter
    neighborDataWrite[offset] = count;
    distanceDataWrite[offset] = count;
  }

  /**
   * Set neighbor data at index k (writes to current write buffer)
   * Used by spatial workers
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index
   * @param {number} neighborId - Neighbor entity ID
   * @param {number} distSq - Squared distance to neighbor
   */
  static setNeighbor(entityId, k, neighborId, distSq) {
    const idx = entityId * Grid._stride + 1 + k;
    const neighborDataWrite = Grid._neighborDataWrite; // Dynamic getter
    const distanceDataWrite = Grid._distanceDataWrite; // Dynamic getter
    neighborDataWrite[idx] = neighborId;
    distanceDataWrite[idx] = distSq;
  }

  // ===== DOUBLE BUFFER SWAP (for spatial_worker) =====

  /**
   * Signal that this spatial worker has finished computing neighbors
   * The LAST worker to finish will swap the read/write buffers
   * Called by spatial workers at the end of their update cycle
   * @returns {boolean} True if this worker performed the swap (was last to finish)
   */
  static signalSpatialWorkerFinished() {
    if (!Grid.neighborSyncData) return false;

    // Atomically increment the finished counter
    const finishedCount = Atomics.add(Grid.neighborSyncData, 1, 1) + 1;
    const totalWorkers = Atomics.load(Grid.neighborSyncData, 2);

    // If this is the last worker to finish, swap buffers
    if (finishedCount === totalWorkers) {
      // Swap the read buffer index (0 <-> 1)
      // All workers will automatically see this change via dynamic getters
      const currentReadBuffer = Atomics.load(Grid.neighborSyncData, 0);
      const newReadBuffer = 1 - currentReadBuffer;
      Atomics.store(Grid.neighborSyncData, 0, newReadBuffer);

      // Reset the finished counter for next frame
      Atomics.store(Grid.neighborSyncData, 1, 0);

      return true; // This worker performed the swap
    }

    return false; // Not the last worker
  }
}
