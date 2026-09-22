self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// Runs GameObject.tick / AI; steering writes RigidBody accel fields for Box2D

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
import { logicBlockRange, logicWorkerThatShouldTick, tickBucketPhase } from '../util/logicOwner.js';

import { LOGIC_STATS, createMultiWorkerStatsWriter } from '../util/workersUtils.js';
import { Ray } from '../core/ray.js';
import { Box2d } from '../core/box2d.js';
import { _cantorResult, collisionPairKey, collisionPairUnpack } from '../util/utils.js';
import { EntityIdArray } from '../util/entityIdWidth.js';
import { bindBox2dHotFields } from '../box2d/box2dHotFields.js';
import { bindCommandRing } from '../box2d/box2dCommandRing.js';
import { bindQueryAabbSab } from '../box2d/box2dQueryAabb.js';
import { bindOverlapCircleSab } from '../box2d/box2dOverlapCircle.js';
import { bindRayCastSab } from '../box2d/box2dRayCast.js';
import { bindCastRayAllSab } from '../box2d/box2dCastRayAll.js';
import { bindLiquidFunQuerySab } from '../box2d/liquidFunQuery.js';
import { bindLiquidFunExtractSab } from '../box2d/liquidFunExtract.js';
import { bindLiquidFunUserDataListSab } from '../box2d/liquidFunUserDataList.js';
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
import { mergeSortedIntoActiveList } from '../util/gameObjectActiveState.js';
import {
  SPAWN_CMD_KIND,
  drainSpawnCommands,
  isSpawnCommandRingBound,
} from '../util/spawnCommandRing.js';

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
    this.queryPublishMsThisFrame = 0;

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
    /** @type {Map<number, number>} collisionPairKey → genA uint32 */
    this._collisionGenA = new Map();
    /** @type {Map<number, number>} collisionPairKey → genB uint32 */
    this._collisionGenB = new Map();
    this._onContactRingEvent = this._onContactRingEvent.bind(this);
    this._onHitRingEvent = this._onHitRingEvent.bind(this);
    this._onJointBreakRingEvent = this._onJointBreakRingEvent.bind(this);

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
    // Entity types are separated at initialization:
    // - skipped: no tick override (or tickInterval === 0) and no CameraInOutListener
    // - nonDecimatedTypes: tickInterval === 1 (most entities) → simple loop
    // - decimatedTypes: tickInterval > 1 → countdown
    this.nonDecimatedTypes = []; // Array of {EntityClass, activeList} for tickInterval === 1
    this.decimatedTypes = [];    // Array of {EntityClass, activeList, tickInterval} for tickInterval > 1
    this.tickAllTypes = [];      // static tickAll, no tick() override

    // ========================================
    // SPAWN/DESPAWN LIST UPDATE QUEUES
    // ========================================
    // List operations (activeEntities, perTypeActive, queries) are NOT thread-safe.
    // Any worker can spawn/despawn (atomic freeList ops), but list updates are queued
    // and processed by logic0 at the START of each frame (before any ticks).
    // This eliminates race conditions in sorted list insertions/removals.
    this.receivedListUpdates = [];       // Batch updates received from other workers
    /** @internal Reused by sendListUpdatesToLogic0 to avoid .map() allocation */
    this._spawnSerializedBuffer = [];
    this._despawnSerializedBuffer = [];
    this._spawnCap = 256;
    this._spawnIdx = new Int32Array(256);
    this._spawnType = new Int32Array(256);
    this._spawnClass = new Array(256);
    this._spawnPerm = new Int32Array(256);
    this._spawnSorted = new Int32Array(256);
    this._spawnSortedClass = new Array(256);
    this._spawnN = 0;
    this._spawnXyScratch = { x: 0, y: 0 };
    this._listMergeScratch = null;
    this._entityClassByType = [];
    this._drainingSpawnRing = false;
    this._pendingDrainExtras = null;
    this._despawnCap = 256;
    this._despawnIdx = new Int32Array(256);
    this._despawnType = new Int32Array(256);
    this._despawnClass = new Array(256);
    this._despawnN = 0;
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
    this._listMergeScratch = new (EntityIdArray())(1 + (this.globalEntityCount || 1));
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

    // setup() writes Transform.x. With WASM, wait for box2dReady. With weed pose, bind already ran.
    if (this._weedPoseBound && !this._gameObjectInstancesCreated) {
      this.createGameObjectInstances();
      this._gameObjectInstancesCreated = true;
    }
  }

  shouldReportReadyAfterInit() {
    return this._weedPoseBound === true;
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   * DENSE ALLOCATION: entityIndex === componentIndex for all components
   * Call after pose bind (box2dReady HEAP, or weed pose at init when physics is off).
   */
  createGameObjectInstances() {
    const numTypes = this.registeredClasses.length;
    this.collisionListenerByType = new Uint8Array(numTypes);
    this.jointBreakListenerByType = new Uint8Array(numTypes);
    this.markActiveTypes = [];
    this._entityClassByType = [];

    for (const classInfo of this.registeredClasses) {
      const { name, poolSize, startIndex, endIndex, entityType } = classInfo;

      const EntityClass = self[name]; // Get class by name from global scope

      if (EntityClass) {
        // Store metadata for spawning system
        EntityClass.startIndex = startIndex;
        EntityClass.poolSize = poolSize;
        EntityClass.endIndex = endIndex;
        EntityClass.entityType = entityType; // Auto-assigned entity type ID
        this._entityClassByType[entityType] = EntityClass;

        // Pre-computed typed array of all entity indices for this class
        // Uses Uint16 since max entities = 65535 (fits in 16 bits)
        EntityClass.entityIndices = new (EntityIdArray())(poolSize);
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
        let hasRigidBody = false;
        for (const ComponentClass of components) {
          if (ComponentClass === CameraInOutListener) needsScreenCallbacks = true;
          if (ComponentClass === CollisionListener) needsCollisionCallbacks = true;
          if (ComponentClass === JointBreakListener) needsJointBreakCallbacks = true;
          if (ComponentClass === RigidBody) hasRigidBody = true;
        }

        if (needsCollisionCallbacks) {
          this.collisionListenerByType[entityType] = 1;
        }
        if (needsJointBreakCallbacks) {
          this.jointBreakListenerByType[entityType] = 1;
        }
        if (EntityClass.reportMarkActive) {
          this.markActiveTypes.push(EntityClass);
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
          const needsTick = GameObject.typeNeedsLogicTick(EntityClass);
          const hasTickAll = GameObject.typeHasTickAll(EntityClass);
          if (hasTickAll && !needsTick && !needsScreenCallbacks) {
            this.tickAllTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              startIndex,
              entityType,
              hasRigidBody,
            });
          } else if (!needsTick && !needsScreenCallbacks) {
            // Tickless: stay on active lists for queries/spatial/physics/render.
          } else {
            const rawInterval = EntityClass.tickInterval;
            const tickInterval = rawInterval == null ? 1 : (rawInterval | 0);

            if (needsTick && tickInterval > 1 && GameObject.nextTick) {
              this.decimatedTypes.push({
                EntityClass,
                activeList: EntityClass._activeList,
                tickInterval,
                startIndex,
                entityType,
                needsScreenCallbacks,
                hasRigidBody,
              });
            } else {
              this.nonDecimatedTypes.push({
                EntityClass,
                activeList: EntityClass._activeList,
                startIndex,
                entityType,
                needsScreenCallbacks,
                hasRigidBody,
              });
            }
          }
        }
      } else {
        console.warn(`LOGIC WORKER: Class ${name} not found in worker scope!`);
      }
    }

    // Scene-level kill switches: skip drain paths when no type opts in
    this.anyTypeNeedsCollisions = this.collisionListenerByType.includes(1);
    this.anyTypeNeedsJointBreaks = this.jointBreakListenerByType.includes(1);
    this._tickAllScratch = new (EntityIdArray())(this.globalEntityCount || 1);
  }

  // ========================================
  // SPAWN/DESPAWN LIST UPDATE QUEUE METHODS
  // ========================================

  /**
   * Queue a spawn list update (called by GameObject.spawn)
   * The actual list insertion will be done by logic0 at start of frame
   */
  _growPending(kind) {
    const capKey = kind === 'spawn' ? '_spawnCap' : '_despawnCap';
    const next = this[capKey] * 2;
    const idx = new Int32Array(next);
    const type = new Int32Array(next);
    const classes = new Array(next);
    const oldIdx = kind === 'spawn' ? this._spawnIdx : this._despawnIdx;
    const oldType = kind === 'spawn' ? this._spawnType : this._despawnType;
    const oldClass = kind === 'spawn' ? this._spawnClass : this._despawnClass;
    idx.set(oldIdx);
    type.set(oldType);
    for (let i = 0; i < this[capKey]; i++) classes[i] = oldClass[i];
    if (kind === 'spawn') {
      this._spawnIdx = idx;
      this._spawnType = type;
      this._spawnClass = classes;
      this._spawnPerm = new Int32Array(next);
      this._spawnSorted = new Int32Array(next);
      this._spawnSortedClass = new Array(next);
      this._spawnCap = next;
    } else {
      this._despawnIdx = idx;
      this._despawnType = type;
      this._despawnClass = classes;
      this._despawnCap = next;
    }
  }

  queueSpawnListUpdate(entityIndex, entityType, EntityClass) {
    let n = this._spawnN;
    if (n === this._spawnCap) this._growPending('spawn');
    this._spawnIdx[n] = entityIndex;
    this._spawnType[n] = entityType;
    this._spawnClass[n] = EntityClass;
    this._spawnN = n + 1;
  }

  /**
   * Queue a despawn list update (called by GameObject.despawn)
   * The actual list removal will be done by logic0 at start of frame
   */
  queueDespawnListUpdate(entityIndex, entityType, EntityClass) {
    let n = this._despawnN;
    if (n === this._despawnCap) this._growPending('despawn');
    this._despawnIdx[n] = entityIndex;
    this._despawnType[n] = entityType;
    this._despawnClass[n] = EntityClass;
    this._despawnN = n + 1;
  }

  /**
   * Process all pending list updates (logic0 only, called at start of frame)
   * This ensures all list operations happen single-threaded, avoiding race conditions.
   */
  processListUpdates() {
    let activeQueryPopulationChanged = false;

    // Fold port batches into the SoA queues so one despawn-then-spawn pass
    // can merge O(n) instead of insert-per-entity.
    const received = this.receivedListUpdates;
    for (let b = 0; b < received.length; b++) {
      const batch = received[b];
      const despawns = batch.despawns;
      if (despawns) {
        for (let i = 0; i < despawns.length; i++) {
          const u = despawns[i];
          this.queueDespawnListUpdate(u.entityIndex, u.entityType, u.EntityClass);
        }
      }
      const spawns = batch.spawns;
      if (spawns) {
        for (let i = 0; i < spawns.length; i++) {
          const u = spawns[i];
          this.queueSpawnListUpdate(u.entityIndex, u.entityType, u.EntityClass);
        }
      }
    }
    received.length = 0;

    // ORDERING: Despawns first, then spawns.
    // This ensures rapid despawn→re-spawn cycles at the same index resolve correctly:
    // the old entry is removed before the new one is added (with dedup preventing duplicates).

    activeQueryPopulationChanged =
      this._processDespawnSoA(this._despawnIdx, this._despawnClass, this._despawnN) ||
      activeQueryPopulationChanged;
    activeQueryPopulationChanged =
      this._processSpawnSoA(this._spawnIdx, this._spawnClass, this._spawnN) ||
      activeQueryPopulationChanged;
    this._despawnN = 0;
    this._spawnN = 0;

    // Invalidate cached non-precomputed active queries once after the full batch.
    if (activeQueryPopulationChanged && this.queryVersionData) {
      Atomics.add(this.queryVersionData, 0, 1);
    }

    if (activeQueryPopulationChanged && this._publishPrecomputedActiveQueries) {
      if (this.collectDetailedStats) {
        const t0 = performance.now();
        this._publishPrecomputedActiveQueries(this.frameNumber);
        this.queryPublishMsThisFrame += performance.now() - t0;
      } else {
        this._publishPrecomputedActiveQueries(this.frameNumber);
      }
    }
  }

  /**
   * Process spawn list updates - add entities to active lists
   */
  _processSpawnSoA(idx, classes, n) {
    if (n <= 0) return false;

    const active = GameObject.activeEntitiesData;
    const destEmpty = !active || active[0] === 0;
    if (n === 1 && !destEmpty) {
      const entityIndex = idx[0];
      const EntityClass = classes[0];
      if (Transform.active[entityIndex] !== 1) return false;
      GameObject._addToActiveEntities(entityIndex);
      GameObject._addToTypeActiveList(EntityClass, entityIndex);
      return true;
    }

    const perm = this._spawnPerm;
    const sorted = this._spawnSorted;
    const sortedClass = this._spawnSortedClass;
    const transformActive = Transform.active;
    for (let i = 0; i < n; i++) perm[i] = i;
    perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);

    let m = 0;
    for (let i = 0; i < n; i++) {
      const src = perm[i];
      const entityIndex = idx[src];
      if (transformActive[entityIndex] !== 1) continue;
      sorted[m] = entityIndex;
      sortedClass[m] = classes[src];
      m++;
    }
    if (m === 0) return false;

    const scratch = this._listMergeScratch;
    if (active) mergeSortedIntoActiveList(active, sorted, m, scratch);

    let runStart = 0;
    while (runStart < m) {
      const EntityClass = sortedClass[runStart];
      let runEnd = runStart + 1;
      while (runEnd < m && sortedClass[runEnd] === EntityClass) runEnd++;
      if (EntityClass?._activeList) {
        mergeSortedIntoActiveList(
          EntityClass._activeList,
          sorted.subarray(runStart, runEnd),
          runEnd - runStart,
          scratch,
        );
      }
      runStart = runEnd;
    }
    return true;
  }

  _processSpawnUpdates(updates) {
    if (!updates || updates.length === 0) return false;
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
  _processDespawnSoA(idx, classes, n) {
    if (n === 0) return false;
    for (let i = 0; i < n; i++) {
      const entityIndex = idx[i];
      const EntityClass = classes[i];
      GameObject._removeFromActiveEntities(entityIndex);
      GameObject._removeFromTypeActiveList(EntityClass, entityIndex);
    }
    return true;
  }

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
    if (this._spawnN === 0 && this._despawnN === 0) {
      return true;
    }

    // Serialize EntityClass to class name for message passing (reuse buffers to avoid .map() allocation)
    const spawns = this._spawnSerializedBuffer;
    const despawns = this._despawnSerializedBuffer;
    const sn = this._spawnN;
    const dn = this._despawnN;
    for (let i = 0; i < sn; i++) {
      let o = spawns[i];
      if (!o) {
        o = { entityIndex: 0, entityType: 0, className: '' };
        spawns[i] = o;
      }
      o.entityIndex = this._spawnIdx[i];
      o.entityType = this._spawnType[i];
      o.className = this._spawnClass[i].name;
    }
    spawns.length = sn;
    for (let i = 0; i < dn; i++) {
      let o = despawns[i];
      if (!o) {
        o = { entityIndex: 0, entityType: 0, className: '' };
        despawns[i] = o;
      }
      o.entityIndex = this._despawnIdx[i];
      o.entityType = this._despawnType[i];
      o.className = this._despawnClass[i].name;
    }
    despawns.length = dn;

    const sent = this.sendDataToWorker('logic0', {
      msg: 'listUpdates',
      spawns,
      despawns,
    });

    if (sent) {
      this._spawnN = 0;
      this._despawnN = 0;
    }

    return sent;
  }

  /** Read-only pose latch for Camera.followEntity. Pre_render owns sync[1]. */
  _latchDisplayPose() {
    this._latchPose(false);
    Camera.bindDisplayPose(
      this._poseX,
      this._poseY,
      this._poseRotC,
      this._poseRotS,
      this._poseReadyFrame
    );
  }

  update(deltaTime, dtRatio, resuming) {
    if (this.collectDetailedStats) this.frameStartTime = performance.now();
    this._latchDisplayPose();

    // Reset stats for this frame
    this.entitiesProcessedThisFrame = 0;
    this.systemsExecutedThisFrame = 0;
    this.entityTimeThisFrame = 0;
    this.raycastMsThisFrame = 0;
    this.raycastCountThisFrame = 0;
    this.box2dRaycastMsThisFrame = 0;
    this.box2dRaycastCountThisFrame = 0;
    this.decimateMsThisFrame = 0;
    this.tickMsThisFrame = 0;
    this.queryPublishMsThisFrame = 0;
    if (this.collectDetailedStats) {
      Ray.beginFrame();
      Box2d.beginFrame();
    }

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
      this._drainSpawnCommandRing();
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

    // Physics applies ax every step until the next tick; replace here so off-ticks keep last steering.
    const rbAx = RigidBody.ax;
    const rbAy = RigidBody.ay;
    const rbAa = RigidBody.angularAccel;

    // ========================================
    // PHASE 1: NON-DECIMATED ENTITIES (FAST PATH)
    // ========================================
    // Zero decimation overhead - no countdown checks, no prototype lookups
    // This is the common case for most entity types
    const nonDecimatedTypes = this.nonDecimatedTypes;
    const nonDecimatedCount = nonDecimatedTypes.length;
    const forceProcessOnLogicWorker = GameObject.forceProcessOnLogicWorker;
    const entityTypeHasForcedLogicWorker = GameObject.entityTypeHasForcedLogicWorker;

    for (let t = 0; t < nonDecimatedCount; t++) {
      const typeInfo = nonDecimatedTypes[t];
      const activeList = typeInfo.activeList;
      const count = Math.min(activeList[0], activeList.length - 1);
      const needsScreenCallbacks = typeInfo.needsScreenCallbacks;
      const typeForced = !!(
        entityTypeHasForcedLogicWorker && entityTypeHasForcedLogicWorker[typeInfo.entityType]
      );

      if (typeForced && forceProcessOnLogicWorker && totalWorkers > 1) {
        for (let idx = 0; idx < count; idx++) {
          const entityIndex = activeList[1 + idx];
          if (
            logicWorkerThatShouldTick(
              idx,
              entityIndex,
              totalWorkers,
              forceProcessOnLogicWorker,
            ) !== myIndex
          ) {
            continue;
          }
          const n = this._tickNonDecimatedOne(
            entityIndex, dtRatio, deltaTime, accTime, frameNum,
            needsScreenCallbacks, transformActive, gameObjects,
            rbAx, rbAy, rbAa, collectDetailed
          );
          activeCount += n;
          if (collectDetailed) tickMs += this._lastTickMs;
        }
      } else {
        let from = myIndex;
        let to = count;
        let step = totalWorkers;
        if (totalWorkers > 1) {
          const range = logicBlockRange(count, myIndex, totalWorkers);
          from = range.start;
          to = range.end;
          step = 1;
        }
        for (let idx = from; idx < to; idx += step) {
          const entityIndex = activeList[1 + idx];
          const n = this._tickNonDecimatedOne(
            entityIndex, dtRatio, deltaTime, accTime, frameNum,
            needsScreenCallbacks, transformActive, gameObjects,
            rbAx, rbAy, rbAa, collectDetailed
          );
          activeCount += n;
          if (collectDetailed) tickMs += this._lastTickMs;
        }
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
      for (let t = 0; t < decimatedCount; t++) {
        const typeInfo = decimatedTypes[t];
        const activeList = typeInfo.activeList;
        const count = Math.min(activeList[0], activeList.length - 1);
        const tickInterval = typeInfo.tickInterval; // Pre-cached, no prototype lookup
        const needsScreenCallbacks = typeInfo.needsScreenCallbacks;
        const typeForced = !!(
          entityTypeHasForcedLogicWorker && entityTypeHasForcedLogicWorker[typeInfo.entityType]
        );
        if (
          !needsScreenCallbacks &&
          tickInterval > 1 &&
          !typeForced &&
          this.config.logic?.tickBuckets !== false
        ) {
          activeCount += this._tickIntervalBucket(
            typeInfo, activeList, count, tickInterval, frameNum,
            dtRatio, deltaTime, accTime, transformActive, gameObjects,
            rbAx, rbAy, rbAa, totalWorkers, myIndex,
            typeForced, forceProcessOnLogicWorker
          );
          continue;
        }

        if (typeForced && forceProcessOnLogicWorker && totalWorkers > 1) {
          for (let idx = 0; idx < count; idx++) {
            const entityIndex = activeList[1 + idx];
            if (
              logicWorkerThatShouldTick(
                idx,
                entityIndex,
                totalWorkers,
                forceProcessOnLogicWorker,
              ) !== myIndex
            ) {
              continue;
            }
            const n = this._tickDecimatedOne(
              entityIndex, dtRatio, deltaTime, accTime, frameNum,
              tickInterval, needsScreenCallbacks, transformActive, gameObjects,
              rbAx, rbAy, rbAa, nextTick, collectDetailed
            );
            activeCount += n;
            if (collectDetailed) {
              decimateMs += this._lastDecimateMs;
              tickMs += this._lastTickMs;
            }
          }
        } else {
          let from = myIndex;
          let to = count;
          let step = totalWorkers;
          if (totalWorkers > 1) {
            const range = logicBlockRange(count, myIndex, totalWorkers);
            from = range.start;
            to = range.end;
            step = 1;
          }
          for (let idx = from; idx < to; idx += step) {
            const entityIndex = activeList[1 + idx];
            const n = this._tickDecimatedOne(
              entityIndex, dtRatio, deltaTime, accTime, frameNum,
              tickInterval, needsScreenCallbacks, transformActive, gameObjects,
              rbAx, rbAy, rbAa, nextTick, collectDetailed
            );
            activeCount += n;
            if (collectDetailed) {
              decimateMs += this._lastDecimateMs;
              tickMs += this._lastTickMs;
            }
          }
        }
      }
    }

    activeCount += this._runTickAllTypes(dtRatio, transformActive, rbAx, rbAy, rbAa);

    if (collectDetailed) {
      this.entityTimeThisFrame = performance.now() - tEntity0;
      this.decimateMsThisFrame = decimateMs;
      this.tickMsThisFrame = tickMs;
      const rayStats = Ray.consumeStats();
      this.raycastMsThisFrame = rayStats.ms;
      this.raycastCountThisFrame = rayStats.count;
      const box2dRayStats = Box2d.consumeStats();
      this.box2dRaycastMsThisFrame = box2dRayStats.ms;
      this.box2dRaycastCountThisFrame = box2dRayStats.count;
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

  _runTickAllTypes(dtRatio, transformActive, rbAx, rbAy, rbAa) {
    const types = this.tickAllTypes;
    const typeCount = types.length;
    if (typeCount === 0) return 0;
    let packed = 0;

    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const scratch = this._tickAllScratch;
    const forceProcessOnLogicWorker = GameObject.forceProcessOnLogicWorker;
    const entityTypeHasForcedLogicWorker = GameObject.entityTypeHasForcedLogicWorker;

    for (let t = 0; t < typeCount; t++) {
      const typeInfo = types[t];
      const activeList = typeInfo.activeList;
      const count = Math.min(activeList[0], activeList.length - 1);
      const hasRigidBody = typeInfo.hasRigidBody;
      const typeForced = !!(
        entityTypeHasForcedLogicWorker && entityTypeHasForcedLogicWorker[typeInfo.entityType]
      );
      let n = 0;
      if (typeForced && forceProcessOnLogicWorker && totalWorkers > 1) {
        for (let idx = 0; idx < count; idx++) {
          const entityIndex = activeList[1 + idx];
          if (
            logicWorkerThatShouldTick(
              idx,
              entityIndex,
              totalWorkers,
              forceProcessOnLogicWorker,
            ) !== myIndex
          ) {
            continue;
          }
          if (transformActive[entityIndex] === 0) continue;
          if (hasRigidBody) {
            rbAx[entityIndex] = 0;
            rbAy[entityIndex] = 0;
            rbAa[entityIndex] = 0;
          }
          scratch[n++] = entityIndex;
        }
      } else {
        let from = myIndex;
        let to = count;
        let step = totalWorkers;
        if (totalWorkers > 1) {
          const range = logicBlockRange(count, myIndex, totalWorkers);
          from = range.start;
          to = range.end;
          step = 1;
        }
        for (let idx = from; idx < to; idx += step) {
          const entityIndex = activeList[1 + idx];
          if (transformActive[entityIndex] === 0) continue;
          if (hasRigidBody) {
            rbAx[entityIndex] = 0;
            rbAy[entityIndex] = 0;
            rbAa[entityIndex] = 0;
          }
          scratch[n++] = entityIndex;
        }
      }
      if (n > 0) typeInfo.EntityClass.tickAll(scratch, n, dtRatio);
      this.entitiesProcessedThisFrame += n;
      packed += n;
    }
    return packed;
  }

  /**
   * tickInterval > 1 without per-frame screen callbacks: one prebuilt id list per phase.
   * Phase matches the old countdown: first frame is frameNumber 1, entity i starts at (i % interval) + 1.
   * Rebuild only when the active count or query version changes. No alloc on the steady frame.
   */
  _tickIntervalBucket(
    typeInfo, activeList, count, interval, frameNum,
    dtRatio, deltaTime, accTime, transformActive, gameObjects,
    rbAx, rbAy, rbAa, totalWorkers, myIndex,
    typeForced, forceProcessOnLogicWorker
  ) {
    const ver = this.queryVersionData ? Atomics.load(this.queryVersionData, 0) : 0;
    if (
      !typeInfo._buckets ||
      typeInfo._bucketStampCount !== count ||
      typeInfo._bucketStampVer !== ver
    ) {
      this._rebuildTickBuckets(typeInfo, activeList, count, interval);
      typeInfo._bucketStampCount = count;
      typeInfo._bucketStampVer = ver;
    }

    const phase = frameNum % interval;
    const list = typeInfo._buckets[phase];
    const nAll = typeInfo._bucketCounts[phase];
    let from = 0;
    let to = nAll;
    let forcedScan = false;
    if (typeForced && forceProcessOnLogicWorker && totalWorkers > 1) {
      forcedScan = true;
    } else if (totalWorkers > 1) {
      const range = logicBlockRange(nAll, myIndex, totalWorkers);
      from = range.start;
      to = range.end;
    }

    let visited = 0;
    if (forcedScan) {
      for (let i = 0; i < nAll; i++) {
        const entityIndex = list[i];
        if (
          logicWorkerThatShouldTick(i, entityIndex, totalWorkers, forceProcessOnLogicWorker) !==
          myIndex
        ) {
          continue;
        }
        if (transformActive[entityIndex] === 0) continue;
        const obj = gameObjects[entityIndex];
        if (!obj || typeof obj.tick !== 'function') continue;
        rbAx[entityIndex] = 0;
        rbAy[entityIndex] = 0;
        rbAa[entityIndex] = 0;
        obj.tick(dtRatio, deltaTime, accTime, frameNum);
        this.entitiesProcessedThisFrame++;
        visited++;
      }
    } else {
      for (let i = from; i < to; i++) {
        const entityIndex = list[i];
        if (transformActive[entityIndex] === 0) continue;
        const obj = gameObjects[entityIndex];
        if (!obj || typeof obj.tick !== 'function') continue;
        rbAx[entityIndex] = 0;
        rbAy[entityIndex] = 0;
        rbAa[entityIndex] = 0;
        obj.tick(dtRatio, deltaTime, accTime, frameNum);
        this.entitiesProcessedThisFrame++;
        visited++;
      }
    }
    return visited;
  }

  _rebuildTickBuckets(typeInfo, activeList, count, interval) {
    const cap = activeList.length > 1 ? activeList.length - 1 : 1;
    let buckets = typeInfo._buckets;
    let counts = typeInfo._bucketCounts;
    if (!buckets || typeInfo._bucketInterval !== interval || cap > typeInfo._bucketCap) {
      buckets = new Array(interval);
      for (let b = 0; b < interval; b++) buckets[b] = new (EntityIdArray())(cap);
      counts = new Int32Array(interval);
      typeInfo._buckets = buckets;
      typeInfo._bucketCounts = counts;
      typeInfo._bucketInterval = interval;
      typeInfo._bucketCap = cap;
    } else {
      counts.fill(0);
    }
    for (let idx = 0; idx < count; idx++) {
      const id = activeList[1 + idx];
      const phase = tickBucketPhase(id, interval);
      const n = counts[phase];
      buckets[phase][n] = id;
      counts[phase] = n + 1;
    }
  }

  _tickNonDecimatedOne(
    entityIndex,
    dtRatio,
    deltaTime,
    accTime,
    frameNum,
    needsScreenCallbacks,
    transformActive,
    gameObjects,
    rbAx,
    rbAy,
    rbAa,
    collectDetailed
  ) {
    this._lastTickMs = 0;
    if (transformActive[entityIndex] === 0) return 0;
    const obj = gameObjects[entityIndex];
    if (!obj || typeof obj.tick !== 'function') return 0;
    rbAx[entityIndex] = 0;
    rbAy[entityIndex] = 0;
    rbAa[entityIndex] = 0;
    if (collectDetailed) {
      const tTick0 = performance.now();
      obj.tick(dtRatio, deltaTime, accTime, frameNum);
      this._lastTickMs = performance.now() - tTick0;
    } else {
      obj.tick(dtRatio, deltaTime, accTime, frameNum);
    }
    if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
    this.entitiesProcessedThisFrame++;
    return 1;
  }

  _tickDecimatedOne(
    entityIndex,
    dtRatio,
    deltaTime,
    accTime,
    frameNum,
    tickInterval,
    needsScreenCallbacks,
    transformActive,
    gameObjects,
    rbAx,
    rbAy,
    rbAa,
    nextTick,
    collectDetailed
  ) {
    this._lastTickMs = 0;
    this._lastDecimateMs = 0;
    if (transformActive[entityIndex] === 0) return 0;
    const obj = gameObjects[entityIndex];
    if (!obj || typeof obj.tick !== 'function') return 0;
    this.entitiesProcessedThisFrame++;
    const tVisit0 = collectDetailed ? performance.now() : 0;
    if (--nextTick[entityIndex] > 0) {
      if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
      if (collectDetailed) this._lastDecimateMs = performance.now() - tVisit0;
      return 1;
    }
    nextTick[entityIndex] = tickInterval;
    rbAx[entityIndex] = 0;
    rbAy[entityIndex] = 0;
    rbAa[entityIndex] = 0;
    obj.tick(dtRatio, deltaTime, accTime, frameNum);
    if (needsScreenCallbacks) this.checkScreenVisibility(entityIndex, obj);
    if (collectDetailed) this._lastTickMs = performance.now() - tVisit0;
    return 1;
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
    const result = drainContactHitRing(
      this.box2dHitRingI32,
      this.box2dHitRingF32,
      this.box2dHitCursor,
      this._onHitRingEvent,
    );
    this.box2dHitCursor = result.nextCursor;
  }

  _onHitRingEvent(a, b, genA, genB, px, py, nx, ny, speed) {
    if (this._entityGen(a) !== (genA | 0) || this._entityGen(b) !== (genB | 0)) return;
    if (!Transform.active[a] || !Transform.active[b]) return;
    const minE = a < b ? a : b;
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = collisionFlags[entityType[a]];
    const bListens = collisionFlags[entityType[b]];
    if (aListens) gameObjects[a]?.onCollisionHit(b, px, py, nx, ny, speed);
    if (bListens) gameObjects[b]?.onCollisionHit(a, px, py, -nx, -ny, speed);
  }

  /**
   * Drain joint-break ring — same worker partition + gen-validation rules as contacts.
   * Dispatch only to entity types with JointBreakListener.
   */
  _processBox2dJointBreakCallbacks() {
    const result = drainJointBreakRing(
      this.box2dJointBreakRingI32,
      this.box2dJointBreakCursor,
      this._onJointBreakRingEvent,
    );
    this.box2dJointBreakCursor = result.nextCursor;
  }

  _onJointBreakRingEvent(jointIndex, entityA, entityB, genA, genB) {
    if (this._entityGen(entityA) !== (genA | 0) || this._entityGen(entityB) !== (genB | 0)) return;
    if (!Transform.active[entityA] || !Transform.active[entityB]) return;
    const minE = entityA < entityB ? entityA : entityB;
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const jointBreakFlags = this.jointBreakListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = jointBreakFlags[entityType[entityA]];
    const bListens = jointBreakFlags[entityType[entityB]];
    if (!aListens && !bListens) return;
    if (aListens) gameObjects[entityA]?.onJointBreak(jointIndex, entityA, entityB);
    if (bListens) gameObjects[entityB]?.onJointBreak(jointIndex, entityA, entityB);
  }

  _setCollisionGens(key, genA, genB) {
    this._collisionGenA.set(key, genA >>> 0);
    this._collisionGenB.set(key, genB >>> 0);
  }

  _deleteCollisionGens(key) {
    this._collisionGenA.delete(key);
    this._collisionGenB.delete(key);
  }

  _clearCollisionGens() {
    this._collisionGenA.clear();
    this._collisionGenB.clear();
  }

  _entityGen(i) {
    return this.bodyGeneration ? Atomics.load(this.bodyGeneration, i) | 0 : 0;
  }

  _gensMatch(key, genA, genB) {
    const storedA = this._collisionGenA.get(key);
    if (storedA === undefined) return false;
    return storedA === (genA >>> 0) && this._collisionGenB.get(key) === (genB >>> 0);
  }

  _pairStillValid(minE, maxE, key) {
    if (!Transform.active[minE] || !Transform.active[maxE]) return false;
    const ga = this._entityGen(minE);
    const gb = this._entityGen(maxE);
    return this._gensMatch(key, ga, gb);
  }

  _clearContactState(reason) {
    this.previousCollisions.clear();
    this._clearCollisionGens();
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
      this._deleteCollisionGens(key);
      return;
    }
    this.previousCollisions.delete(key);
    this._deleteCollisionGens(key);
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
    this._setCollisionGens(key, genA, genB);
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

  _onContactRingEvent(kind, a, b, genA, genB) {
    const KIND = BOX2D_CONTACT_KIND;
    if (kind === KIND.CONTACT_END || kind === KIND.SENSOR_END) {
      this._applyContactEnd(a, b, genA, genB);
    } else if (kind === KIND.CONTACT_BEGIN || kind === KIND.SENSOR_BEGIN) {
      this._applyContactBegin(a, b, genA, genB);
    }
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

    beginSet.clear();

    const result = drainContactRing(
      this.box2dContactRingI32,
      this.box2dContactCursor,
      this._onContactRingEvent,
    );
    this.box2dContactCursor = result.nextCursor;
    if (result.overrun) {
      // Cold start: no tracked pairs — catch up silently (common when first
      // physics steps flood the ring before logic drains).
      if (active.size === 0 && this._collisionGenA.size === 0) {
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
        this._deleteCollisionGens(key);
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
   * Handle custom messages from Scene or other workers
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
        if (data.overlapCircleSab) {
          bindOverlapCircleSab(data.overlapCircleSab);
        }
        if (data.rayCastSab) {
          bindRayCastSab(data.rayCastSab);
        }
        if (data.castRayAllSab) {
          bindCastRayAllSab(data.castRayAllSab);
        }
        if (data.liquidFunQuerySab) {
          bindLiquidFunQuerySab(data.liquidFunQuerySab);
        }
        if (data.liquidFunExtractSab) {
          bindLiquidFunExtractSab(data.liquidFunExtractSab);
        }
        if (data.liquidFunUserDataListSab) {
          bindLiquidFunUserDataListSab(data.liquidFunUserDataListSab);
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
      case 'drainSpawnCommands': {
        if (this.workerIndex !== 0) break;
        if (data.extras && data.extras.length) {
          const extras = new Map();
          for (let i = 0; i < data.extras.length; i++) {
            extras.set(data.extras[i].entityIndex, data.extras[i]);
          }
          this._pendingDrainExtras = extras;
        }
        this._drainSpawnCommandRing();
        this.processListUpdates();
        self.postMessage({ msg: 'drainSpawnCommandsComplete', workerIndex: 0 });
        break;
      }
      case 'spawn': {
        this._mainThreadSpawn(data);
        break;
      }

      case 'despawn': {
        if (this.workerIndex !== 0) break;
        this._mainThreadDespawn(data.entityIndex);
        break;
      }

      // Entity spawn/despawn uses atomic SAB-backed free lists
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

  _mainThreadSpawn(entry) {
    const className = entry.className;
    const spawnConfig = entry.spawnConfig;
    const entityIndex = entry.entityIndex;
    const EntityClass = self[className];
    if (!EntityClass) {
      console.error(
        `LOGIC WORKER ${this.workerIndex}: Cannot spawn ${className} - class not found!`
      );
      return;
    }
    const instance = GameObject.spawn(EntityClass, spawnConfig, entityIndex);
    if (!instance) {
      console.warn(
        `LOGIC WORKER ${this.workerIndex}: Failed to spawn ${className} - pool exhausted!`
      );
    }
  }

  _drainSpawnCommandRing() {
    if (!isSpawnCommandRingBound()) return 0;
    this._drainingSpawnRing = true;
    const extras = this._pendingDrainExtras;
    const xy = this._spawnXyScratch;
    const byType = this._entityClassByType;
    const n = drainSpawnCommands((kind, typeId, entityIndex, x, y) => {
      if (kind === SPAWN_CMD_KIND.DESPAWN) {
        this._mainThreadDespawn(entityIndex);
        return;
      }
      const extra = extras ? extras.get(entityIndex) : null;
      let EntityClass;
      let cfg;
      if (extra) {
        EntityClass = extra.className ? self[extra.className] : byType[typeId];
        cfg = extra.spawnConfig;
      } else {
        EntityClass = byType[typeId];
        xy.x = x;
        xy.y = y;
        cfg = xy;
      }
      if (!EntityClass) {
        console.error(
          `LOGIC WORKER ${this.workerIndex}: ring spawn type ${typeId} not found`,
        );
        return;
      }
      const instance = GameObject.spawn(EntityClass, cfg, entityIndex);
      if (!instance) {
        console.warn(
          `LOGIC WORKER ${this.workerIndex}: Failed ring spawn ${EntityClass.name}`,
        );
      }
    });
    this._pendingDrainExtras = null;
    this._drainingSpawnRing = false;
    return n;
  }

  _mainThreadDespawn(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this.globalEntityCount) return;
    const instance = this.gameObjects[entityIndex];
    if (instance && instance.despawn) instance.despawn();
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    if (!this.stats) return;
    this.stats[LOGIC_STATS.FPS] = this.currentFPS;
    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
    let markActive = 0;
    const markTypes = this.markActiveTypes;
    if (markTypes) {
      for (let i = 0; i < markTypes.length; i++) {
        const list = markTypes[i]._activeList;
        if (list) markActive += list[0] | 0;
      }
    }
    this.stats[LOGIC_STATS.MARK_ACTIVE] = markActive;
    if (!this.collectDetailedStats) return;
    this.stats[LOGIC_STATS.SYSTEMS_EXECUTED] = this.systemsExecutedThisFrame;
    this.stats[LOGIC_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[LOGIC_STATS.RAYCAST_MS] = this.raycastMsThisFrame || 0;
    this.stats[LOGIC_STATS.RAYCAST_COUNT] = this.raycastCountThisFrame || 0;
    this.stats[LOGIC_STATS.BOX2D_RAYCAST_MS] = this.box2dRaycastMsThisFrame || 0;
    this.stats[LOGIC_STATS.BOX2D_RAYCAST_COUNT] = this.box2dRaycastCountThisFrame || 0;
    this.stats[LOGIC_STATS.ENTITY_MS] = this.entityTimeThisFrame || 0;
    this.stats[LOGIC_STATS.DECIMATE_MS] = this.decimateMsThisFrame || 0;
    this.stats[LOGIC_STATS.TICK_MS] = this.tickMsThisFrame || 0;
    this.stats[LOGIC_STATS.QUERY_PUBLISH_MS] = this.queryPublishMsThisFrame || 0;
  }
}

// Create singleton instance and setup message handler
self.logicWorker = new LogicWorker(self);
