// =============================================================================
// SPATIAL WORKER - Row-Based Partitioned Spatial Hashing & Neighbor Detection
// =============================================================================
//
// ARCHITECTURE: Each spatial worker owns row blocks where floor(row / rowsPerBlock) % workerCount === workerId
// - No double buffering (neither grid nor neighbors)
// - Each worker rebuilds its own rows AND computes neighbors for entities in those rows
// - Workers can READ any cell but only WRITE to owned rows/entities
//
// FLOW PER FRAME:
// 1. Clear LOCAL cell counts (not shared buffer - avoids mid-clear race)
// 2. Insert ALL active entities into grid (only to owned rows)
// 3. Copy local counts to shared gridCounts (single write per cell)
//    (1-3 when physics moved few bodies, E-126: rewrite only the cells of the entities that
//    changed, to the same bytes: _rebuildGrid chooses, _rebuildMovedRows rewrites)
// 4. For each entity in owned rows: find visual-range neighbors
//    (Box2D owns contacts; no collision-candidate partition)
//
// MEMORY MODEL (1-frame eventual consistency):
// - Grid: Single buffer, row ownership prevents write races
// - Neighbors: Single buffer, row ownership prevents write races
// - Reading cells owned by other workers may return 1-frame-stale data (acceptable)
// - "Torn reads" by logic workers just mix current + recent data (never garbage)
// - Distance checks filter any out-of-range neighbors
// - Transform.active[] check handles despawned entities
//
// IMPORTANT: Home row uses entityPosData latched this frame in rebuild
// (from collider bounds / Transform). Skip if that row is not ours.
// Do not trust another worker's entityPosData (may be stale/zero).
//
// =============================================================================

self.postMessage({
  msg: 'log',
  message: 'spatial_worker.js loaded (row-based partitioning)',
  when: Date.now(),
});

import { Transform as TransformImport } from '../components/transform.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { RigidBody as RigidBodyImport } from '../components/rigidBody.js';
import { Collider as ColliderImport } from '../components/collider.js';
import { SpriteRenderer as SpriteRendererImport } from '../components/spriteRenderer.js';
import { AbstractWorker } from './abstractWorker.js';
import { Grid as GridImport } from '../core/grid.js';
import {
  SPATIAL_STATS,
  createMultiWorkerStatsWriter,
  getEntityHomeCellIndex,
} from '../util/workersUtils.js';
import { generateSymmetricalCirclePattern } from '../util/utils.js';
import { SPATIAL_DEFAULTS } from '../util/configDefaults.js';
import { EntityIdArray, packSpatialPairStamp as packSpatialPairStampImport, SPATIAL_STAMP_FRAME_MASK } from '../util/entityIdWidth.js';
import { bindSpatialGather, bindSpatialPublish } from './spatialPublishClient.js';
import { SPATIAL_MAX_CELL_RADIUS } from '../util/spatialPublishMemory.js';
import { getColliderBounds as getColliderBoundsImport, getCellRange as getCellRangeImport, _boundsResult as _boundsResultImport, _cellRangeResult as _cellRangeResultImport, SHAPE_CIRCLE as SHAPE_CIRCLEImport } from '../util/colliderUtils.js';
import { readMovedBodiesHeader, copyMovedBodies } from '../box2d/box2dMovedBodies.js';

// Hot code reads these as module consts, not imports. TurboFan folds a module
// const (and the typed arrays its class holds); an import is a cell it reads
// at run time. See HOW_WE_MEASURE, "Imports in hot code".
const Transform = TransformImport;
const RigidBody = RigidBodyImport;
const Collider = ColliderImport;
const SpriteRenderer = SpriteRendererImport;
const Grid = GridImport;
const packSpatialPairStamp = packSpatialPairStampImport;
const getColliderBounds = getColliderBoundsImport;
const getCellRange = getCellRangeImport;
const _boundsResult = _boundsResultImport;
const _cellRangeResult = _cellRangeResultImport;
const SHAPE_CIRCLE = SHAPE_CIRCLEImport;

// E-126 (grid movers only). In a frame where physics moved at most this share of the active
// entities, the grid is rewritten for the entities that changed (_rebuildMovedRows) instead of
// rebuilt for all of them (rebuildOwnedRows). It belongs at the crossover of
// tests/bench/spatialGridMoversMicrobench.mjs (cases 35 % and 50 %); 0.35 is the old path's value.
const MOVERS_MAX_FRACTION = 0.35;
// SpatialWorker._gridMoversMode.
const GRID_MOVERS_AUTO = 0; // by the moved fraction
const GRID_MOVERS_OFF = 1; // the full rebuild every frame
const GRID_MOVERS_FORCE = 2; // the movers path whenever its state allows (kernels, tests)
// SpatialWorker._mvState bits: each entity as the grid holds it.
const MV_PRESENT = 1; // in the active list the state was built from
const MV_IN_GRID = 2; // binned, with the cell range in _mvRange
const MV_OWNED = 4; // home row owned here: in _ownedEntityList
const MV_LOOSE = 8; // no collider, so no physics list reports it: compared every frame
const MV_SPRITE = 16; // a loose entity's SpriteRenderer.active when it was binned

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
    // processedMarker[entityB] = (frameStamp | entityA) encodes both frame and source entity
    // Top 13 bits = frame counter, low 19 bits = entityA (packSpatialPairStamp). Avoids fill() every frame.
    this.processedMarker = null; // Int32Array
    this._processedFrameCounter = 0;
    // Local cell counts for race-free grid rebuilding
    // We build counts locally, then copy to grid at the end (avoids mid-clear races)
    this._localCellCounts = null; // Uint8Array(totalCells)
    this._entityLastX = null;
    this._entityLastY = null;
    this._entityLastHalfExtent = null;
    this._entityLastVisualRange = null;
    this._entityReuseInitialized = null;

    // Visual ranges up to ~1500 px at cellSize 128; the WASM gather's pattern table is sized by it.
    this._maxCellRadius = SPATIAL_MAX_CELL_RADIUS;
    // Precomputed circle patterns: cellRadius -> Int32Array of [dr, dc, dr, dc, ...]
    this._circlePatterns = new Array(this._maxCellRadius + 1);
    // Pattern lengths cache: cellRadius -> length (number of cell pairs)
    this._patternLengths = new Uint16Array(this._maxCellRadius + 1);

    // Cached neighbor cells: (cellIndex * MAX_CELL_RADIUS + cellRadius) -> cell-index list.
    // Uint16 while totalCells <= 65535; Uint32 above that. Chosen in initialize.
    this._cellIndexArray = Uint16Array;
    this._cellNeighborCache = new Map();
    this._maxNeighborCacheEntries = 8192;
    // The WASM candidate gather (E-78), bound in initialize when the publish memory has its regions.
    this._wasmGather = null;

    // Performance stats
    this.entitiesProcessedThisFrame = 0;
    this.neighborsFoundThisFrame = 0;
    this.cellsCheckedThisFrame = 0;
    this.rebuildTimeThisFrame = 0;
    this.neighborSearchTimeThisFrame = 0;
    this.neighborsReusedThisFrame = 0;
    this.sleepNeighborSkipsThisFrame = 0;

    /** Fraction of visualRange (0 = off). */
    this._neighborReuseSkin = 0;
    /** Full candidate rebuild every N frames (1 = every frame). */
    this._neighborTickInterval = 1;
    // spatial.gatherCellOrder: the WASM gather walks its batch in home-cell order.
    this._gatherCellOrder = false;
    /** Countdown to next full rebuild when neighborTickInterval > 1. */
    this._entityNeighborNextTick = null;
    /** Per-entity expanded candidate lists: [count, id0, ...] stride = 1+maxNeighbors */
    this._neighborCandidateData = null;
    /** Dense copy of each list's count: the stagger skip reads this, not the head of a 1+maxNeighbors row. */
    this._candidateCountOf = null;
    /** Entities whose home row is this worker's, listed by rebuildOwnedRows for findNeighbors. */
    this._ownedEntityList = null;
    this._ownedEntityCount = 0;
    this._neighborCandidateTruncated = null;
    this._entityFramesSinceBuild = null;

    // E-126: when physics moved few bodies, the grid is rewritten for the entities that changed.
    /** GRID_MOVERS_AUTO, GRID_MOVERS_OFF (the full rebuild only) or GRID_MOVERS_FORCE (kernels, tests). */
    this._gridMoversMode = GRID_MOVERS_AUTO;
    /** 1 when this frame's grid was rewritten for the entities that changed (SPATIAL_STATS.GRID_MOVERS). */
    this._gridMoversThisFrame = 0;
    /** The state below matches the grid, so the next frame can rewrite it for what changed. */
    this._mvSeeded = false;
    /** Physics' moved-list generation and the active-query version the state includes. */
    this._mvGen = 0;
    this._mvVersion = 0;
    /** Latches given up with no rewrite since, and full-rebuild frames left before the next latch. */
    this._mvFailures = 0;
    this._mvBackoff = 0;
    /** readMovedBodiesHeader's [generation, count, sequence]. */
    this._mvHead = new Int32Array(3);
    // Sized on the first latch (_allocMovers). Per entity:
    this._mvState = new Uint8Array(0);
    /** [minCol, maxCol, minRow, maxRow] per entity, as binned. */
    this._mvRange = new Int32Array(0);
    /** [x, y] a loose entity was binned at. */
    this._mvLoosePos = new Float64Array(0);
    this._mvLoose = new Int32Array(0);
    this._mvLooseCount = 0;
    /** The active list the state was built from, [count, ids…], and the next one. */
    this._mvActive = new Int32Array(0);
    this._mvActiveNext = new Int32Array(0);
    this._mvDirty = new Uint8Array(0);
    this._mvDirtyIds = new Int32Array(0);
    /** This frame's copy of physics' moved list. */
    this._mvMoved = new Int32Array(0);
    // Per cell:
    /** Entities that cover the cell, uncapped (the cell holds the first maxEntitiesPerCell). */
    this._mvTrue = new Int32Array(0);
    this._mvLeaves = new Int32Array(0);
    this._mvCellMark = new Uint8Array(0);
    this._mvTouched = new Int32Array(0);
    /** Entities joining each cell this frame, ascending: a list per cell through _mvJoinNext. */
    this._mvJoinHead = new Int32Array(0);
    this._mvJoinNext = new Int32Array(0);
    this._mvJoinId = new Int32Array(0);
    this._mvCellScratch = new Int32Array(0);
  }

  /**
   * Initialize spatial worker
   * @param {Object} data - Initialization data from Scene
   */
  async initialize(data) {
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
    this._cellIndexArray = this.totalCells > 65535 ? Uint32Array : Uint16Array;
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
      const posByte = data.gridMetadata?.posByte | 0;
      this.entityPosData = posByte
        ? new Float32Array(data.buffers.entityPosData, posByte, this.globalEntityCount * 4)
        : new Float32Array(data.buffers.entityPosData);
    }
    // Initialize duplicate detection marker for neighbors (entityB)
    // Uint32Array: upper 16 bits = frame counter, lower 16 bits = entityA
    // Int32Array, as packSpatialPairStamp is an int32: from stamp frame 4096 its top bit is set,
    // and a Uint32Array element read back as unsigned never equalled it, so the dedup failed for
    // half of every 8191-frame cycle and candidates in several cells were appended once per cell.
    this.processedMarker = new Int32Array(this.globalEntityCount);

    // Initialize local cell counts array for race-free grid rebuilding
    this._localCellCounts = new Uint8Array(this.totalCells);
    this._entityLastX = new Float32Array(this.globalEntityCount);
    this._entityLastY = new Float32Array(this.globalEntityCount);
    this._entityLastHalfExtent = new Float32Array(this.globalEntityCount);
    this._entityLastVisualRange = new Float32Array(this.globalEntityCount);
    this._entityReuseInitialized = new Uint8Array(this.globalEntityCount);

    const spatialCfg = this.config?.spatial || {};
    this._neighborReuseSkin = Number(spatialCfg.neighborReuseSkin) > 0 ? Number(spatialCfg.neighborReuseSkin) : 0;
    // Max frames to keep a candidate list (bounds B drift). Override via spatial.neighborReuseMaxFrames.
    const maxFrames = Number(spatialCfg.neighborReuseMaxFrames);
    this._maxReuseFrames = maxFrames > 0 ? maxFrames | 0 : this._neighborReuseSkin > 0 ? 15 : 0;
    const tickInterval = Number(spatialCfg.neighborTickInterval);
    this._neighborTickInterval = tickInterval > 1 ? tickInterval | 0 : 1;
    this._gatherCellOrder = spatialCfg.gatherCellOrder !== false;
    if (this._neighborTickInterval > 1) {
      const nextTick = new Uint8Array(this.globalEntityCount);
      const interval = this._neighborTickInterval;
      for (let i = 0; i < this.globalEntityCount; i++) {
        nextTick[i] = (i % interval) + 1;
      }
      this._entityNeighborNextTick = nextTick;
    } else {
      this._entityNeighborNextTick = null;
    }
    const candStride = 1 + Grid.maxNeighbors;
    this._wasmPub = null;
    if (data.spatialPublishMemory && data.gridMetadata?.candByte) {
      try {
        this._wasmPub = await bindSpatialPublish(
          data.spatialPublishMemory,
          data.gridMetadata,
          this.workerId | 0,
          this.globalEntityCount,
          Grid.maxNeighbors,
        );
        this._wasmMeta = data.gridMetadata;
      } catch (err) {
        console.error('[spatial] publish wasm unavailable', err);
        this._wasmPub = null;
      }
    }
    this._neighborCandidateData = this._wasmPub
      ? this._wasmPub.cand
      : new (EntityIdArray())(this.globalEntityCount * candStride);
    this._candidateCountOf = new (EntityIdArray())(this.globalEntityCount);
    this._ownedEntityList = new (EntityIdArray())(this.globalEntityCount);
    this._ownedEntityCount = 0;
    this._neighborCandidateTruncated = new Uint8Array(this.globalEntityCount);
    this._entityFramesSinceBuild = new Uint16Array(this.globalEntityCount);
    this._noBodyCount = 0;

    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius)
    this._precomputeCirclePatterns();

    // E-78: the candidate gather in WASM, on the publish memory's grid, markers, flags and lists.
    // Its marker and flags are the ones the JS reads (the fill on stamp wrap, _canReuseNeighbors).
    this._wasmGather = null;
    if (this._wasmPub && this.config?.wasm?.spatialGather !== false && data.gridMetadata?.patternByte) {
      try {
        this._wasmGather = await bindSpatialGather(
          data.spatialPublishMemory,
          data.gridMetadata,
          this.workerId | 0,
          this.globalEntityCount,
          this._circlePatterns,
          this._maxCellRadius,
        );
        this.processedMarker = this._wasmGather.marker;
        this._neighborCandidateTruncated = this._wasmGather.truncated;
      } catch (err) {
        console.error('[spatial] gather wasm unavailable', err);
        this._wasmGather = null;
      }
    }

    if (this.ownedRowCount > 0) {
      debugWorkerLog(
        `SPATIAL WORKER ${this.workerId}: Initialized with ${this.ownedRowCount} rows ` +
        `(rows ${this.ownedRows[0]} to ${this.ownedRows[this.ownedRowCount - 1]} step ${this.totalSpatialWorkers}), ` +
        `precomputed ${this._circlePatterns.length} circle patterns`
      );
    } else {
      debugWorkerLog(
        `SPATIAL WORKER ${this.workerId}: Initialized with 0 rows, ` +
        `precomputed ${this._circlePatterns.length} circle patterns`
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
      this._circlePatterns[cellRadius] = pattern;
      // Cache pattern length (number of cell pairs, so pattern.length / 2)
      this._patternLengths[cellRadius] = pattern.length >> 1;
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
    return this._circlePatterns[clampedRadius] || this._circlePatterns[0];
  }

  /**
   * Get cached neighbor cells for a cell+radius combination, or generate and cache it
   * @param {number} cellIndex - Source cell index
   * @param {number} cellRadius - Search radius in cells
   * @param {number} centerRow - Center row of the entity's cell
   * @param {number} centerCol - Center column of the entity's cell
   * @returns {Uint16Array|Uint32Array} Neighbor cell indices
   */
  _getNeighborCells(cellIndex, cellRadius, centerRow, centerCol) {
    const clampedRadius = cellRadius > this._maxCellRadius ? this._maxCellRadius : cellRadius;
    // Cache key: cellIndex * MAX_RADIUS + cellRadius
    const cacheKey = cellIndex * (this._maxCellRadius + 1) + clampedRadius;

    // Single lookup avoids an extra Map probe in the hot path.
    const cached = this._cellNeighborCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Generate neighbor cells from pattern
    const pattern = this._circlePatterns[clampedRadius];
    const patternLength = pattern.length;
    const maxNeighborCells = this._patternLengths[clampedRadius] || (patternLength >> 1);

    // Pre-allocate array (worst case: all cells in pattern are valid)
    const neighborCells = new this._cellIndexArray(maxNeighborCells);
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

    // Bound cache growth: this memoization is only a performance hint.
    if (this._cellNeighborCache.size >= this._maxNeighborCacheEntries) {
      this._cellNeighborCache.clear();
    }
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
    this.rebuildTimeThisFrame = 0;
    this.neighborSearchTimeThisFrame = 0;
    this.neighborsReusedThisFrame = 0;
    this.sleepNeighborSkipsThisFrame = 0;

    // STEP 1: Rebuild grid (only owned rows), or rewrite it for what changed (E-126)
    const detail = this.collectDetailedStats;
    let startTime = detail ? performance.now() : 0;
    this._rebuildGrid();
    if (detail) {
      this.rebuildTimeThisFrame = performance.now() - startTime;
    }

    // STEP 2: Find neighbors (only for entities in owned rows)
    startTime = detail ? performance.now() : 0;
    if (this._wasmGather) this._findNeighborsWasmGather();
    else this.findNeighborsForOwnedEntities();
    if (detail) {
      this.neighborSearchTimeThisFrame = performance.now() - startTime;
    }
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
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const rigidActive = RigidBody.active;
    const countNoBody = this.collectDetailedStats;
    let noBody = 0;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellStride = Grid._cellIdStride;
    const cellHeader = Grid._headerIds;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const ownedList = this._ownedEntityList;
    let ownedCount = 0;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        localCounts[rowBase + col] = 0;
      }
    }

    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];

      if (!colliderActive[i] && !spriteRendererActive[i]) continue;
      if (
        countNoBody &&
        spriteRendererActive[i] &&
        !colliderActive[i] &&
        !(rigidActive && rigidActive[i])
      ) {
        noBody++;
      }

      let posX;
      let posY;
      let halfW = 0;
      let halfH = 0;
      if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
        // Same math as getColliderBounds' circle branch, without the call.
        posX = x[i] + (offsetX[i] || 0);
        posY = y[i] + (offsetY[i] || 0);
        halfW = radius[i] || 0;
        halfH = halfW;
      } else if (colliderActive[i]) {
        getColliderBounds(i, _boundsResult);
        posX = _boundsResult.posX;
        posY = _boundsResult.posY;
        halfW = _boundsResult.halfW;
        halfH = _boundsResult.halfH;
      } else {
        posX = x[i] + offsetX[i];
        posY = y[i] + offsetY[i];
      }

      if (posX !== posX || posY !== posY) continue;

      const maxHalfExtent = halfW > halfH ? halfW : halfH;
      // Home row from the Float32 Y that findNeighbors reads back from entityPosData.
      let homeRow = (Math.fround(posY) * invCellSize) | 0;
      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
      if (rowOwnership[homeRow] === workerId) ownedList[ownedCount++] = i;

      getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);
      const minCol = _cellRangeResult.minCol;
      const maxColBB = _cellRangeResult.maxCol;
      const minRow = _cellRangeResult.minRow;
      const maxRowBB = _cellRangeResult.maxRow;

      let wroteEntityPos = false;
      for (let row = minRow; row <= maxRowBB; row++) {
        if (rowOwnership[row] !== workerId) continue;

        if (!wroteEntityPos) {
          const baseIdx = i * 4;
          entityPosData[baseIdx] = posX;
          entityPosData[baseIdx + 1] = posY;
          entityPosData[baseIdx + 2] = maxHalfExtent;
          wroteEntityPos = true;
        }

        const rowBase = row * gridWidth;

        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
          }
        }
      }
    }

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;
      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
        gridCounts[byteOffset] = localCounts[cellIndex];
      }
    }
    this._noBodyCount = noBody;
    this._ownedEntityCount = ownedCount;
  }

  /**
   * E-126. This frame's grid: rewritten for the entities that changed (_rebuildMovedRows) when
   * physics moved at most MOVERS_MAX_FRACTION of the active entities, rebuilt otherwise. Chosen here,
   * before either loop. The rewrite starts from the state a latched rebuild leaves and needs
   * physics' moved list of every publish since; a publish missed or torn, or a frame the rewrite
   * gives up on, rebuilds and latches again (after a backoff when that keeps happening).
   */
  _rebuildGrid() {
    const mode = this._gridMoversMode;
    const head = this._mvHead;
    const activeData = this.activeEntitiesData;
    this._gridMoversThisFrame = 0;
    // No physics worker (no moved list): nothing tells which bodies moved.
    if (mode === GRID_MOVERS_OFF || !activeData || !readMovedBodiesHeader(head)) {
      this._mvSeeded = false;
      this.rebuildOwnedRows();
      return;
    }
    const gen = head[0];
    const count = head[1];
    const seq = head[2];
    const auto = mode === GRID_MOVERS_AUTO;
    const limit = auto ? activeData[0] * MOVERS_MAX_FRACTION : this.globalEntityCount;
    if (this._mvSeeded) {
      // Bodies physics moved since the state: none when it has not published since, its list
      // when it published once (and not while the header was being written).
      const moved = gen === this._mvGen ? 0 : gen === ((this._mvGen + 1) | 0) && seq >= 0 ? count : -1;
      if (moved >= 0 && moved <= limit && this._rebuildMovedRows(moved, seq, limit)) {
        this._mvGen = gen;
        this._gridMoversThisFrame = 1;
        this._mvFailures = 0;
        return;
      }
      // The state is spent, and the grid may be half rewritten: the rebuild below writes all of it.
      this._mvSeeded = false;
      // One rewrite after a latch already pays for it. A latch that gets none costs a rebuild and
      // more for nothing: when that repeats, wait 2, 4, … 128 frames before the next latch.
      if (auto) {
        this._mvFailures++;
        this._mvBackoff = this._mvFailures < 2 ? 0 : this._mvFailures > 8 ? 128 : 1 << (this._mvFailures - 1);
      }
    }
    if (this._mvBackoff > 0 || count > limit) {
      if (this._mvBackoff > 0) this._mvBackoff--;
      this.rebuildOwnedRows();
      return;
    }
    this._allocMovers();
    this._mvGen = gen;
    this._mvSeeded = this._rebuildOwnedRowsLatched();
  }

  /** E-126. The movers state, sized once, on the first latch (a scene that never takes the path pays nothing). */
  _allocMovers() {
    const n = this.globalEntityCount;
    const cells = this.totalCells;
    if (this._mvState.length === n && this._mvTrue.length === cells) return;
    this._mvState = new Uint8Array(n);
    this._mvRange = new Int32Array(n * 4);
    this._mvLoosePos = new Float64Array(n * 2);
    this._mvLoose = new Int32Array(n);
    this._mvActive = new Int32Array(n + 1);
    this._mvActiveNext = new Int32Array(n + 1);
    this._mvDirty = new Uint8Array(n);
    this._mvDirtyIds = new Int32Array(n);
    this._mvMoved = new Int32Array(n);
    this._mvTrue = new Int32Array(cells);
    this._mvLeaves = new Int32Array(cells);
    this._mvCellMark = new Uint8Array(cells);
    this._mvTouched = new Int32Array(cells);
    this._mvJoinHead = new Int32Array(cells).fill(-1);
    this._mvJoinNext = new Int32Array(n * 2 + 64);
    this._mvJoinId = new Int32Array(n * 2 + 64);
    this._mvCellScratch = new Int32Array(Grid.maxEntitiesPerCell);
  }

  /**
   * E-126. rebuildOwnedRows, latching the state _rebuildMovedRows starts from: each entity's cell
   * range and whether it is binned and owned here, where an entity without a collider was binned,
   * each owned cell's uncapped count, the active list read. Latched with the values the cells are
   * written from, so the state is this grid's even while physics writes poses. A copy of the loop,
   * not a branch in rebuildOwnedRows (hot loops: R8); tests/node/spatialGridMovers.test.js holds the
   * two to the same bytes.
   * @returns {boolean} false when the active list read was not strictly ascending (torn): the grid
   *   is still this frame's, but the state cannot be rewritten from
   */
  _rebuildOwnedRowsLatched() {
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const rigidActive = RigidBody.active;
    const countNoBody = this.collectDetailedStats;
    let noBody = 0;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellStride = Grid._cellIdStride;
    const cellHeader = Grid._headerIds;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const ownedList = this._ownedEntityList;
    let ownedCount = 0;

    const n = this.globalEntityCount;
    const state = this._mvState;
    const range = this._mvRange;
    const loosePos = this._mvLoosePos;
    const loose = this._mvLoose;
    let looseCount = 0;
    const trueCount = this._mvTrue;
    const snapshot = this._mvActive;
    // Scratch a given-up frame may have left behind.
    state.fill(0);
    this._mvDirty.fill(0);
    this._mvCellMark.fill(0);
    this._mvLeaves.fill(0);
    this._mvJoinHead.fill(-1);
    // Before the list is read: a population change after this read moves the version again.
    this._mvVersion = this.queryVersionData ? Atomics.load(this.queryVersionData, 0) : 0;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        localCounts[rowBase + col] = 0;
        trueCount[rowBase + col] = 0;
      }
    }

    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;
    snapshot[0] = totalActiveEntities;
    let previous = -1;
    let ascending = true;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];
      snapshot[1 + activeIdx] = i;
      if (i <= previous || i >= n) ascending = false;
      previous = i;
      let s = MV_PRESENT;

      // rebuildOwnedRows' bounds; without a collider the position is read once, for the bin and
      // for the latch _rebuildMovedRows compares with.
      let posX;
      let posY;
      let halfW = 0;
      let halfH = 0;
      if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
        // Same math as getColliderBounds' circle branch, without the call.
        posX = x[i] + (offsetX[i] || 0);
        posY = y[i] + (offsetY[i] || 0);
        halfW = radius[i] || 0;
        halfH = halfW;
      } else if (colliderActive[i]) {
        getColliderBounds(i, _boundsResult);
        posX = _boundsResult.posX;
        posY = _boundsResult.posY;
        halfW = _boundsResult.halfW;
        halfH = _boundsResult.halfH;
      } else {
        posX = x[i] + offsetX[i];
        posY = y[i] + offsetY[i];
        s |= MV_LOOSE;
        loosePos[i * 2] = posX;
        loosePos[i * 2 + 1] = posY;
        loose[looseCount++] = i;
        if (!spriteRendererActive[i]) {
          state[i] = s;
          continue;
        }
        s |= MV_SPRITE;
        if (countNoBody && !(rigidActive && rigidActive[i])) noBody++;
      }
      state[i] = s;

      if (posX !== posX || posY !== posY) continue;

      const maxHalfExtent = halfW > halfH ? halfW : halfH;
      // Home row from the Float32 Y that findNeighbors reads back from entityPosData.
      let homeRow = (Math.fround(posY) * invCellSize) | 0;
      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
      if (rowOwnership[homeRow] === workerId) {
        ownedList[ownedCount++] = i;
        s |= MV_OWNED;
      }

      getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);
      const minCol = _cellRangeResult.minCol;
      const maxColBB = _cellRangeResult.maxCol;
      const minRow = _cellRangeResult.minRow;
      const maxRowBB = _cellRangeResult.maxRow;
      const r4 = i * 4;
      range[r4] = minCol;
      range[r4 + 1] = maxColBB;
      range[r4 + 2] = minRow;
      range[r4 + 3] = maxRowBB;
      state[i] = s | MV_IN_GRID;

      let wroteEntityPos = false;
      for (let row = minRow; row <= maxRowBB; row++) {
        if (rowOwnership[row] !== workerId) continue;

        if (!wroteEntityPos) {
          const baseIdx = i * 4;
          entityPosData[baseIdx] = posX;
          entityPosData[baseIdx + 1] = posY;
          entityPosData[baseIdx + 2] = maxHalfExtent;
          wroteEntityPos = true;
        }

        const rowBase = row * gridWidth;

        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];
          trueCount[cellIndex]++;

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
          }
        }
      }
    }

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;
      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
        gridCounts[byteOffset] = localCounts[cellIndex];
      }
    }
    this._noBodyCount = noBody;
    this._ownedEntityCount = ownedCount;
    this._mvLooseCount = looseCount;
    return ascending;
  }

  /**
   * E-126. The grid rewritten for the entities that changed since the state was latched, to the
   * bytes rebuildOwnedRows would write: each owned cell lists the entities that cover it in active-
   * list (ascending id) order, the first maxEntitiesPerCell of them, and keeps its bytes past the
   * count; the pose of an entity that covers an owned row; the owned list in active-list order.
   * The entities that changed: physics' list (bodies moved, teleported, created, destroyed or
   * reshaped), the active list's spawns and despawns (read when the query version or the count
   * moved), and the entities without a collider whose bin position, sprite or collider changed.
   * @param {number} movedCount entries of physics' list to read (0: it has not published since)
   * @param {number} seq the sequence readMovedBodiesHeader returned with that count
   * @param {number} limit more changed entities than this and the full rebuild is cheaper
   * @returns {boolean} false when the state is spent: the list copy was torn, the active list is not
   *   ascending, more changed than `limit`, a full cell loses an entity it holds (the one that takes
   *   its place is not known here), or the join list is full. The caller then rebuilds the grid,
   *   which may be half rewritten.
   */
  _rebuildMovedRows(movedCount, seq, limit) {
    const n = this.globalEntityCount;
    const state = this._mvState;
    const dirty = this._mvDirty;
    const dirtyIds = this._mvDirtyIds;
    let nd = 0;

    // 1. Physics' list.
    if (movedCount > 0) {
      const moved = this._mvMoved;
      if (!copyMovedBodies(moved, movedCount, seq)) return false;
      for (let k = 0; k < movedCount; k++) {
        const e = moved[k];
        if (e < 0 || e >= n || dirty[e] !== 0) continue;
        dirty[e] = 1;
        dirtyIds[nd++] = e;
      }
    }

    // 2. Spawns and despawns: the active list against the one the state was built from.
    const activeData = this.activeEntitiesData;
    const versionData = this.queryVersionData;
    const version = versionData ? Atomics.load(versionData, 0) : 0;
    const prev = this._mvActive;
    const curCount = activeData[0];
    if (!versionData || version !== this._mvVersion || curCount !== prev[0]) {
      const next = this._mvActiveNext;
      const prevCount = prev[0];
      let p = 1;
      let last = -1;
      for (let j = 1; j <= curCount; j++) {
        const b = activeData[j];
        if (b <= last || b >= n) return false;
        last = b;
        next[j] = b;
        while (p <= prevCount && prev[p] < b) {
          const a = prev[p++];
          state[a] &= ~MV_PRESENT;
          if (dirty[a] === 0) {
            dirty[a] = 1;
            dirtyIds[nd++] = a;
          }
        }
        if (p <= prevCount && prev[p] === b) {
          p++;
        } else {
          state[b] |= MV_PRESENT;
          if (dirty[b] === 0) {
            dirty[b] = 1;
            dirtyIds[nd++] = b;
          }
        }
      }
      while (p <= prevCount) {
        const a = prev[p++];
        state[a] &= ~MV_PRESENT;
        if (dirty[a] === 0) {
          dirty[a] = 1;
          dirtyIds[nd++] = a;
        }
      }
      next[0] = curCount;
      this._mvActive = next;
      this._mvActiveNext = prev;
      this._mvVersion = version;
    }

    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;

    // 3. Entities without a collider, which no physics list reports: where they would bin now.
    const loose = this._mvLoose;
    const loosePos = this._mvLoosePos;
    let looseCount = 0;
    const looseBefore = this._mvLooseCount;
    for (let k = 0; k < looseBefore; k++) {
      const e = loose[k];
      const s = state[e];
      if ((s & MV_LOOSE) === 0) continue;
      loose[looseCount++] = e;
      if (dirty[e] !== 0) continue;
      const px = x[e] + offsetX[e];
      const py = y[e] + offsetY[e];
      const lx = loosePos[e * 2];
      const ly = loosePos[e * 2 + 1];
      if (
        colliderActive[e] !== 0 ||
        (spriteRendererActive[e] !== 0) !== ((s & MV_SPRITE) !== 0) ||
        // Changed bits: two NaNs bin alike, 0 and -0 do not (the pose keeps the sign).
        (px !== lx ? px === px || lx === lx : px === 0 && 1 / px !== 1 / lx) ||
        (py !== ly ? py === py || ly === ly : py === 0 && 1 / py !== 1 / ly)
      ) {
        dirty[e] = 1;
        dirtyIds[nd++] = e;
      }
    }
    if (nd > limit) return false;

    // 4. Each changed entity binned again: its pose, its state, and the owned cells it leaves and joins.
    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;
    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;
    const rowOwnership = this.rowOwnership;
    const entityPosData = this.entityPosData;
    const range = this._mvRange;
    const leaves = this._mvLeaves;
    const mark = this._mvCellMark;
    const touched = this._mvTouched;
    let touchedCount = 0;
    const joinHead = this._mvJoinHead;
    const joinNext = this._mvJoinNext;
    const joinId = this._mvJoinId;
    const joinCap = joinId.length;
    let joinCount = 0;
    let ownedChanged = false;

    for (let d = 0; d < nd; d++) {
      const i = dirtyIds[d];
      const s = state[i];
      let ns = s & MV_PRESENT;
      const r4 = i * 4;
      const wasIn = (s & MV_IN_GRID) !== 0;
      const oMinCol = range[r4];
      const oMaxCol = range[r4 + 1];
      const oMinRow = range[r4 + 2];
      const oMaxRow = range[r4 + 3];
      let isIn = false;
      let minCol = 0;
      let maxColBB = -1;
      let minRow = 0;
      let maxRowBB = -1;

      if (ns !== 0) {
        // rebuildOwnedRows' bounds; without a collider the position is read once, for the bin and
        // for the latch step 3 compares with.
        let posX;
        let posY;
        let halfW = 0;
        let halfH = 0;
        let binned = true;
        if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
          posX = x[i] + (offsetX[i] || 0);
          posY = y[i] + (offsetY[i] || 0);
          halfW = radius[i] || 0;
          halfH = halfW;
        } else if (colliderActive[i]) {
          getColliderBounds(i, _boundsResult);
          posX = _boundsResult.posX;
          posY = _boundsResult.posY;
          halfW = _boundsResult.halfW;
          halfH = _boundsResult.halfH;
        } else {
          posX = x[i] + offsetX[i];
          posY = y[i] + offsetY[i];
          ns |= MV_LOOSE;
          loosePos[i * 2] = posX;
          loosePos[i * 2 + 1] = posY;
          if ((s & MV_LOOSE) === 0) loose[looseCount++] = i;
          if (spriteRendererActive[i]) ns |= MV_SPRITE;
          else binned = false;
        }
        if (binned) {
          if (posX === posX && posY === posY) {
            isIn = true;
            const maxHalfExtent = halfW > halfH ? halfW : halfH;
            let homeRow = (Math.fround(posY) * invCellSize) | 0;
            homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
            if (rowOwnership[homeRow] === workerId) ns |= MV_OWNED;
            getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);
            minCol = _cellRangeResult.minCol;
            maxColBB = _cellRangeResult.maxCol;
            minRow = _cellRangeResult.minRow;
            maxRowBB = _cellRangeResult.maxRow;
            for (let row = minRow; row <= maxRowBB; row++) {
              if (rowOwnership[row] !== workerId) continue;
              entityPosData[r4] = posX;
              entityPosData[r4 + 1] = posY;
              entityPosData[r4 + 2] = maxHalfExtent;
              break;
            }
          }
        }
      }

      // Owned cells it covered and no longer covers.
      if (wasIn) {
        for (let row = oMinRow; row <= oMaxRow; row++) {
          if (rowOwnership[row] !== workerId) continue;
          const rowStays = isIn && row >= minRow && row <= maxRowBB;
          const rowBase = row * gridWidth;
          for (let col = oMinCol; col <= oMaxCol; col++) {
            if (rowStays && col >= minCol && col <= maxColBB) continue;
            const cell = rowBase + col;
            leaves[cell]++;
            if (mark[cell] === 0) {
              mark[cell] = 1;
              touched[touchedCount++] = cell;
            }
          }
        }
      }
      // Owned cells it covers and did not cover: into each cell's joins, in ascending id order.
      if (isIn) {
        for (let row = minRow; row <= maxRowBB; row++) {
          if (rowOwnership[row] !== workerId) continue;
          const rowStayed = wasIn && row >= oMinRow && row <= oMaxRow;
          const rowBase = row * gridWidth;
          for (let col = minCol; col <= maxColBB; col++) {
            if (rowStayed && col >= oMinCol && col <= oMaxCol) continue;
            const cell = rowBase + col;
            if (joinCount === joinCap) return false;
            joinId[joinCount] = i;
            let before = -1;
            let at = joinHead[cell];
            while (at >= 0 && joinId[at] < i) {
              before = at;
              at = joinNext[at];
            }
            joinNext[joinCount] = at;
            if (before < 0) joinHead[cell] = joinCount;
            else joinNext[before] = joinCount;
            joinCount++;
            if (mark[cell] === 0) {
              mark[cell] = 1;
              touched[touchedCount++] = cell;
            }
          }
        }
        range[r4] = minCol;
        range[r4 + 1] = maxColBB;
        range[r4 + 2] = minRow;
        range[r4 + 3] = maxRowBB;
        ns |= MV_IN_GRID;
      }
      if (((s ^ ns) & MV_OWNED) !== 0) ownedChanged = true;
      state[i] = ns;
    }

    // 5. Each touched cell: what it holds minus the entities that left, merged with the ones that
    // joined, both ascending; the first maxEntitiesPerCell written, the bytes past them kept.
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellStride = Grid._cellIdStride;
    const cellHeader = Grid._headerIds;
    const cellByteSize = Grid.cellByteSize;
    const maxPerCell = Grid.maxEntitiesPerCell;
    const localCounts = this._localCellCounts;
    const trueCount = this._mvTrue;
    const scratch = this._mvCellScratch;
    for (let t = 0; t < touchedCount; t++) {
      const cell = touched[t];
      const byteOffset = cell * cellByteSize;
      const held = gridCounts[byteOffset];
      const total = trueCount[cell];
      const base = cell * cellStride + cellHeader;
      const row = (cell / gridWidth) | 0;
      const col = cell - row * gridWidth;
      let node = joinHead[cell];
      let joins = 0;
      let heldLeaves = 0;
      let merged = 0;
      for (let k = 0; k < held; k++) {
        const id = gridEntities[base + k];
        if (dirty[id] !== 0) {
          const r = id * 4;
          if (
            (state[id] & MV_IN_GRID) === 0 ||
            col < range[r] ||
            col > range[r + 1] ||
            row < range[r + 2] ||
            row > range[r + 3]
          ) {
            heldLeaves++;
            continue;
          }
        }
        while (node >= 0 && joinId[node] < id) {
          if (merged < maxPerCell) scratch[merged] = joinId[node];
          merged++;
          joins++;
          node = joinNext[node];
        }
        if (merged < maxPerCell) scratch[merged] = id;
        merged++;
      }
      while (node >= 0) {
        if (merged < maxPerCell) scratch[merged] = joinId[node];
        merged++;
        joins++;
        node = joinNext[node];
      }
      // Over the cap the cell holds the first maxEntitiesPerCell only: one of those leaving needs
      // the next one, which is not known here. Under it, every leave is an entity it holds.
      if (total > maxPerCell ? heldLeaves !== 0 : heldLeaves !== leaves[cell]) return false;
      const count = merged < maxPerCell ? merged : maxPerCell;
      for (let k = 0; k < count; k++) gridEntities[base + k] = scratch[k];
      gridCounts[byteOffset] = count;
      localCounts[cell] = count;
      trueCount[cell] = total - leaves[cell] + joins;
      leaves[cell] = 0;
      joinHead[cell] = -1;
      mark[cell] = 0;
    }

    // 6. The owned list, in active-list order, when an entity entered or left it.
    if (ownedChanged) {
      const snapshot = this._mvActive;
      const total = snapshot[0];
      const ownedList = this._ownedEntityList;
      let ownedCount = 0;
      for (let a = 1; a <= total; a++) {
        const e = snapshot[a];
        if ((state[e] & MV_OWNED) !== 0) ownedList[ownedCount++] = e;
      }
      this._ownedEntityCount = ownedCount;
    }

    for (let d = 0; d < nd; d++) dirty[dirtyIds[d]] = 0;
    this._mvLooseCount = looseCount;
    let noBody = 0;
    if (this.collectDetailedStats) {
      // rebuildOwnedRows' count: listed entities with a sprite, no collider and no rigid body.
      const rigidActive = RigidBody.active;
      for (let k = 0; k < looseCount; k++) {
        const e = loose[k];
        if ((state[e] & MV_LOOSE) !== 0 && spriteRendererActive[e] && !(rigidActive && rigidActive[e])) noBody++;
      }
    }
    this._noBodyCount = noBody;
    return true;
  }

  /**
   * STEP 2: Find neighbors for all entities owned by this worker
   *
   * - Walks the list rebuildOwnedRows made: entities whose center Y falls in a row
   *   owned by this worker, each once (no per-cell walk, no dedupe)
   * - Searches cells in visualRange (+ skin) radius (can read ANY cell) and writes neighbor data
   *
   * ENTITY OWNERSHIP: Each entity is owned by exactly ONE worker based on its
   * "home row" (the row containing its center Y position). This prevents race
   * conditions when entities span multiple rows due to their bounding box.
   */
  /**
   * Verlet-style reuse: A within skin of build position, same vr/extent,
   * and list age below cap (bounds B drift without cell-hash thrashing).
   * Cell-version dependency hash is unused (skin + age already gate reuse).
   */
  _canReuseNeighbors(entityId, myX, myY, myHalfExtent, myVisualRange) {
    if (this._entityReuseInitialized[entityId] !== 1) return false;
    if (this._neighborCandidateTruncated[entityId]) return false;
    if (this._entityLastHalfExtent[entityId] !== myHalfExtent) return false;
    if (this._entityLastVisualRange[entityId] !== myVisualRange) return false;
    // Cap list age so B cannot drift more than ~skin at scene max speed before rebuild.
    if (this._entityFramesSinceBuild[entityId] >= this._maxReuseFrames) return false;
    const skin = myVisualRange * this._neighborReuseSkin;
    const skinSq = skin * skin;
    const dx = myX - this._entityLastX[entityId];
    const dy = myY - this._entityLastY[entityId];
    return dx * dx + dy * dy <= skinSq;
  }

  _storeNeighborReuseSignature(entityId, myX, myY, myHalfExtent, myVisualRange) {
    this._entityReuseInitialized[entityId] = 1;
    this._entityLastX[entityId] = myX;
    this._entityLastY[entityId] = myY;
    this._entityLastHalfExtent[entityId] = myHalfExtent;
    this._entityLastVisualRange[entityId] = myVisualRange;
    this._entityFramesSinceBuild[entityId] = 0;
  }

  /**
   * Filter expanded candidate list into published neighborData at exact visualRange.
   * @returns {number} published count
   */
  _publishFilteredNeighbors(entityA, myX, myY, myVisualRange, neighborOffset, maxNeighbors, entityPosData, neighborData) {
    if (this._wasmPub) {
      this._wasmPub.range[entityA] = myVisualRange;
      this._wasmPub.list[this._wasmPub.queued++] = entityA;
      return 0;
    }
    const candStride = 1 + maxNeighbors;
    const candBase = entityA * candStride;
    const cand = this._neighborCandidateData;
    const candCount = cand[candBase];
    let published = 0;
    for (let i = 0; i < candCount; i++) {
      const entityB = cand[candBase + 1 + i];
      const baseIdxB = entityB * 4;
      const bX = entityPosData[baseIdxB];
      const bY = entityPosData[baseIdxB + 1];
      const bHalfExtent = entityPosData[baseIdxB + 2];
      const dx = bX - myX;
      const dy = bY - myY;
      const effectiveRange = myVisualRange + bHalfExtent;
      if (dx * dx + dy * dy < effectiveRange * effectiveRange) {
        if (published < maxNeighbors) {
          neighborData[neighborOffset + 1 + published] = entityB;
          published++;
          this.neighborsFoundThisFrame++;
        }
      }
    }
    neighborData[neighborOffset] = published;
    return published;
  }

  findNeighborsForOwnedEntities() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const cellStride = Grid._cellIdStride;
    const cellHeader = Grid._headerIds;
    const workerId = this.workerId;
    const skinFrac = this._neighborReuseSkin;
    const tickInterval = this._neighborTickInterval;
    const nextTick = this._entityNeighborNextTick;
    const maxReuseFrames = this._maxReuseFrames;
    const framesSinceBuild = this._entityFramesSinceBuild;
    const candStride = 1 + maxNeighbors;
    const candData = this._neighborCandidateData;
    const candCountOf = this._candidateCountOf;

    const neighborData = Grid.neighborData;
    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const processedMarker = this.processedMarker;
    this._processedFrameCounter++;
    if (this._processedFrameCounter > SPATIAL_STAMP_FRAME_MASK) {
      this._processedFrameCounter = 1;
      processedMarker.fill(0);
    }
    const stampFrame = this._processedFrameCounter;

    const maxRow = gridHeight - 1;

    // Built by rebuildOwnedRows this frame: each entity once, home row owned here.
    const ownedList = this._ownedEntityList;
    const ownedCount = this._ownedEntityCount;
    for (let oi = 0; oi < ownedCount; oi++) {
      const entityA = ownedList[oi];
      if (!active[entityA]) continue;

      const baseIdxA = entityA * 4;
      const myX = entityPosData[baseIdxA];
      const myY = entityPosData[baseIdxA + 1];
      const myHalfExtent = entityPosData[baseIdxA + 2];

      let homeRow = (myY * invCellSize) | 0;
      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

      this.entitiesProcessedThisFrame++;

      const stampedA = packSpatialPairStamp(stampFrame, entityA);
      const myVisualRange = visualRange[entityA];
      const neighborOffset = entityA * stride;

      if (myVisualRange <= 0) {
        neighborData[neighborOffset] = 0;
        continue;
      }

      const skin = myVisualRange * skinFrac;
      const searchRange = myVisualRange + 2 * skin;

      let homeCol = (myX * invCellSize) | 0;
      const maxCol = gridWidth - 1;
      homeCol = homeCol < 0 ? 0 : homeCol > maxCol ? maxCol : homeCol;
      const entityCellIndex = homeRow * gridWidth + homeCol;
      const cellRadius = ((searchRange * invCellSize) | 0) + 1;

      // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame
      let scheduleSkipRebuild = false;
      if (tickInterval > 1) {
        if (--nextTick[entityA] > 0) {
          scheduleSkipRebuild = true;
        } else {
          nextTick[entityA] = tickInterval;
        }
      }

      // True tickInterval: off-tick keeps last neighborData (no cell-walk, no re-filter).
      // Logic already decimates AI; stale neighbors for N frames is the point.
      if (
        scheduleSkipRebuild &&
        candCountOf[entityA] > 0 &&
        framesSinceBuild[entityA] < maxReuseFrames
      ) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        continue;
      }

      // Verlet skin reuse: re-filter expanded candidates into published set
      const skinCanReuse =
        skinFrac > 0 &&
        this._canReuseNeighbors(
          entityA,
          myX,
          myY,
          myHalfExtent,
          myVisualRange
        );

      if (skinCanReuse) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        this._publishFilteredNeighbors(
          entityA,
          myX,
          myY,
          myVisualRange,
          neighborOffset,
          maxNeighbors,
          entityPosData,
          neighborData
        );
      } else {
        const neighborCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
        const neighborCellsLength = neighborCells.length;

        // Miss: rebuild expanded candidate list at searchRange
        const candBase = entityA * candStride;
        let candCount = 0;
        let truncated = false;
        const searchRangeWithExtentBase = searchRange;

        for (let i = 0; i < neighborCellsLength; i++) {
          const checkCellIndex = neighborCells[i];
          const checkByteOffset = checkCellIndex * Grid.cellByteSize;
          const checkCellCount = gridCounts[checkByteOffset];
          if (checkCellCount === 0) continue;

          this.cellsCheckedThisFrame++;
          const checkEntityBase = checkCellIndex * cellStride + cellHeader;

          for (let j = 0; j < checkCellCount; j++) {
            const entityB = gridEntities[checkEntityBase + j];
            if (entityA === entityB) continue;
            if (processedMarker[entityB] === stampedA) continue;
            processedMarker[entityB] = stampedA;

            const baseIdxB = entityB * 4;
            const bX = entityPosData[baseIdxB];
            const bY = entityPosData[baseIdxB + 1];
            const bHalfExtent = entityPosData[baseIdxB + 2];
            const dxAB = bX - myX;
            const dyAB = bY - myY;
            const effectiveRange = searchRangeWithExtentBase + bHalfExtent;
            if (dxAB * dxAB + dyAB * dyAB < effectiveRange * effectiveRange) {
              if (candCount < maxNeighbors) {
                candData[candBase + 1 + candCount] = entityB;
                candCount++;
              } else {
                truncated = true;
                break;
              }
            }
          }
          if (truncated) break;
        }

        candData[candBase] = candCount;
        candCountOf[entityA] = candCount;
        this._neighborCandidateTruncated[entityA] = truncated ? 1 : 0;

        this._publishFilteredNeighbors(
          entityA,
          myX,
          myY,
          myVisualRange,
          neighborOffset,
          maxNeighbors,
          entityPosData,
          neighborData
        );

        if (!truncated) {
          this._storeNeighborReuseSignature(entityA, myX, myY, myHalfExtent, myVisualRange);
        } else {
          // Skin reuse stays off (incomplete list), but schedule stagger needs age reset
          this._entityReuseInitialized[entityA] = 0;
          framesSinceBuild[entityA] = 0;
        }
      }
    }
    this._flushWasmPublish();
  }

  /**
   * findNeighborsForOwnedEntities with the candidate gather in WASM (E-78). The per-entity
   * decisions (stagger, skin reuse) stay here; every list to rebuild goes to one gather_batch call
   * (wasm/spatialGather.c: the JS arithmetic in double, this worker's circle patterns in order);
   * then the bookkeeping, then the publish. Taken when the publish memory has the gather's regions
   * and wasm.spatialGather is on. It publishes exactly what the JS gather publishes
   * (tests/node/spatialGatherWasm.test.js).
   */
  _findNeighborsWasmGather() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const skinFrac = this._neighborReuseSkin;
    const tickInterval = this._neighborTickInterval;
    const nextTick = this._entityNeighborNextTick;
    const maxReuseFrames = this._maxReuseFrames;
    const framesSinceBuild = this._entityFramesSinceBuild;
    const candCountOf = this._candidateCountOf;
    const neighborData = Grid.neighborData;
    const entityPosData = this.entityPosData;
    const pub = this._wasmPub;
    const g = this._wasmGather;
    const rebuild = g.rebuild;

    this._processedFrameCounter++;
    if (this._processedFrameCounter > SPATIAL_STAMP_FRAME_MASK) {
      this._processedFrameCounter = 1;
      this.processedMarker.fill(0);
    }
    const stampFrame = this._processedFrameCounter;

    let rebuilds = 0;
    const ownedList = this._ownedEntityList;
    const ownedCount = this._ownedEntityCount;
    for (let oi = 0; oi < ownedCount; oi++) {
      const entityA = ownedList[oi];
      if (!active[entityA]) continue;

      const baseIdxA = entityA * 4;
      const myX = entityPosData[baseIdxA];
      const myY = entityPosData[baseIdxA + 1];
      const myHalfExtent = entityPosData[baseIdxA + 2];

      this.entitiesProcessedThisFrame++;

      const myVisualRange = visualRange[entityA];
      if (myVisualRange <= 0) {
        neighborData[entityA * stride] = 0;
        continue;
      }

      // Schedule stagger, as in findNeighborsForOwnedEntities.
      let scheduleSkipRebuild = false;
      if (tickInterval > 1) {
        if (--nextTick[entityA] > 0) {
          scheduleSkipRebuild = true;
        } else {
          nextTick[entityA] = tickInterval;
        }
      }
      if (
        scheduleSkipRebuild &&
        candCountOf[entityA] > 0 &&
        framesSinceBuild[entityA] < maxReuseFrames
      ) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        continue;
      }

      // The publish and the gather both read the range from the memory.
      pub.range[entityA] = myVisualRange;
      if (skinFrac > 0 && this._canReuseNeighbors(entityA, myX, myY, myHalfExtent, myVisualRange)) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        pub.list[pub.queued++] = entityA;
      } else {
        rebuild[rebuilds++] = entityA;
      }
    }

    if (rebuilds) {
      const meta = this._wasmMeta;
      // The same results in any order; in cell order the cells each entity walks are still in cache.
      if (this._gatherCellOrder && g.order) {
        g.order(rebuilds, g.rebuildByte, meta.posByte, this.invCellSize, this.gridWidth, this.gridHeight, g.orderByte);
      }
      this.cellsCheckedThisFrame += g.gather(
        rebuilds,
        g.rebuildByte,
        meta.posByte,
        meta.rangeByte,
        meta.candByte,
        maxNeighbors,
        meta.gridByte,
        Grid.cellByteSize,
        Grid._cellIdStride,
        Grid._headerIds,
        this.gridWidth,
        this.gridHeight,
        this.invCellSize,
        skinFrac,
        this._maxCellRadius,
        g.patternByte,
        g.patternIndexByte,
        g.markerByte,
        stampFrame,
        g.truncatedByte,
      );
      const cand = pub.cand;
      const truncatedOf = this._neighborCandidateTruncated;
      for (let k = 0; k < rebuilds; k++) {
        const entityA = rebuild[k];
        candCountOf[entityA] = cand[entityA * stride];
        pub.list[pub.queued++] = entityA;
        if (!truncatedOf[entityA]) {
          const b = entityA * 4;
          this._storeNeighborReuseSignature(entityA, entityPosData[b], entityPosData[b + 1], entityPosData[b + 2], visualRange[entityA]);
        } else {
          // Skin reuse stays off (incomplete list), but schedule stagger needs age reset
          this._entityReuseInitialized[entityA] = 0;
          framesSinceBuild[entityA] = 0;
        }
      }
    }
    this._flushWasmPublish();
  }

  /** The WASM publish of every entity queued this frame (both gathers end here). */
  _flushWasmPublish() {
    if (this._wasmPub && this._wasmPub.queued) {
      const n = this._wasmPub.queued;
      this._wasmPub.queued = 0;
      const meta = this._wasmMeta;
      this._wasmPub.publish(
        n,
        Grid.maxNeighbors,
        meta.posByte,
        meta.rangeByte,
        meta.candByte,
        meta.neighborByte,
        this._wasmPub.listByte,
      );
      // E-02. This recount is a SECOND full pass over the neighbor array after
      // the WASM publish, and it exists only to fill `neighborsFoundThisFrame`.
      // The WASM kernel returns nothing (it could: scripts/buildWasm.mjs builds it
      // since E-76), so the count is read back here instead.
      //
      // The read-back is not free and not local: `stride` is `1 + maxNeighbors`
      // (2050 bytes at Predator's 1024), so n rows touch n * 2 KB of address
      // space to read one uint16 from each - the same ~34 MB working set the
      // publish itself just walked.
      //
      // It is gated for the same reason the rest of this report is gated: the
      // only consumer is `SPATIAL_STATS.NEIGHBOR_CHECKS`, which is a
      // `collectDetailedStats` stat. HOW_WE_MEASURE requires detailed stats OFF
      // for the pair that writes a verdict ("Sub-timers inflate the step, and a
      // 3 percent gap on that inflation is not the product"), so on every run
      // that can decide anything this loop was computing a number nobody could
      // read. The JS fallback path above still increments the counter inline and
      // is unconditional - it costs nothing extra to keep it correct there.
      if (this.collectDetailedStats) {
        // neighbor-recount-start
        const stride = 1 + Grid.maxNeighbors;
        let found = 0;
        const neighborData = Grid.neighborData;
        const list = this._wasmPub.list;
        for (let i = 0; i < n; i++) found += neighborData[list[i] * stride];
        // neighbor-recount-end
        this.neighborsFoundThisFrame += found;
      }
    }
  }

  /**
   * Report FPS and stats to SharedArrayBuffer
   */
  reportFPS() {
    if (!this.stats) return;
    this._writeFrameMeters(SPATIAL_STATS);
    this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
    this.stats[SPATIAL_STATS.GRID_MOVERS] = this._gridMoversThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[SPATIAL_STATS.NEIGHBOR_CHECKS] = this.neighborsFoundThisFrame;
    this.stats[SPATIAL_STATS.GRID_CELLS_CHECKED] = this.cellsCheckedThisFrame;
    this.stats[SPATIAL_STATS.REBUILD_MS] = this.rebuildTimeThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBOR_MS] = this.neighborSearchTimeThisFrame;
    this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS] = this.sleepNeighborSkipsThisFrame;
    this.stats[SPATIAL_STATS.NO_BODY_COUNT] = this._noBodyCount || 0;
  }
}

// Create singleton instance
const spatialWorker = new SpatialWorker(self);
self.spatialWorker = spatialWorker;
