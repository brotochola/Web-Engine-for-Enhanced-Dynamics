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
  // ===== GRID DATA - SINGLE BUFFER (row-partitioned across spatial_workers) =====
  // Each spatial_worker owns rows where (row % numWorkers == workerIndex)
  // No double-buffering needed - workers write to non-overlapping rows
  static gridEntities = null; // Uint32Array - entity IDs per cell
  static gridCounts = null; // Uint16Array - entity count per cell

  // ===== NEIGHBOR DATA - QUADRUPLE BUFFERED =====
  // A/B: Spatial workers ping-pong write buffers
  // StableA/StableB: Consumer read buffers (double-stable pattern)
  // This eliminates ALL race conditions: consumers never read from a buffer being written
  static neighborDataA = null; // Int32Array - Buffer A (spatial write)
  static neighborDataB = null; // Int32Array - Buffer B (spatial write)
  static distanceDataA = null; // Float32Array - Buffer A (spatial write)
  static distanceDataB = null; // Float32Array - Buffer B (spatial write)

  // DOUBLE STABLE BUFFERS - One is read by consumers, other receives copy
  // When copy completes, an atomic flag swap makes the other buffer active
  static neighborDataStableA = null; // Int32Array - stable buffer A
  static neighborDataStableB = null; // Int32Array - stable buffer B
  static distanceDataStableA = null; // Float32Array - stable buffer A
  static distanceDataStableB = null; // Float32Array - stable buffer B

  // SYNCHRONIZATION - for buffer swapping
  // [0] = currentWriteBuffer (0=A, 1=B) - which A/B buffer spatial workers write to
  // [1] = workersFinishedA - counter for buffer A
  // [2] = workersFinishedB - counter for buffer B
  // [3] = totalSpatialWorkers
  // [4] = currentStableRead (0=StableA, 1=StableB) - which stable buffer consumers read from
  static neighborSyncData = null; // Int32Array

  // ===== STABLE READ ACCESS (for logic/particle workers) =====
  // Dynamic getters select the correct stable buffer based on sync flag
  // Consumers should cache the result once per frame for performance

  /**
   * Get the stable neighbor data array for reading
   * Returns the stable buffer NOT being written to (atomic swap ensures consistency)
   * @returns {Int32Array} Stable neighbor data (never changes mid-frame)
   */
  static get neighborData() {
    if (!Grid.neighborSyncData) return Grid.neighborDataStableA;
    const stableRead = Atomics.load(Grid.neighborSyncData, 4);
    return stableRead === 0 ? Grid.neighborDataStableA : Grid.neighborDataStableB;
  }

  /**
   * Get the stable distance data array for reading
   * Returns the stable buffer NOT being written to (atomic swap ensures consistency)
   * @returns {Float32Array} Stable distance data (never changes mid-frame)
   */
  static get distanceData() {
    if (!Grid.neighborSyncData) return Grid.distanceDataStableA;
    const stableRead = Atomics.load(Grid.neighborSyncData, 4);
    return stableRead === 0 ? Grid.distanceDataStableA : Grid.distanceDataStableB;
  }

  // ===== WRITE BUFFER ACCESS (for spatial_worker only) =====
  // Spatial workers write to A or B based on sync flag

  static get _neighborDataWrite() {
    if (!Grid.neighborSyncData || !Grid.neighborDataA)
      return Grid.neighborDataA;
    const writeBuffer = Atomics.load(Grid.neighborSyncData, 0);
    return writeBuffer === 0 ? Grid.neighborDataA : Grid.neighborDataB;
  }

  static get _distanceDataWrite() {
    if (!Grid.neighborSyncData || !Grid.distanceDataA)
      return Grid.distanceDataA;
    const writeBuffer = Atomics.load(Grid.neighborSyncData, 0);
    return writeBuffer === 0 ? Grid.distanceDataA : Grid.distanceDataB;
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
    // Single grid buffer (row-partitioned across spatial_workers)
    Grid.gridEntities = buffers.gridEntities
      ? new Uint32Array(buffers.gridEntities)
      : null;
    Grid.gridCounts = buffers.gridCounts
      ? new Uint16Array(buffers.gridCounts)
      : null;

    // Quadruple-buffered neighbor data
    // A/B: Spatial workers write (ping-pong)
    // StableA/StableB: Consumers read (double-stable with atomic swap)
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

    // Double stable buffers - consumers read from one while copy happens to other
    // Atomic swap of read index ensures consumers never read during copy
    Grid.neighborDataStableA = buffers.neighborDataStableA
      ? new Int32Array(buffers.neighborDataStableA)
      : null;
    Grid.neighborDataStableB = buffers.neighborDataStableB
      ? new Int32Array(buffers.neighborDataStableB)
      : null;
    Grid.distanceDataStableA = buffers.distanceDataStableA
      ? new Float32Array(buffers.distanceDataStableA)
      : null;
    Grid.distanceDataStableB = buffers.distanceDataStableB
      ? new Float32Array(buffers.distanceDataStableB)
      : null;

    // Synchronization buffer for spatial worker coordination
    // [0] = currentWriteBuffer (0=A, 1=B) - which buffer spatial workers write to
    // [1] = workersFinishedA - counter for buffer A
    // [2] = workersFinishedB - counter for buffer B
    // [3] = totalWorkers - total spatial workers
    // [4] = currentStableRead (0=StableA, 1=StableB) - which stable buffer consumers read
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

  // ===== TRIPLE BUFFER SWAP (for spatial_worker) =====

  /**
   * Get the current write buffer index
   * Spatial workers should call this at the START of their frame and remember the value
   * @returns {number} 0 for buffer A, 1 for buffer B
   */
  static getCurrentWriteBuffer() {
    if (!Grid.neighborSyncData) return 0;
    return Atomics.load(Grid.neighborSyncData, 0);
  }

  /**
   * Reset all neighbor sync counters
   * Called when resuming from background/throttled state to ensure clean slate
   * This prevents corrupted counter states from causing flickering
   */
  static resetNeighborSyncCounters() {
    if (!Grid.neighborSyncData) return;
    // Reset both buffer counters to 0
    Atomics.store(Grid.neighborSyncData, 1, 0); // workersFinishedA
    Atomics.store(Grid.neighborSyncData, 2, 0); // workersFinishedB
  }

  /**
   * Signal that this spatial worker has finished computing neighbors
   * Uses per-buffer counters to handle workers running at different speeds
   *
   * DOUBLE-STABLE PATTERN:
   * 1. Copy completed write buffer → INACTIVE stable buffer
   * 2. Atomically swap which stable buffer consumers read from
   * 3. Toggle write buffer for next frame
   * This ensures consumers NEVER read from a buffer being written to.
   *
   * @param {number} bufferIndex - Which buffer this worker wrote to (0=A, 1=B)
   *                               MUST be the value from getCurrentWriteBuffer() at frame start
   * @returns {boolean} True if this worker performed the copy+swap (was last to finish this buffer)
   */
  static signalSpatialWorkerFinished(bufferIndex) {
    if (!Grid.neighborSyncData) return false;

    // Per-buffer counter indices: [1] = buffer A counter, [2] = buffer B counter
    const counterIndex = 1 + bufferIndex;
    const totalWorkers = Atomics.load(Grid.neighborSyncData, 3);

    // SAFETY CHECK: If counter is already >= totalWorkers, it's corrupted (e.g., from
    // background tab issues). Reset it before proceeding to prevent permanent deadlock.
    const currentCount = Atomics.load(Grid.neighborSyncData, counterIndex);
    if (currentCount >= totalWorkers) {
      Atomics.store(Grid.neighborSyncData, counterIndex, 0);
    }

    // Atomically increment THIS buffer's finished counter
    const finishedCount = Atomics.add(Grid.neighborSyncData, counterIndex, 1) + 1;

    // If all workers finished writing to THIS buffer, copy to inactive stable and swap
    if (finishedCount === totalWorkers) {
      // Get which stable buffer consumers are currently reading from
      const currentStableRead = Atomics.load(Grid.neighborSyncData, 4);

      // COPY: Write buffer → INACTIVE stable buffer (the one NOT being read)
      // Consumers continue reading from the active stable buffer during this copy
      // TypedArray.set() uses optimized memcpy - very fast (~1-2ms for 8MB)
      if (currentStableRead === 0) {
        // Consumers reading StableA, so copy to StableB
        if (bufferIndex === 0) {
          Grid.neighborDataStableB.set(Grid.neighborDataA);
          Grid.distanceDataStableB.set(Grid.distanceDataA);
        } else {
          Grid.neighborDataStableB.set(Grid.neighborDataB);
          Grid.distanceDataStableB.set(Grid.distanceDataB);
        }
      } else {
        // Consumers reading StableB, so copy to StableA
        if (bufferIndex === 0) {
          Grid.neighborDataStableA.set(Grid.neighborDataA);
          Grid.distanceDataStableA.set(Grid.distanceDataA);
        } else {
          Grid.neighborDataStableA.set(Grid.neighborDataB);
          Grid.distanceDataStableA.set(Grid.distanceDataB);
        }
      }

      // ATOMIC SWAP: Toggle which stable buffer consumers read from
      // After this atomic store, consumers will start reading from the newly copied buffer
      const newStableRead = 1 - currentStableRead;
      Atomics.store(Grid.neighborSyncData, 4, newStableRead);

      // Reset THIS write buffer's counter (ready for next time it's used)
      Atomics.store(Grid.neighborSyncData, counterIndex, 0);

      // SWAP: Toggle write buffer for next frame
      // New writers will write to the OTHER buffer
      const newWriteBuffer = 1 - bufferIndex;
      Atomics.store(Grid.neighborSyncData, 0, newWriteBuffer);

      return true; // This worker performed the copy+swap
    }

    return false; // Not the last worker for this buffer
  }

}
