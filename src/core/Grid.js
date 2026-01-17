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
  // ===== GRID DATA - DOUBLE BUFFERED (SAB views) =====
  static gridEntitiesA = null; // Uint32Array - Buffer A
  static gridEntitiesB = null; // Uint32Array - Buffer B
  static gridCountsA = null; // Uint16Array - Buffer A
  static gridCountsB = null; // Uint16Array - Buffer B

  // GRID SYNCHRONIZATION
  static gridSyncData = null; // Int32Array - [rebuildFlag, currentReadGrid]

  static get gridEntities() {
    if (!Grid.gridSyncData || !Grid.gridEntitiesA) return Grid.gridEntitiesA;
    try {
      const readGrid = Atomics.load(Grid.gridSyncData, 1);
      return readGrid === 0 ? Grid.gridEntitiesA : Grid.gridEntitiesB;
    } catch (e) {
      console.error("[Grid] Error in gridEntities getter:", e);
      return Grid.gridEntitiesA;
    }
  }

  static get gridCounts() {
    if (!Grid.gridSyncData || !Grid.gridCountsA) return Grid.gridCountsA;
    try {
      const readGrid = Atomics.load(Grid.gridSyncData, 1);
      return readGrid === 0 ? Grid.gridCountsA : Grid.gridCountsB;
    } catch (e) {
      console.error("[Grid] Error in gridCounts getter:", e);
      return Grid.gridCountsA;
    }
  }

  // INTERNAL: Get write grid (opposite of read grid)
  static get _gridEntitiesWrite() {
    if (!Grid.gridSyncData || !Grid.gridEntitiesA) return Grid.gridEntitiesA;
    try {
      const readGrid = Atomics.load(Grid.gridSyncData, 1);
      return readGrid === 0 ? Grid.gridEntitiesB : Grid.gridEntitiesA;
    } catch (e) {
      console.error("[Grid] Error in _gridEntitiesWrite getter:", e);
      return Grid.gridEntitiesA;
    }
  }

  static get _gridCountsWrite() {
    if (!Grid.gridSyncData || !Grid.gridCountsA) return Grid.gridCountsA;
    try {
      const readGrid = Atomics.load(Grid.gridSyncData, 1);
      return readGrid === 0 ? Grid.gridCountsB : Grid.gridCountsA;
    } catch (e) {
      console.error("[Grid] Error in _gridCountsWrite getter:", e);
      return Grid.gridCountsA;
    }
  }

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
    // Double-buffered grid data
    Grid.gridEntitiesA = buffers.gridEntitiesA
      ? new Uint32Array(buffers.gridEntitiesA)
      : null;
    Grid.gridEntitiesB = buffers.gridEntitiesB
      ? new Uint32Array(buffers.gridEntitiesB)
      : null;
    Grid.gridCountsA = buffers.gridCountsA
      ? new Uint16Array(buffers.gridCountsA)
      : null;
    Grid.gridCountsB = buffers.gridCountsB
      ? new Uint16Array(buffers.gridCountsB)
      : null;

    // Grid synchronization buffer
    Grid.gridSyncData = buffers.gridSyncData
      ? new Int32Array(buffers.gridSyncData)
      : null;

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

  // ===== OVERLAPPED GRID EXECUTION =====
  // gridSyncData layout:
  //   [0] = rebuild status (0=rebuilding, 1=ready) - LEGACY, kept for compatibility
  //   [1] = current read grid index (0=A, 1=B)
  //   [2] = spatial workers reading count (how many are currently reading the grid)
  //   [3] = frame generation counter (increments each frame to detect stale reads)

  /**
   * Signal that a spatial worker is starting to read the grid
   * Called at the START of spatial_worker.update() - NON-BLOCKING
   * Returns immediately, allowing overlapped execution with grid rebuild
   */
  static signalGridReadStart() {
    if (!Grid.gridSyncData) return;
    // Atomically increment readers count
    Atomics.add(Grid.gridSyncData, 2, 1);
  }

  /**
   * Signal that a spatial worker has finished reading the grid
   * Called at the END of spatial_worker.update()
   * Wakes particle_worker if it's waiting for all readers to finish
   */
  static signalGridReadEnd() {
    if (!Grid.gridSyncData) return;
    // Atomically decrement readers count
    const readersLeft = Atomics.sub(Grid.gridSyncData, 2, 1) - 1;
    // If no more readers, notify particle_worker (if it's waiting)
    if (readersLeft === 0) {
      Atomics.notify(Grid.gridSyncData, 2, 1);
    }
  }

  /**
   * Wait for all spatial workers to finish reading the current grid
   * Called by particle_worker BEFORE swapping grid buffers
   * This ensures no spatial worker is reading the buffer we're about to write to
   */
  static waitForGridReadersToFinish() {
    if (!Grid.gridSyncData) return;
    // Wait while readers count > 0
    // "not-equal" condition means: wait while value equals the expected value
    // So we wait while readersCount === currentValue (non-zero)
    while (Atomics.load(Grid.gridSyncData, 2) > 0) {
      // Wait for readers to finish (will be woken by signalGridReadEnd)
      Atomics.wait(Grid.gridSyncData, 2, Atomics.load(Grid.gridSyncData, 2), 10);
    }
  }

  /**
   * Swap the grid read/write buffers
   * Called by particle_worker after rebuilding the grid
   * IMPORTANT: Call waitForGridReadersToFinish() BEFORE this!
   */
  static swapGridBuffers() {
    if (!Grid.gridSyncData) return;

    const currentReadGrid = Atomics.load(Grid.gridSyncData, 1);
    const newReadGrid = 1 - currentReadGrid;
    Atomics.store(Grid.gridSyncData, 1, newReadGrid);
  }
}
