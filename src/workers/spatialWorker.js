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
import { LightEmitter as LightEmitterImport } from '../components/lightEmitter.js';
import { AbstractWorker } from './abstractWorker.js';
import { Grid as GridImport } from '../core/grid.js';
import {
  SPATIAL_STATS,
  createMultiWorkerStatsWriter,
  getEntityHomeCellIndex,
} from '../util/workersUtils.js';
import { generateSymmetricalCirclePattern } from '../util/utils.js';
import { SPATIAL_DEFAULTS } from '../util/configDefaults.js';
import { EntityIdArray, SPATIAL_STAMP_FRAME_MASK } from '../util/entityIdWidth.js';
import { bindSpatialGather, bindSpatialPublish } from './spatialPublishClient.js';
import { SPATIAL_MAX_CELL_RADIUS } from '../util/spatialPublishMemory.js';
import { getColliderBounds as getColliderBoundsImport, getCellRange as getCellRangeImport, _boundsResult as _boundsResultImport, _cellRangeResult as _cellRangeResultImport, SHAPE_CIRCLE as SHAPE_CIRCLEImport, SHAPE_BOX as SHAPE_BOXImport } from '../util/colliderUtils.js';
import { readMovedBodiesHeader, copyMovedBodies } from '../box2d/box2dMovedBodies.js';
import { tickBucketPhase } from '../util/logicOwner.js';
import { addWaitMs } from '../util/waitMeter.js';
import { HEADER_BYTES, LOGIC_SLOT0, MAX_LOGIC, SLOT_BYTES, TIME_ORIGIN } from '../util/frameClock.js';

// Hot code reads these as module consts, not imports. TurboFan folds a module
// const (and the typed arrays its class holds); an import is a cell it reads
// at run time. See HOW_WE_MEASURE, "Imports in hot code".
const Transform = TransformImport;
const RigidBody = RigidBodyImport;
const Collider = ColliderImport;
const SpriteRenderer = SpriteRendererImport;
const LightEmitter = LightEmitterImport;
const Grid = GridImport;
const getColliderBounds = getColliderBoundsImport;
const getCellRange = getCellRangeImport;
const _boundsResult = _boundsResultImport;
const _cellRangeResult = _cellRangeResultImport;
const SHAPE_CIRCLE = SHAPE_CIRCLEImport;
const SHAPE_BOX = SHAPE_BOXImport;

// E-126 (grid movers only). In a frame where physics moved at most this share of the active
// entities, the grid is rewritten for the entities that changed (_rebuildMovedRows) instead of
// rebuilt for all of them (rebuildOwnedRows). Under the crossover of tests/bench/spatialGridMoversMicrobench.mjs
// (60 000 bodies, Node, 2026-10-24): against the full rebuild the path is +188.6 % at 10 % movers, +17.5 % at
// 20 %, -10.1 % at 25 % and -34.9 % at 35 % (the old path's 0.35), so the crossover is near 23 %.
// E-503: that crossover is one mix's (circles, a cell each). Where the full rebuild costs more an entity (the barrio's
// 4 400 house polygons, their vertices walked and several cells each, while the people that move are circles) the
// rewrite wins further: Buenos Aires moves 21.7 % and its spatial took 3.4 ms with the rebuild, 2.2 with the rewrite.
// So AUTO times both paths and moves the limit to where they tie (_moversLimit), between MOVERS_MIN_FRACTION and
// MOVERS_CAP_FRACTION; this fraction is the limit until both have been timed.
const MOVERS_MAX_FRACTION = 0.2;
const MOVERS_MIN_FRACTION = 0.05;
const MOVERS_CAP_FRACTION = 0.5;
// E-503: in a run of rewrites, one full rebuild timed after this many, times the ratio of a rebuild's cost to a rewrite
// frame's up to MOVERS_RETIME_STRETCH (the further apart the costs, the rarer: the scene may have changed what a
// rebuild costs, and the first rebuilds may have been timed while the page loaded); while rebuilding, a probe this
// often when the moved count is under the cap: a latch and MOVERS_PROBE_LENGTH frames of rewrites, timed, whatever the
// limit says.
const MOVERS_RETIME_FRAMES = 256;
const MOVERS_RETIME_STRETCH = 32;
const MOVERS_PROBE_FRAMES = 512;
const MOVERS_PROBE_LENGTH = 16;
// E-503: a probe the rewrite lost doubles the gap to the next, up to this many times MOVERS_PROBE_FRAMES; one it won
// resets it.
const MOVERS_PROBE_STRETCH = 16;
// E-503: entering the rewrite takes a moved count under this share of the limit, staying in it under the limit: a
// count that hovers at the tie does not pay a latch (about 2.5 rebuilds) each time it crosses.
const MOVERS_ENTRY_SHARE = 0.8;
// E-503: what a grid step did (_stepGrid), so _rebuildGrid knows which path its time was.
const GRID_STEP_FULL = 1; // the full rebuild alone
const GRID_STEP_REWRITE = 2; // a rewrite that held
const GRID_STEP_GAVE_UP = 3; // a rewrite given up, and the rebuild or latch after it: the rewrite's cost too
const GRID_STEP_LATCH = 4; // a latch from the rebuild (the limit, a probe): an entry, not a cost per moved body
// SpatialWorker._gridMoversMode.
const GRID_MOVERS_AUTO = 0; // by the moved count against the limit where the two paths' timed costs tie
const GRID_MOVERS_OFF = 1; // the full rebuild every frame
const GRID_MOVERS_FIXED = 3; // by the moved fraction alone (MOVERS_MAX_FRACTION): tests, whose path must not hang on a clock
// E-266: _rebuildMovedRows' movedCount with no physics list: it compares every collider's bounds with the latch.
const MOVED_SCAN = -2;
const GRID_MOVERS_FORCE = 2; // the movers path whenever its state allows (kernels, tests)
// SpatialWorker._mvState bits: each entity as the grid holds it.
const MV_PRESENT = 1; // in the active list the state was built from
const MV_IN_GRID = 2; // binned, with the cell range in _mvRange
const MV_OWNED = 4; // home row owned here: in _ownedEntityList
const MV_LOOSE = 8; // no collider, so no physics list reports it: compared every frame
const MV_SPRITE = 16; // a loose entity's SpriteRenderer.active when it was binned
// E-200: a typed list comes this many logic frames before its tick. Logic publishes the frame it ticks as it
// starts, before or after this worker reads it on the same vsync; two frames ahead is before the tick either way.
const TYPED_NEIGHBOR_LEAD = 2;
// E-274: _writtenCounts before a cell's first write (a count is a byte).
const COUNT_UNWRITTEN = 0xffff;
// E-136. The pose generation moves by 2, so it is always even: a row marked with this was cleared and
// is published again.
const POSE_GEN_NONE = 1;
// E-328 (spatial.startOn 'logicDone'): a frame waits for logic's frame of this vsync, ending its wait at the latest this
// long before the next vsync less this worker's own step, and waiting at most this share of the frame.
const LOGIC_WAIT_MARGIN_MS = 1;
const LOGIC_WAIT_MAX_SHARE = 0.75;
// A shorter budget is no wait: the frame starts on the vsync.
const LOGIC_WAIT_MIN_MS = 1;
// Waits that run out in a row before the waits go off, and the frames they stay off.
const LOGIC_WAIT_MISSES = 4;
const LOGIC_WAIT_OFF_FRAMES = 120;
// A logic step that began this long before this vsync's estimated start is still this vsync's (the workers' animation
// frames fire within about 0.2 ms of each other).
const LOGIC_WAIT_SLACK_MS = 1;
const FRAME_MS_60 = 1000 / 60;
// E-476 (spatial.neighborRefreshSpread): which of its period's P / T ticks a typed slot's list comes before.
const REFRESH_SPREAD_NONE = 0; // the first: a class refreshes on T frames of every P
const REFRESH_SPREAD_ID_BLOCKS = 1; // tick k for the k-th of P / T contiguous blocks of the class's slots
const REFRESH_SPREADS = Object.freeze({
  none: REFRESH_SPREAD_NONE,
  idBlocks: REFRESH_SPREAD_ID_BLOCKS,
});

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
    // Top 12 bits = frame counter, low 20 bits = entityA (packSpatialPairStamp). Avoids fill() every frame.
    this.processedMarker = null; // Int32Array
    this._processedFrameCounter = 0;
    // E-268: per entity, the frame (mod 254) this worker last kept its row clear; see _findNeighbors.
    this._clearHeld = new Uint8Array(0);
    this._clearHeldFrame = 1;
    // E-274: per cell, the count this worker last wrote into the shared grid (COUNT_UNWRITTEN before its first rebuild).
    this._writtenCounts = new Uint16Array(0);
    // Local cell counts for race-free grid rebuilding
    // We build counts locally, then copy to grid at the end (avoids mid-clear races)
    this._localCellCounts = null; // Uint8Array(totalCells)
    this._entityLastX = null;
    this._entityLastY = null;
    this._entityLastHalfExtent = null;
    this._entityLastVisualRange = null;
    // E-264: an empty array of its class, not null: _canReuseNeighbors indexes it per entity through `this`, and a field
    // declared null is typed any value (E-71: 15 % of the emit kernel where per-entity code read one).
    this._entityReuseInitialized = new Uint8Array(0);

    // Visual ranges up to ~1500 px at cellSize 128; the WASM gather's pattern table is sized by it.
    this._maxCellRadius = SPATIAL_MAX_CELL_RADIUS;
    // Precomputed circle patterns: cellRadius -> Int32Array of [dr, dc, dr, dc, ...]
    this._circlePatterns = new Array(this._maxCellRadius + 1);
    // Pattern lengths cache: cellRadius -> length (number of cell pairs)
    this._patternLengths = new Uint16Array(this._maxCellRadius + 1);

    // The WASM candidate gather (E-78), bound in initialize when the publish memory has its regions.
    this._wasmGather = null;

    // Performance stats
    this.entitiesProcessedThisFrame = 0;
    this.neighborsFoundThisFrame = 0;
    this.cellsCheckedThisFrame = 0;
    this.rebuildTimeThisFrame = 0;
    this.neighborSearchTimeThisFrame = 0;
    this.neighborsReusedThisFrame = 0;
    this.neighborsRebuiltThisFrame = 0;
    this.neighborsPublishedThisFrame = 0;
    this.sleepNeighborSkipsThisFrame = 0;

    /** Fraction of visualRange (0 = off). */
    this._neighborReuseSkin = 0;
    /**
     * Raycasted lighting: lights take neighbour lists (its occluder gather reads them). In basic lighting nothing reads
     * a light's list, so a light takes one only when its class reads its neighbours (N-153).
     */
    this._raycastLights = false;
    /** Full candidate rebuild every N frames (1 = every frame). */
    this._neighborTickInterval = 1;
    // spatial.gatherCellOrder: the WASM gather walks its batch in home-cell order.
    this._gatherCellOrder = false;
    /** Countdown to next full rebuild when neighborTickInterval > 1. */
    this._entityNeighborNextTick = null;
    /**
     * E-200: per slot, 1 + the index of its class in the typed stagger (0: the stagger above). A typed list comes
     * on the logic frames f with f % period === its offset.
     */
    this._typedNeighborClass = new Uint8Array(0);
    /** E-200: per slot, its refresh frame within its class's period. */
    this._typedNeighborOffset = new Uint16Array(0);
    /** E-200: per class (from 1), its refresh period in logic frames. */
    this._typedNeighborPeriods = new Int32Array(1);
    /** E-200: per class (from 1), logic's frame modulo its period, for this search. */
    this._typedNeighborNow = new Int32Array(1);
    /** E-200: index of logic 0's frame number in frameRateData (-1: no typed stagger). */
    this._logicFrameSlot = -1;
    /** E-200: logic's frame at this worker's last search (-1: none yet). */
    this._lastLogicFrame = -1;
    /** E-476: spatial.neighborRefreshSpread (REFRESH_SPREAD_*). */
    this._neighborRefreshSpread = REFRESH_SPREAD_NONE;
    /**
     * E-476: the frames a list the stagger skips may stand: neighborReuseMaxFrames, or with a spread that plus the
     * longest refresh period, so a list past the reuse cap waits for its own refresh frame (_setupScheduleReuseCap).
     */
    this._scheduleReuseCap = 0;
    /** Per-entity expanded candidate lists: [count, id0, ...] stride = 1+maxNeighbors */
    this._neighborCandidateData = null;
    /** Dense copy of each list's count: the stagger skip reads this, not the head of a 1+maxNeighbors row. */
    this._candidateCountOf = null;
    /** Entities whose home row is this worker's, listed by rebuildOwnedRows for findNeighbors. */
    this._ownedEntityList = null;
    this._ownedEntityCount = 0;
    /** Sprites without a collider or a body this frame (detailed stats), counted by the grid passes. */
    this._noBodyCount = 0;
    this._neighborCandidateTruncated = null;
    this._entityFramesSinceBuild = null;

    // E-136: a kept row comes out of the publish as it went in when no pose changed since its last
    // publish (the publish reads only the poses, the range and the list), so it is left as it is.
    /**
     * The pose generation, in the publish memory's sync region: every spatial worker adds 2 to it after
     * a frame in which a pose it wrote changed.
     */
    this._poseGen = new Int32Array(0);
    /** false without a sync region (a hand-made layout): the generation is this worker's and moves every frame. */
    this._poseGenShared = false;
    /** The generation each row was last published at (POSE_GEN_NONE once its row was cleared). */
    this._rowPoseGen = new Int32Array(0);
    /** A pose this worker wrote this frame was not the one already there. */
    this._poseChanged = false;

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
    // E-503: the two paths' costs, timed in AUTO (moving averages; NaN until the first sample).
    /** ms of a full rebuild (rebuildOwnedRows). */
    this._mvFullMs = NaN;
    /**
     * ms of a frame on the rewrite's path (a rewrite, a latch, a rewrite given up and the rebuild after it) per body
     * physics listed as moved, and of such a frame.
     */
    this._mvPerMovedMs = NaN;
    this._mvMoversFrameMs = NaN;
    /** Physics' moved count this frame (_stepGrid), and its moving average (NaN until the first frame). */
    this._mvCount = 0;
    this._mvCountAvg = NaN;
    /** The last rewrite gave up: the latch that follows is the rewrite's cost, not an entry's. */
    this._mvAfterGiveUp = false;
    /** Rewrites since the last timed full rebuild; frames of full rebuilds left before the next probe. */
    this._mvRewrites = 0;
    this._mvProbeIn = MOVERS_PROBE_FRAMES;
    /** MOVERS_RETIME_FRAMES and MOVERS_PROBE_FRAMES (tests shorten them, to run every transition). */
    this._mvRetimeEvery = MOVERS_RETIME_FRAMES;
    this._mvProbeEvery = MOVERS_PROBE_FRAMES;
    /** The next frame rebuilds in full, timed; frames a probe has left on the rewrite's path (its limit is the cap). */
    this._mvRetimeFull = false;
    this._mvProbeLeft = 0;
    /** The run of rewrites a probe started, not yet judged; the gap before the next probe (MOVERS_PROBE_STRETCH). */
    this._mvFromProbe = false;
    this._mvProbeGap = MOVERS_PROBE_FRAMES;
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
    this._mvBounds = new Float64Array(0);
    this._mvLeaves = new Int32Array(0);
    this._mvCellMark = new Uint8Array(0);
    this._mvTouched = new Int32Array(0);
    /** Entities joining each cell this frame, ascending: a list per cell through _mvJoinNext. */
    this._mvJoinHead = new Int32Array(0);
    this._mvJoinNext = new Int32Array(0);
    this._mvJoinId = new Int32Array(0);
    this._mvCellScratch = new Int32Array(0);

    // E-328 (spatial.startOn): the frame starts when logic's frame of this vsync has ended, not on the vsync.
    /** This worker's frames wait for logic's ('logicDone'; _setupStartOn). */
    this._startOnLogicDone = false;
    /** The logic workers whose frames it waits for. */
    this._logicWorkers = 0;
    /** Moving averages, NaN until the first sample: the vsync period, and this worker's own step (its wait left out). */
    this._logicWaitPeriodMs = NaN;
    this._logicWaitOwnMs = NaN;
    /** This frame's start (performance.now(); NaN before the first frame) and its wait for logic, ms. */
    this._logicWaitLastStart = NaN;
    this._logicWaitMs = -0;
    /** Waits that ran out in a row, and the frame number from which the waits are on again. */
    this._logicWaitMisses = 0;
    this._logicWaitOffUntil = 0;
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
    // Initialize duplicate detection marker for neighbors (entityB): 12 frame bits over 20 id bits.
    // Int32Array, as packSpatialPairStamp is an int32: from stamp frame 2048 its top bit is set,
    // and a Uint32Array element read back as unsigned never equalled it, so the dedup failed for
    // half of every frame cycle and candidates in several cells were appended once per cell.
    this.processedMarker = new Int32Array(this.globalEntityCount);
    this._clearHeld = new Uint8Array(this.globalEntityCount);

    // Initialize local cell counts array for race-free grid rebuilding
    this._localCellCounts = new Uint8Array(this.totalCells);
    this._writtenCounts = new Uint16Array(this.totalCells).fill(COUNT_UNWRITTEN);
    this._entityLastX = new Float32Array(this.globalEntityCount);
    this._entityLastY = new Float32Array(this.globalEntityCount);
    this._entityLastHalfExtent = new Float32Array(this.globalEntityCount);
    this._entityLastVisualRange = new Float32Array(this.globalEntityCount);
    this._entityReuseInitialized = new Uint8Array(this.globalEntityCount);

    const spatialCfg = this.config?.spatial || {};
    this._raycastLights = this.config?.lighting?.enabled === true && this.config?.lighting?.walls === true;
    this._neighborReuseSkin = Number(spatialCfg.neighborReuseSkin) > 0 ? Number(spatialCfg.neighborReuseSkin) : 0;
    // Max frames to keep a candidate list (bounds B drift). Override via spatial.neighborReuseMaxFrames.
    const maxFrames = Number(spatialCfg.neighborReuseMaxFrames);
    this._maxReuseFrames = maxFrames > 0 ? maxFrames | 0 : this._neighborReuseSkin > 0 ? 15 : 0;
    const tickInterval = Number(spatialCfg.neighborTickInterval);
    this._neighborTickInterval = tickInterval > 1 ? tickInterval | 0 : 1;
    this._gatherCellOrder = spatialCfg.gatherCellOrder !== false;
    this._setupStartOn();
    const spread = spatialCfg.neighborRefreshSpread;
    if (spread !== undefined && !Object.hasOwn(REFRESH_SPREADS, spread) && this.workerId === 0) {
      console.warn(
        `WeedJS: spatial.neighborRefreshSpread ${JSON.stringify(spread)} is not 'none' or 'idBlocks'; the lists are not spread.`,
      );
    }
    this._neighborRefreshSpread = Object.hasOwn(REFRESH_SPREADS, spread) ? REFRESH_SPREADS[spread] : REFRESH_SPREAD_NONE;
    if (this._neighborTickInterval > 1) {
      const nextTick = new Uint8Array(this.globalEntityCount);
      const interval = this._neighborTickInterval;
      for (let i = 0; i < this.globalEntityCount; i++) {
        nextTick[i] = (i % interval) + 1;
      }
      this._entityNeighborNextTick = nextTick;
      this._setupTypedNeighborStagger(data);
    } else {
      this._entityNeighborNextTick = null;
    }
    this._setupScheduleReuseCap();
    // E-76: the publish (and, below, E-78's gather) in WASM on the spatial publish memory, the worker's only search.
    if (!data.spatialPublishMemory || !data.gridMetadata?.candByte || !data.gridMetadata?.patternByte) {
      throw new Error('spatial worker without the spatial publish memory and its gather regions (createSpatialPublishMemory)');
    }
    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius): the gather's table.
    this._precomputeCirclePatterns();

    // E-78: the candidate gather in WASM, on the publish memory's grid, markers, flags and lists, bound with the
    // publish (SST-2: neither needs the other). Its marker and flags are the ones the worker reads (the fill on stamp
    // wrap, _canReuseNeighbors).
    const [wasmPub, wasmGather] = await Promise.all([
      bindSpatialPublish(
        data.spatialPublishMemory,
        data.gridMetadata,
        this.workerId | 0,
        this.globalEntityCount,
        Grid.maxNeighbors,
      ),
      bindSpatialGather(
        data.spatialPublishMemory,
        data.gridMetadata,
        this.workerId | 0,
        this.globalEntityCount,
        this._circlePatterns,
        this._maxCellRadius,
      ),
    ]);
    this._wasmPub = wasmPub;
    this._wasmMeta = data.gridMetadata;
    this._neighborCandidateData = this._wasmPub.cand;
    this._candidateCountOf = new (EntityIdArray())(this.globalEntityCount);
    this._ownedEntityList = new (EntityIdArray())(this.globalEntityCount);
    this._ownedEntityCount = 0;
    this._neighborCandidateTruncated = new Uint8Array(this.globalEntityCount);
    this._entityFramesSinceBuild = new Uint16Array(this.globalEntityCount);
    this._noBodyCount = 0;
    const syncByte = data.gridMetadata.syncByte | 0;
    this._poseGenShared = syncByte > 0;
    this._poseGen = this._poseGenShared
      ? new Int32Array(data.spatialPublishMemory.buffer, syncByte, 1)
      : new Int32Array(new SharedArrayBuffer(4));
    this._rowPoseGen = new Int32Array(this.globalEntityCount).fill(POSE_GEN_NONE);
    this._poseChanged = false;

    this._wasmGather = wasmGather;
    this.processedMarker = this._wasmGather.marker;
    this._neighborCandidateTruncated = this._wasmGather.truncated;

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
   * E-328: spatial.startOn, 'vsync' (the default) or 'logicDone', or an array of them, one per spatial worker (a worker
   * past its end starts on the vsync). 'logicDone' needs logic workers and frames on the vsync: a worker or a logic paced
   * by a timer (noLimitFPS, fixedFps) has no vsync to share, and starts when its timer fires.
   */
  _setupStartOn() {
    const startOn = this.config?.spatial?.startOn;
    const mine = Array.isArray(startOn) ? startOn[this.workerId] : startOn;
    if (mine !== undefined && mine !== 'vsync' && mine !== 'logicDone') {
      console.warn(
        `WeedJS: spatial.startOn ${JSON.stringify(mine)} is not 'vsync' or 'logicDone'; spatial worker ${this.workerId} starts on the vsync.`,
      );
    }
    const logic = this.config?.logic || {};
    this._logicWorkers = Math.max(0, logic.numberOfLogicWorkers | 0);
    const timed = this.noLimitFPS || this.fixedFps > 0 || logic.noLimitFPS === true || Number(logic.fixedFps) > 0;
    this._startOnLogicDone = mine === 'logicDone' && this._logicWorkers > 0 && !timed;
    this._logicWaitMisses = 0;
    this._logicWaitOffUntil = 0;
  }

  /** E-328: the wait for logic's frame (spatial.startOn 'logicDone'), inside the step, so it counts in WAIT_MS. */
  beforeUpdate() {
    if (this._startOnLogicDone) this._waitForLogicFrame();
  }

  /**
   * E-328 (spatial.startOn 'logicDone'). Every worker wakes on the vsync, and logic's frame (about 7 ms at Predator crowd
   * 2.5) runs on the cores this one shares with it: two spatial workers beside it cut spatial 32 % and cost logic 8 %
   * (R-1035). The rows this frame publishes are read TYPED_NEIGHBOR_LEAD logic frames later and Box2D rewrites Transform
   * only at its finalize, so the search loses nothing by starting once logic's frame of this vsync has ended, when the
   * cores are free (from about 7 to 16.7 ms at crowd 2.5). It sleeps on the frame chain's bell ([2]), which each logic
   * worker rings at its frame's end (and at each sync query it posts), until the chain's count of logic frames done
   * ([0]) has risen by the logic workers that had not finished this vsync's frame when this frame began (the frame
   * clock's stamps: a frame kept off the cores may begin after logic's). The wait ends at the latest at the frame's end
   * less this worker's own step and LOGIC_WAIT_MARGIN_MS (at most LOGIC_WAIT_MAX_SHARE of the frame); then the frame
   * starts anyway. On Windows a wait of a millisecond or more that nobody ends sleeps to the timer period (about 15 ms),
   * so the deadline is a ceiling when logic rings nothing at all, and a late logic's ring is what usually ends the wait:
   * LOGIC_WAIT_MISSES frames in a row that start past the deadline turn the waits off for LOGIC_WAIT_OFF_FRAMES frames.
   * A frame whose own step does not fit after logic (a budget under LOGIC_WAIT_MIN_MS) starts on the vsync. Lockstep
   * frames do not wait.
   */
  _waitForLogicFrame() {
    const now = performance.now();
    // The vsync period: the gap between two frames over the vsyncs it spans (a frame that ran past a vsync skipped one).
    const est = this._logicWaitPeriodMs === this._logicWaitPeriodMs ? this._logicWaitPeriodMs : FRAME_MS_60;
    const last = this._logicWaitLastStart;
    this._logicWaitLastStart = now;
    if (last === last) {
      const gap = now - last;
      if (gap > 0 && gap < 100) {
        const vsyncs = Math.round(gap / est);
        this._logicWaitPeriodMs = est * 0.9 + (gap / (vsyncs > 1 ? vsyncs : 1)) * 0.1;
      }
      // The last frame's own step: its step less its wait.
      const own = this.stepTimeThisFrame - this._logicWaitMs;
      if (own > 0 && own < 100) {
        this._logicWaitOwnMs = this._logicWaitOwnMs === this._logicWaitOwnMs ? this._logicWaitOwnMs * 0.9 + own * 0.1 : own;
      }
    }
    this._logicWaitMs = 0;
    const chain = this._frameChain;
    if (chain === null || this._injectedDeltaTime > 0 || this.frameNumber < this._logicWaitOffUntil) return;
    const period = this._logicWaitPeriodMs === this._logicWaitPeriodMs ? this._logicWaitPeriodMs : FRAME_MS_60;
    const own = this._logicWaitOwnMs === this._logicWaitOwnMs ? this._logicWaitOwnMs : 0;
    const fit = period - own - LOGIC_WAIT_MARGIN_MS;
    const cap = period * LOGIC_WAIT_MAX_SHARE;
    const budget = fit < cap ? fit : cap;
    if (!(budget >= LOGIC_WAIT_MIN_MS)) return;
    // The stamps before the count: a logic worker stamps its step after it adds to the count, so each one found done
    // is in the count read after.
    const done = this._logicFramesDoneThisVsync(TIME_ORIGIN + now, period);
    // The bell before the count: a ring after the bell's read ends the wait at once.
    let bell = Atomics.load(chain, 2);
    let cur = Atomics.load(chain, 0);
    const target = cur + this._logicWorkers - done;
    if (cur >= target) {
      this._logicWaitMisses = 0;
      return;
    }
    const end = now + budget;
    while (cur < target) {
      const left = end - performance.now();
      if (!(left > 0)) break;
      Atomics.wait(chain, 2, bell, left);
      bell = Atomics.load(chain, 2);
      cur = Atomics.load(chain, 0);
    }
    const after = performance.now();
    const waited = after - now;
    this._logicWaitMs = waited;
    addWaitMs(waited);
    // A miss is a start past the deadline, whether logic's ring or the timeout ended the wait (Windows may end a timed
    // wait only at its timer period, so a logic later than the budget is usually waited for in full).
    if (after <= end) {
      this._logicWaitMisses = 0;
    } else if (++this._logicWaitMisses >= LOGIC_WAIT_MISSES) {
      this._logicWaitMisses = 0;
      this._logicWaitOffUntil = this.frameNumber + LOGIC_WAIT_OFF_FRAMES;
    }
  }

  /**
   * E-328: the logic workers whose last finished step began at this vsync, from the frame clock's stamps. The vsync is
   * placed a whole number of periods after the latest logic step's start (logic's frames start on the vsync), so a frame
   * that began late still finds logic's frame of this vsync done. A stamp being written is a step ending now: done.
   * Logic workers past the clock's slots (MAX_LOGIC) are never found done.
   * @param {number} nowAbs this frame's start, absolute ms (TIME_ORIGIN + performance.now())
   * @param {number} period the vsync period, ms
   */
  _logicFramesDoneThisVsync(nowAbs, period) {
    const clock = this._frameClock;
    if (clock === null) return 0;
    const f64 = clock.f64;
    const i32 = clock.i32;
    const n = this._logicWorkers < MAX_LOGIC ? this._logicWorkers : MAX_LOGIC;
    let latest = 0;
    for (let i = 0; i < n; i++) {
      const at = HEADER_BYTES + (LOGIC_SLOT0 + i) * SLOT_BYTES;
      if ((Atomics.load(i32, (at >> 2) + 5) & 1) !== 0) continue;
      const start = f64[at >> 3];
      if (start > latest) latest = start;
    }
    if (!(latest > 0)) return 0;
    const vsync = latest + Math.floor((nowAbs + LOGIC_WAIT_SLACK_MS - latest) / period) * period;
    let done = 0;
    for (let i = 0; i < n; i++) {
      const at = HEADER_BYTES + (LOGIC_SLOT0 + i) * SLOT_BYTES;
      if ((Atomics.load(i32, (at >> 2) + 5) & 1) !== 0 || f64[at >> 3] >= vsync - LOGIC_WAIT_SLACK_MS) done++;
    }
    return done;
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
    this.neighborsRebuiltThisFrame = 0;
    this.neighborsPublishedThisFrame = 0;
    this.sleepNeighborSkipsThisFrame = 0;

    // STEP 1: Rebuild grid (only owned rows), or rewrite it for what changed (E-126)
    const detail = this.collectDetailedStats;
    let startTime = detail ? performance.now() : 0;
    this._rebuildGrid();
    // E-136: after the poses, so a worker that reads the new generation reads them too.
    if (this._poseChanged || !this._poseGenShared) Atomics.add(this._poseGen, 0, 2);
    this._poseChanged = false;
    if (detail) {
      this.rebuildTimeThisFrame = performance.now() - startTime;
    }

    // STEP 2: Find neighbors (only for entities in owned rows)
    startTime = detail ? performance.now() : 0;
    this._findNeighbors();
    // N-214: the publish of what the search queued, called here and not at the search's end. Inlined there, TurboFan
    // compiled its body before it had run (the search tiers up in its first frames, when nothing is published yet), and
    // that code then deopted at its first property read every frame something was published, never replaced (Predator:
    // 391 times in 8 s).
    this._flushWasmPublish();
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
    const boxWidth = Collider.width;
    const boxHeight = Collider.height;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const rigidActive = RigidBody.active;
    // E-471: a boolean, so the per-entity test is one compare, not ToBoolean of a field typed any value.
    const countNoBody = this.collectDetailedStats === true;
    let noBody = 0;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    // E-471: the grid's integers as int32, read once: as they were, each was Smi-checked and untagged at every cell
    // it is used in, and maxEntitiesPerCell read again from Grid at each one.
    const cellStride = Grid._cellIdStride | 0;
    const cellHeader = Grid._headerIds | 0;
    const maxPerCell = Grid.maxEntitiesPerCell | 0;
    const cellByteSize = Grid.cellByteSize | 0;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const ownedList = this._ownedEntityList;
    let ownedCount = 0;
    let poseChanged = false;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        localCounts[rowBase + col] = 0;
      }
    }

    const activeEntitiesData = this.activeEntitiesData;
    // E-471: every array the entity loop indexes is looked at here, before it. Their fields start null (typed any
    // value) or are another module's statics, and the loop is too big for TurboFan to peel, so it checked each one's
    // map (and decoded its data pointer) where the loop first indexed it: at every entity. Looked at here, their maps
    // are known inside. No active list (a hand-made layout: _rebuildGrid) bins nothing, as before; nor does an array
    // a worker never sized (none is empty after initialize).
    if (
      activeEntitiesData !== null &&
      activeEntitiesData.length > 0 &&
      rowOwnership.length > 0 &&
      localCounts.length > 0 &&
      ownedList.length > 0 &&
      entityPosData.length > 0 &&
      gridEntities.length > 0 &&
      gridCounts.length > 0
    ) {
      const totalActiveEntities = activeEntitiesData[0];
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
        } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
          // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
          const c = rotC ? rotC[i] : 1;
          const sn = rotS ? rotS[i] : 0;
          const ox = offsetX[i] || 0;
          const oy = offsetY[i] || 0;
          posX = x[i] + c * ox - sn * oy;
          posY = y[i] + sn * ox + c * oy;
          const hw = (boxWidth[i] || 0) * 0.5;
          const hh = (boxHeight[i] || 0) * 0.5;
          const ac = c < 0 ? -c : c;
          const as = sn < 0 ? -sn : sn;
          halfW = ac * hw + as * hh;
          halfH = as * hw + ac * hh;
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
        // E-472: a point (no extent: a sprite without a collider, every boid) covers one cell, in the row its Y falls
        // in: the cell range's row below, not the home row (they differ where the float32 Y rounds across a cell's
        // edge). When another worker owns that row nothing below writes anything, so the cell range is skipped.
        if (halfW === 0 && halfH === 0) {
          const pointRow = (posY * invCellSize) | 0;
          if (rowOwnership[pointRow < 0 ? 0 : pointRow > maxRow ? maxRow : pointRow] !== workerId) continue;
        }

        // E-471: getCellRange's arithmetic in locals. Through _cellRangeResult (a module object, so the stores stay),
        // its four results were Smi-tagged, stored and read back at every entity.
        const c0 = ((posX - halfW) * invCellSize) | 0;
        const c1 = ((posX + halfW) * invCellSize) | 0;
        const r0 = ((posY - halfH) * invCellSize) | 0;
        const r1 = ((posY + halfH) * invCellSize) | 0;
        const minCol = c0 < 0 ? 0 : c0 > maxCol ? maxCol : c0;
        const maxColBB = c1 < 0 ? 0 : c1 > maxCol ? maxCol : c1;
        const minRow = r0 < 0 ? 0 : r0 > maxRow ? maxRow : r0;
        const maxRowBB = r1 < 0 ? 0 : r1 > maxRow ? maxRow : r1;

        let wroteEntityPos = false;
        for (let row = minRow; row <= maxRowBB; row++) {
          if (rowOwnership[row] !== workerId) continue;

          if (!wroteEntityPos) {
            const baseIdx = i * 4;
            // E-136: one pose that changed is enough to move the generation this frame.
            if (
              !poseChanged &&
              (entityPosData[baseIdx] !== Math.fround(posX) ||
                entityPosData[baseIdx + 1] !== Math.fround(posY) ||
                entityPosData[baseIdx + 2] !== Math.fround(maxHalfExtent))
            ) {
              poseChanged = true;
            }
            entityPosData[baseIdx] = posX;
            entityPosData[baseIdx + 1] = posY;
            entityPosData[baseIdx + 2] = maxHalfExtent;
            wroteEntityPos = true;
          }

          const rowBase = row * gridWidth;

          for (let col = minCol; col <= maxColBB; col++) {
            const cellIndex = rowBase + col;
            const localCount = localCounts[cellIndex];

            if (localCount < maxPerCell) {
              gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
              localCounts[cellIndex] = localCount + 1;
            }
          }
        }
      }
    }

    // E-274: a count is written only when it changed. Each cell's count is a cache line of the shared grid (an empty
    // world's cells too); this worker's copy of what it wrote is a dense array, and only the owner writes a count.
    const writtenCounts = this._writtenCounts;
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;
      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const count = localCounts[cellIndex];
        if (writtenCounts[cellIndex] !== count) {
          gridCounts[cellIndex * cellByteSize] = count;
          writtenCounts[cellIndex] = count;
        }
      }
    }
    if (poseChanged) this._poseChanged = true;
    this._noBodyCount = noBody;
    this._ownedEntityCount = ownedCount;
  }

  /**
   * E-126. This frame's grid: rewritten for the entities that changed (_rebuildMovedRows) when
   * physics moved at most the limit (_moversLimit: where the two paths' timed costs tie, E-503), rebuilt
   * otherwise (_stepGrid). The rewrite starts from the state a latched rebuild leaves and needs physics'
   * moved list of every publish since; a publish missed or torn, or a frame the rewrite gives up on,
   * rebuilds and latches again (after a backoff when that keeps happening). Either path writes the same
   * bytes, so the choice (and the clock it reads) changes the cost only.
   * E-503: in AUTO the whole step is timed, so a rewrite given up and the latch after it count against the
   * rewrite's path: in a crowd whose cells fill (Buenos Aires with 15 000 people), timing the rewrites that held
   * alone took the path at a cost 15 to 20 % over the rebuild.
   */
  _rebuildGrid() {
    const mode = this._gridMoversMode;
    const activeData = this.activeEntitiesData;
    this._gridMoversThisFrame = 0;
    if (mode === GRID_MOVERS_OFF || !activeData) {
      this._mvSeeded = false;
      this.rebuildOwnedRows();
      return;
    }
    if (mode !== GRID_MOVERS_AUTO) {
      this._stepGrid(mode, activeData);
      return;
    }
    const retime = this._mvRetimeFull;
    const start = performance.now();
    const step = this._stepGrid(mode, activeData);
    const ms = performance.now() - start;
    if (step === GRID_STEP_FULL) {
      if (retime && ms < this._mvFullMs) this._mvFullMs = ms;
      else this._timeFull(ms);
    } else if (step !== GRID_STEP_LATCH || this._mvAfterGiveUp) {
      this._timeMovers(ms, this._mvCount, step === GRID_STEP_REWRITE);
    } else if (this._mvProbeLeft > 0) {
      this._mvProbeLeft--;
    }
    this._mvAfterGiveUp = step === GRID_STEP_GAVE_UP;
  }

  /**
   * E-126. The grid step _rebuildGrid chose a path for: the rewrite, the full rebuild, or a latch.
   * @returns {number} GRID_STEP_FULL, GRID_STEP_REWRITE, GRID_STEP_GAVE_UP or GRID_STEP_LATCH (E-503: which path
   *   the time was)
   */
  _stepGrid(mode, activeData) {
    const head = this._mvHead;
    // E-266: no physics worker, so no moved list: the rewrite compares every collider's bounds with the ones its
    // cells were written from (_scanColliderBounds) instead of reading which bodies moved.
    const listed = readMovedBodiesHeader(head);
    const gen = listed ? head[0] : 0;
    const count = listed ? head[1] : 0;
    const seq = listed ? head[2] : 0;
    const timed = mode === GRID_MOVERS_AUTO;
    const auto = timed || mode === GRID_MOVERS_FIXED;
    const active = activeData[0];
    const limit = timed ? this._moversLimit(active) : auto ? active * MOVERS_MAX_FRACTION : this.globalEntityCount;
    let gaveUp = false;
    this._mvCount = count;
    if (timed) {
      const avg = this._mvCountAvg;
      this._mvCountAvg = avg === avg ? avg + (count - avg) * 0.25 : count;
    }
    if (this._mvSeeded && !this._mvRetimeFull) {
      // Bodies physics moved since the state: none when it has not published since, its list
      // when it published once (and not while the header was being written).
      const moved = !listed
        ? MOVED_SCAN
        : gen === this._mvGen
          ? 0
          : gen === ((this._mvGen + 1) | 0) && seq >= 0
            ? count
            : -1;
      if (moved !== -1 && moved <= limit) {
        if (this._rebuildMovedRows(moved, seq, limit)) {
          this._mvGen = gen;
          this._gridMoversThisFrame = 1;
          this._mvFailures = 0;
          // E-503: a rewrite that holds past its probe's window: the probe won, the gap starts over.
          if (this._mvFromProbe && this._mvProbeLeft === 0) {
            this._mvFromProbe = false;
            this._mvProbeGap = this._mvProbeEvery;
          }
          return GRID_STEP_REWRITE;
        }
        gaveUp = true;
      }
      // E-503: a probe's run that ends before a rewrite held past its window (on the limit, or given up): the rewrite
      // lost, the next probe waits longer.
      if (this._mvFromProbe) {
        const gap = this._mvProbeGap * 2;
        const most = this._mvProbeEvery * MOVERS_PROBE_STRETCH;
        this._mvProbeGap = gap < most ? gap : most;
      }
      this._mvFromProbe = false;
      // The state is spent, and the grid may be half rewritten: the rebuild below writes all of it.
      this._mvSeeded = false;
      this._mvProbeLeft = 0;
      // One rewrite after a latch already pays for it. A latch that gets none costs a rebuild and
      // more for nothing: when that repeats, wait 2, 4, … 128 frames before the next latch.
      if (auto) {
        this._mvFailures++;
        this._mvBackoff = this._mvFailures < 2 ? 0 : this._mvFailures > 8 ? 128 : 1 << (this._mvFailures - 1);
      }
    }
    // E-503: rebuilding while the limit (or no timing yet) says so, with a probe now and then. Coming from the
    // rebuild, the count and its recent average must be under MOVERS_ENTRY_SHARE of a timed limit (one short list,
    // physics not stepping, is no reason to latch).
    const entry = timed && !gaveUp && this._mvProbeLeft === 0 && this._mvFullMs > 0 && this._mvPerMovedMs > 0
      ? limit * MOVERS_ENTRY_SHARE
      : limit;
    const over = count > entry || (timed && this._mvCountAvg > entry);
    const probe =
      timed &&
      over &&
      this._mvBackoff === 0 &&
      !this._mvRetimeFull &&
      --this._mvProbeIn <= 0 &&
      count <= active * MOVERS_CAP_FRACTION;
    if (!probe && (this._mvRetimeFull || this._mvBackoff > 0 || over)) {
      if (this._mvBackoff > 0) this._mvBackoff--;
      this._mvSeeded = false;
      this._mvRetimeFull = false;
      this.rebuildOwnedRows();
      return gaveUp ? GRID_STEP_GAVE_UP : GRID_STEP_FULL;
    }
    if (probe) {
      this._mvProbeIn = this._mvProbeGap;
      this._mvProbeLeft = MOVERS_PROBE_LENGTH;
      this._mvFromProbe = true;
    }
    this._allocMovers();
    this._mvGen = gen;
    this._mvSeeded = this._rebuildOwnedRowsLatched();
    return gaveUp ? GRID_STEP_GAVE_UP : GRID_STEP_LATCH;
  }

  /**
   * E-503. The most moved bodies the rewrite takes: the count at which the rewrite path's timed cost per moved body
   * adds up to a timed full rebuild, kept between MOVERS_MIN_FRACTION and MOVERS_CAP_FRACTION of the active
   * entities; MOVERS_MAX_FRACTION until both are timed, and the cap while a probe lasts.
   */
  _moversLimit(active) {
    if (this._mvProbeLeft > 0) return active * MOVERS_CAP_FRACTION;
    const full = this._mvFullMs;
    const perMoved = this._mvPerMovedMs;
    if (!(full > 0) || !(perMoved > 0)) return active * MOVERS_MAX_FRACTION;
    const tie = full / perMoved;
    const low = active * MOVERS_MIN_FRACTION;
    const high = active * MOVERS_CAP_FRACTION;
    return tie < low ? low : tie > high ? high : tie;
  }

  /** E-503. A full rebuild's ms into its moving average (a sample over 4× the average, a preemption, counts as 4×). */
  _timeFull(ms) {
    const avg = this._mvFullMs;
    this._mvFullMs = avg > 0 ? avg + ((ms > avg * 4 ? avg * 4 : ms) - avg) * 0.125 : ms;
  }

  /**
   * E-503. A frame on the rewrite's path into its moving averages, per moved body and whole: a rewrite, one given up
   * with the rebuild after it, the latch after that (a latch costs about 2.5 rebuilds, so a sample counts up to 8× the
   * average); not a latch the choice made on purpose (an entry, which MOVERS_ENTRY_SHARE pays for). A frame physics
   * did not publish, or without its list, says nothing of the cost per body. After MOVERS_RETIME_FRAMES rewrites
   * (times a rebuild's cost over these frames', up to MOVERS_RETIME_STRETCH, so a world that sleeps pays little for
   * it), a full rebuild is timed again; a lower time replaces the average (a stale one, or the load's), a higher one
   * joins it.
   */
  _timeMovers(ms, moved, rewrote) {
    if (moved > 0) {
      const per = ms / moved;
      const avg = this._mvPerMovedMs;
      this._mvPerMovedMs = avg > 0 ? avg + ((per > avg * 8 ? avg * 8 : per) - avg) * 0.125 : per;
    }
    // Every frame on the path, a still one too: a world that sleeps then stretches its retimes to the most.
    const last = this._mvMoversFrameMs;
    this._mvMoversFrameMs = last > 0 ? last + ((ms > last * 8 ? last * 8 : ms) - last) * 0.125 : ms;
    if (this._mvProbeLeft > 0) this._mvProbeLeft--;
    if (rewrote) {
      const full = this._mvFullMs;
      const frame = this._mvMoversFrameMs;
      let stretch = full > 0 && frame > 0 ? full / frame : 1;
      stretch = stretch > 1 ? (stretch < MOVERS_RETIME_STRETCH ? stretch : MOVERS_RETIME_STRETCH) : 1;
      if (++this._mvRewrites >= this._mvRetimeEvery * stretch) {
        this._mvRewrites = 0;
        this._mvRetimeFull = true;
      }
    }
  }

  /** E-126. The movers state, sized once, on the first latch (a scene that never takes the path pays nothing). */
  _allocMovers() {
    const n = this.globalEntityCount;
    const cells = this.totalCells;
    if (this._mvState.length === n && this._mvTrue.length === cells) return;
    this._mvState = new Uint8Array(n);
    this._mvRange = new Int32Array(n * 4);
    this._mvBounds = new Float64Array(n * 4);
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
    const boxWidth = Collider.width;
    const boxHeight = Collider.height;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
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
    let poseChanged = false;

    const n = this.globalEntityCount;
    const state = this._mvState;
    const range = this._mvRange;
    const bounds = this._mvBounds;
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
      } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
        // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
        const c = rotC ? rotC[i] : 1;
        const sn = rotS ? rotS[i] : 0;
        const ox = offsetX[i] || 0;
        const oy = offsetY[i] || 0;
        posX = x[i] + c * ox - sn * oy;
        posY = y[i] + sn * ox + c * oy;
        const hw = (boxWidth[i] || 0) * 0.5;
        const hh = (boxHeight[i] || 0) * 0.5;
        const ac = c < 0 ? -c : c;
        const as = sn < 0 ? -sn : sn;
        halfW = ac * hw + as * hh;
        halfH = as * hw + ac * hh;
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
      // E-266: what _scanColliderBounds compares with.
      const b4 = i * 4;
      bounds[b4] = posX;
      bounds[b4 + 1] = posY;
      bounds[b4 + 2] = halfW;
      bounds[b4 + 3] = halfH;

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
          // E-136, as in rebuildOwnedRows.
          if (
            !poseChanged &&
            (entityPosData[baseIdx] !== Math.fround(posX) ||
              entityPosData[baseIdx + 1] !== Math.fround(posY) ||
              entityPosData[baseIdx + 2] !== Math.fround(maxHalfExtent))
          ) {
            poseChanged = true;
          }
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

    // E-274: a count is written only when it changed. Each cell's count is a cache line of the shared grid (an empty
    // world's cells too); this worker's copy of what it wrote is a dense array, and only the owner writes a count.
    const writtenCounts = this._writtenCounts;
    const cellByteSize = Grid.cellByteSize;
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;
      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const count = localCounts[cellIndex];
        if (writtenCounts[cellIndex] !== count) {
          gridCounts[cellIndex * cellByteSize] = count;
          writtenCounts[cellIndex] = count;
        }
      }
    }
    if (poseChanged) this._poseChanged = true;
    this._noBodyCount = noBody;
    this._ownedEntityCount = ownedCount;
    this._mvLooseCount = looseCount;
    return ascending;
  }

  /**
   * E-266. Without a physics worker nothing lists the bodies that moved: each present entity with a collider whose
   * bounds differ from the ones its cells were written from (the latch, or its last rebin in step 4), bit for bit as
   * step 3 compares a loose entity's position, or that lost its collider, joins the changed ones. Entities without a
   * collider are step 3's. A copy of the bounds math, not a call (hot loops: R8).
   * @param {number} nd the changed count so far
   * @param {number} limit past it the rewrite gives up, so the scan stops there
   * @returns {number} the changed count
   */
  _scanColliderBounds(nd, limit) {
    const state = this._mvState;
    const dirty = this._mvDirty;
    const dirtyIds = this._mvDirtyIds;
    const bounds = this._mvBounds;
    const active = this._mvActive;
    const activeCount = active[0];
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const boxWidth = Collider.width;
    const boxHeight = Collider.height;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
    const colliderActive = Collider.active;
    for (let j = 1; j <= activeCount; j++) {
      const i = active[j];
      if (dirty[i] !== 0 || (state[i] & MV_LOOSE) !== 0) continue;
      let changed = colliderActive[i] === 0;
      if (!changed) {
        let posX;
        let posY;
        let halfW = 0;
        let halfH = 0;
        if (shapeType[i] === SHAPE_CIRCLE) {
          posX = x[i] + (offsetX[i] || 0);
          posY = y[i] + (offsetY[i] || 0);
          halfW = radius[i] || 0;
          halfH = halfW;
        } else if (shapeType[i] === SHAPE_BOX) {
          const c = rotC ? rotC[i] : 1;
          const sn = rotS ? rotS[i] : 0;
          const ox = offsetX[i] || 0;
          const oy = offsetY[i] || 0;
          posX = x[i] + c * ox - sn * oy;
          posY = y[i] + sn * ox + c * oy;
          const hw = (boxWidth[i] || 0) * 0.5;
          const hh = (boxHeight[i] || 0) * 0.5;
          const ac = c < 0 ? -c : c;
          const as = sn < 0 ? -sn : sn;
          halfW = ac * hw + as * hh;
          halfH = as * hw + ac * hh;
        } else {
          getColliderBounds(i, _boundsResult);
          posX = _boundsResult.posX;
          posY = _boundsResult.posY;
          halfW = _boundsResult.halfW;
          halfH = _boundsResult.halfH;
        }
        const b4 = i * 4;
        const bx = bounds[b4];
        const by = bounds[b4 + 1];
        const bw = bounds[b4 + 2];
        const bh = bounds[b4 + 3];
        // Changed bits: two NaNs bin alike, 0 and -0 do not (the pose keeps the sign).
        changed =
          (posX !== bx ? posX === posX || bx === bx : posX === 0 && 1 / posX !== 1 / bx) ||
          (posY !== by ? posY === posY || by === by : posY === 0 && 1 / posY !== 1 / by) ||
          (halfW !== bw ? halfW === halfW || bw === bw : halfW === 0 && 1 / halfW !== 1 / bw) ||
          (halfH !== bh ? halfH === halfH || bh === bh : halfH === 0 && 1 / halfH !== 1 / bh);
      }
      if (changed) {
        dirty[i] = 1;
        dirtyIds[nd++] = i;
        if (nd > limit) return nd;
      }
    }
    return nd;
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
    const boxWidth = Collider.width;
    const boxHeight = Collider.height;
    const rotC = Transform.rotC;
    const rotS = Transform.rotS;
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
    // E-266: no physics list: the colliders whose bounds changed (or that lost their collider).
    if (movedCount === MOVED_SCAN) nd = this._scanColliderBounds(nd, limit);
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
    const bounds = this._mvBounds;
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
    let poseChanged = false;

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
        } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
          // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
          const c = rotC ? rotC[i] : 1;
          const sn = rotS ? rotS[i] : 0;
          const ox = offsetX[i] || 0;
          const oy = offsetY[i] || 0;
          posX = x[i] + c * ox - sn * oy;
          posY = y[i] + sn * ox + c * oy;
          const hw = (boxWidth[i] || 0) * 0.5;
          const hh = (boxHeight[i] || 0) * 0.5;
          const ac = c < 0 ? -c : c;
          const as = sn < 0 ? -sn : sn;
          halfW = ac * hw + as * hh;
          halfH = as * hw + ac * hh;
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
        // E-266: what _scanColliderBounds compares with.
        bounds[r4] = posX;
        bounds[r4 + 1] = posY;
        bounds[r4 + 2] = halfW;
        bounds[r4 + 3] = halfH;
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
              // E-136, as in rebuildOwnedRows (the field at once: a spent state returns early).
              if (
                !poseChanged &&
                (entityPosData[r4] !== Math.fround(posX) ||
                  entityPosData[r4 + 1] !== Math.fround(posY) ||
                  entityPosData[r4 + 2] !== Math.fround(maxHalfExtent))
              ) {
                poseChanged = true;
                this._poseChanged = true;
              }
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
    const writtenCounts = this._writtenCounts;
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
      writtenCounts[cell] = count;
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
   * E-200. A class whose logic ticks every T frames (`logic.staggeredUpdates`, a `tick`, `tickInterval` > 1) reads
   * its neighbours when it ticks, so its list comes TYPED_NEIGHBOR_LEAD logic frames before a tick, and at most
   * every neighborTickInterval frames: every P frames, P the smallest multiple of T not under the interval. A
   * boid that ticks every 30 frames under an interval of 15 gets one list where it had two, fresh when it ticks;
   * a civilian that ticks every 4 gets one every 16 frames instead of 15. Lights keep the stagger above (pre-render
   * reads their lists every frame). The countdowns align with logic 0's frame number, which logic publishes in
   * frameRateData as its frame starts.
   */
  _setupTypedNeighborStagger(data) {
    const n = this.globalEntityCount;
    const spread = this._neighborRefreshSpread;
    this._typedNeighborClass = new Uint8Array(n);
    this._typedNeighborOffset = new Uint16Array(n);
    this._typedNeighborPeriods = new Int32Array(1);
    this._typedNeighborNow = new Int32Array(1);
    this._logicFrameSlot = -1;
    this._lastLogicFrame = -1;
    const logicRow = data.logicFrameRateIndex;
    const stride = data.frameRateStride | 0;
    if (this.config?.logic?.staggeredUpdates !== true || !Number.isInteger(logicRow) || logicRow < 0 || stride < 2) return;
    const slot = logicRow * stride + 1;
    if (!this.frameRateData || slot >= this.frameRateData.length) return;
    const N = this._neighborTickInterval;
    const periods = [0];
    for (const r of data.registeredClasses || []) {
      const T = r.tickInterval | 0;
      if (T <= 1 || r.ticks !== true || periods.length > 255) continue;
      const period = Math.ceil(N / T) * T;
      const start = Math.max(0, r.startIndex | 0);
      const end = Math.min(n, r.endIndex | 0);
      if (period > 0xffff || end <= start) continue;
      const c = periods.length;
      periods.push(period);
      // E-476: a period holds period / T of a slot's ticks, and its list may come before any of them (as fresh at its
      // tick). Before the first for every slot ('none'), the class's whole refresh lands on T frames of every period:
      // spatial at Predator crowd 2.5 ran 3 to 4 ms on some frames and 28 to 46 ms on others, a 32-frame cycle (R-1226).
      // 'idBlocks' gives the k-th of period / T contiguous blocks of the class's slots its k-th tick, so each frame of the
      // period refreshes one phase of one block, every T-th slot of it (as dense in memory as before).
      const ticks = period / T;
      const span = end - start;
      for (let i = start; i < end; i++) {
        this._typedNeighborClass[i] = c;
        const k = spread === REFRESH_SPREAD_ID_BLOCKS ? Math.floor(((i - start) * ticks) / span) : 0;
        // Logic ticks slot i on the frames f with f % T === its phase; its list comes on f - LEAD.
        this._typedNeighborOffset[i] = (((tickBucketPhase(i, T) + k * T - TYPED_NEIGHBOR_LEAD) % period) + period) % period;
      }
    }
    if (periods.length === 1) return;
    this._typedNeighborPeriods = Int32Array.from(periods);
    this._typedNeighborNow = new Int32Array(periods.length);
    this._logicFrameSlot = slot;
  }

  /**
   * E-476. The stagger keeps a list it skips (its slot's refresh frame has not come) while the list is under
   * neighborReuseMaxFrames; skin reuse keeps a list on its refresh frame on the same condition. A list that skin reuse
   * keeps (its entity did not move: a guard, a lamp) therefore reaches the cap between two refresh frames, and is rebuilt
   * on the frame it does, not on one its schedule picked: lists built on the same frame (every list at the scene's start)
   * stay on one cycle of cap + 1 frames for good, whatever the stagger spreads (on the Predator-like kernel world, cap
   * 30: 1 600 more rebuilds, a frame at 1.9 times the median, every 31 frames). With a spread, a skipped list stands up to
   * a period past the cap instead, so it is rebuilt on its own refresh frame, the first after the cap: no list goes longer
   * than the cap plus a period without a refresh, and the rebuilds stay spread. Without one, the cap as before.
   */
  _setupScheduleReuseCap() {
    const cap = this._maxReuseFrames;
    let longest = this._neighborTickInterval;
    const periods = this._typedNeighborPeriods;
    for (let c = 1; c < periods.length; c++) if (periods[c] > longest) longest = periods[c];
    const spread = this._neighborRefreshSpread !== REFRESH_SPREAD_NONE && cap > 0;
    this._scheduleReuseCap = spread ? Math.min(0xffff, cap + longest) : cap;
  }

  /**
   * The neighbour search of the owned entities (E-76 W5, E-78). The per-entity decisions (stagger, skin
   * reuse) stay here; every list to rebuild goes to one gather_batch call (wasm/spatialGather.c: the JS
   * arithmetic in double, this worker's circle patterns in order); then the bookkeeping, then the publish
   * (publish_batch). It publishes exactly what the JS search it replaced published
   * (tests/reference/spatialGather.mjs; tests/node/spatialGatherWasm.test.js).
   */
  _findNeighbors() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;
    // E-176: lists only for types whose code reads them, and with walls (lighting.walls) for active lights that cast
    // shadows (pre-render gathers their occluders from them; N-153: nothing reads a light's list in basic lighting).
    const readers = Grid.neighborReaders;
    const entityType = Transform.entityType;
    const lightActive = this._raycastLights ? LightEmitter.active || null : null; // null: no light takes a list
    const lightCasts = lightActive !== null ? LightEmitter.castShadows : null;
    const lightRadius = lightActive !== null ? LightEmitter.radius : null;
    const lightShadowRange = lightActive !== null ? LightEmitter.shadowRange : null;
    const lightOffsetX = lightActive !== null ? LightEmitter.offsetX : null;
    const lightOffsetY = lightActive !== null ? LightEmitter.offsetY : null;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const skinFrac = this._neighborReuseSkin;
    const tickInterval = this._neighborTickInterval;
    const nextTick = this._entityNeighborNextTick;
    const scheduleReuseCap = this._scheduleReuseCap;
    const framesSinceBuild = this._entityFramesSinceBuild;
    const candCountOf = this._candidateCountOf;
    const neighborData = Grid.neighborData;
    const entityPosData = this.entityPosData;
    const pub = this._wasmPub;
    const g = this._wasmGather;
    const rebuild = g.rebuild;
    // E-136: read before the publish reads a pose (update() adds to it after this worker's poses).
    const poseGen = Atomics.load(this._poseGen, 0);
    const rowPoseGen = this._rowPoseGen;
    const sharedRows = this.totalSpatialWorkers > 1;
    // E-200: logic frames since this worker's last search (0 until logic publishes one, or if it has not moved),
    // and each typed class's place in its period. A list is due when its refresh frame fell in those frames.
    const typedClass = this._typedNeighborClass;
    const typedOffset = this._typedNeighborOffset;
    const typedPeriods = this._typedNeighborPeriods;
    const typedNow = this._typedNeighborNow;
    let logicStep = 0;
    if (this._logicFrameSlot >= 0) {
      const logicFrame = this.frameRateData[this._logicFrameSlot] | 0;
      if (logicFrame > 0) {
        const last = this._lastLogicFrame;
        // The first frame, or logic's counter going back (a restart): this frame alone.
        logicStep = last < 0 || logicFrame < last ? 1 : logicFrame - last;
        this._lastLogicFrame = logicFrame;
        for (let c = 1; c < typedPeriods.length; c++) typedNow[c] = logicFrame % typedPeriods[c];
      }
    }

    this._processedFrameCounter++;
    if (this._processedFrameCounter > SPATIAL_STAMP_FRAME_MASK) {
      this._processedFrameCounter = 1;
      this.processedMarker.fill(0);
    }
    const stampFrame = this._processedFrameCounter;

    // E-268: only the worker that owns an entity publishes its row, so a row this worker kept clear the frame before
    // is still clear: the read of its head (a cache line per entity, rows ~2 KB apart) is needed only for an entity
    // that just arrived or came back. Every 254 frames every head is read once more.
    let clearFrame = this._clearHeldFrame + 1;
    if (clearFrame > 255) {
      this._clearHeld.fill(0);
      clearFrame = 2;
    }
    this._clearHeldFrame = clearFrame;
    const clearHeld = this._clearHeld;
    const clearHeldBefore = clearFrame - 1;

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

      let myVisualRange = visualRange[entityA];
      // DX-LIGHTAPI: a light searches its own reach (shadowRange, or its radius) past its offset from the entity, so
      // no Collider.visualRange has to cover it. Not when its class reads its neighbours: the row is that code's list
      // too, and the light's reach would widen what it sees (a hero with a flashlight would find enemies 1500 px off).
      // Such a light finds its occluders within the entity's visualRange, as every light did before.
      const isLight = lightActive !== null && lightActive[entityA] !== 0 && lightCasts[entityA] !== 0;
      if (isLight && readers !== null && readers[entityType[entityA]] === 0) {
        const sr = lightShadowRange[entityA];
        const ox = lightOffsetX[entityA];
        const oy = lightOffsetY[entityA];
        const reach = (sr > 0 ? sr : lightRadius[entityA]) + Math.sqrt(ox * ox + oy * oy);
        // A float32, as the column the reuse signature keeps (a double would never match it).
        if (reach > myVisualRange) myVisualRange = Math.fround(reach);
      }
      if (
        myVisualRange <= 0 ||
        (readers !== null && readers[entityType[entityA]] === 0 && !isLight)
      ) {
        // A row this worker cleared stays clear: only its publish writes it. Its own write each frame
        // dirtied a cache line per entity (130 bytes a row at maxNeighbors 64). With other spatial
        // workers, one of them may have published the row before this one took the entity over.
        if (rowPoseGen[entityA] !== POSE_GEN_NONE) {
          neighborData[entityA * stride] = 0;
          rowPoseGen[entityA] = POSE_GEN_NONE;
        } else if (sharedRows && clearHeld[entityA] !== clearHeldBefore && neighborData[entityA * stride] !== 0) {
          neighborData[entityA * stride] = 0;
        }
        clearHeld[entityA] = clearFrame;
        continue;
      }

      // Schedule stagger: only ~1/tickInterval entities rebuild per frame.
      let scheduleSkipRebuild = false;
      if (tickInterval > 1) {
        const tc = typedClass[entityA];
        if (tc !== 0 && !isLight) {
          // E-200: logic frames since this slot's last refresh frame (_setupTypedNeighborStagger); due if that
          // frame came since the last search. Stateless, so a slot whose row changed owner keeps its phase.
          let since = typedNow[tc] - typedOffset[entityA];
          if (since < 0) since += typedPeriods[tc];
          scheduleSkipRebuild = since >= logicStep;
        } else if (--nextTick[entityA] > 0) {
          scheduleSkipRebuild = true;
        } else {
          nextTick[entityA] = tickInterval;
        }
      }
      if (
        scheduleSkipRebuild &&
        candCountOf[entityA] > 0 &&
        framesSinceBuild[entityA] < scheduleReuseCap
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
        // E-136: the same list, range and poses as at its last publish: the row stands.
        if (rowPoseGen[entityA] === poseGen) continue;
        rowPoseGen[entityA] = poseGen;
        pub.list[pub.queued++] = entityA;
      } else {
        rebuild[rebuilds++] = entityA;
      }
    }

    this.neighborsRebuiltThisFrame += rebuilds;
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
        rowPoseGen[entityA] = poseGen;
        pub.list[pub.queued++] = entityA;
        if (!truncatedOf[entityA]) {
          const b = entityA * 4;
          // The range searched (a light's own reach, else its visualRange), as the next frame compares it.
          this._storeNeighborReuseSignature(entityA, entityPosData[b], entityPosData[b + 1], entityPosData[b + 2], pub.range[entityA]);
        } else {
          // Skin reuse stays off (incomplete list), but schedule stagger needs age reset
          this._entityReuseInitialized[entityA] = 0;
          framesSinceBuild[entityA] = 0;
        }
      }
    }
  }

  /** The WASM publish of every entity queued this frame (the search ends here). */
  _flushWasmPublish() {
    if (this._wasmPub && this._wasmPub.queued) {
      const n = this._wasmPub.queued;
      this._wasmPub.queued = 0;
      this.neighborsPublishedThisFrame += n;
      const meta = this._wasmMeta;
      // E-299: the batch in cell order, as the gather's rebuild list is: consecutive entities share neighbours, whose
      // poses the publish then finds still in cache (entity ids carry no place). The rows do not depend on the order.
      const g = this._wasmGather;
      if (n > 1 && this._gatherCellOrder && g !== null && g.order) {
        g.order(n, this._wasmPub.listByte, meta.posByte, this.invCellSize, this.gridWidth, this.gridHeight, g.orderByte);
      }
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
      // read.
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
    this.stats[SPATIAL_STATS.NEIGHBORS_REBUILT] = this.neighborsRebuiltThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBORS_PUBLISHED] = this.neighborsPublishedThisFrame;
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
