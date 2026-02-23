// NavGrid.js - Navigation grid for pathfinding (flowfields and A*)
//
// ============================================================================
// FLOWFIELD SYSTEM OVERVIEW
// ============================================================================
//
// Flowfields provide efficient pathfinding for MANY entities going to the SAME target.
// Instead of computing individual paths, we compute ONE flowfield per target that
// ALL entities can sample from.
//
// How it works:
// 1. Entity calls NavGrid.requestVector(myX, myY, targetX, targetY, outVec)
// 2. If flowfield for targetCell exists → returns direction vector immediately
// 3. If flowfield doesn't exist → returns (0,0), sends request to particle_worker
// 4. Particle worker computes flowfield using Dijkstra's algorithm
// 5. Next frame, entity gets the direction vector
//
// Key concepts:
// - targetCell: The destination cell (world position → grid cell)
// - Flowfield: A grid where each cell stores a direction pointing toward the target
// - Slot: Flowfields are cached in slots (default 16 slots, LRU eviction)
//
// ============================================================================
// MEMORY LAYOUT (SharedArrayBuffer)
// ============================================================================
//
// The navigation SAB is laid out as:
//
// [HEADER (32 bytes)]
//   - version (u32)      : Incremented on invalidation
//   - gridWidth (u32)    : Grid width in cells
//   - gridHeight (u32)   : Grid height in cells
//   - cellSize (u32)     : Pixels per cell
//   - totalCells (u32)   : gridWidth * gridHeight
//   - maxFlowfields (u32): Number of flowfield slots
//   - maxPaths (u32)     : Number of A* path slots
//   - maxPathLength (u32): Max cells per path
//
// [WALKABILITY (totalCells bytes)]
//   - 1 byte per cell: 0 = blocked, 1+ = walkable
//
// [FLOWFIELD SLOTS (interleaved)]
//   For each slot:
//   - Header (12 bytes): targetCell (u32), lastUsedFrame (u32), status (u32)
//   - Data (totalCells bytes): direction per cell (1 byte each)
//
// [PATH SLOTS]
//   For each slot:
//   - Header (20 bytes): fromCell, toCell, lastUsedFrame, length, status
//   - Data (maxPathLength * 4 bytes): cell indices
//
// ============================================================================
// MULTI-WORKER ARCHITECTURE
// ============================================================================
//
// - Main thread: Initializes SAB, can read for debug visualization
// - Logic workers: READ-ONLY - call requestVector(), receive directions
// - Particle worker: READ+WRITE - computes flowfields, writes to SAB
//
// Communication flow:
// 1. Logic worker calls requestVector() → flowfield not found
// 2. Logic worker sends REQUEST_FLOWFIELD message to particle_worker via MessagePort
// 3. Particle worker computes Dijkstra, writes to slot, sets status = READY
// 4. Next frame, logic worker finds flowfield and samples direction
//
// ============================================================================

/**
 * Flowfield slot status values
 */
const FLOWFIELD_STATUS = {
  EMPTY: 0,
  COMPUTING: 1,
  READY: 2,
};

/**
 * Path slot status values
 */
const PATH_STATUS = {
  EMPTY: 0,
  COMPUTING: 1,
  READY: 2,
};

/**
 * Direction encoding for flowfields
 * 8 directions + no movement = 9 values (fits in 4 bits)
 */
const DIRECTION = {
  NONE: 0,
  N: 1, // (0, -1)
  NE: 2, // (1, -1)
  E: 3, // (1, 0)
  SE: 4, // (1, 1)
  S: 5, // (0, 1)
  SW: 6, // (-1, 1)
  W: 7, // (-1, 0)
  NW: 8, // (-1, -1)
};

/**
 * Direction to dx/dy lookup table
 */
const DIR_TO_VEC = [
  [0, 0], // NONE
  [0, -1], // N
  [1, -1], // NE
  [1, 0], // E
  [1, 1], // SE
  [0, 1], // S
  [-1, 1], // SW
  [-1, 0], // W
  [-1, -1], // NW
];

/**
 * NavGrid - Navigation grid for pathfinding
 *
 * Provides:
 * - Flowfield pathfinding (for masses of entities going to same target)
 * - A* pathfinding (for individual path queries)
 * - Grid utilities (walkability checks, cell conversions)
 *
 * Usage pattern:
 * - Call requestVector() or getNextAStarPosition() every frame
 * - If data not ready, returns fallback (0,0 or current position)
 * - Particle worker computes in background, next frame will have data
 */
export class NavGrid {
  // =========================================================
  // Static state (shared across all instances in a worker)
  // =========================================================

  static _initialized = false;

  // SAB views
  static _sab = null;
  static _headerView = null; // Uint32Array for header
  static _walkability = null; // Uint8Array for walkability grid
  static _flowfieldHeaders = null; // Flowfield slot headers
  static _flowfieldData = null; // Flowfield direction data
  static _pathHeaders = null; // Path slot headers
  static _pathData = null; // Path cell data

  // Cached metadata (read once from header)
  static _version = 0;
  static _gridWidth = 0;
  static _gridHeight = 0;
  static _cellSize = 0;
  static _totalCells = 0;
  static _maxFlowfields = 0;
  static _maxPaths = 0;
  static _maxPathLength = 0;

  // World bounds (for coordinate conversions)
  static _worldWidth = 0;
  static _worldHeight = 0;

  // Communication port to particle worker (set by logic workers)
  static _navWorkerPort = null;

  // Request deduplication (avoid spamming particle worker)
  // Maps store targetCell/key -> version when request was made
  // Allows re-requesting after grid invalidation (version changes)
  static _pendingFlowfieldRequests = new Map();
  static _pendingPathRequests = new Map();

  // Frame tracking for LRU
  static _currentFrame = 0;

  // =========================================================
  // Byte offsets in the SAB (calculated in initialize)
  // =========================================================

  static _HEADER_SIZE = 32; // bytes (8 x Uint32)
  static _FLOWFIELD_HEADER_SIZE = 12; // bytes per slot (targetCell, lastUsedFrame, status)
  static _PATH_HEADER_SIZE = 20; // bytes per slot (fromCell, toCell, lastUsedFrame, length, status + padding)

  // Offsets (set in initialize based on grid size)
  static _walkabilityOffset = 0;
  static _flowfieldHeadersOffset = 0;
  static _flowfieldDataOffset = 0;
  static _pathHeadersOffset = 0;
  static _pathDataOffset = 0;

  // =========================================================
  // Initialization
  // =========================================================

  /**
   * Calculate the total SAB size needed for navigation data
   * @param {Object} config - Navigation config
   * @param {number} gridWidth - Grid width in cells
   * @param {number} gridHeight - Grid height in cells
   * @returns {number} - Total bytes needed
   */
  static calculateSABSize(config, gridWidth, gridHeight) {
    const totalCells = gridWidth * gridHeight;
    const { maxFlowfields, maxPaths, maxPathLength } = config;

    const headerSize = this._HEADER_SIZE;
    const walkabilitySize = totalCells; // 1 byte per cell

    // Align flowfield headers offset to 4 bytes
    const flowfieldHeadersOffset = Math.ceil((headerSize + walkabilitySize) / 4) * 4;

    // Flowfield: header (12 bytes) + data (2 bytes per cell: X and Y as Int8)
    // Align data size to 4 bytes for Uint32Array compatibility
    const flowfieldDataSize = Math.ceil((totalCells * 2) / 4) * 4;
    const flowfieldSlotSize = this._FLOWFIELD_HEADER_SIZE + flowfieldDataSize;
    const flowfieldsSize = maxFlowfields * flowfieldSlotSize;

    // Path: header (20 bytes) + data (4 bytes per cell * maxPathLength)
    const pathSlotSize = this._PATH_HEADER_SIZE + maxPathLength * 4;
    const pathsSize = maxPaths * pathSlotSize;

    // Total size from flowfield headers offset
    return flowfieldHeadersOffset + flowfieldsSize + pathsSize;
  }

  /**
   * Initialize NavGrid with SharedArrayBuffer
   * @param {SharedArrayBuffer} sab - The navigation SAB
   * @param {Object} metadata - Grid metadata from Scene
   */
  static initialize(sab, metadata) {
    if (!sab) {
      console.warn('[NavGrid] No SAB provided, navigation disabled');
      return;
    }

    this._sab = sab;
    this._worldWidth = metadata.worldWidth || 1000;
    this._worldHeight = metadata.worldHeight || 1000;

    // Read header
    this._headerView = new Uint32Array(sab, 0, 8);
    this._version = this._headerView[0];
    this._gridWidth = this._headerView[1];
    this._gridHeight = this._headerView[2];
    this._cellSize = this._headerView[3];
    this._totalCells = this._headerView[4];
    this._maxFlowfields = this._headerView[5];
    this._maxPaths = this._headerView[6];
    this._maxPathLength = this._headerView[7];

    // Calculate offsets (all aligned to 4 bytes for Uint32Array compatibility)
    this._walkabilityOffset = this._HEADER_SIZE;
    // Align flowfield headers offset to 4 bytes
    this._flowfieldHeadersOffset = Math.ceil((this._walkabilityOffset + this._totalCells) / 4) * 4;

    // Align flowfield data size to 4 bytes
    this._flowfieldDataSize = Math.ceil((this._totalCells * 2) / 4) * 4;
    this._flowfieldSlotSize = this._FLOWFIELD_HEADER_SIZE + this._flowfieldDataSize;

    this._flowfieldDataOffset =
      this._flowfieldHeadersOffset + this._maxFlowfields * this._FLOWFIELD_HEADER_SIZE;

    const totalFlowfieldSize = this._maxFlowfields * this._flowfieldSlotSize;
    this._pathHeadersOffset = this._flowfieldHeadersOffset + totalFlowfieldSize;

    const pathSlotSize = this._PATH_HEADER_SIZE + this._maxPathLength * 4;
    this._pathDataOffset = this._pathHeadersOffset + this._maxPaths * this._PATH_HEADER_SIZE;

    // Create views
    this._walkability = new Uint8Array(sab, this._walkabilityOffset, this._totalCells);

    // Flowfield views - we'll access these dynamically per slot
    // Path views - we'll access these dynamically per slot

    this._initialized = true;
  }

  /**
   * Set the MessagePort for communication with particle worker (handles navigation)
   * Called by logic workers during initialization
   * @param {MessagePort} port - Port to particle worker
   */
  static setNavWorkerPort(port) {
    this._navWorkerPort = port;
  }

  /**
   * Reset NavGrid state (called when unloading a scene to prevent memory leaks)
   * Clears port reference and pending requests so old buffers can be GC'd
   */
  static reset() {
    this._navWorkerPort = null;
    this._initialized = false;
    this._sab = null;
    this._headerView = null;
    this._walkability = null;
    this._flowfieldHeaders = null;
    this._flowfieldData = null;
    this._pathHeaders = null;
    this._pathData = null;
    this._pendingFlowfieldRequests.clear();
    this._pendingPathRequests.clear();
  }

  // =========================================================
  // HOT Queries (per frame, O(1))
  // =========================================================

  /**
   * Get movement vector from flowfield pathfinding
   *
   * This is the main API for flowfield navigation. Call every frame for each
   * entity that needs pathfinding. The system handles caching automatically.
   *
   * @param {number} cx - Current world X position
   * @param {number} cy - Current world Y position
   * @param {number} tx - Target world X position
   * @param {number} ty - Target world Y position
   * @param {Object} outVec - Output vector {x, y} to fill
   *
   * If flowfield exists: outVec = normalized direction vector (-1, 0, or 1 per axis)
   * If flowfield not ready: outVec = {x: 0, y: 0}, requests calculation
   *
   * @example
   * const vec = { x: 0, y: 0 };
   * NavGrid.requestVector(entity.x, entity.y, target.x, target.y, vec);
   * entity.vx += vec.x * speed;
   * entity.vy += vec.y * speed;
   */
  static requestVector(cx, cy, tx, ty, outVec) {

    if (!this._initialized) {
      outVec.x = 0;
      outVec.y = 0;
      return;
    }

    // Convert target to cell - flowfields are keyed by target cell
    const targetCell = this.getCellAt(tx, ty);
    if (targetCell < 0 || targetCell >= this._totalCells) {
      outVec.x = 0;
      outVec.y = 0;
      return;
    }

    // Convert current position to cell - used to sample the flowfield
    const currentCell = this.getCellAt(cx, cy);
    if (currentCell < 0 || currentCell >= this._totalCells) {
      outVec.x = 0;
      outVec.y = 0;
      return;
    }

    // Already at target?
    if (currentCell === targetCell) {
      outVec.x = 0;
      outVec.y = 0;
      return;
    }

    // Find flowfield slot for this target
    const slotIndex = this._findFlowfieldSlot(targetCell);

    if (slotIndex >= 0) {
      // Flowfield exists - sample vector at our current cell
      this._sampleFlowfield(slotIndex, currentCell, outVec);
      // Note: LRU is handled by particle_worker when it receives requests
    } else {
      // Flowfield not ready - return zero and request computation
      outVec.x = 0;
      outVec.y = 0;
      this._requestFlowfield(targetCell);
    }
  }

  /**
   * Get next position from A* pathfinding
   *
   * @param {number} fromX - Current world X position
   * @param {number} fromY - Current world Y position
   * @param {number} toX - Target world X position
   * @param {number} toY - Target world Y position
   * @param {Object} outPos - Output position {x, y} to fill
   *
   * If path exists: outPos = center of next cell in path
   * If path not ready: outPos = current position, requests calculation
   */
  static getNextAStarPosition(fromX, fromY, toX, toY, outPos) {
    if (!this._initialized) {
      outPos.x = fromX;
      outPos.y = fromY;
      return;
    }

    const fromCell = this.getCellAt(fromX, fromY);
    const toCell = this.getCellAt(toX, toY);

    if (fromCell < 0 || toCell < 0 || fromCell === toCell) {
      outPos.x = fromX;
      outPos.y = fromY;
      return;
    }

    // Find path slot
    const slotIndex = this._findPathSlot(fromCell, toCell);

    if (slotIndex >= 0) {
      // Path exists - get next cell
      const nextCell = this._getPathNextCell(slotIndex, fromCell);
      if (nextCell >= 0) {
        this.getCellCenter(nextCell, outPos);
        // Note: LRU is handled by particle_worker when it receives requests
        return;
      }
    }

    // Path not ready - return current position and request
    outPos.x = fromX;
    outPos.y = fromY;
    this._requestPath(fromCell, toCell);
  }

  // =========================================================
  // COLD Queries (planning, debug, AI)
  // =========================================================

  /**
   * Get complete A* path between two positions
   *
   * @param {number} fromX - Start world X position
   * @param {number} fromY - Start world Y position
   * @param {number} toX - End world X position
   * @param {number} toY - End world Y position
   * @param {Array} outPath - Array to fill with {x, y} positions
   *
   * If path cached: fills outPath with cell centers
   * If not cached: outPath.length = 0, requests calculation
   */
  static getPathAStar(fromX, fromY, toX, toY, outPath) {
    outPath.length = 0;

    if (!this._initialized) {
      return;
    }

    const fromCell = this.getCellAt(fromX, fromY);
    const toCell = this.getCellAt(toX, toY);

    if (fromCell < 0 || toCell < 0) {
      return;
    }

    if (fromCell === toCell) {
      // Already at destination
      return;
    }

    const slotIndex = this._findPathSlot(fromCell, toCell);

    if (slotIndex >= 0) {
      // Path exists - copy to outPath
      this._copyPathToArray(slotIndex, outPath);
      // Note: LRU is handled by particle_worker when it receives requests
    } else {
      // Request calculation
      this._requestPath(fromCell, toCell);
    }
  }

  // =========================================================
  // Grid Utilities
  // =========================================================

  /**
   * Get cell ID from world position
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @returns {number} - Cell ID, or -1 if out of bounds
   */
  static getCellAt(x, y) {
    if (!this._initialized) return -1;

    const cellX = Math.floor(x / this._cellSize);
    const cellY = Math.floor(y / this._cellSize);

    if (cellX < 0 || cellX >= this._gridWidth || cellY < 0 || cellY >= this._gridHeight) {
      return -1;
    }

    return cellY * this._gridWidth + cellX;
  }

  /**
   * Check if a cell is walkable
   * @param {number} cellId - Cell ID
   * @returns {boolean} - True if walkable
   */
  static isCellWalkable(cellId) {
    if (!this._initialized || cellId < 0 || cellId >= this._totalCells) {
      return false;
    }
    return this._walkability[cellId] > 0;
  }

  /**
   * Check if a world position is walkable
   * @param {number} x - World X position
   * @param {number} y - World Y position
   * @returns {boolean} - True if walkable
   */
  static isPositionWalkable(x, y) {
    return this.isCellWalkable(this.getCellAt(x, y));
  }

  /**
   * Get world position of cell center
   * @param {number} cellId - Cell ID
   * @param {Object} outPos - Output position {x, y} to fill
   */
  static getCellCenter(cellId, outPos) {
    if (!this._initialized || cellId < 0 || cellId >= this._totalCells) {
      outPos.x = 0;
      outPos.y = 0;
      return;
    }

    const cellX = cellId % this._gridWidth;
    const cellY = Math.floor(cellId / this._gridWidth);

    outPos.x = (cellX + 0.5) * this._cellSize;
    outPos.y = (cellY + 0.5) * this._cellSize;
  }

  /**
   * Get grid dimensions
   * @returns {Object} - {width, height, cellSize, totalCells}
   */
  static getGridInfo() {
    return {
      width: this._gridWidth,
      height: this._gridHeight,
      cellSize: this._cellSize,
      totalCells: this._totalCells,
    };
  }

  // =========================================================
  // Mutation / Rebuild (NOT hot path - only particle worker)
  // =========================================================

  /**
   * Write header to SAB (called by Scene during setup)
   * @param {SharedArrayBuffer} sab - The SAB to write to
   * @param {Object} config - Navigation config
   * @param {number} gridWidth - Grid width in cells
   * @param {number} gridHeight - Grid height in cells
   */
  static writeHeader(sab, config, gridWidth, gridHeight) {
    const header = new Uint32Array(sab, 0, 8);
    header[0] = 1; // version
    header[1] = gridWidth;
    header[2] = gridHeight;
    header[3] = config.cellSize;
    header[4] = gridWidth * gridHeight; // totalCells
    header[5] = config.maxFlowfields;
    header[6] = config.maxPaths;
    header[7] = config.maxPathLength;
  }

  /**
   * Set walkability for a cell (called by particle worker during rebuild)
   * @param {number} cellId - Cell ID
   * @param {number} walkable - 0 = blocked, 1+ = walkable (cost)
   */
  static setWalkability(cellId, walkable) {
    if (this._initialized && cellId >= 0 && cellId < this._totalCells) {
      this._walkability[cellId] = walkable;
    }
  }

  /**
   * Get walkability array reference (for particle worker bulk updates)
   * @returns {Uint8Array} - Walkability array
   */
  static getWalkabilityArray() {
    return this._walkability;
  }

  /**
   * Request particle worker to rebuild walkability from entity indices
   * Can be called from any worker that has NavGrid initialized.
   * This invalidates ALL cached flowfields and paths.
   *
   * @param {number[]} entityIndices - Array of entity indices to mark as obstacles
   */
  static updateNavGrid(entityIndices) {
    if (!this._navWorkerPort) {
      console.warn('NavGrid: No particle worker port set, cannot update grid');
      return;
    }

    // Clear pending requests - they'll be re-requested with new version after rebuild
    this._pendingFlowfieldRequests.clear();
    this._pendingPathRequests.clear();

    this._navWorkerPort.postMessage({
      type: 'REBUILD_FROM_INDICES',
      entityIndices,
    });
  }

  /**
   * Invalidate all caches (called after rebuild)
   */
  static invalidate() {
    if (!this._initialized) return;

    // Increment version
    Atomics.add(this._headerView, 0, 1);

    // Clear all flowfield slots
    for (let i = 0; i < this._maxFlowfields; i++) {
      this._clearFlowfieldSlot(i);
    }

    // Clear all path slots
    for (let i = 0; i < this._maxPaths; i++) {
      this._clearPathSlot(i);
    }
  }

  // =========================================================
  // Internal - Flowfield slot management
  // =========================================================

  /**
   * Find flowfield slot for a target cell
   *
   * Flowfield slots use an INTERLEAVED memory layout:
   * [slot0 header][slot0 data][slot1 header][slot1 data]...
   *
   * Each slot = FLOWFIELD_HEADER_SIZE (12 bytes) + totalCells (1 byte per cell)
   *
   * @param {number} targetCell - The destination cell to find flowfield for
   * @returns {number} - Slot index, or -1 if not found
   */
  static _findFlowfieldSlot(targetCell) {
    const slotSize = this._flowfieldSlotSize;

    for (let i = 0; i < this._maxFlowfields; i++) {
      const offset = this._flowfieldHeadersOffset + i * slotSize;
      const view = new Uint32Array(this._sab, offset, 3);

      // Check if this slot targets our cell and is ready
      if (view[0] === targetCell && view[2] === FLOWFIELD_STATUS.READY) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Sample flowfield vector at a cell
   *
   * @param {number} slotIndex - Which flowfield slot to sample
   * @param {number} currentCell - The cell to get direction for
   * @param {Object} outVec - Output vector {x, y} to fill with float values
   */
  static _sampleFlowfield(slotIndex, currentCell, outVec) {
    const slotSize = this._flowfieldSlotSize;
    const dataOffset =
      this._flowfieldHeadersOffset + slotIndex * slotSize + this._FLOWFIELD_HEADER_SIZE;
    // Data is stored as Int8: 2 bytes per cell (X, Y), normalized to [-127, 127]
    const data = new Int8Array(this._sab, dataOffset, this._totalCells * 2);
    const idx = currentCell * 2;
    // Convert from Int8 [-127, 127] to float [-1, 1]
    outVec.x = data[idx] / 127;
    outVec.y = data[idx + 1] / 127;
  }

  /**
   * Update LRU timestamp for flowfield slot
   */
  static _touchFlowfieldSlot(slotIndex) {
    const slotSize = this._flowfieldSlotSize;
    const headerOffset = this._flowfieldHeadersOffset + slotIndex * slotSize;
    const view = new Uint32Array(this._sab, headerOffset, 3);
    view[1] = this._currentFrame; // lastUsedFrame
  }

  /**
   * Clear a flowfield slot
   */
  static _clearFlowfieldSlot(slotIndex) {
    const slotSize = this._flowfieldSlotSize;
    const headerOffset = this._flowfieldHeadersOffset + slotIndex * slotSize;
    const view = new Uint32Array(this._sab, headerOffset, 3);
    view[0] = 0xffffffff; // targetCell = invalid
    view[1] = 0; // lastUsedFrame
    view[2] = FLOWFIELD_STATUS.EMPTY;
  }

  /**
   * Request flowfield calculation from particle worker
   *
   * Uses version-based deduplication to avoid spamming requests.
   * If a request was already made for this targetCell in the current
   * version, we skip. After invalidate() bumps the version, requests
   * will be sent again.
   *
   * @private
   */
  static _requestFlowfield(targetCell) {
    if (!this._navWorkerPort) {
      console.warn('[NavGrid] _requestFlowfield called but no port set!');
      return;
    }

    // Get current version from SAB header
    const currentVersion = Atomics.load(this._headerView, 0);
    const pendingVersion = this._pendingFlowfieldRequests.get(targetCell);

    // Skip if we already have a pending request from this version
    if (pendingVersion === currentVersion) return;

    // Send new request (either no pending, or version changed after invalidate)
    this._pendingFlowfieldRequests.set(targetCell, currentVersion);
    this._navWorkerPort.postMessage({
      type: 'REQUEST_FLOWFIELD',
      targetCell,
    });
  }

  // =========================================================
  // Internal - Path slot management
  // =========================================================

  /**
   * Find path slot for from/to cells
   * @returns {number} - Slot index, or -1 if not found
   */
  static _findPathSlot(fromCell, toCell) {
    const headerOffset = this._pathHeadersOffset;
    const headerSize = this._PATH_HEADER_SIZE;

    for (let i = 0; i < this._maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const view = new Uint32Array(this._sab, offset, 5);

      if (view[0] === fromCell && view[1] === toCell && view[4] === PATH_STATUS.READY) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Get next cell in path after currentCell
   */
  static _getPathNextCell(slotIndex, currentCell) {
    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const headerView = new Uint32Array(this._sab, headerOffset, 5);
    const pathLength = headerView[3];

    if (pathLength === 0) return -1;

    const pathSlotSize = this._PATH_HEADER_SIZE + this._maxPathLength * 4;
    const dataOffset = this._pathHeadersOffset + slotIndex * pathSlotSize + this._PATH_HEADER_SIZE;
    const pathData = new Uint32Array(this._sab, dataOffset, pathLength);

    // Find current cell in path and return next
    for (let i = 0; i < pathLength - 1; i++) {
      if (pathData[i] === currentCell) {
        return pathData[i + 1];
      }
    }

    // If not found in path or at end, return first cell
    return pathData[0];
  }

  /**
   * Copy path to output array
   */
  static _copyPathToArray(slotIndex, outPath) {
    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const headerView = new Uint32Array(this._sab, headerOffset, 5);
    const pathLength = headerView[3];

    if (pathLength === 0) return;

    const pathSlotSize = this._PATH_HEADER_SIZE + this._maxPathLength * 4;
    const dataOffset = this._pathHeadersOffset + slotIndex * pathSlotSize + this._PATH_HEADER_SIZE;
    const pathData = new Uint32Array(this._sab, dataOffset, pathLength);

    const pos = { x: 0, y: 0 };
    for (let i = 0; i < pathLength; i++) {
      this.getCellCenter(pathData[i], pos);
      outPath.push({ x: pos.x, y: pos.y });
    }
  }

  /**
   * Update LRU timestamp for path slot
   */
  static _touchPathSlot(slotIndex) {
    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const view = new Uint32Array(this._sab, headerOffset, 5);
    view[2] = this._currentFrame; // lastUsedFrame
  }

  /**
   * Clear a path slot
   */
  static _clearPathSlot(slotIndex) {
    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const view = new Uint32Array(this._sab, headerOffset, 5);
    view[0] = 0xffffffff; // fromCell = invalid
    view[1] = 0xffffffff; // toCell = invalid
    view[2] = 0; // lastUsedFrame
    view[3] = 0; // length
    view[4] = PATH_STATUS.EMPTY;
  }

  /**
   * Request path calculation from particle worker
   * @private
   */
  static _requestPath(fromCell, toCell) {
    if (!this._navWorkerPort) return;

    const key = `${fromCell}_${toCell}`;

    // Get current version from SAB header
    const currentVersion = Atomics.load(this._headerView, 0);
    const pendingVersion = this._pendingPathRequests.get(key);

    // Skip if we already have a pending request from this version
    if (pendingVersion === currentVersion) return;

    // Send new request (either no pending, or version changed after invalidate)
    this._pendingPathRequests.set(key, currentVersion);
    this._navWorkerPort.postMessage({
      type: 'REQUEST_PATH',
      fromCell,
      toCell,
    });
  }

  // =========================================================
  // Particle Worker specific methods (for writing results)
  // =========================================================

  /**
   * Find or allocate a flowfield slot (particle worker only)
   *
   * Allocation strategy:
   * 1. If flowfield for targetCell already exists → return that slot
   * 2. If empty slot available → use first empty slot
   * 3. Otherwise → evict least recently used (LRU) slot
   *
   * @param {number} targetCell - Destination cell for the flowfield
   * @returns {number} - Slot index
   */
  static allocateFlowfieldSlot(targetCell) {
    const slotSize = this._flowfieldSlotSize;

    let emptySlot = -1;
    let lruSlot = 0;
    let lruFrame = Infinity;

    for (let i = 0; i < this._maxFlowfields; i++) {
      const offset = this._flowfieldHeadersOffset + i * slotSize;
      const view = new Uint32Array(this._sab, offset, 3);

      // Already exists for this target? Reuse the slot.
      if (view[0] === targetCell) {
        return i;
      }

      // Empty slot? Remember the first one.
      if (view[2] === FLOWFIELD_STATUS.EMPTY && emptySlot < 0) {
        emptySlot = i;
      }

      // Track LRU (only for non-empty slots)
      if (view[2] !== FLOWFIELD_STATUS.EMPTY && view[1] < lruFrame) {
        lruFrame = view[1];
        lruSlot = i;
      }
    }

    // Use empty slot if available, otherwise evict LRU
    const slot = emptySlot >= 0 ? emptySlot : lruSlot;

    // Initialize slot header
    const offset = this._flowfieldHeadersOffset + slot * slotSize;
    const view = new Uint32Array(this._sab, offset, 3);
    view[0] = targetCell;
    view[1] = this._currentFrame;
    view[2] = FLOWFIELD_STATUS.COMPUTING;

    return slot;
  }

  /**
   * Write flowfield data and mark as ready (particle worker only)
   *
   * @param {number} slotIndex - Slot to write to
   * @param {Int8Array} vectors - Vector data (2 bytes per cell: X, Y as Int8)
   */
  static writeFlowfieldData(slotIndex, vectors) {
    const slotSize = this._flowfieldSlotSize;
    const dataOffset =
      this._flowfieldHeadersOffset + slotIndex * slotSize + this._FLOWFIELD_HEADER_SIZE;
    const data = new Int8Array(this._sab, dataOffset, this._totalCells * 2);

    // Copy vector data
    data.set(vectors);

    // Mark as ready (header is at start of slot)
    const headerOffset = this._flowfieldHeadersOffset + slotIndex * slotSize;
    const view = new Uint32Array(this._sab, headerOffset, 3);
    view[2] = FLOWFIELD_STATUS.READY;
  }

  /**
   * Find or allocate a path slot (particle worker only)
   * Uses LRU eviction if all slots are full
   * @returns {number} - Slot index
   */
  static allocatePathSlot(fromCell, toCell) {
    const headerOffset = this._pathHeadersOffset;
    const headerSize = this._PATH_HEADER_SIZE;

    let emptySlot = -1;
    let lruSlot = 0;
    let lruFrame = Infinity;

    for (let i = 0; i < this._maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const view = new Uint32Array(this._sab, offset, 5);

      // Already exists for this path?
      if (view[0] === fromCell && view[1] === toCell) {
        return i;
      }

      // Empty slot?
      if (view[4] === PATH_STATUS.EMPTY && emptySlot < 0) {
        emptySlot = i;
      }

      // Track LRU
      if (view[2] < lruFrame) {
        lruFrame = view[2];
        lruSlot = i;
      }
    }

    // Use empty slot if available, otherwise evict LRU
    const slot = emptySlot >= 0 ? emptySlot : lruSlot;

    // Initialize slot header
    const offset = headerOffset + slot * headerSize;
    const view = new Uint32Array(this._sab, offset, 5);
    view[0] = fromCell;
    view[1] = toCell;
    view[2] = this._currentFrame;
    view[3] = 0; // length
    view[4] = PATH_STATUS.COMPUTING;

    return slot;
  }

  /**
   * Write path data and mark as ready (particle worker only)
   */
  static writePathData(slotIndex, pathCells, explicitLength = -1) {
    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const headerView = new Uint32Array(this._sab, headerOffset, 5);

    // Clamp path length
    const sourceLength = explicitLength >= 0 ? explicitLength : pathCells.length;
    const pathLength = Math.min(sourceLength, this._maxPathLength);
    headerView[3] = pathLength;

    // Write path data
    if (pathLength > 0) {
      const pathSlotSize = this._PATH_HEADER_SIZE + this._maxPathLength * 4;
      const dataOffset =
        this._pathHeadersOffset + slotIndex * pathSlotSize + this._PATH_HEADER_SIZE;
      const pathData = new Uint32Array(this._sab, dataOffset, pathLength);

      for (let i = 0; i < pathLength; i++) {
        pathData[i] = pathCells[i];
      }
    }

    // Mark as ready
    headerView[4] = PATH_STATUS.READY;
  }

  // =========================================================
  // Debug / Visualization methods (for DebugUI)
  // =========================================================

  /**
   * Get list of all cached flowfields for debug display
   * @returns {Array} Array of {slotIndex, targetCell, targetX, targetY, lastUsedFrame}
   */
  static getCachedFlowfieldsList() {
    if (!this._initialized) return [];

    const result = [];
    const slotSize = this._flowfieldSlotSize;

    for (let i = 0; i < this._maxFlowfields; i++) {
      const offset = this._flowfieldHeadersOffset + i * slotSize;
      const view = new Uint32Array(this._sab, offset, 3);
      const status = view[2];

      if (status === FLOWFIELD_STATUS.READY) {
        const targetCell = view[0];
        const lastUsedFrame = view[1];
        const targetX = (targetCell % this._gridWidth) * this._cellSize + this._cellSize / 2;
        const targetY =
          Math.floor(targetCell / this._gridWidth) * this._cellSize + this._cellSize / 2;

        result.push({
          slotIndex: i,
          targetCell,
          targetX: Math.round(targetX),
          targetY: Math.round(targetY),
          lastUsedFrame,
        });
      }
    }

    return result;
  }

  /**
   * Get list of all cached paths for debug display
   * @returns {Array} Array of {slotIndex, fromCell, toCell, fromX, fromY, toX, toY, length, lastUsedFrame}
   */
  static getCachedPathsList() {
    if (!this._initialized) return [];

    const result = [];
    const headerOffset = this._pathHeadersOffset;
    const headerSize = this._PATH_HEADER_SIZE;

    for (let i = 0; i < this._maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const view = new Uint32Array(this._sab, offset, 5);
      const status = view[4];

      if (status === PATH_STATUS.READY) {
        const fromCell = view[0];
        const toCell = view[1];
        const lastUsedFrame = view[2];
        const length = view[3];

        const fromX = (fromCell % this._gridWidth) * this._cellSize + this._cellSize / 2;
        const fromY = Math.floor(fromCell / this._gridWidth) * this._cellSize + this._cellSize / 2;
        const toX = (toCell % this._gridWidth) * this._cellSize + this._cellSize / 2;
        const toY = Math.floor(toCell / this._gridWidth) * this._cellSize + this._cellSize / 2;

        result.push({
          slotIndex: i,
          fromCell,
          toCell,
          fromX: Math.round(fromX),
          fromY: Math.round(fromY),
          toX: Math.round(toX),
          toY: Math.round(toY),
          length,
          lastUsedFrame,
        });
      }
    }

    return result;
  }

  /**
   * Get flowfield data for visualization
   * @param {number} slotIndex - Slot index
   * @returns {Object|null} {targetCell, vectors: Int8Array (2 per cell)} or null
   */
  static getFlowfieldForVisualization(slotIndex) {
    if (!this._initialized || slotIndex < 0 || slotIndex >= this._maxFlowfields) return null;

    const slotSize = this._flowfieldSlotSize;
    const headerOffset = this._flowfieldHeadersOffset + slotIndex * slotSize;
    const headerView = new Uint32Array(this._sab, headerOffset, 3);

    if (headerView[2] !== FLOWFIELD_STATUS.READY) return null;

    const dataOffset = headerOffset + this._FLOWFIELD_HEADER_SIZE;

    return {
      targetCell: headerView[0],
      vectors: new Int8Array(this._sab, dataOffset, this._totalCells * 2),
      gridWidth: this._gridWidth,
      gridHeight: this._gridHeight,
      cellSize: this._cellSize,
    };
  }

  /**
   * Get path data for visualization
   * @param {number} slotIndex - Slot index
   * @returns {Array|null} Array of {x, y} world positions or null
   */
  static getPathForVisualization(slotIndex) {
    if (!this._initialized || slotIndex < 0 || slotIndex >= this._maxPaths) return null;

    const headerOffset = this._pathHeadersOffset + slotIndex * this._PATH_HEADER_SIZE;
    const headerView = new Uint32Array(this._sab, headerOffset, 5);

    if (headerView[4] !== PATH_STATUS.READY) return null;

    const pathLength = headerView[3];
    if (pathLength === 0) return [];

    const pathSlotSize = this._PATH_HEADER_SIZE + this._maxPathLength * 4;
    const dataOffset = this._pathHeadersOffset + slotIndex * pathSlotSize + this._PATH_HEADER_SIZE;
    const pathData = new Uint32Array(this._sab, dataOffset, pathLength);

    const result = [];
    for (let i = 0; i < pathLength; i++) {
      const cell = pathData[i];
      const x = (cell % this._gridWidth) * this._cellSize + this._cellSize / 2;
      const y = Math.floor(cell / this._gridWidth) * this._cellSize + this._cellSize / 2;
      result.push({ x, y });
    }

    return result;
  }
}

// Export constants for external use
export { FLOWFIELD_STATUS, PATH_STATUS, DIRECTION, DIR_TO_VEC };
