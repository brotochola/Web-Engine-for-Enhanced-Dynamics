self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { Joint } from '../core/joint.js';
import { Mouse } from '../core/mouse.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Camera } from '../core/camera.js';

import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';

import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';

import { AbstractWorker } from './abstractWorker.js';

import { LOGIC_STATS, createMultiWorkerStatsWriter } from '../util/workersUtils.js';
import { Ray } from '../core/ray.js';
import { _cantorResult } from '../util/utils.js';
import { bindBox2dHotFields } from '../box2d/box2dHotFields.js';
import { bindCommandRing } from '../box2d/box2dCommandRing.js';
import { bindQueryAabbSab } from '../box2d/box2dQueryAabb.js';
import { bindRayCastSab } from '../box2d/box2dRayCast.js';
import { bindLiquidFunQuerySab } from '../box2d/liquidFunQuery.js';
import { bindLiquidFunExtractSab } from '../box2d/liquidFunExtract.js';
import { LiquidFun } from '../core/liquidFun.js';
import { bindMovedBodies } from '../box2d/box2dMovedBodies.js';
import {
  bindContactRing,
  drainContactRing,
  initialContactCursor,
  BOX2D_CONTACT_KIND,
} from '../box2d/box2dContactRing.js';
import {
  bindContactHitRing,
  drainContactHitRing,
  initialContactHitCursor,
} from '../box2d/box2dContactHitRing.js';
import {
  bindJointBreakRing,
  drainJointBreakRing,
  initialJointBreakCursor,
} from '../box2d/box2dJointBreakRing.js';
import { bindBodySyncBuffers } from '../box2d/box2dBodySync.js';

/** Pair key for entity indices < 65536. Replaces Cantor on contact hot path (LOG-PAIR). */
function collisionPairKey(minE, maxE) {
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}
function collisionPairUnpack(key, out) {
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}

// Note: Core engine classes (GameObject, Mouse, Keyboard, etc.) and components
// (Transform, RigidBody, etc.) are now registered automatically by AbstractWorker
// during initialization. Game-specific entity classes are loaded dynamically.

/**
 * LogicWorker - Handles game logic and AI for all entities
 * Extends AbstractWorker for common worker functionality
 */
class LogicWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Logic worker needs to CREATE GameObject instances (all workers get scripts/components)
    this.needsGameScripts = true;

    // Game objects - one per entity
    this.gameObjects = new Array(this.globalEntityCount).fill(null);

    // Worker identification
    this.workerIndex = 0; // Which worker am I? (0, 1, 2, ...)

    // Multi-worker coordination
    this.totalLogicWorkers = 1; // Total number of logic workers

    // Performance tracking
    this.activeEntityCount = 0; // Number of active entities this worker is processing
    this.entitiesProcessedThisFrame = 0; // Track actual entities processed
    this.systemsExecutedThisFrame = 0; // Track number of distinct update phases executed
    this.frameStartTime = 0; // For timing diagnostics

    // Collision tracking (Unity-style Enter/Stay/Exit from Box2D contacts)

    // Optimized collision tracking using numeric keys instead of strings
    // LOG-PAIR: (min<<16)|max for entity indices < 65536 (zero GC unpack)
    this.previousCollisions = new Set(); // Track collisions from last frame (numeric keys)
    this.currentCollisions = new Set(); // Track collisions in current frame (numeric keys)
    // Stable reference to the latest COMPLETED frame's collision set.
    // previousCollisions/currentCollisions swap every frame, so entity ticks
    // (which run after processCollisionCallbacks) must query through this alias.
    this.frameCollisions = this.currentCollisions;
    this._beginSet = new Set();
    /** @type {Map<number, bigint>} collisionPairKey → packed gens */
    this._collisionGens = new Map();

    // Box2D sequenced contact ring (msg box2dReady)
    this.box2dContactRingI32 = null;
    this.box2dContactCursor = 0;
    this.bodyGeneration = null;
    this.useBox2dContacts = false;

    // Box2D contact-hit + joint-break rings (msg box2dReady, opt-in)
    this.box2dHitRingI32 = null;
    this.box2dHitRingF32 = null;
    this.box2dHitCursor = 0;
    this.useBox2dHits = false;
    this.box2dJointBreakRingI32 = null;
    this.box2dJointBreakCursor = 0;
    this.useBox2dJointBreaks = false;

    // Screen visibility tracking (for onScreenEnter/Exit lifecycle methods)
    // Track previous frame's visibility state to detect transitions
    this.previousScreenVisibility = new Uint8Array(0); // Will be sized in initialize()

    // Collision listener per-type flags (indexed by entityType)
    // Resolved once in createGameObjectInstances, never changes
    this.collisionListenerByType = null; // Uint8Array sized to max entity types
    this.anyTypeNeedsCollisions = false; // Scene-level kill switch

    // Joint-break listener per-type flags (indexed by entityType)
    this.jointBreakListenerByType = null; // Uint8Array sized to max entity types
    this.anyTypeNeedsJointBreaks = false; // Scene-level kill switch

    // ========================================
    // TICK DECIMATION OPTIMIZATION
    // ========================================
    // Entity types are separated into two groups at initialization:
    // - nonDecimatedTypes: tickInterval === 1 (most entities) → simple loop, zero overhead
    // - decimatedTypes: tickInterval > 1 → full countdown logic
    // This eliminates per-entity checks for the common case (no decimation)
    this.nonDecimatedTypes = []; // Array of {EntityClass, activeList} for tickInterval === 1
    this.decimatedTypes = [];    // Array of {EntityClass, activeList, tickInterval} for tickInterval > 1

    // ========================================
    // SPAWN/DESPAWN LIST UPDATE QUEUES
    // ========================================
    // List operations (activeEntities, perTypeActive, queries) are NOT thread-safe.
    // Any worker can spawn/despawn (atomic freeList ops), but list updates are queued
    // and processed by logic0 at the START of each frame (before any ticks).
    // This eliminates race conditions in sorted list insertions/removals.
    this.pendingSpawnListUpdates = [];   // [{entityIndex, entityType, EntityClass}, ...]
    this.pendingDespawnListUpdates = []; // [{entityIndex, entityType, EntityClass}, ...]
    this.receivedListUpdates = [];       // Batch updates received from other workers
    /** @internal Reused by sendListUpdatesToLogic0 to avoid .map() allocation */
    this._spawnSerializedBuffer = [];
    this._despawnSerializedBuffer = [];
  }

  /**
   * Initialize the logic worker (implementation of AbstractWorker.initialize)
   * Sets up shared memory and creates GameObject instances
   */
  initialize(data) {
    // Set worker index for identification
    this.workerIndex = data.workerIndex || 0;

    // Initialize stats buffer for writing metrics (strided access for multi-worker)
    if (data.buffers.logicStats) {
      this.stats = createMultiWorkerStatsWriter(
        data.buffers.logicStats,
        LOGIC_STATS,
        this.workerIndex
      );
      console.log(`LOGIC WORKER ${this.workerIndex}: Stats buffer initialized`);
    }

    if (data.buffers.bodyGeneration) {
      this.bodyGeneration = new Int32Array(data.buffers.bodyGeneration);
    } else if (data.buffers.bodyDirtyFlags) {
      const views = bindBodySyncBuffers(data.buffers);
      this.bodyGeneration = views?.generation ?? null;
    }

    // Deserialize spritesheet metadata for animation lookups
    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);

      // Register proxy sheets for transparent lookups
      if (data.bigAtlasProxySheets) {
        for (const [sheetName, proxyData] of Object.entries(data.bigAtlasProxySheets)) {
          SpriteSheetRegistry.registerProxy(sheetName, proxyData);
        }
        console.log(
          `LOGIC WORKER ${this.workerIndex}: Registered ${Object.keys(data.bigAtlasProxySheets).length
          } proxy sheets`
        );
      }

      // console.log(
      //   `LOGIC WORKER ${this.workerIndex}: Loaded ${
      //     SpriteSheetRegistry.getSpritesheetNames().length
      //   } spritesheets`
      // );
    }

    // Get total logic workers count from config
    this.totalLogicWorkers = data.config?.logic?.numberOfLogicWorkers || 1;

    if (data.impactBuffer) {
      // Sizes derive from config (buffer is allocated as 8 + maxImpactsPerFrame * 24)
      const maxImpacts = data.config?.bullet?.maxImpactsPerFrame ?? 64;
      this._impactHeader = new Int32Array(data.impactBuffer, 0, 2); // [0]=count, [1]=batch sequence
      this._impactData = new Float32Array(data.impactBuffer, 8, maxImpacts * 6);
      this._lastImpactSeq = 0;
    }

    // console.log("LOGIC WORKER: Initializing with component system");

    // Initialize screen visibility tracking array
    this.previousScreenVisibility = new Uint8Array(data.globalEntityCount);
    // Initialize to 0 (off-screen) - first frame will trigger onScreenEnter for visible entities
    this.previousScreenVisibility.fill(0);
    // console.log("LOGIC WORKER: Screen visibility tracking enabled");

    // Note: Game-specific scripts and components are loaded automatically by AbstractWorker.initializeCommonBuffers()
    // All entity classes and components are now available in the worker's global scope with SharedArrayBuffer connections
    //
    // Note: ParticleEmitter and DecorationPool are now initialized by AbstractWorker.initializeCommonBuffers()
    // with shared free lists, enabling any worker to spawn particles/decorations

    // Pre-allocate gameObjects array to keep V8 in dense/packed mode
    // Without this, sparse indices cause V8 to switch to dictionary mode (hash table lookups)
    this.gameObjects = new Array(this.globalEntityCount).fill(null);
    this._gameObjectInstancesCreated = false;

    // GameObject construction waits for box2dReady so setup() can write Transform.x on HEAP.
    // reportReady is deferred until then (shouldReportReadyAfterInit → false).
  }

  shouldReportReadyAfterInit() {
    return false;
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   * DENSE ALLOCATION: entityIndex === componentIndex for all components
   * Call only after bindBox2dHotFields (box2dReady).
   */
  createGameObjectInstances() {
    const numTypes = this.registeredClasses.length;
    this.collisionListenerByType = new Uint8Array(numTypes);
    this.jointBreakListenerByType = new Uint8Array(numTypes);

    for (const classInfo of this.registeredClasses) {
      const { name, poolSize, startIndex, endIndex, entityType } = classInfo;

      const EntityClass = self[name]; // Get class by name from global scope

      if (EntityClass) {
        // Store metadata for spawning system
        EntityClass.startIndex = startIndex;
        EntityClass.poolSize = poolSize;
        EntityClass.endIndex = endIndex;
        EntityClass.entityType = entityType; // Auto-assigned entity type ID

        // Pre-computed typed array of all entity indices for this class
        // Uses Uint16 since max entities = 65535 (fits in 16 bits)
        EntityClass.entityIndices = new Uint16Array(poolSize);
        for (let j = 0; j < poolSize; j++) {
          EntityClass.entityIndices[j] = startIndex + j;
        }

        // CRITICAL: Initialize instances array for THIS class (not inherited from GameObject)
        // Without this, all entity types share GameObject.instances causing spawn bugs
        if (!EntityClass.hasOwnProperty('instances')) {
          EntityClass.instances = [];
        }

        GameObject._assignComponentClassMap(EntityClass);
        const components = GameObject._collectComponents(EntityClass);
        let needsScreenCallbacks = false;
        let needsCollisionCallbacks = false;
        let needsJointBreakCallbacks = false;
        for (const ComponentClass of components) {
          if (ComponentClass === CameraInOutListener) needsScreenCallbacks = true;
          if (ComponentClass === CollisionListener) needsCollisionCallbacks = true;
          if (ComponentClass === JointBreakListener) needsJointBreakCallbacks = true;
        }

        if (needsCollisionCallbacks) {
          this.collisionListenerByType[entityType] = 1;
        }
        if (needsJointBreakCallbacks) {
          this.jointBreakListenerByType[entityType] = 1;
        }

        // Special initialization for internal engine classes
        // Flash needs its initialize() called with the pool size
        // Note: Flash uses Camera class directly for off-screen culling
        if (name === 'Flash' && EntityClass.initialize) {
          EntityClass.initialize(poolSize);
        }

        for (let i = 0; i < poolSize; i++) {
          const index = startIndex + i;

          // DENSE ALLOCATION: entityIndex === componentIndex for all components
          // Create instance - GameObject will use entity index for all component access
          const instance = new EntityClass(index, this.config, this);
          this.gameObjects[index] = instance;

          // Call start() lifecycle method (one-time initialization)
          if (instance.start) {
            instance.start();
          }
        }

        // ========================================
        // TICK DECIMATION: Classify entity type
        // ========================================
        // Separate into decimated vs non-decimated for optimized update loops
        // Only classify if this type has entities (poolSize > 0)
        if (poolSize > 0) {
          const tickInterval = EntityClass.tickInterval || 1;

          if (tickInterval > 1 && GameObject.nextTick) {
            // Decimated type: needs full countdown logic
            this.decimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              tickInterval,
              startIndex,
              needsScreenCallbacks,
            });
          } else {
            // Non-decimated type: simple loop, zero overhead
            this.nonDecimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              startIndex,
              needsScreenCallbacks,
            });
          }
        }
      } else {
        console.warn(`LOGIC WORKER: Class ${name} not found in worker scope!`);
      }
    }

    // Scene-level kill switches: skip drain paths when no type opts in
    this.anyTypeNeedsCollisions = this.collisionListenerByType.includes(1);
    this.anyTypeNeedsJointBreaks = this.jointBreakListenerByType.includes(1);
  }

  // ========================================
  // SPAWN/DESPAWN LIST UPDATE QUEUE METHODS
  // ========================================

  /**
   * Queue a spawn list update (called by GameObject.spawn)
   * The actual list insertion will be done by logic0 at start of frame
   */
  queueSpawnListUpdate(entityIndex, entityType, EntityClass) {
    this.pendingSpawnListUpdates.push({ entityIndex, entityType, EntityClass });
  }

  /**
   * Queue a despawn list update (called by GameObject.despawn)
   * The actual list removal will be done by logic0 at start of frame
   */
  queueDespawnListUpdate(entityIndex, entityType, EntityClass) {
    this.pendingDespawnListUpdates.push({ entityIndex, entityType, EntityClass });
  }

  /**
   * Process all pending list updates (logic0 only, called at start of frame)
   * This ensures all list operations happen single-threaded, avoiding race conditions.
   */
  processListUpdates() {
    let activeQueryPopulationChanged = false;

    // ORDERING: Despawns first, then spawns.
    // This ensures rapid despawn→re-spawn cycles at the same index resolve correctly:
    // the old entry is removed before the new one is added (with dedup preventing duplicates).

    // Process own pending updates
    activeQueryPopulationChanged =
      this._processDespawnUpdates(this.pendingDespawnListUpdates) || activeQueryPopulationChanged;
    activeQueryPopulationChanged =
      this._processSpawnUpdates(this.pendingSpawnListUpdates) || activeQueryPopulationChanged;
    this.pendingDespawnListUpdates.length = 0;
    this.pendingSpawnListUpdates.length = 0;

    // Process updates received from other workers (same order)
    for (const batch of this.receivedListUpdates) {
      if (batch.despawns) {
        activeQueryPopulationChanged =
          this._processDespawnUpdates(batch.despawns) || activeQueryPopulationChanged;
      }
      if (batch.spawns) {
        activeQueryPopulationChanged =
          this._processSpawnUpdates(batch.spawns) || activeQueryPopulationChanged;
      }
    }
    this.receivedListUpdates.length = 0;

    // Invalidate cached non-precomputed active queries once after the full batch.
    if (activeQueryPopulationChanged && this.queryVersionData) {
      Atomics.add(this.queryVersionData, 0, 1);
    }

    if (activeQueryPopulationChanged && this._publishPrecomputedActiveQueries) {
      this._publishPrecomputedActiveQueries(this.frameNumber);
    }
  }

  /**
   * Process spawn list updates - add entities to active lists
   */
  _processSpawnUpdates(updates) {
    let changed = false;
    for (const update of updates) {
      const { entityIndex, EntityClass } = update;
      // Only add if entity is still active (wasn't despawned in same frame)
      if (Transform.active[entityIndex] === 1) {
        GameObject._addToActiveEntities(entityIndex);
        GameObject._addToTypeActiveList(EntityClass, entityIndex);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Process despawn list updates - remove entities from active lists
   * No active-state guard: despawns are processed BEFORE spawns, so a re-spawned
   * entity will be re-added in the subsequent spawn pass (with dedup protection).
   */
  _processDespawnUpdates(updates) {
    if (!updates || updates.length === 0) {
      return false;
    }

    for (const update of updates) {
      const { entityIndex, EntityClass } = update;
      GameObject._removeFromActiveEntities(entityIndex);
      GameObject._removeFromTypeActiveList(EntityClass, entityIndex);
    }
    return true;
  }

  /**
   * Send pending list updates to logic0 (called at end of frame by non-logic0 workers)
   */
  sendListUpdatesToLogic0() {
    if (this.pendingSpawnListUpdates.length === 0 && this.pendingDespawnListUpdates.length === 0) {
      return true;
    }

    // Serialize EntityClass to class name for message passing (reuse buffers to avoid .map() allocation)
    const spawns = this._spawnSerializedBuffer;
    const despawns = this._despawnSerializedBuffer;
    spawns.length = 0;
    despawns.length = 0;

    for (const u of this.pendingSpawnListUpdates) {
      spawns.push({ entityIndex: u.entityIndex, entityType: u.entityType, className: u.EntityClass.name });
    }
    for (const u of this.pendingDespawnListUpdates) {
      despawns.push({ entityIndex: u.entityIndex, entityType: u.entityType, className: u.EntityClass.name });
    }

    const sent = this.sendDataToWorker('logic0', {
      msg: 'listUpdates',
      spawns,
      despawns,
    });

    if (sent) {
      this.pendingSpawnListUpdates.length = 0;
      this.pendingDespawnListUpdates.length = 0;
    }

    return sent;
  }

  /** Read-only pose latch for Camera.followEntity. Pre_render owns sync[1]. */
  _latchDisplayPose() {
    this._latchPose(false);
    Camera.bindDisplayPose(this._poseX, this._poseY, this._poseRotC, this._poseRotS);
  }

  update(deltaTime, dtRatio, resuming) {
    this.frameStartTime = performance.now();
    this._latchDisplayPose();

    // Reset stats for this frame
    this.entitiesProcessedThisFrame = 0;
    this.systemsExecutedThisFrame = 0;
    this.entityTimeThisFrame = 0;
    this.raycastMsThisFrame = 0;
    this.raycastCountThisFrame = 0;
    this.decimateMsThisFrame = 0;
    this.tickMsThisFrame = 0;
    if (this.collectDetailedStats) Ray.beginFrame();

    // Process bullet impacts from particle_worker (SAB poll - no message needed)
    // Gated on the batch sequence so each batch is processed exactly once,
    // regardless of logic/particle frame-rate differences (no double damage,
    // no reprocessing of stale batches).
    if (this._impactHeader) {
      const seq = Atomics.load(this._impactHeader, 1);
      if (seq !== this._lastImpactSeq) {
        this._lastImpactSeq = seq;
        const count = Atomics.load(this._impactHeader, 0);
        if (count > 0) this.processImpacts(count);
      }
    }

    // ========================================
    // PHASE 0: PROCESS LIST UPDATES (logic0 only)
    // ========================================
    // All spawn/despawn list updates are queued and processed here BEFORE any ticks.
    // This ensures single-threaded list operations, avoiding race conditions.
    if (this.workerIndex === 0) {
      this.processListUpdates();
    }

    // Snapshot mouse edge flags BEFORE entity ticks so isButton0Pressed etc. are
    // stable for the entire frame. Every worker does this independently.
    Mouse.updateEdgeFlags();

    // Process collision/hit/joint-break callbacks BEFORE entity logic (Unity-style).
    // Contacts/hits need CollisionListener; joint breaks need JointBreakListener.
    // hitSab always exists — do not let useBox2dHits bypass the listener kill switch.
    if (
      (this.anyTypeNeedsCollisions && (this.useBox2dContacts || this.useBox2dHits)) ||
      (this.anyTypeNeedsJointBreaks && this.useBox2dJointBreaks)
    ) {
      this.processCollisionCallbacks();
      this.systemsExecutedThisFrame++;
    }

    // Count active entities while processing
    let activeCount = 0;

    // DETERMINISTIC MODULO: Each worker processes entities where (idx % totalWorkers === workerIndex)
    // Applied per-type to maintain fair load distribution
    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;

    // Cache hot references outside all loops
    const gameObjects = this.gameObjects;
    const accTime = this.accumulatedTime;
    const frameNum = this.frameNumber;
    const transformActive = Transform.active; // Cache for active check

    const collectDetailed = this.collectDetailedStats;
    const tEntity0 = collectDetailed ? performance.now() : 0;
    let decimateMs = 0;
    let tickMs = 0;

    // ========================================
    // PHASE 1: NON-DECIMATED ENTITIES (FAST PATH)
    // ========================================
    // Zero decimation overhead - no countdown checks, no prototype lookups
    // This is the common case for most entity types
    const nonDecimatedTypes = this.nonDecimatedTypes;
    const nonDecimatedCount = nonDecimatedTypes.length;

    for (let t = 0; t < nonDecimatedCount; t++) {
      const typeInfo = nonDecimatedTypes[t];
      const activeList = typeInfo.activeList;
      const count = Math.min(activeList[0], activeList.length - 1);
      const needsScreenCallbacks = typeInfo.needsScreenCallbacks;

      // Worker partitioning within this type's active list
      for (let idx = myIndex; idx < count; idx += totalWorkers) {
        const entityIndex = activeList[1 + idx];

        // Skip despawned entities (may still be in list until logic0 processes removal)
        if (transformActive[entityIndex] === 0) continue;

        const obj = gameObjects[entityIndex];
        if (!obj || typeof obj.tick !== 'function') continue;

        activeCount++;
        this.entitiesProcessedThisFrame++;

        if (collectDetailed) {
          const tTick0 = performance.now();
          obj.tick(dtRatio, deltaTime, accTime, frameNum);
          tickMs += performance.now() - tTick0;
        } else {
          obj.tick(dtRatio, deltaTime, accTime, frameNum);
        }

        if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
      }
    }

    // ========================================
    // PHASE 2: DECIMATED ENTITIES (COUNTDOWN PATH)
    // ========================================
    // Full countdown logic for entities with tickInterval > 1
    // tickInterval is cached per-type (no prototype lookup in inner loop)
    const decimatedTypes = this.decimatedTypes;
    const decimatedCount = decimatedTypes.length;
    const nextTick = GameObject.nextTick; // Cache the typed array reference

    if (decimatedCount > 0 && nextTick) {
      // Cache RigidBody arrays for acceleration scaling
      const rbAx = RigidBody.ax;
      const rbAy = RigidBody.ay;

      for (let t = 0; t < decimatedCount; t++) {
        const typeInfo = decimatedTypes[t];
        const activeList = typeInfo.activeList;
        const count = Math.min(activeList[0], activeList.length - 1);
        const tickInterval = typeInfo.tickInterval; // Pre-cached, no prototype lookup
        const needsScreenCallbacks = typeInfo.needsScreenCallbacks;

        // Worker partitioning within this type's active list
        for (let idx = myIndex; idx < count; idx += totalWorkers) {
          const entityIndex = activeList[1 + idx];

          // Skip despawned entities (may still be in list until logic0 processes removal)
          if (transformActive[entityIndex] === 0) continue;

          const obj = gameObjects[entityIndex];
          if (!obj || typeof obj.tick !== 'function') continue;

          activeCount++;
          this.entitiesProcessedThisFrame++;

          const tVisit0 = collectDetailed ? performance.now() : 0;

          // TICK DECIMATION: Check countdown
          if (--nextTick[entityIndex] > 0) {
            if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
            if (collectDetailed) decimateMs += performance.now() - tVisit0;
            continue;
          }

          // Reset countdown for next cycle
          nextTick[entityIndex] = tickInterval;

          // Tick entity logic
          obj.tick(dtRatio, deltaTime, accTime, frameNum);

          // ACCELERATION SCALING: Compensate for tick decimation
          // Scale acceleration by tickInterval so physics integrates same total impulse
          rbAx[entityIndex] *= tickInterval;
          rbAy[entityIndex] *= tickInterval;

          if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
          if (collectDetailed) tickMs += performance.now() - tVisit0;
        }
      }
    }

    if (collectDetailed) {
      this.entityTimeThisFrame = performance.now() - tEntity0;
      this.decimateMsThisFrame = decimateMs;
      this.tickMsThisFrame = tickMs;
      const rayStats = Ray.consumeStats();
      this.raycastMsThisFrame = rayStats.ms;
      this.raycastCountThisFrame = rayStats.count;
    }

    // Entity processing system executed
    if (this.entitiesProcessedThisFrame > 0) {
      this.systemsExecutedThisFrame++; // Entity tick system executed
    }

    // Store active count for FPS reporting
    this.activeEntityCount = activeCount;

    // ========================================
    // PHASE 3: SEND LIST UPDATES TO LOGIC0 (non-logic0 workers)
    // ========================================
    // At end of frame, send any queued spawn/despawn list updates to logic0
    if (this.workerIndex !== 0) {
      this.sendListUpdatesToLogic0();
    }

    Mouse.snapshotPreviousFrame();
  }

  /**
   * Process bullet impact events from particle_worker.
   * Partitioned by targetId % totalWorkers - each worker processes impacts for its entities.
   */
  processImpacts(count) {
    if (!count || !this._impactData || count <= 0) return;
    const impactData = this._impactData;
    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const gameObjects = this.gameObjects;

    for (let i = 0; i < count; i++) {
      const base = i * 6;
      const targetId = impactData[base] | 0;
      if (targetId % totalWorkers !== myIndex) continue;

      const damage = impactData[base + 1];
      const hitX = impactData[base + 2];
      const hitY = impactData[base + 3];
      const ownerId = impactData[base + 4] | 0;
      const shooterEntityType = impactData[base + 5] | 0;

      const obj = gameObjects[targetId];
      if (obj && obj.onGotShot) {
        obj.onGotShot(damage, hitX, hitY, ownerId, shooterEntityType);
      }
    }
  }

  /**
   * Process collision callbacks (Unity-style)
   * Determines Enter/Stay/Exit states and calls appropriate callbacks
   * Partitions CALLBACK dispatch across workers using modulo (minEntity % workers == myIndex),
   * but EVERY worker records EVERY pair in its collision set so isCollidingWith()
   * works regardless of which worker ticks the querying entity.
   * OPTIMIZED: Normalized (min,max) ordering - ONE key per collision pair (half the storage)
   * ZERO ALLOC: Cantor pairing (exact float math, no Int32 overflow) + inline min/max, no string concat
   */
  /**
   * Unity-style Enter/Stay/Exit from Box2D begin/end (Delta Stay).
   */
  processCollisionCallbacks() {
    if (this.anyTypeNeedsCollisions) {
      if (this.useBox2dContacts) this._processBox2dCollisionCallbacks();
      if (this.useBox2dHits) this._processBox2dHitCallbacks();
    }
    if (this.anyTypeNeedsJointBreaks && this.useBox2dJointBreaks) {
      this._processBox2dJointBreakCallbacks();
    }
  }

  /**
   * Drain contact-hit ring (opt-in Collider.enableHitEvents) — same worker
   * partition + gen-validation rules as begin/end contacts.
   */
  _processBox2dHitCallbacks() {
    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const gameObjects = this.gameObjects;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;

    const result = drainContactHitRing(
      this.box2dHitRingI32,
      this.box2dHitRingF32,
      this.box2dHitCursor,
      (a, b, genA, genB, px, py, nx, ny, speed) => {
        if (this._entityGen(a) !== (genA | 0) || this._entityGen(b) !== (genB | 0)) return;
        if (!Transform.active[a] || !Transform.active[b]) return;
        const minE = a < b ? a : b;
        if (minE % totalWorkers !== myIndex) return;
        const aListens = collisionFlags[entityType[a]];
        const bListens = collisionFlags[entityType[b]];
        if (aListens) gameObjects[a]?.onCollisionHit(b, px, py, nx, ny, speed);
        if (bListens) gameObjects[b]?.onCollisionHit(a, px, py, -nx, -ny, speed);
      },
    );
    this.box2dHitCursor = result.nextCursor;
  }

  /**
   * Drain joint-break ring — same worker partition + gen-validation rules as contacts.
   * Dispatch only to entity types with JointBreakListener.
   */
  _processBox2dJointBreakCallbacks() {
    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const gameObjects = this.gameObjects;
    const entityType = Transform.entityType;
    const jointBreakFlags = this.jointBreakListenerByType;

    const result = drainJointBreakRing(
      this.box2dJointBreakRingI32,
      this.box2dJointBreakCursor,
      (jointIndex, entityA, entityB, genA, genB) => {
        if (this._entityGen(entityA) !== (genA | 0) || this._entityGen(entityB) !== (genB | 0)) return;
        if (!Transform.active[entityA] || !Transform.active[entityB]) return;
        const minE = entityA < entityB ? entityA : entityB;
        if (minE % totalWorkers !== myIndex) return;
        const aListens = jointBreakFlags[entityType[entityA]];
        const bListens = jointBreakFlags[entityType[entityB]];
        if (!aListens && !bListens) return;
        if (aListens) gameObjects[entityA]?.onJointBreak(jointIndex, entityA, entityB);
        if (bListens) gameObjects[entityB]?.onJointBreak(jointIndex, entityA, entityB);
      },
    );
    this.box2dJointBreakCursor = result.nextCursor;
  }

  _packGens(genA, genB) {
    return (BigInt(genA >>> 0) << 32n) | BigInt(genB >>> 0);
  }

  _entityGen(i) {
    return this.bodyGeneration ? Atomics.load(this.bodyGeneration, i) | 0 : 0;
  }

  _gensMatch(key, genA, genB) {
    const packed = this._collisionGens.get(key);
    if (packed === undefined) return false;
    return packed === this._packGens(genA, genB);
  }

  _pairStillValid(minE, maxE, key) {
    if (!Transform.active[minE] || !Transform.active[maxE]) return false;
    const ga = this._entityGen(minE);
    const gb = this._entityGen(maxE);
    return this._gensMatch(key, ga, gb);
  }

  _clearContactState(reason) {
    this.previousCollisions.clear();
    this._collisionGens.clear();
    this._beginSet.clear();
    if (reason) {
      console.warn(`LOGIC WORKER ${this.workerIndex}: contact state cleared (${reason})`);
    }
  }

  _applyContactEnd(rawA, rawB, genA, genB) {
    const minE = rawA < rawB ? rawA : rawB;
    const maxE = rawA < rawB ? rawB : rawA;
    const key = collisionPairKey(minE, maxE);
    if (!this.previousCollisions.has(key)) return;
    if (!this._gensMatch(key, genA, genB)) {
      this.previousCollisions.delete(key);
      this._collisionGens.delete(key);
      return;
    }
    this.previousCollisions.delete(key);
    this._collisionGens.delete(key);
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = collisionFlags[entityType[minE]];
    const bListens = collisionFlags[entityType[maxE]];
    if (aListens) gameObjects[minE]?.onCollisionExit(maxE);
    if (bListens) gameObjects[maxE]?.onCollisionExit(minE);
  }

  _applyContactBegin(rawA, rawB, genA, genB) {
    // Reject stale gens relative to current bodyGeneration
    if (this._entityGen(rawA) !== (genA | 0) || this._entityGen(rawB) !== (genB | 0)) {
      return;
    }
    if (!Transform.active[rawA] || !Transform.active[rawB]) return;

    const minE = rawA < rawB ? rawA : rawB;
    const maxE = rawA < rawB ? rawB : rawA;
    const key = collisionPairKey(minE, maxE);
    const isNew = !this.previousCollisions.has(key);
    this.previousCollisions.add(key);
    this._collisionGens.set(key, this._packGens(genA, genB));
    this._beginSet.add(key);
    if (!isNew) return;
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = collisionFlags[entityType[rawA]];
    const bListens = collisionFlags[entityType[rawB]];
    if (!aListens && !bListens) return;
    if (aListens) gameObjects[rawA]?.onCollisionEnter(rawB);
    if (bListens) gameObjects[rawB]?.onCollisionEnter(rawA);
  }

  _processBox2dCollisionCallbacks() {
    if (!this.useBox2dContacts || !this.box2dContactRingI32) return;

    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const gameObjects = this.gameObjects;
    const active = this.previousCollisions;
    const beginSet = this._beginSet;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const KIND = BOX2D_CONTACT_KIND;

    beginSet.clear();

    const result = drainContactRing(
      this.box2dContactRingI32,
      this.box2dContactCursor,
      (kind, a, b, genA, genB) => {
        if (kind === KIND.CONTACT_END || kind === KIND.SENSOR_END) {
          this._applyContactEnd(a, b, genA, genB);
        } else if (kind === KIND.CONTACT_BEGIN || kind === KIND.SENSOR_BEGIN) {
          this._applyContactBegin(a, b, genA, genB);
        }
      },
    );
    this.box2dContactCursor = result.nextCursor;
    if (result.overrun) {
      // Cold start: no tracked pairs — catch up silently (common when first
      // physics steps flood the ring before logic drains).
      if (active.size === 0 && this._collisionGens.size === 0) {
        this.frameCollisions = active;
        return;
      }
      this._clearContactState('contact ring overrun');
      this.frameCollisions = active;
      return;
    }

    // Purge pairs whose generation changed or entities went inactive
    for (const key of active) {
      collisionPairUnpack(key, _cantorResult);
      const minE = _cantorResult.a;
      const maxE = _cantorResult.b;
      if (!this._pairStillValid(minE, maxE, key)) {
        active.delete(key);
        this._collisionGens.delete(key);
        continue;
      }
      if (beginSet.has(key)) continue;
      if (minE % totalWorkers !== myIndex) continue;
      const aListens = collisionFlags[entityType[minE]];
      const bListens = collisionFlags[entityType[maxE]];
      if (aListens) gameObjects[minE]?.onCollisionStay(maxE);
      if (bListens) gameObjects[maxE]?.onCollisionStay(minE);
    }

    this.frameCollisions = active;
  }

  /**
   * Check screen visibility changes and trigger lifecycle methods
   * Detects when entities enter or exit the screen and calls onScreenEnter/onScreenExit
   * @param {number} entityIndex - The entity's index
   * @param {GameObject} obj - The entity instance
   */
  checkScreenVisibility(entityIndex, obj) {
    const currentlyVisible = Transform.isItOnScreen[entityIndex];
    const wasVisible = this.previousScreenVisibility[entityIndex];

    // Check for visibility state transitions
    if (currentlyVisible && !wasVisible) {
      // Entity just entered the screen
      // if (obj.onScreenEnter) {
      obj.onScreenEnter();
      // }
    } else if (!currentlyVisible && wasVisible) {
      // Entity just exited the screen
      // if (obj.onScreenExit) {
      obj.onScreenExit();
      // }
    }

    // Update previous visibility state for next frame
    this.previousScreenVisibility[entityIndex] = currentlyVisible;
  }

  /**
   * Handle custom messages from main thread or other workers
   * Implements spawning and despawning commands
   */
  handleCustomMessage(data) {
    const { msg } = data;

    switch (msg) {
      case 'box2dReady': {
        bindBox2dHotFields(data);
        if (data.commandSab) {
          bindCommandRing(data.commandSab);
        }
        if (data.queryAabbSab) {
          bindQueryAabbSab(data.queryAabbSab);
        }
        if (data.rayCastSab) {
          bindRayCastSab(data.rayCastSab);
        }
        if (data.liquidFunQuerySab) {
          bindLiquidFunQuerySab(data.liquidFunQuerySab);
        }
        if (data.liquidFunExtractSab) {
          bindLiquidFunExtractSab(data.liquidFunExtractSab);
        }
        if (data.liquidFunHeap) {
          LiquidFun.bindHeapPose(data.liquidFunHeap);
        }
        if (data.movedSab) {
          bindMovedBodies(data.movedSab);
        }
        if (data.contactSab) {
          bindContactRing(data.contactSab);
          this.box2dContactRingI32 = new Int32Array(data.contactSab);
          // Snap to write head — physics may already be producing events.
          this.box2dContactCursor = initialContactCursor(this.box2dContactRingI32);
          this.useBox2dContacts = true;
          console.log(`LOGIC WORKER ${this.workerIndex}: Box2D contact ring bound`);
        } else {
          this.box2dContactRingI32 = null;
          this.useBox2dContacts = false;
        }
        if (data.hitSab) {
          bindContactHitRing(data.hitSab);
          this.box2dHitRingI32 = new Int32Array(data.hitSab);
          this.box2dHitRingF32 = new Float32Array(data.hitSab);
          this.box2dHitCursor = initialContactHitCursor(this.box2dHitRingI32);
          this.useBox2dHits = true;
        } else {
          this.box2dHitRingI32 = null;
          this.box2dHitRingF32 = null;
          this.useBox2dHits = false;
        }
        if (data.jointBreakSab) {
          bindJointBreakRing(data.jointBreakSab);
          this.box2dJointBreakRingI32 = new Int32Array(data.jointBreakSab);
          this.box2dJointBreakCursor = initialJointBreakCursor(this.box2dJointBreakRingI32);
          this.useBox2dJointBreaks = true;
        } else {
          this.box2dJointBreakRingI32 = null;
          this.useBox2dJointBreaks = false;
        }

        // HEAP bound — construct pools so setup() writes live Transform.x, then signal ready.
        if (!this._gameObjectInstancesCreated) {
          this.createGameObjectInstances();
          this._gameObjectInstancesCreated = true;
          this.reportReady();
          console.log(
            `LOGIC WORKER ${this.workerIndex}: GameObjects created after box2dReady, workerReady sent`
          );
        }
        break;
      }
      case 'spawn': {
        // Only worker 0 handles spawn messages to avoid race conditions
        // All workers receive the broadcast, but only worker 0 actually spawns
        if (this.workerIndex !== 0) {
          break; // Ignore spawn messages on other workers
        }

        const { className, spawnConfig, entityIndex } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot spawn ${className} - class not found!`
          );
          return;
        }

        // If entityIndex is provided, use pre-assigned index from main thread
        // Otherwise, let GameObject.spawn acquire a new index
        const instance = GameObject.spawn(EntityClass, spawnConfig, entityIndex);
        if (!instance) {
          console.warn(
            `LOGIC WORKER ${this.workerIndex}: Failed to spawn ${className} - pool exhausted!`
          );
        }
        break;
      }

      case 'despawn': {
        // Only worker 0 handles despawn messages from main thread
        if (this.workerIndex !== 0) {
          break;
        }

        const { entityIndex } = data;

        // Basic validation
        if (entityIndex < 0 || entityIndex >= this.globalEntityCount) {
          break;
        }

        // Get the instance and despawn it
        // Note: despawn() internally checks Transform.active to prevent double-despawn
        const instance = this.gameObjects[entityIndex];
        if (instance && instance.despawn) {
          instance.despawn();
        }
        break;
      }

      // NOTE: spawnRequest and despawnRequest handlers removed
      // Entity spawn/despawn now uses atomic SAB-backed free lists
      // Any worker can spawn/despawn directly without routing to worker-0

      case 'despawnAll': {
        // Only worker 0 handles despawnAll to avoid duplicate processing
        // (message is broadcast to all workers, but only one should act on it)
        if (this.workerIndex !== 0) {
          break;
        }

        const { className } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot despawn ${className} - class not found!`
          );
          return;
        }

        // Use unified batch despawn which handles:
        // - Lifecycle hooks (onDespawned)
        // - Component deactivation
        // - Active list removal
        // - Query cache updates
        // - Free list reset (SAB-backed, interleaved)
        const despawnedCount = GameObject.despawnAll(EntityClass);

        console.log(
          `LOGIC WORKER ${this.workerIndex}: Despawned ${despawnedCount} ${className} entities`
        );
        break;
      }

      case 'restoreSave': {
        if (this.workerIndex !== 0) break;

        const { serializableClassNames = [], entities = [], joints = [] } = data;
        let restored = 0;
        let failed = 0;
        const oldToNew = new Map();

        for (let i = 0; i < serializableClassNames.length; i++) {
          const EntityClass = self[serializableClassNames[i]];
          if (EntityClass) GameObject.despawnAll(EntityClass);
        }

        if (typeof Joint.clearAllActive === 'function') {
          Joint.clearAllActive();
        }

        for (let i = 0; i < entities.length; i++) {
          const rec = entities[i];
          const EntityClass = self[rec.typeName];
          if (!EntityClass) {
            console.error(
              `LOGIC WORKER ${this.workerIndex}: restoreSave missing class ${rec.typeName}`
            );
            failed++;
            continue;
          }
          const fields = rec.components?.Transform?.fields || {};
          const spawnConfig = {
            x: fields.x ?? 0,
            y: fields.y ?? 0,
            _saveRestore: rec.components,
          };
          const instance = GameObject.spawn(EntityClass, spawnConfig);
          if (!instance) {
            console.warn(
              `LOGIC WORKER ${this.workerIndex}: restoreSave spawn failed for ${rec.typeName}`
            );
            failed++;
          } else {
            restored++;
            if (rec.entityIndex != null && rec.entityIndex >= 0) {
              oldToNew.set(rec.entityIndex | 0, instance.index | 0);
            }
          }
        }

        let jointsRestored = 0;
        if (joints.length && typeof Joint.restoreFromSave === 'function') {
          const created = Joint.restoreFromSave(joints, oldToNew);
          jointsRestored = created.length;
        }

        // Flush active lists before ack so entities are fully in the scene.
        this.processListUpdates();
        self.postMessage({
          msg: 'restoreSaveComplete',
          restored,
          failed,
          jointsRestored,
        });
        break;
      }

      case 'clearAll': {
        // Only worker 0 handles clearAll to keep freeList synchronized with spawn
        if (this.workerIndex !== 0) {
          break;
        }

        // Despawn all entities of each type using unified batch despawn
        let totalDespawned = 0;
        for (const classInfo of this.registeredClasses) {
          const EntityClass = self[classInfo.name];
          if (!EntityClass) continue;

          totalDespawned += GameObject.despawnAll(EntityClass);
        }

        // console.log(
        //   `LOGIC WORKER ${this.workerIndex}: Cleared ${totalDespawned} entities`
        // );
        break;
      }

      case 'listUpdates': {
        // Only worker 0 processes list updates from other workers
        if (this.workerIndex !== 0) {
          break;
        }

        // Deserialize class names to EntityClass references (single-pass loop avoids .map/.filter intermediates)
        const { spawns, despawns } = data;
        const deserializedSpawns = [];
        const deserializedDespawns = [];

        if (spawns) {
          for (let i = 0; i < spawns.length; i++) {
            const u = spawns[i];
            const EntityClass = self[u.className];
            if (EntityClass) {
              deserializedSpawns.push({ entityIndex: u.entityIndex, entityType: u.entityType, EntityClass });
            }
          }
        }
        if (despawns) {
          for (let i = 0; i < despawns.length; i++) {
            const u = despawns[i];
            const EntityClass = self[u.className];
            if (EntityClass) {
              deserializedDespawns.push({ entityIndex: u.entityIndex, entityType: u.entityType, EntityClass });
            }
          }
        }

        if (deserializedSpawns.length > 0 || deserializedDespawns.length > 0) {
          this.receivedListUpdates.push({
            spawns: deserializedSpawns,
            despawns: deserializedDespawns,
          });
        }
        break;
      }

      default:
        super.handleCustomMessage(data);
        break;
    }
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    if (!this.stats) return;
    this.stats[LOGIC_STATS.FPS] = this.currentFPS;
    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
    this.stats[LOGIC_STATS.SYSTEMS_EXECUTED] = this.systemsExecutedThisFrame;
    this.stats[LOGIC_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[LOGIC_STATS.RAYCAST_MS] = this.raycastMsThisFrame || 0;
    this.stats[LOGIC_STATS.RAYCAST_COUNT] = this.raycastCountThisFrame || 0;
    this.stats[LOGIC_STATS.ENTITY_MS] = this.entityTimeThisFrame || 0;
    this.stats[LOGIC_STATS.DECIMATE_MS] = this.decimateMsThisFrame || 0;
    this.stats[LOGIC_STATS.TICK_MS] = this.tickMsThisFrame || 0;
  }
}

// Create singleton instance and setup message handler
self.logicWorker = new LogicWorker(self);
