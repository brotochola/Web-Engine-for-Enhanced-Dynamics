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

  // ===== NEIGHBOR DATA (SAB views) =====
  static neighborData = null; // Int32Array - neighbor indices per entity
  static distanceData = null; // Float32Array - squared distances to neighbors

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
   *   - neighborData: SharedArrayBuffer for neighbor indices
   *   - distanceData: SharedArrayBuffer for neighbor distances
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

    // Neighbor buffers
    if (buffers.neighborData) {
      Grid.neighborData = new Int32Array(buffers.neighborData);
    }
    if (buffers.distanceData) {
      Grid.distanceData = new Float32Array(buffers.distanceData);
    }

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
   * Get neighbor count for an entity
   * @param {number} entityId - Entity index
   * @returns {number} Number of neighbors
   */
  static getNeighborCount(entityId) {
    if (!Grid.neighborData) return 0;
    return Grid.neighborData[entityId * Grid._stride];
  }

  /**
   * Get neighbor entity ID at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to getNeighborCount-1)
   * @returns {number} Neighbor entity ID
   */
  static getNeighbor(entityId, k) {
    return Grid.neighborData[entityId * Grid._stride + 1 + k];
  }

  /**
   * Get squared distance to neighbor at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index (0 to getNeighborCount-1)
   * @returns {number} Squared distance to neighbor
   */
  static getNeighborDistanceSq(entityId, k) {
    return Grid.distanceData[entityId * Grid._stride + 1 + k];
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
   * Set neighbor count for an entity
   * @param {number} entityId - Entity index
   * @param {number} count - Number of neighbors
   */
  static setNeighborCount(entityId, count) {
    const offset = entityId * Grid._stride;
    Grid.neighborData[offset] = count;
    Grid.distanceData[offset] = count;
  }

  /**
   * Set neighbor data at index k
   * @param {number} entityId - Entity index
   * @param {number} k - Neighbor index
   * @param {number} neighborId - Neighbor entity ID
   * @param {number} distSq - Squared distance to neighbor
   */
  static setNeighbor(entityId, k, neighborId, distSq) {
    const idx = entityId * Grid._stride + 1 + k;
    Grid.neighborData[idx] = neighborId;
    Grid.distanceData[idx] = distSq;
  }
}
