self.postMessage({
  msg: 'log',
  message: 'nav_worker.js loaded',
  when: Date.now(),
});

// nav_worker.js - Dedicated navigation worker for pathfinding calculations
//
// ============================================================================
// OVERVIEW
// ============================================================================
//
// The nav_worker handles all pathfinding computations in a dedicated thread:
// - Flowfield computation (Dijkstra's algorithm)
// - A* path computation
// - Walkability grid management
//
// This keeps the main thread and logic workers responsive while pathfinding
// calculations happen in the background.
//
// ============================================================================
// FLOWFIELD COMPUTATION
// ============================================================================
//
// Flowfields use Dijkstra's algorithm with a bucket queue for O(V) complexity:
//
// 1. Start at target cell with distance 0
// 2. Expand outward, calculating distance to each reachable cell
// 3. For each cell, store the direction that leads toward the target
// 4. Result: Every walkable cell knows which direction leads to the target
//
// The bucket queue optimization:
// - Instead of a priority queue (O(log n) per operation)
// - Use array of buckets indexed by distance (O(1) per operation)
// - Works because edge weights are small integers (10 or 14)
//
// ============================================================================
// SLOT MANAGEMENT
// ============================================================================
//
// Computed flowfields are stored in slots in the SharedArrayBuffer:
// - Default: 16 flowfield slots, 64 path slots
// - LRU eviction when slots are full
// - Slots are keyed by targetCell (flowfields) or fromCell+toCell (paths)
//
// ============================================================================

import { AbstractWorker } from './AbstractWorker.js';
import { NavGrid, DIRECTION, DIR_TO_VEC } from '../core/NavGrid.js';
import { NAVIGATION_STATS, createStatsWriter } from './workers-utils.js';
import {
  getColliderBounds,
  getCellRange,
  _boundsResult,
  _cellRangeResult,
} from '../core/ColliderUtils.js';

// Components needed for shadow render queue and derived properties
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { Grid } from '../core/Grid.js';
import { calculateCameraScreenBounds, screenBoundsToWorldBounds, calculateSpeed, calculateVelocityAngle } from '../core/utils.js';
import { PHYSICS_DEFAULTS } from '../core/ConfigDefaults.js';

const EMPTY_SLOT = 0;
const OCCUPIED_SLOT = 1;
const TOMBSTONE_SLOT = 2;

function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

class Uint32SabRingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this._sab = new SharedArrayBuffer(this.capacity * 4);
    this.values = new Uint32Array(this._sab);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  enqueue(value) {
    if (this.count >= this.capacity) return false;
    this.values[this.tail] = value >>> 0;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }

  dequeue() {
    if (this.count === 0) return -1;
    const value = this.values[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return value >>> 0;
  }

  get size() {
    return this.count;
  }
}

class FlowfieldRequestQueue {
  constructor(totalCells, capacity) {
    this.ring = new Uint32SabRingBuffer(capacity);
    this._pendingSab = new SharedArrayBuffer(totalCells);
    this.pending = new Uint8Array(this._pendingSab);
  }

  enqueue(targetCell) {
    if (this.pending[targetCell] === 1) return true;
    if (!this.ring.enqueue(targetCell)) return false;
    this.pending[targetCell] = 1;
    return true;
  }

  dequeue() {
    const cell = this.ring.dequeue();
    if (cell < 0) return -1;
    this.pending[cell] = 0;
    return cell;
  }

  get size() {
    return this.ring.size;
  }
}

class PathRequestQueue {
  constructor(totalCells, capacity) {
    this.totalCells = totalCells;
    this.capacity = Math.max(1, capacity | 0);

    this.keyRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.fromRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.toRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.keyRing = new Uint32Array(this.keyRingSab);
    this.fromRing = new Uint32Array(this.fromRingSab);
    this.toRing = new Uint32Array(this.toRingSab);
    this.head = 0;
    this.tail = 0;
    this.count = 0;

    this.hashCapacity = nextPowerOfTwo(this.capacity * 4);
    this.hashMask = this.hashCapacity - 1;
    this.hashState = new Uint8Array(new SharedArrayBuffer(this.hashCapacity));
    this.hashKey = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
    this.hashFrom = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
    this.hashTo = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
  }

  _packPathKey(fromCell, toCell) {
    if (this.totalCells <= 0xffff) {
      return ((fromCell << 16) | toCell) >>> 0;
    }
    // Fallback hash for larger grids: keep Uint32 key while preserving from/to in hash table.
    return (((fromCell * 73856093) ^ (toCell * 19349663)) >>> 0);
  }

  _findSlot(key, fromCell, toCell) {
    let firstTombstone = -1;
    let idx = key & this.hashMask;
    for (let probe = 0; probe < this.hashCapacity; probe++) {
      const state = this.hashState[idx];
      if (state === EMPTY_SLOT) {
        return firstTombstone >= 0 ? firstTombstone : idx;
      }
      if (state === TOMBSTONE_SLOT) {
        if (firstTombstone < 0) firstTombstone = idx;
      } else if (
        this.hashKey[idx] === key &&
        this.hashFrom[idx] === fromCell &&
        this.hashTo[idx] === toCell
      ) {
        return idx;
      }
      idx = (idx + 1) & this.hashMask;
    }
    return firstTombstone;
  }

  enqueue(fromCell, toCell) {
    const key = this._packPathKey(fromCell, toCell);
    const slot = this._findSlot(key, fromCell, toCell);
    if (slot < 0) return false;

    if (this.hashState[slot] === OCCUPIED_SLOT) {
      // Already pending (dedupe)
      return true;
    }
    if (this.count >= this.capacity) return false;

    this.keyRing[this.tail] = key;
    this.fromRing[this.tail] = fromCell >>> 0;
    this.toRing[this.tail] = toCell >>> 0;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;

    this.hashState[slot] = OCCUPIED_SLOT;
    this.hashKey[slot] = key;
    this.hashFrom[slot] = fromCell >>> 0;
    this.hashTo[slot] = toCell >>> 0;
    return true;
  }

  dequeue(out) {
    if (this.count === 0) return false;
    const key = this.keyRing[this.head];
    const fromCell = this.fromRing[this.head];
    const toCell = this.toRing[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.count--;

    const slot = this._findSlot(key, fromCell, toCell);
    if (slot >= 0 && this.hashState[slot] === OCCUPIED_SLOT) {
      this.hashState[slot] = TOMBSTONE_SLOT;
    }

    out.key = key;
    out.fromCell = fromCell;
    out.toCell = toCell;
    return true;
  }

  get size() {
    return this.count;
  }
}

/**
 * NavScratch - Reusable buffers for pathfinding algorithms
 *
 * Using scratch buffers avoids allocation during pathfinding,
 * which would cause GC pauses. One set per nav worker, reused
 * across all calculations.
 */
class NavScratch {
  constructor(totalCells, maxPathLength, gridWidth, gridHeight) {
    // Common buffers
    this.visited = new Uint8Array(totalCells);
    this.stamp = new Uint32Array(totalCells);
    this.currentStamp = 0;

    // Flowfield (Dijkstra) buffers
    this.distance = new Uint16Array(totalCells);
    this.direction = new Uint8Array(totalCells); // Output directions (discrete, for Dijkstra pass)
    this.smoothedVectors = new Int8Array(totalCells * 2); // Smoothed vectors (X, Y as Int8)

    // Bucket queue for O(1) Dijkstra (typed linked lists, zero per-iteration allocation)
    // Max distance must cover worst case: traversing entire grid diagonally
    // Cost is 10 for cardinal, 14 for diagonal moves
    // Worst case: (gridWidth + gridHeight) * 14 (diagonal cost)
    this.maxDistance = Math.min(65535, (gridWidth + gridHeight) * 14);
    this.bucketHead = new Int32Array(this.maxDistance + 1);
    this.bucketTail = new Int32Array(this.maxDistance + 1);
    this.bucketNodeNext = new Int32Array(totalCells);
    this.bucketNodePrev = new Int32Array(totalCells);
    this.bucketNodeDist = new Int32Array(totalCells);
    this.bucketNodeCell = new Uint32Array(totalCells);
    for (let i = 0; i <= this.maxDistance; i++) {
      this.bucketHead[i] = -1;
      this.bucketTail[i] = -1;
    }
    for (let i = 0; i < totalCells; i++) {
      this.bucketNodeNext[i] = -1;
      this.bucketNodePrev[i] = -1;
      this.bucketNodeDist[i] = -1;
      this.bucketNodeCell[i] = i;
    }
    this.bucketHeadDistance = 0;
    this.bucketCount = 0;

    // A* buffers
    this.heapCell = new Uint32Array(totalCells);
    this.heapFCost = new Uint32Array(totalCells); // f = g + h
    this.heapGCost = new Uint32Array(totalCells);
    this.heapSize = 0;
    this.cameFrom = new Uint32Array(totalCells);
    this.inOpenSet = new Uint8Array(totalCells);
    this.pathResult = new Uint32Array(maxPathLength);
  }

  /**
   * Reset for new calculation using stamp technique (O(1) reset)
   *
   * Instead of clearing the visited array (O(n)), we increment a stamp.
   * A cell is "visited" if its stamp matches the current stamp.
   */
  reset() {
    this.currentStamp++;
    // If stamp wraps around (very unlikely), do full reset
    if (this.currentStamp === 0) {
      this.stamp.fill(0);
      this.currentStamp = 1;
    }

    // Reset bucket queue
    this.bucketHeadDistance = 0;
    this.bucketCount = 0;
    this.bucketHead.fill(-1);
    this.bucketTail.fill(-1);
    this.bucketNodeNext.fill(-1);
    this.bucketNodePrev.fill(-1);
    this.bucketNodeDist.fill(-1);

    // Reset A* heap
    this.heapSize = 0;
  }

  /**
   * Check if cell was visited this calculation
   */
  isVisited(cell) {
    return this.stamp[cell] === this.currentStamp;
  }

  /**
   * Mark cell as visited
   */
  markVisited(cell) {
    this.stamp[cell] = this.currentStamp;
  }
}

/**
 * NavWorker - Handles pathfinding calculations
 * Extends AbstractWorker for common worker functionality
 */
class NavWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Nav worker doesn't need game scripts or GameObject instances
    this.needsGameScripts = false;

    // Scratch buffers (initialized after we know grid size)
    this.scratch = null;

    // Request queues (populated from MessagePort, processed in update)
    this.flowfieldRequests = null;
    this.pathRequests = null;
    this._pathRequestTmp = { key: 0, fromCell: 0, toCell: 0 };

    // Grid metadata
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.totalCells = 0;
    this.maxFlowfields = 0;
    this.maxPaths = 0;

    // Performance tracking
    this.flowfieldsComputedThisFrame = 0;
    this.pathsComputedThisFrame = 0;

    // Cache counters (avoid iterating all slots to count)
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;

    // ========================================
    // SHADOW RENDER QUEUE
    // ========================================
    // Calculates shadow positions for entities near lights
    // Writes to ShadowSprite buffer, read by pixi_worker
    this.shadowsEnabled = false;
    this.maxShadowCastingLights = 20;
    this.maxShadowsPerLight = 15;
    this.maxShadowsPerEntity = 0; // 0 = unlimited
    this.maxShadowSprites = 0;
    this.maxShadowLights = 0;
    this.maxShadowRenderItems = 0;

    // Shadow render queue typed array views
    this.shadowRenderQueueCount = null;
    this.shadowRenderQueueX = null;
    this.shadowRenderQueueY = null;
    this.shadowRenderQueueScaleX = null;
    this.shadowRenderQueueScaleY = null;
    this.shadowRenderQueueRotation = null;
    this.shadowRenderQueueAlpha = null;
    this.shadowRenderQueueTint = null;
    this.shadowRenderQueueTextureId = null;
    this.shadowRenderQueueAnchorX = null;
    this.shadowRenderQueueAnchorY = null;

    // Per-entity shadow count tracking (reused each frame)
    this._entityShadowCounts = null;

    // Entity texture lookup for shadow textures
    this.entityLastTextureId = null;

    // Texture metadata for light gradient texture lookup
    this.animationNameToIndex = null;
    this.animationFrameStart = null;

    // Stats tracking
    this.shadowsUpdatedThisFrame = 0;

    // Camera and viewport data for shadow culling
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.cullingRatio = 0.5;
    this.globalEntityCount = 0;

    // GC OPTIMIZATION: Pre-allocated query array
    this._queryLightEmitter = null;

    // GC OPTIMIZATION: Pre-allocated buffer for Y-sorted light indices
    this._sortedLightEntities = [];
    // GC OPTIMIZATION: Pre-bound comparator for Y-sorting (avoids arrow function allocation)
    this._lightYComparator = (a, b) => Transform.y[a] - Transform.y[b];

    // ========================================
    // DERIVED PROPERTIES
    // ========================================
    // Minimum speed threshold for rotation updates (prevents jitter when stationary)
    this.minSpeedForRotation = 0.1;
    this.rigidBodyCount = 0;

    // Sleeping optimization
    this.sleepThreshold = 0.1;
    this.sleepDuration = 30;

    // GC OPTIMIZATION: Pre-allocated query array
    this._queryRigidBody = null;
    this._cameraBounds = { zoom: 1, cameraOffsetX: 0, cameraOffsetY: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
    this._cameraWorldBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  /**
   * Initialize the nav worker
   */
  async initialize(data) {
    this.reportLog('initializing navigation worker');

    // Get navigation config
    const navConfig = data.config?.navigation;
    const navigationEnabled = navConfig?.enabled;

    // Check for noLimitFPS setting (defaults to true for nav worker)
    if (navConfig?.noLimitFPS !== undefined) {
      this.noLimitFPS = navConfig.noLimitFPS;
    } else {
      this.noLimitFPS = true; // Nav worker runs fast by default
    }

    // Initialize stats buffer for DebugUI
    if (data.buffers?.navigationStats) {
      this.stats = createStatsWriter(data.buffers.navigationStats, NAVIGATION_STATS);
    }

    // Initialize NavGrid from SAB (only if navigation enabled)
    if (navigationEnabled && data.buffers?.navigationData) {
      NavGrid.initialize(data.buffers.navigationData, {
        worldWidth: data.config.worldWidth,
        worldHeight: data.config.worldHeight,
      });

      // Cache grid metadata
      const gridInfo = NavGrid.getGridInfo();
      this.gridWidth = gridInfo.width;
      this.gridHeight = gridInfo.height;
      this.totalCells = gridInfo.totalCells;
      this.maxFlowfields = navConfig.maxFlowfields || 16;
      this.maxPaths = navConfig.maxPaths || 64;

      // Create scratch buffers
      this.scratch = new NavScratch(
        this.totalCells,
        navConfig.maxPathLength || 128,
        this.gridWidth,
        this.gridHeight
      );
      const flowfieldQueueCapacity = Math.max(32, this.maxFlowfields * 8);
      const pathQueueCapacity = Math.max(64, this.maxPaths * 8);
      this.flowfieldRequests = new FlowfieldRequestQueue(this.totalCells, flowfieldQueueCapacity);
      this.pathRequests = new PathRequestQueue(this.totalCells, pathQueueCapacity);

      this.reportLog(
        `initialized with ${this.gridWidth}x${this.gridHeight} grid (${this.totalCells} cells)`
      );
    } else if (navigationEnabled) {
      this.reportLog('navigation enabled but no buffer provided');
    } else {
      this.reportLog('navigation disabled, running for shadow/derived properties only');
    }

    // ========================================
    // SHADOW RENDER QUEUE - Initialize
    // ========================================
    if (
      data.shadows &&
      data.shadows.enabled &&
      data.shadows.renderQueueData &&
      data.buffers?.componentData?.ShadowCaster
    ) {
      this.shadowsEnabled = true;
      this.maxShadowCastingLights = data.shadows.maxShadowCastingLights;
      this.maxShadowsPerLight = data.shadows.maxShadowsPerLight;
      this.maxShadowsPerEntity = data.shadows.maxShadowsPerEntity || 0;
      this.maxShadowSprites = data.shadows.maxShadowSprites;
      this.maxShadowLights = data.shadows.maxLights || 128;
      this.maxShadowRenderItems = data.shadows.maxRenderItems;

      // Store viewport dimensions for shadow culling
      this.canvasWidth = data.config?.canvasWidth || 1920;
      this.canvasHeight = data.config?.canvasHeight || 1080;
      this.cullingRatio = data.config?.renderer?.cullingRatio ?? 0.5;
      this.globalEntityCount = data.globalEntityCount || 0;

      // Allocate per-entity shadow count tracking array if limit is set
      if (this.maxShadowsPerEntity > 0 && this.globalEntityCount > 0) {
        this._entityShadowCounts = new Uint8Array(this.globalEntityCount);
      }

      // Initialize shadow render queue typed array views
      const sab = data.shadows.renderQueueData;
      const maxItems = this.maxShadowRenderItems;
      let offset = 0;

      this.shadowRenderQueueCount = new Int32Array(sab, offset, 1);
      offset += 4;

      this.shadowRenderQueueX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueScaleX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueScaleY = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueRotation = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueAlpha = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueTint = new Uint32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueTextureId = new Uint16Array(sab, offset, maxItems);
      offset += maxItems * 2;

      // Align to 4 bytes for Float32Array
      offset = Math.ceil(offset / 4) * 4;

      this.shadowRenderQueueAnchorX = new Float32Array(sab, offset, maxItems);
      offset += maxItems * 4;

      this.shadowRenderQueueAnchorY = new Float32Array(sab, offset, maxItems);

      // Entity texture lookup buffer (separate SAB) - for shadow textures
      if (data.renderQueue?.entityTextureData) {
        this.entityLastTextureId = new Uint16Array(data.renderQueue.entityTextureData);
      }

      // Texture metadata for light gradient texture lookup
      if (data.textureMetadata) {
        this.animationNameToIndex = data.textureMetadata.animationNameToIndex;
        this.animationFrameStart = data.textureMetadata.animationFrameStart;
      }

      // Pre-allocate query array for light entities
      this._queryLightEmitter = [LightEmitter];

      this.reportLog(`shadow render queue initialized (${maxItems} max items)`);
    }

    // ========================================
    // DERIVED PROPERTIES - Initialize
    // ========================================
    if (data.buffers?.componentData?.RigidBody && data.componentPools?.RigidBody) {
      this.rigidBodyCount = data.componentPools.RigidBody.count || 0;

      // Get physics config values
      const physicsConfig = data.config?.physics || {};
      this.minSpeedForRotation = physicsConfig.minSpeedForRotation ?? PHYSICS_DEFAULTS.minSpeedForRotation;
      this.sleepThreshold = physicsConfig.sleepThreshold ?? PHYSICS_DEFAULTS.sleepThreshold;
      this.sleepDuration = physicsConfig.sleepDuration ?? PHYSICS_DEFAULTS.sleepDuration;

      // Pre-allocate query array for rigidbody entities
      this._queryRigidBody = [RigidBody];

      this.reportLog(`derived properties initialized (${this.rigidBodyCount} rigidbodies)`);
    }
  }

  /**
   * Handle messages from other workers via MessagePort
   *
   * Message types:
   * - REQUEST_FLOWFIELD: Compute flowfield for targetCell
   * - REQUEST_PATH: Compute A* path from fromCell to toCell
   * - REBUILD: Rebuild walkability from static entity list
   * - REBUILD_FROM_INDICES: Rebuild walkability from entity indices
   */
  handleWorkerMessage(fromWorker, data) {
    const { type } = data;

    switch (type) {
      case 'REQUEST_FLOWFIELD': {
        if (!this.flowfieldRequests) break;
        const { targetCell } = data;
        if (targetCell >= 0 && targetCell < this.totalCells) {
          // Check if flowfield already exists - if so, just update LRU
          const existingSlot = this._findExistingFlowfieldSlot(targetCell);
          if (existingSlot >= 0) {
            this._updateFlowfieldLRU(existingSlot);
          } else {
            this.flowfieldRequests.enqueue(targetCell);
          }
        }
        break;
      }

      case 'REQUEST_PATH': {
        if (!this.pathRequests) break;
        const { fromCell, toCell } = data;
        if (
          fromCell >= 0 &&
          fromCell < this.totalCells &&
          toCell >= 0 &&
          toCell < this.totalCells
        ) {
          // Check if path already exists - if so, just update LRU
          const existingSlot = this._findExistingPathSlot(fromCell, toCell);
          if (existingSlot >= 0) {
            this._updatePathLRU(existingSlot);
          } else {
            this.pathRequests.enqueue(fromCell, toCell);
          }
        }
        break;
      }

      case 'REBUILD': {
        // Rebuild walkability grid from static entities
        this.rebuildWalkability(data.staticEntities || []);
        break;
      }

      case 'REBUILD_FROM_INDICES': {
        // Rebuild walkability grid from entity indices (reads from component SABs)
        this.rebuildWalkabilityFromIndices(data.entityIndices || []);
        break;
      }
    }
  }

  /**
   * Find existing flowfield slot (without allocating)
   */
  _findExistingFlowfieldSlot(targetCell) {
    const sab = NavGrid._sab;
    const slotSize = NavGrid._flowfieldSlotSize;
    const maxFlowfields = NavGrid._maxFlowfields;

    for (let i = 0; i < maxFlowfields; i++) {
      const offset = NavGrid._flowfieldHeadersOffset + i * slotSize;
      const view = new Uint32Array(sab, offset, 3);
      if (view[0] === targetCell && view[2] === 2) {
        // 2 = READY
        return i;
      }
    }
    return -1;
  }

  /**
   * Update LRU timestamp for flowfield slot
   */
  _updateFlowfieldLRU(slotIndex) {
    const sab = NavGrid._sab;
    const slotSize = NavGrid._flowfieldSlotSize;
    const headerOffset = NavGrid._flowfieldHeadersOffset + slotIndex * slotSize;
    const view = new Uint32Array(sab, headerOffset, 3);
    view[1] = this.frameNumber;
  }

  /**
   * Find existing path slot (without allocating)
   */
  _findExistingPathSlot(fromCell, toCell) {
    const sab = NavGrid._sab;
    const headerOffset = NavGrid._pathHeadersOffset;
    const headerSize = NavGrid._PATH_HEADER_SIZE;
    const maxPaths = NavGrid._maxPaths;

    for (let i = 0; i < maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const view = new Uint32Array(sab, offset, 5);
      if (view[0] === fromCell && view[1] === toCell && view[4] === 2) {
        // 2 = READY
        return i;
      }
    }
    return -1;
  }

  /**
   * Update LRU timestamp for path slot
   */
  _updatePathLRU(slotIndex) {
    const sab = NavGrid._sab;
    const headerOffset = NavGrid._pathHeadersOffset + slotIndex * NavGrid._PATH_HEADER_SIZE;
    const view = new Uint32Array(sab, headerOffset, 5);
    view[2] = this.frameNumber;
  }

  /**
   * Update method called each frame
   * Processes queued pathfinding requests and computes shadows/derived properties
   */
  update(deltaTime, dtRatio, resuming) {
    // Reset frame stats
    this.flowfieldsComputedThisFrame = 0;
    this.pathsComputedThisFrame = 0;
    this.shadowsUpdatedThisFrame = 0;

    // Process pathfinding requests (only if navigation initialized)
    if (this.scratch) {
      // Update NavGrid's frame counter for LRU tracking
      NavGrid._currentFrame = this.frameNumber;

      // Process flowfield requests (higher priority, shared by many entities)
      let targetCell = this.flowfieldRequests.dequeue();
      while (targetCell >= 0) {
        this.computeFlowfield(targetCell);
        this.flowfieldsComputedThisFrame++;
        targetCell = this.flowfieldRequests.dequeue();
      }

      // Process path requests
      while (this.pathRequests.dequeue(this._pathRequestTmp)) {
        this.computePath(this._pathRequestTmp.fromCell, this._pathRequestTmp.toCell);
        this.pathsComputedThisFrame++;
      }
    }

    // Build shadow render queue
    this.buildShadowRenderQueue();

    // Update derived properties: speed, velocityAngle, sleeping
    this.updateDerivedProperties();

    // Write stats to SharedArrayBuffer for DebugUI
    this.reportFPS();
  }

  /**
   * Compute a flowfield using Dijkstra's algorithm with bucket queue
   *
   * Algorithm:
   * 1. Initialize target cell with distance 0
   * 2. Use bucket queue (array indexed by distance) for O(1) operations
   * 3. For each cell, propagate to neighbors with cost 10 (cardinal) or 14 (diagonal)
   * 4. Store direction pointing TOWARD target (opposite of propagation direction)
   * 5. Second pass: Make blocked cells point to nearest walkable neighbor
   *
   * Time complexity: O(V) where V = number of cells
   * Space complexity: O(V) for scratch buffers
   *
   * @param {number} targetCell - Destination cell for the flowfield
   */
  computeFlowfield(targetCell) {
    // Track whether we'll use an empty slot (for cache count tracking)
    const willUseEmptySlot = this._hasEmptyFlowfieldSlot();

    const scratch = this.scratch;
    scratch.reset();

    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const totalCells = this.totalCells;

    // Initialize distances to max
    scratch.distance.fill(65535);
    scratch.direction.fill(DIRECTION.NONE);

    // Target cell has distance 0
    scratch.distance[targetCell] = 0;
    this._bucketInsertCell(scratch, targetCell, 0);

    // 8-directional neighbors
    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];
    const cost = [10, 14, 10, 14, 10, 14, 10, 14]; // 10 = cardinal, 14 = diagonal (~sqrt(2)*10)

    // When we propagate FROM a cell TO a neighbor, the neighbor should point BACK
    // So if we go North (dy=-1), the neighbor should point South to reach target
    const oppositeDir = [
      DIRECTION.S,
      DIRECTION.SW,
      DIRECTION.W,
      DIRECTION.NW,
      DIRECTION.N,
      DIRECTION.NE,
      DIRECTION.E,
      DIRECTION.SE,
    ];

    // Dijkstra with bucket queue
    while (scratch.bucketCount > 0) {
      // Find next non-empty bucket
      while (
        scratch.bucketHeadDistance <= scratch.maxDistance &&
        scratch.bucketHead[scratch.bucketHeadDistance] < 0
      ) {
        scratch.bucketHeadDistance++;
      }
      if (scratch.bucketHeadDistance > scratch.maxDistance) break;

      const cell = this._bucketPopCell(scratch, scratch.bucketHeadDistance);
      if (cell < 0) continue;

      if (scratch.isVisited(cell)) continue;
      scratch.markVisited(cell);

      const cellDist = scratch.distance[cell];
      const cellX = cell % gridWidth;
      const cellY = Math.floor(cell / gridWidth);

      // Check all 8 neighbors
      for (let dir = 0; dir < 8; dir++) {
        const nx = cellX + dx[dir];
        const ny = cellY + dy[dir];

        // Bounds check
        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= this.gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        // Walkability check
        if (walkability[neighbor] === 0) continue;

        // Already visited?
        if (scratch.isVisited(neighbor)) continue;

        // Calculate new distance
        const newDist = cellDist + cost[dir];
        if (newDist < scratch.distance[neighbor]) {
          scratch.distance[neighbor] = newDist;
          scratch.direction[neighbor] = oppositeDir[dir]; // Point towards target

          // Add to bucket queue
          const bucket = Math.min(newDist, scratch.maxDistance);
          this._bucketInsertCell(scratch, neighbor, bucket);
        }
      }
    }

    // Second pass: make unwalkable tiles point towards nearest walkable neighbor
    // This helps entities escape if they somehow end up inside obstacles
    const dirMap = [
      DIRECTION.N,
      DIRECTION.NE,
      DIRECTION.E,
      DIRECTION.SE,
      DIRECTION.S,
      DIRECTION.SW,
      DIRECTION.W,
      DIRECTION.NW,
    ];

    for (let cell = 0; cell < totalCells; cell++) {
      if (walkability[cell] !== 0) continue; // Skip walkable cells

      const cellX = cell % gridWidth;
      const cellY = Math.floor(cell / gridWidth);

      let bestDir = DIRECTION.NONE;
      let bestDist = 65535;

      // Find the walkable neighbor with lowest distance to target
      for (let dir = 0; dir < 8; dir++) {
        const nx = cellX + dx[dir];
        const ny = cellY + dy[dir];

        // Bounds check
        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= this.gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        // Only consider walkable neighbors
        if (walkability[neighbor] === 0) continue;

        // Check if this neighbor has a better (lower) distance to target
        if (scratch.distance[neighbor] < bestDist) {
          bestDist = scratch.distance[neighbor];
          bestDir = dirMap[dir]; // Point towards this neighbor
        }
      }

      scratch.direction[cell] = bestDir;
    }

    // Third pass: Smoothing
    // Average each vector with its 8 neighbors to get continuous float vectors

    // Safety check for hot-reload scenarios where scratch might be stale
    if (!scratch.smoothedVectors) {
      scratch.smoothedVectors = new Int8Array(this.totalCells * 2);
    }

    const smoothed = scratch.smoothedVectors;

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const cell = y * gridWidth + x;
        const outIdx = cell * 2;
        const dir = scratch.direction[cell];

        // Skip if original cell has no direction (unreachable)
        if (dir === DIRECTION.NONE) {
          smoothed[outIdx] = 0;
          smoothed[outIdx + 1] = 0;
          continue;
        }

        // Unwalkable cells keep their original direction (don't average them)
        // but they DO count when averaging walkable neighbors
        if (walkability[cell] === 0) {
          const vec = DIR_TO_VEC[dir];
          smoothed[outIdx] = Math.round(vec[0] * 127);
          smoothed[outIdx + 1] = Math.round(vec[1] * 127);
          continue;
        }

        let sumX = 0;
        let sumY = 0;
        let count = 0;

        // 3x3 kernel - sum all neighbor vectors (including unwalkable cells)
        for (let ny = y - 1; ny <= y + 1; ny++) {
          for (let nx = x - 1; nx <= x + 1; nx++) {
            if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < this.gridHeight) {
              const neighbor = ny * gridWidth + nx;
              const neighborDir = scratch.direction[neighbor];
              if (neighborDir !== DIRECTION.NONE) {
                const vec = DIR_TO_VEC[neighborDir];
                sumX += vec[0];
                sumY += vec[1];
                count++;
              }
            }
          }
        }

        if (count > 0) {
          // Average the vector (sum / count) - this gives float values in [-1, 1]
          const avgX = sumX / count;
          const avgY = sumY / count;

          // Store as Int8 scaled by 127 (so -1.0 -> -127, 1.0 -> 127)
          smoothed[outIdx] = Math.round(avgX * 127);
          smoothed[outIdx + 1] = Math.round(avgY * 127);
        } else {
          smoothed[outIdx] = 0;
          smoothed[outIdx + 1] = 0;
        }
      }
    }

    // Allocate slot and write results
    const slot = NavGrid.allocateFlowfieldSlot(targetCell);
    NavGrid.writeFlowfieldData(slot, smoothed);

    // Update cache count
    if (willUseEmptySlot) {
      this.cachedFlowfieldsCount++;
    }
  }

  /**
   * Compute A* path between two cells
   *
   * Uses octile distance heuristic for 8-directional movement.
   * Binary heap for efficient open set operations.
   *
   * @param {number} fromCell - Starting cell
   * @param {number} toCell - Destination cell
   */
  computePath(fromCell, toCell) {
    const willUseEmptySlot = this._hasEmptyPathSlot();

    const scratch = this.scratch;
    scratch.reset();

    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    // Clear open set tracking
    scratch.inOpenSet.fill(0);

    // Target coordinates for heuristic
    const targetX = toCell % gridWidth;
    const targetY = Math.floor(toCell / gridWidth);

    // Heuristic function (octile distance)
    const heuristic = (cell) => {
      const cx = cell % gridWidth;
      const cy = Math.floor(cell / gridWidth);
      const dx = Math.abs(cx - targetX);
      const dy = Math.abs(cy - targetY);
      // Octile: 10 * max(dx, dy) + 4 * min(dx, dy) (approximates 14 for diagonal)
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    };

    // Initialize start node
    scratch.heapGCost[fromCell] = 0;
    const startH = heuristic(fromCell);
    scratch.heapFCost[fromCell] = startH;
    scratch.cameFrom[fromCell] = fromCell;

    // Binary heap operations
    const heapPush = (cell) => {
      const idx = scratch.heapSize++;
      scratch.heapCell[idx] = cell;
      // Bubble up
      let i = idx;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (scratch.heapFCost[scratch.heapCell[i]] < scratch.heapFCost[scratch.heapCell[parent]]) {
          // Swap
          const tmp = scratch.heapCell[i];
          scratch.heapCell[i] = scratch.heapCell[parent];
          scratch.heapCell[parent] = tmp;
          i = parent;
        } else {
          break;
        }
      }
    };

    const heapPop = () => {
      if (scratch.heapSize === 0) return -1;
      const result = scratch.heapCell[0];
      scratch.heapSize--;
      if (scratch.heapSize > 0) {
        scratch.heapCell[0] = scratch.heapCell[scratch.heapSize];
        // Bubble down
        let i = 0;
        while (true) {
          const left = 2 * i + 1;
          const right = 2 * i + 2;
          let smallest = i;
          if (
            left < scratch.heapSize &&
            scratch.heapFCost[scratch.heapCell[left]] <
            scratch.heapFCost[scratch.heapCell[smallest]]
          ) {
            smallest = left;
          }
          if (
            right < scratch.heapSize &&
            scratch.heapFCost[scratch.heapCell[right]] <
            scratch.heapFCost[scratch.heapCell[smallest]]
          ) {
            smallest = right;
          }
          if (smallest !== i) {
            const tmp = scratch.heapCell[i];
            scratch.heapCell[i] = scratch.heapCell[smallest];
            scratch.heapCell[smallest] = tmp;
            i = smallest;
          } else {
            break;
          }
        }
      }
      return result;
    };

    // Add start to open set
    heapPush(fromCell);
    scratch.inOpenSet[fromCell] = 1;

    // 8-directional neighbors
    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];
    const cost = [10, 14, 10, 14, 10, 14, 10, 14];

    let found = false;

    while (scratch.heapSize > 0) {
      const current = heapPop();
      scratch.inOpenSet[current] = 0;

      // Found target?
      if (current === toCell) {
        found = true;
        break;
      }

      // Already processed?
      if (scratch.isVisited(current)) continue;
      scratch.markVisited(current);

      const currentG = scratch.heapGCost[current];
      const currentX = current % gridWidth;
      const currentY = Math.floor(current / gridWidth);

      // Check all 8 neighbors
      for (let dir = 0; dir < 8; dir++) {
        const nx = currentX + dx[dir];
        const ny = currentY + dy[dir];

        // Bounds check
        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        // Walkability check
        if (walkability[neighbor] === 0) continue;

        // Already in closed set?
        if (scratch.isVisited(neighbor)) continue;

        const tentativeG = currentG + cost[dir];

        // Better path?
        if (!scratch.inOpenSet[neighbor] || tentativeG < scratch.heapGCost[neighbor]) {
          scratch.cameFrom[neighbor] = current;
          scratch.heapGCost[neighbor] = tentativeG;
          scratch.heapFCost[neighbor] = tentativeG + heuristic(neighbor);

          if (!scratch.inOpenSet[neighbor]) {
            heapPush(neighbor);
            scratch.inOpenSet[neighbor] = 1;
          }
        }
      }
    }

    // Reconstruct path
    let pathLength = 0;
    if (found) {
      // Build path backwards
      let current = toCell;
      while (current !== fromCell && pathLength < scratch.pathResult.length) {
        scratch.pathResult[pathLength++] = current;
        current = scratch.cameFrom[current];
      }
      scratch.pathResult[pathLength++] = fromCell;

      // Reverse path
      for (let i = 0; i < pathLength / 2; i++) {
        const tmp = scratch.pathResult[i];
        scratch.pathResult[i] = scratch.pathResult[pathLength - 1 - i];
        scratch.pathResult[pathLength - 1 - i] = tmp;
      }
    }

    // Allocate slot and write results
    const slot = NavGrid.allocatePathSlot(fromCell, toCell);

    NavGrid.writePathData(slot, scratch.pathResult, pathLength);

    // Update cache count
    if (willUseEmptySlot) {
      this.cachedPathsCount++;
    }
  }

  /**
   * Rebuild walkability grid from static entities
   * Called when scene changes (NOT hot path)
   *
   * @param {Array} staticEntities - Array of {x, y, width, height}
   */
  rebuildWalkability(staticEntities) {
    if (!this.scratch) return;

    const walkability = NavGrid.getWalkabilityArray();
    const cellSize = NavGrid._cellSize;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    // Start with all cells walkable
    walkability.fill(1);

    // Mark cells occupied by static entities as blocked
    for (let i = 0; i < staticEntities.length; i++) {
      const entity = staticEntities[i];
      const { x, y, width, height } = entity;

      // Calculate cell range
      const startCellX = Math.floor(x / cellSize);
      const startCellY = Math.floor(y / cellSize);
      const endCellX = Math.ceil((x + (width || cellSize)) / cellSize);
      const endCellY = Math.ceil((y + (height || cellSize)) / cellSize);

      for (let cy = startCellY; cy < endCellY; cy++) {
        for (let cx = startCellX; cx < endCellX; cx++) {
          if (cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight) {
            const cellId = cy * gridWidth + cx;
            walkability[cellId] = 0; // blocked
          }
        }
      }
    }

    // Invalidate all cached paths and flowfields
    NavGrid.invalidate();

    // Reset cache counters
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;

    this.reportLog(`rebuilt walkability grid, ${staticEntities.length} static entities`);
  }

  /**
   * Rebuild walkability grid from entity indices
   *
   * Reads positions from Transform component and sizes from Collider component.
   * Handles both circle and box colliders via ColliderUtils.
   *
   * @param {number[]} entityIndices - Array of entity indices to mark as obstacles
   */
  rebuildWalkabilityFromIndices(entityIndices) {
    if (!this.scratch) return;

    const walkability = NavGrid.getWalkabilityArray();
    const cellSize = NavGrid._cellSize;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    // Pre-compute invariants outside loop (performance)
    const invCellSize = 1 / cellSize;
    const maxCol = gridWidth - 1;
    const maxRow = gridHeight - 1;

    // Start with all cells walkable
    walkability.fill(1);

    // Mark cells occupied by entities as blocked
    for (let i = 0; i < entityIndices.length; i++) {
      const idx = entityIndices[i];

      // Get collider bounds (handles circles, boxes, and offsets)
      getColliderBounds(idx, _boundsResult);

      // Calculate cell range covered by this collider
      getCellRange(
        _boundsResult.posX,
        _boundsResult.posY,
        _boundsResult.halfW,
        _boundsResult.halfH,
        invCellSize,
        maxCol,
        maxRow,
        _cellRangeResult
      );

      // Mark all cells in range as blocked
      for (let row = _cellRangeResult.minRow; row <= _cellRangeResult.maxRow; row++) {
        for (let col = _cellRangeResult.minCol; col <= _cellRangeResult.maxCol; col++) {
          walkability[row * gridWidth + col] = 0; // blocked
        }
      }
    }

    // Invalidate all cached paths and flowfields
    NavGrid.invalidate();

    // Reset cache counters
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;

    this.reportLog(`rebuilt walkability from ${entityIndices.length} entity indices`);
  }

  /**
   * Check if there's an empty flowfield slot available
   */
  _hasEmptyFlowfieldSlot() {
    if (!NavGrid._initialized) return false;

    const sab = NavGrid._sab;
    const slotSize = NavGrid._flowfieldSlotSize;

    for (let i = 0; i < this.maxFlowfields; i++) {
      const offset = NavGrid._flowfieldHeadersOffset + i * slotSize;
      const view = new Uint32Array(sab, offset, 3);
      if (view[2] === 0) return true; // 0 = EMPTY
    }
    return false;
  }

  /**
   * Check if there's an empty path slot available
   */
  _hasEmptyPathSlot() {
    if (!NavGrid._initialized) return false;

    const sab = NavGrid._sab;
    const headerOffset = NavGrid._pathHeadersOffset;
    const headerSize = NavGrid._PATH_HEADER_SIZE;

    for (let i = 0; i < this.maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const view = new Uint32Array(sab, offset, 5);
      if (view[4] === 0) return true; // 0 = EMPTY
    }
    return false;
  }

  _bucketInsertCell(scratch, cell, bucket) {
    const clampedBucket = bucket > scratch.maxDistance ? scratch.maxDistance : bucket;
    const oldBucket = scratch.bucketNodeDist[cell];
    if (oldBucket >= 0) {
      if (oldBucket === clampedBucket) return;
      this._bucketUnlinkCell(scratch, cell, oldBucket);
    }

    const head = scratch.bucketHead[clampedBucket];
    scratch.bucketNodePrev[cell] = -1;
    scratch.bucketNodeNext[cell] = head;
    if (head >= 0) {
      scratch.bucketNodePrev[head] = cell;
    } else {
      scratch.bucketTail[clampedBucket] = cell;
    }
    scratch.bucketHead[clampedBucket] = cell;
    scratch.bucketNodeDist[cell] = clampedBucket;
    scratch.bucketCount++;
  }

  _bucketUnlinkCell(scratch, cell, bucket) {
    const prev = scratch.bucketNodePrev[cell];
    const next = scratch.bucketNodeNext[cell];
    if (prev >= 0) {
      scratch.bucketNodeNext[prev] = next;
    } else {
      scratch.bucketHead[bucket] = next;
    }
    if (next >= 0) {
      scratch.bucketNodePrev[next] = prev;
    } else {
      scratch.bucketTail[bucket] = prev;
    }
    scratch.bucketNodePrev[cell] = -1;
    scratch.bucketNodeNext[cell] = -1;
    scratch.bucketNodeDist[cell] = -1;
    scratch.bucketCount--;
  }

  _bucketPopCell(scratch, bucket) {
    const cell = scratch.bucketHead[bucket];
    if (cell < 0) return -1;
    this._bucketUnlinkCell(scratch, cell, bucket);
    return scratch.bucketNodeCell[cell];
  }

  // ========================================
  // SHADOW RENDER QUEUE
  // ========================================

  /**
   * Build shadow render queue with light gradients and shadows
   * Order: light1_gradient, light1_shadows..., light2_gradient, light2_shadows...
   * Lights are sorted by Y position (lower Y first) for correct painter's algorithm layering
   * This pre-sorted queue is consumed directly by pixi_worker (no additional sorting needed)
   */
  buildShadowRenderQueue() {
    if (!this.shadowsEnabled || !this.shadowRenderQueueCount) {
      if (this.shadowRenderQueueCount) this.shadowRenderQueueCount[0] = 0;
      return;
    }

    // Cache Grid data and metadata
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    // Check if we have precomputed distances from Grid (spatial worker)
    if (!neighborData || Grid.maxNeighbors <= 0) {
      this.shadowRenderQueueCount[0] = 0;
      return;
    }

    // Cache component arrays
    const worldX = Transform.x;
    const worldY = Transform.y;
    const transformActive = Transform.active;
    const lightEnabled = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;
    const lightHeight = LightEmitter.height;
    const shadowCasterActive = ShadowCaster.active;
    const entityShadowRadius = ShadowCaster.shadowRadius;
    const entityShadowHeight = ShadowCaster.height;
    const flashActive = FlashComponent.active;

    // Per-entity shadow limit tracking
    const maxShadowsPerEntity = this.maxShadowsPerEntity;
    const entityShadowCounts = this._entityShadowCounts;
    if (maxShadowsPerEntity > 0 && entityShadowCounts) {
      entityShadowCounts.fill(0);
    }

    // Output arrays
    const rqX = this.shadowRenderQueueX;
    const rqY = this.shadowRenderQueueY;
    const rqScaleX = this.shadowRenderQueueScaleX;
    const rqScaleY = this.shadowRenderQueueScaleY;
    const rqRotation = this.shadowRenderQueueRotation;
    const rqAlpha = this.shadowRenderQueueAlpha;
    const rqTint = this.shadowRenderQueueTint;
    const rqTextureId = this.shadowRenderQueueTextureId;
    const rqAnchorX = this.shadowRenderQueueAnchorX;
    const rqAnchorY = this.shadowRenderQueueAnchorY;

    // Entity texture lookup for shadow textures
    const entityLastTextureId = this.entityLastTextureId;

    // Light gradient texture ID (from bigAtlas)
    const lightGradientAnimIdx = this.animationNameToIndex?.['_lightGradient'] ?? 0;
    const lightGradientTextureId = this.animationFrameStart?.[lightGradientAnimIdx] ?? 0;

    let writeIdx = 0;
    let lightsProcessed = 0;
    const maxItems = this.maxShadowRenderItems;
    const maxShadowSprites = this.maxShadowSprites;
    const PI = Math.PI;

    // Track shadow count for stats
    let shadowCount = 0;

    // Compute world-space viewport bounds for shadow culling
    const zoom = this.cameraData ? this.cameraData[0] : 1;
    const camX = this.cameraData ? this.cameraData[1] : 0;
    const camY = this.cameraData ? this.cameraData[2] : 0;
    const screenBounds = calculateCameraScreenBounds(
      zoom,
      camX,
      camY,
      this.canvasWidth,
      this.canvasHeight,
      this.cullingRatio,
      this._cameraBounds
    );
    const worldBounds = screenBoundsToWorldBounds(
      screenBounds,
      0,
      0,
      this._cameraWorldBounds
    );
    const viewMinX = worldBounds.minX;
    const viewMaxX = worldBounds.maxX;
    const viewMinY = worldBounds.minY;
    const viewMaxY = worldBounds.maxY;

    // Query only active entities with LightEmitter
    const lightEntitiesRaw = this.queryActiveEntities(this._queryLightEmitter);

    // Sort lights by Y position for consistent visual ordering (painter's algorithm)
    // Lights higher on screen (lower Y) render first, so shadows layer correctly
    // GC OPTIMIZATION: Reuse pre-allocated array instead of Array.from()
    const lightEntities = this._sortedLightEntities;
    lightEntities.length = lightEntitiesRaw.length;
    for (let i = 0; i < lightEntitiesRaw.length; i++) {
      lightEntities[i] = lightEntitiesRaw[i];
    }
    lightEntities.sort(this._lightYComparator);

    // For each LIGHT, add light gradient then its shadows
    for (let i = 0; i < lightEntities.length; i++) {
      if (writeIdx >= maxItems) break;
      if (lightsProcessed >= this.maxShadowCastingLights) break;

      const lightIdx = lightEntities[i];
      if (!lightEnabled[lightIdx]) continue;

      const isFlash = flashActive[lightIdx] === 1;
      const intensity = lightIntensity[lightIdx];
      if (intensity <= 0) continue;

      // Collect shadows for this light first
      const lightX = worldX[lightIdx];
      const lightY = worldY[lightIdx];
      const lightH = lightHeight[lightIdx] || 0;

      // Check if light's influence area reaches the viewport
      if (!isFlash) {
        const lightInfluenceRadius = sqrtLightIntensity[lightIdx] * 10;
        if (lightX + lightInfluenceRadius < viewMinX || lightX - lightInfluenceRadius > viewMaxX ||
          lightY + lightInfluenceRadius < viewMinY || lightY - lightInfluenceRadius > viewMaxY) continue;
      }

      // Get neighbors of this light
      const offset = lightIdx * stride;
      const neighborCountForLight = neighborData[offset];

      // Temporary collection for this light's shadows
      const shadowStartIdx = writeIdx + 1;
      let shadowsForThisLight = 0;

      // Pre-compute light position with offset once per light
      const lightXWithOffset = worldX[lightIdx] + (Collider.offsetX[lightIdx] || 0);
      const lightYWithOffset = worldY[lightIdx] + (Collider.offsetY[lightIdx] || 0);

      for (let k = 0; k < neighborCountForLight; k++) {
        if (shadowsForThisLight >= this.maxShadowsPerLight) break;
        if (shadowCount >= maxShadowSprites) break;
        if (writeIdx + 1 + shadowsForThisLight >= maxItems) break;

        const neighborIdx = neighborData[offset + 2 + k];

        // Skip if not a shadow caster or inactive
        if (!shadowCasterActive[neighborIdx] || !transformActive[neighborIdx]) continue;

        // Per-entity shadow limit
        if (maxShadowsPerEntity > 0 && entityShadowCounts[neighborIdx] >= maxShadowsPerEntity) continue;

        // Calculate distance
        const neighborX = worldX[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
        const neighborY = worldY[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
        const dx = neighborX - lightXWithOffset;
        const dy = neighborY - lightYWithOffset;
        const distSq = dx * dx + dy * dy;

        if (distSq < 1) continue;

        // Calculate shadow properties
        const casterX = worldX[neighborIdx];
        const casterY = worldY[neighborIdx];
        let casterRadius = entityShadowRadius[neighborIdx];
        if (Number.isNaN(casterRadius) || casterRadius <= 0) casterRadius = 10;
        const casterHeight = entityShadowHeight[neighborIdx] || casterRadius;

        const dist = Math.sqrt(distSq);
        const invDist = 1 / dist;
        const dirX = dx * invDist;
        const dirY = dy * invDist;

        // Shadow position
        const posX = casterX - dirX * casterRadius * 0.5;
        const posY = casterY - dirY * casterRadius * 0.5;

        if (Number.isNaN(posX) || Number.isNaN(posY)) continue;

        // Shadow scale
        const distRatio = dist * 0.00390625; // 1/256
        const clampedDistRatio = distRatio > 1 ? 1 : distRatio;
        const heightFactor = casterHeight * 0.025;
        const lengthScale = (0.3 + clampedDistRatio * 0.9) * heightFactor;
        const widthScale = 1;

        // Cull shadow by its actual world position
        const shadowExtent = casterHeight * (1 + lengthScale);
        if (posX + shadowExtent < viewMinX || posX - shadowExtent > viewMaxX ||
          posY + shadowExtent < viewMinY || posY - shadowExtent > viewMaxY) continue;

        // Alpha and angle
        let alpha = intensity / (intensity + distSq);
        if (Number.isNaN(alpha)) alpha = 0;
        if (alpha > 1) alpha = 1;
        if (alpha < 0) alpha = 0;
        alpha *= 0.33;

        const angle = Math.atan2(dy, dx);

        // Get entity's current texture for shadow
        const textureId = entityLastTextureId ? entityLastTextureId[neighborIdx] : 0;

        // Write shadow to queue
        const idx = shadowStartIdx + shadowsForThisLight;
        rqX[idx] = posX;
        rqY[idx] = posY;
        rqScaleX[idx] = widthScale;
        rqScaleY[idx] = lengthScale;
        rqRotation[idx] = angle - 1.5707963267948966 + PI; // PI/2 + PI
        rqAlpha[idx] = alpha;
        rqTint[idx] = 0x000000;
        rqTextureId[idx] = textureId;
        rqAnchorX[idx] = 0.5;
        rqAnchorY[idx] = 1.0;

        shadowsForThisLight++;
        shadowCount++;
        if (maxShadowsPerEntity > 0) entityShadowCounts[neighborIdx]++;
      }

      // Only add light gradient if there are shadows for this light
      if (shadowsForThisLight > 0) {
        lightsProcessed++;

        // Write light gradient FIRST
        const gradientScale = 10 * sqrtLightIntensity[lightIdx] * 3 / 100;
        const gradientAlpha = intensity / 50000;

        rqX[writeIdx] = lightX;
        rqY[writeIdx] = lightY - lightH;
        rqScaleX[writeIdx] = gradientScale;
        rqScaleY[writeIdx] = gradientScale;
        rqRotation[writeIdx] = 0;
        rqAlpha[writeIdx] = gradientAlpha;
        rqTint[writeIdx] = 0xFFFFFF;
        rqTextureId[writeIdx] = lightGradientTextureId;
        rqAnchorX[writeIdx] = 0.5;
        rqAnchorY[writeIdx] = 0.5;

        // Move write index past light gradient + all its shadows
        writeIdx = shadowStartIdx + shadowsForThisLight;
      }
    }

    // Write count
    this.shadowRenderQueueCount[0] = writeIdx;

    // Track shadows updated for stats
    this.shadowsUpdatedThisFrame = shadowCount;
  }

  // ========================================
  // DERIVED PROPERTIES
  // ========================================

  /**
   * Update derived properties from positions
   * Calculates speed and velocityAngle from velocity data
   * Also handles sleeping detection for physics optimization
   */
  updateDerivedProperties() {
    if (this.rigidBodyCount === 0 || !RigidBody.vx) return;

    const rigidBodyActive = RigidBody.active;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const velocityAngle = RigidBody.velocityAngle;
    const speed = RigidBody.speed;
    const minSpeedForRotation = this.minSpeedForRotation;
    const sleepThreshold = this.sleepThreshold;
    const sleepDuration = this.sleepDuration;
    const sleeping = RigidBody.sleeping;
    const stillnessTime = RigidBody.stillnessTime;
    const isStatic = RigidBody.static;

    // Query only active entities that have RigidBody component
    const physicsEntities = this.queryActiveEntities(this._queryRigidBody || [RigidBody]);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      if (!rigidBodyActive[i]) continue;

      // Skip static entities
      if (isStatic[i]) continue;

      // Calculate speed from velocity
      const currentSpeed = calculateSpeed(vx[i], vy[i]);
      speed[i] = currentSpeed;

      // SLEEPING DETECTION: Track stillness and put entities to sleep
      if (currentSpeed < sleepThreshold) {
        stillnessTime[i]++;
        if (stillnessTime[i] >= sleepDuration) {
          sleeping[i] = 1;
        }
      } else {
        sleeping[i] = 0;
        stillnessTime[i] = 0;
      }

      // Only update rotation if moving above minimum threshold
      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = calculateVelocityAngle(vx[i], vy[i]);
      }
    }
  }

  /**
   * Override reportFPS to write navigation-specific stats to SharedArrayBuffer
   */
  reportFPS() {
    if (!this.stats) return;

    this.stats[NAVIGATION_STATS.FPS] = this.currentFPS;
    this.stats[NAVIGATION_STATS.FLOWFIELDS_COMPUTED] = this.flowfieldsComputedThisFrame;
    this.stats[NAVIGATION_STATS.PATHS_COMPUTED] = this.pathsComputedThisFrame;
    this.stats[NAVIGATION_STATS.FLOWFIELDS_CACHED] = this.cachedFlowfieldsCount;
    this.stats[NAVIGATION_STATS.PATHS_CACHED] = this.cachedPathsCount;
    this.stats[NAVIGATION_STATS.PENDING_FLOWFIELDS] = this.flowfieldRequests ? this.flowfieldRequests.size : 0;
    this.stats[NAVIGATION_STATS.PENDING_PATHS] = this.pathRequests ? this.pathRequests.size : 0;
    this.stats[NAVIGATION_STATS.GRID_WIDTH] = this.gridWidth;
    this.stats[NAVIGATION_STATS.GRID_HEIGHT] = this.gridHeight;
    this.stats[NAVIGATION_STATS.SHADOWS_UPDATED] = this.shadowsUpdatedThisFrame;
  }
}

// Create singleton instance
self.navWorker = new NavWorker(self);
