self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// Runs GameObject.tick / AI; steering writes RigidBody accel fields for Box2D

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { reportWorkerError } from '../util/errorReport.js';
import { Messages } from '../core/messages.js';
import { drainMessages } from '../util/messageRing.js';
import { definesBelow } from '../util/listenerTags.js';
import { Joint } from '../core/joint.js';
import { Mouse } from '../core/mouse.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Camera } from '../core/camera.js';
import { Tween } from '../core/tween.js';
import {
  applyChains,
  applyFixtures,
  applyMeshes,
  applyTweens,
  remapEntityIdFields,
} from '../core/save/worldBufferSave.js';

import { CameraInOutListener, noteScreenVisibility } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';

import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';

import { AbstractWorker } from './abstractWorker.js';
import { logicBlockRange, logicWorkerThatShouldTick, resolveForceProcessOnLogicWorker, tickBucketPhase } from '../util/logicOwner.js';

import { LOGIC_STATS, createMultiWorkerStatsWriter } from '../util/workersUtils.js';
import { Ray } from '../core/ray.js';
import { Box2d } from '../core/box2d.js';
import { collisionPairKey } from '../util/utils.js';
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
/** Stale pairs owned by another logic worker are dropped at least this often. */
const FOREIGN_SWEEP_FRAMES = 30;

/**
 * B-09 / H-17 caps for the pending cross-worker list-update queue.
 *
 * Sized against what a healthy frame actually produces: every non-logic0 worker
 * sends one batch per frame, and a batch is bounded by that worker's own spawn
 * buffer (256 by default). So a normal backlog is one or two small batches.
 *
 * - MAX_BATCHES bounds how many batch wrappers exist, which is what the object
 *   allocation rate is made of.
 * - MAX_BATCH_PENDING bounds how many records one wrapper can hold, which is
 *   what bounds the arrays when coalescing.
 *
 * 64 x 2048 records is far past anything a drain-once-per-frame loop should see,
 * so a healthy engine never reaches either cap and never pays for them. The cap
 * exists for the case where logic0 stops draining, and there the choice is
 * bounded growth with a visible counter versus an OOM with neither.
 */
const LIST_UPDATE_MAX_BATCHES = 64;
const LIST_UPDATE_MAX_BATCH_PENDING = 2048;

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

    // Tracked contact pairs: collisionPairKey → slot in dense columns
    // (min, max, gen of min, gen of max). Delete swaps the last slot in, so the
    // stay loop walks the columns without iterating a Set or unpacking keys.
    // Pairs this worker owns (minE % workers === index, the only ones it fires
    // callbacks for) are validated every frame. Pairs another worker owns sit in
    // the foreign columns and are validated when isCollidingWith asks, plus a
    // sweep every FOREIGN_SWEEP_FRAMES. Map value: slot ≥ 0 own, −(slot+1) foreign.
    /** @type {Map<number, number>} */
    this._pairSlot = new Map();
    // The key is `collisionPairKey(minE, maxE)`, which is `packPair` bound by
    // `bindEntityIdWidth` - see src/util/entityIdWidth.js, which carries the full note.
    //
    // A previous version of this file had, 45 lines above and attached to nothing, the
    // comment "Float64Array, not Int32Array: this key overflows a 32-bit int well
    // before the entity cap." There is no Float64Array in this file - the grep for one
    // returns that comment - and the key is a Map key, i.e. a JS number. As a floating
    // JSDoc it also visually documented the B-09 block below it. Read as a performance
    // claim about hashing, it is what made E-10 a two-line hypothesis that was already
    // dead; E-10 then swept 715 838 805 keys and found zero boxed (in Node; Chrome's
    // 31-bit Smis box keys from minE 16384 on, E-54). The comment is gone
    // and the measurement is cited where the key is actually built.
    this._pairCount = 0;
    this._pairCapacity = 0;
    this._pairMin = new Uint32Array(0);
    this._pairMax = new Uint32Array(0);
    this._pairGenMin = new Uint32Array(0);
    this._pairGenMax = new Uint32Array(0);
    this._foreignCount = 0;
    this._foreignCapacity = 0;
    this._foreignMin = new Uint32Array(0);
    this._foreignMax = new Uint32Array(0);
    this._foreignGenMin = new Uint32Array(0);
    this._foreignGenMax = new Uint32Array(0);
    this._foreignSweepIn = FOREIGN_SWEEP_FRAMES;
    // Latest completed frame's pairs, for isCollidingWith (has(key)).
    const pairView = { has: (key) => this._hasPair(key) };
    this.frameCollisions = pairView;
    this._pairView = pairView;
    // Pairs that began this frame: the slot's stamp equals _contactFrame (E-54).
    // A Set of keys meant a collisionPairKey and a has() per pair per frame, and in
    // Chrome a key from minE 16384 on is a heap number (Predator's soldiers, trees
    // and rocks: 4.2 MB/s of them).
    this._pairBegan = new Uint32Array(0);
    this._contactFrame = 0;
    this._onContactRingEvent = this._onContactRingEvent.bind(this);
    this._onHitRingEvent = this._onHitRingEvent.bind(this);
    this._onJointBreakRingEvent = this._onJointBreakRingEvent.bind(this);
    this._onMessageEvent = this._onMessageEvent.bind(this);

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

    // onMessage per-type flags (indexed by entityType); filled with the instances
    this.messageListenerByType = new Uint8Array(0);
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
    /**
     * B-09 / H-17. `receivedListUpdates` used to grow without bound.
     *
     * Every non-logic0 worker pushes one batch per frame, and the queue is only
     * drained inside `processListUpdates`, which runs from logic0's own frame
     * loop. Anything that stops that loop from running - logic0 paused, a
     * manual-step worker waiting on the main thread, the tab throttled - turns
     * the queue into an unbounded producer/consumer mismatch, and each entry is
     * an object holding two arrays of objects. So it is not a slow leak, it is
     * fast allocation growth landing exactly when the frame budget is already
     * gone, and it ends in an OOM rather than a visible stall.
     *
     * Two mechanisms, because they fail differently:
     *
     *  - Coalesce first. While the backlog fits in one batch, append into the
     *    existing arrays instead of pushing a new batch wrapper. This is the
     *    normal transient case and it costs no allocation at all, so a brief
     *    hiccup leaves no trace.
     *  - Drop and count past the cap. When even the tail batch is full, further
     *    updates are dropped and counted. Dropping is not free and not hidden:
     *    `listUpdatesDropped` is non-zero, which is the signal that logic0 is
     *    not draining and the frame budget is the real problem.
     *
     * Dropping spawn/despawn updates is genuinely destructive - a despawn that
     * is lost leaves a body in the active list forever. That is why it is capped
     * at a level a healthy frame never approaches and why the counter is exposed
     * rather than merely incremented.
     */
    this.listUpdatesDropped = 0;
    this.listUpdatesCoalesced = 0;
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
      debugWorkerLog(`LOGIC WORKER ${this.workerIndex}: Stats buffer initialized`);
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
        debugWorkerLog(
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

    // onSpawned writes Transform.x. With WASM, wait for box2dReady. With weed pose, bind already ran.
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
    this.messageListenerByType = new Uint8Array(numTypes);
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
        GameObject.classByType[entityType] = EntityClass;

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
        if (definesBelow(EntityClass, GameObject, 'onMessage')) {
          this.messageListenerByType[entityType] = 1;
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
   /**
   * B-09 / H-17. Add one batch of received spawn/despawn updates to the pending
   * queue, keeping the queue bounded.
   *
   * Order of preference:
   *   1. coalesce into the tail batch if it has room - allocates nothing, and is
   *      what a brief frame hiccup should cost;
   *   2. push a new batch if the queue is under LIST_UPDATE_MAX_BATCHES;
   *   3. otherwise drop and count.
   *
   * Step 2 has to come before step 3. A single batch that fills the tail must not
   * be able to wedge the queue shut: if it could, every later update would be
   * dropped until logic0 next drained, which is the exact unbounded growth the
   * cap is meant to prevent, wearing a different hat.
   *
   * @param {Array} spawns deserialized spawn records
   * @param {Array} despawns deserialized despawn records
   */
  enqueueListUpdateBatch(spawns, despawns) {
    const incoming = spawns.length + despawns.length;
    const queue = this.receivedListUpdates;

    const tail = queue.length > 0 ? queue[queue.length - 1] : null;
    if (tail) {
      const room = LIST_UPDATE_MAX_BATCH_PENDING - (tail.spawns.length + tail.despawns.length);
      if (room > 0 && incoming <= room) {
        for (let i = 0; i < spawns.length; i++) tail.spawns.push(spawns[i]);
        for (let i = 0; i < despawns.length; i++) tail.despawns.push(despawns[i]);
        this.listUpdatesCoalesced++;
        return 'coalesced';
      }
    }

    if (queue.length < LIST_UPDATE_MAX_BATCHES) {
      queue.push({ spawns, despawns });
      return 'queued';
    }

    // At the cap. Drop and count - see the constructor note for why this is
    // visible rather than silent.
    this.listUpdatesDropped += incoming;
    return 'dropped';
  }

  /** Pending updates waiting to be folded into the SoA queues. */
  getPendingListUpdateCount() {
    const received = this.receivedListUpdates;
    let n = 0;
    for (let b = 0; b < received.length; b++) {
      n += received[b].spawns.length + received[b].despawns.length;
    }
    return n;
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

    // Sort spawn positions by entity index with a comparator over a permutation,
    // then gather. H-14 (2026-10-14) replaced the comparator with a numeric sort
    // of packed (entityIndex, position) Float64 keys: +106..147 % in the kernel,
    // but a spawnStorm sitting of -0.55 % with 3/8 pairs worse, contaminated by a
    // stray Chromium launch, so it was dropped and reverted. Its comments stayed
    // here and described a key this code does not build (review). Read
    // HYPOTHESIS_LOG before re-proposing it. Two spawns of one index compare
    // equal; they carry the same class, so their order does not change the lists.
    let m = 0;
    for (let i = 0; i < n; i++) perm[i] = i;
    perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
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
    Tween.tick(deltaTime, this.workerIndex, this.totalLogicWorkers);
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

    // Entity messages sent since the last frame (sendTo / sendToEntity / engine).
    if (Messages.enabled) {
      drainMessages(Messages.inboxI32[this.workerIndex], Messages.inboxF64[this.workerIndex], this._onMessageEvent);
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

      // A throw from game code reports that entity and resumes after it. The
      // try sits outside the inner loop so the loop body compiles as before.
      if (typeForced && forceProcessOnLogicWorker && totalWorkers > 1) {
        let idx = 0;
        for (;;) {
          try {
            for (; idx < count; idx++) {
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
            break;
          } catch (error) {
            this._entityThrew(error, activeList[1 + idx], 'tick');
            idx++;
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
        let idx = from;
        for (;;) {
          try {
            for (; idx < to; idx += step) {
              const entityIndex = activeList[1 + idx];
              const n = this._tickNonDecimatedOne(
                entityIndex, dtRatio, deltaTime, accTime, frameNum,
                needsScreenCallbacks, transformActive, gameObjects,
                rbAx, rbAy, rbAa, collectDetailed
              );
              activeCount += n;
              if (collectDetailed) tickMs += this._lastTickMs;
            }
            break;
          } catch (error) {
            this._entityThrew(error, activeList[1 + idx], 'tick');
            idx += step;
          }
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
          let idx = 0;
          for (;;) {
            try {
              for (; idx < count; idx++) {
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
              break;
            } catch (error) {
              this._entityThrew(error, activeList[1 + idx], 'tick');
              idx++;
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
          let idx = from;
          for (;;) {
            try {
              for (; idx < to; idx += step) {
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
              break;
            } catch (error) {
              this._entityThrew(error, activeList[1 + idx], 'tick');
              idx += step;
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
      if (n > 0) {
        try {
          typeInfo.EntityClass.tickAll(scratch, n, dtRatio);
        } catch (error) {
          reportWorkerError(error, 'tickAll', typeInfo.EntityClass.name);
        }
      }
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
    // Same resume-after-the-throw shape as update(): try outside the loop.
    if (forcedScan) {
      let i = 0;
      for (;;) {
        try {
          for (; i < nAll; i++) {
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
          break;
        } catch (error) {
          this._entityThrew(error, list[i], 'tick');
          i++;
        }
      }
    } else {
      let i = from;
      for (;;) {
        try {
          for (; i < to; i++) {
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
          break;
        } catch (error) {
          this._entityThrew(error, list[i], 'tick');
          i++;
        }
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
        try {
          obj.onGotShot(damage, hitX, hitY, ownerId, shooterEntityType);
        } catch (error) {
          this._entityThrew(error, targetId, 'onGotShot');
        }
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
    // A throw is caught per call so the ring drain still advances its cursor.
    if (aListens) {
      try {
        gameObjects[a]?.onCollisionHit(b, px, py, nx, ny, speed);
      } catch (error) {
        this._entityThrew(error, a, 'onCollisionHit');
      }
    }
    if (bListens) {
      try {
        gameObjects[b]?.onCollisionHit(a, px, py, -nx, -ny, speed);
      } catch (error) {
        this._entityThrew(error, b, 'onCollisionHit');
      }
    }
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
    if (aListens) {
      try {
        gameObjects[entityA]?.onJointBreak(jointIndex, entityA, entityB);
      } catch (error) {
        this._entityThrew(error, entityA, 'onJointBreak');
      }
    }
    if (bListens) {
      try {
        gameObjects[entityB]?.onJointBreak(jointIndex, entityA, entityB);
      } catch (error) {
        this._entityThrew(error, entityB, 'onJointBreak');
      }
    }
  }

  /** One inbox message: dropped if its target despawned since it was sent. */
  _onMessageEvent(target, from, nameId, gen, a, b, c, d) {
    if (Transform.active[target] === 0 || Messages.spawnGen[target] !== gen) return;
    const obj = this.gameObjects[target];
    if (!obj || this.messageListenerByType[Transform.entityType[target]] !== 1) return;
    try {
      obj.onMessage(Messages.names[nameId], from, a, b, c, d);
    } catch (error) {
      this._entityThrew(error, target, 'onMessage');
    }
  }

  /** Report a throw from game code on one entity (class + index + phase). Error path only. */
  _entityThrew(error, entityIndex, phase) {
    const obj = entityIndex >= 0 ? this.gameObjects[entityIndex] : null;
    const className = obj && obj.constructor ? obj.constructor.name : '';
    reportWorkerError(error, phase, className, entityIndex);
  }

  _entityGen(i) {
    return this.bodyGeneration ? Atomics.load(this.bodyGeneration, i) | 0 : 0;
  }

  _growPairColumns() {
    const cap = this._pairCapacity > 0 ? this._pairCapacity * 2 : 1024;
    const grow = (old) => {
      const next = new Uint32Array(cap);
      next.set(old);
      return next;
    };
    this._pairMin = grow(this._pairMin);
    this._pairMax = grow(this._pairMax);
    this._pairGenMin = grow(this._pairGenMin);
    this._pairGenMax = grow(this._pairGenMax);
    this._pairBegan = grow(this._pairBegan);
    this._pairCapacity = cap;
  }

  /** Swap the last slot into `slot`. The caller continues at `slot` when walking. */
  _removePairSlot(slot, key) {
    const last = --this._pairCount;
    if (slot !== last) {
      const minE = this._pairMin[last];
      const maxE = this._pairMax[last];
      this._pairMin[slot] = minE;
      this._pairMax[slot] = maxE;
      this._pairGenMin[slot] = this._pairGenMin[last];
      this._pairGenMax[slot] = this._pairGenMax[last];
      this._pairBegan[slot] = this._pairBegan[last];
      this._pairSlot.set(collisionPairKey(minE, maxE), slot);
    }
    this._pairSlot.delete(key);
  }

  _growForeignColumns() {
    const cap = this._foreignCapacity > 0 ? this._foreignCapacity * 2 : 1024;
    const grow = (old) => {
      const next = new Uint32Array(cap);
      next.set(old);
      return next;
    };
    this._foreignMin = grow(this._foreignMin);
    this._foreignMax = grow(this._foreignMax);
    this._foreignGenMin = grow(this._foreignGenMin);
    this._foreignGenMax = grow(this._foreignGenMax);
    this._foreignCapacity = cap;
  }

  _removeForeignSlot(slot, key) {
    const last = --this._foreignCount;
    if (slot !== last) {
      const minE = this._foreignMin[last];
      const maxE = this._foreignMax[last];
      this._foreignMin[slot] = minE;
      this._foreignMax[slot] = maxE;
      this._foreignGenMin[slot] = this._foreignGenMin[last];
      this._foreignGenMax[slot] = this._foreignGenMax[last];
      this._pairSlot.set(collisionPairKey(minE, maxE), -(slot + 1));
    }
    this._pairSlot.delete(key);
  }

  _foreignValid(slot) {
    const minE = this._foreignMin[slot];
    const maxE = this._foreignMax[slot];
    const active = Transform.active;
    if (!active[minE] || !active[maxE]) return false;
    const gen = this.bodyGeneration;
    return gen
      ? (Atomics.load(gen, minE) >>> 0) === this._foreignGenMin[slot] &&
          (Atomics.load(gen, maxE) >>> 0) === this._foreignGenMax[slot]
      : this._foreignGenMin[slot] === 0 && this._foreignGenMax[slot] === 0;
  }

  /** isCollidingWith: own pairs were validated this frame; foreign ones are checked here. */
  _hasPair(key) {
    const v = this._pairSlot.get(key);
    if (v === undefined) return false;
    if (v >= 0) return true;
    const slot = -v - 1;
    if (this._foreignValid(slot)) return true;
    this._removeForeignSlot(slot, key);
    return false;
  }

  _clearContactState(reason) {
    this._pairSlot.clear();
    this._pairCount = 0;
    this._foreignCount = 0;
    if (reason) {
      console.warn(`LOGIC WORKER ${this.workerIndex}: contact state cleared (${reason})`);
    }
  }

  _applyContactEnd(rawA, rawB, genA, genB) {
    const minE = rawA < rawB ? rawA : rawB;
    const maxE = rawA < rawB ? rawB : rawA;
    const key = collisionPairKey(minE, maxE);
    const slot = this._pairSlot.get(key);
    if (slot === undefined) return;
    if (slot < 0) {
      this._removeForeignSlot(-slot - 1, key);
      return;
    }
    const match =
      this._pairGenMin[slot] === ((rawA < rawB ? genA : genB) >>> 0) &&
      this._pairGenMax[slot] === ((rawA < rawB ? genB : genA) >>> 0);
    this._removePairSlot(slot, key);
    if (!match) return;
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = collisionFlags[entityType[minE]];
    const bListens = collisionFlags[entityType[maxE]];
    if (aListens) {
      try {
        gameObjects[minE]?.onCollisionExit(maxE);
      } catch (error) {
        this._entityThrew(error, minE, 'onCollisionExit');
      }
    }
    if (bListens) {
      try {
        gameObjects[maxE]?.onCollisionExit(minE);
      } catch (error) {
        this._entityThrew(error, maxE, 'onCollisionExit');
      }
    }
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
    if (minE % this.totalLogicWorkers !== this.workerIndex) {
      const v = this._pairSlot.get(key);
      let f;
      if (v === undefined) {
        if (this._foreignCount === this._foreignCapacity) this._growForeignColumns();
        f = this._foreignCount++;
        this._pairSlot.set(key, -(f + 1));
        this._foreignMin[f] = minE;
        this._foreignMax[f] = maxE;
      } else {
        f = -v - 1;
      }
      this._foreignGenMin[f] = (rawA < rawB ? genA : genB) >>> 0;
      this._foreignGenMax[f] = (rawA < rawB ? genB : genA) >>> 0;
      return;
    }
    let slot = this._pairSlot.get(key);
    const isNew = slot === undefined;
    if (isNew) {
      if (this._pairCount === this._pairCapacity) this._growPairColumns();
      slot = this._pairCount++;
      this._pairSlot.set(key, slot);
      this._pairMin[slot] = minE;
      this._pairMax[slot] = maxE;
    }
    // Box2D orders the event (shapeA, shapeB); the stay loop reads gens as (min, max).
    this._pairGenMin[slot] = (rawA < rawB ? genA : genB) >>> 0;
    this._pairGenMax[slot] = (rawA < rawB ? genB : genA) >>> 0;
    this._pairBegan[slot] = this._contactFrame;
    if (!isNew) return;
    if (minE % this.totalLogicWorkers !== this.workerIndex) return;
    const entityType = Transform.entityType;
    const collisionFlags = this.collisionListenerByType;
    const gameObjects = this.gameObjects;
    const aListens = collisionFlags[entityType[rawA]];
    const bListens = collisionFlags[entityType[rawB]];
    if (!aListens && !bListens) return;
    if (aListens) {
      try {
        gameObjects[rawA]?.onCollisionEnter(rawB);
      } catch (error) {
        this._entityThrew(error, rawA, 'onCollisionEnter');
      }
    }
    if (bListens) {
      try {
        gameObjects[rawB]?.onCollisionEnter(rawA);
      } catch (error) {
        this._entityThrew(error, rawB, 'onCollisionEnter');
      }
    }
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

    // Every slot is stamped when its pair begins, so a fresh stamp starts the frame empty.
    const frame = (this._contactFrame = (this._contactFrame + 1) >>> 0);

    const result = drainContactRing(
      this.box2dContactRingI32,
      this.box2dContactCursor,
      this._onContactRingEvent,
    );
    this.box2dContactCursor = result.nextCursor;
    this.frameCollisions = this._pairView;
    if (result.overrun) {
      // Cold start: no tracked pairs — catch up silently (common when first
      // physics steps flood the ring before logic drains).
      if (this._pairCount !== 0 || this._foreignCount !== 0) this._clearContactState('contact ring overrun');
      return;
    }

    if (--this._foreignSweepIn <= 0) {
      this._foreignSweepIn = FOREIGN_SWEEP_FRAMES;
      for (let f = 0; f < this._foreignCount; ) {
        if (this._foreignValid(f)) f++;
        else this._removeForeignSlot(f, collisionPairKey(this._foreignMin[f], this._foreignMax[f]));
      }
    }

    const gameObjects = this.gameObjects;
    const entityType = Transform.entityType;
    const active = Transform.active;
    const collisionFlags = this.collisionListenerByType;
    const gen = this.bodyGeneration;
    const pairMin = this._pairMin;
    const pairMax = this._pairMax;
    const genMin = this._pairGenMin;
    const genMax = this._pairGenMax;
    const began = this._pairBegan;

    // Purge pairs whose generation changed or entities went inactive.
    // A throwing onCollisionStay is reported and the walk resumes at the next
    // pair (s is already past it); the try sits outside the loop.
    let s = 0;
    let calling = -1;
    for (;;) {
      try {
        while (s < this._pairCount) {
          const minE = pairMin[s];
          const maxE = pairMax[s];
          const valid =
            active[minE] &&
            active[maxE] &&
            (gen
              ? (Atomics.load(gen, minE) >>> 0) === genMin[s] && (Atomics.load(gen, maxE) >>> 0) === genMax[s]
              : genMin[s] === 0 && genMax[s] === 0);
          if (!valid) {
            this._removePairSlot(s, collisionPairKey(minE, maxE));
            continue;
          }
          const beganNow = began[s] === frame;
          s++;
          if (beganNow) continue;
          const aListens = collisionFlags[entityType[minE]];
          const bListens = collisionFlags[entityType[maxE]];
          calling = minE;
          if (aListens) gameObjects[minE]?.onCollisionStay(maxE);
          calling = maxE;
          if (bListens) gameObjects[maxE]?.onCollisionStay(minE);
        }
        break;
      } catch (error) {
        this._entityThrew(error, calling, 'onCollisionStay');
      }
    }
  }

  /**
   * Check screen visibility changes and trigger lifecycle methods
   * Detects when entities enter or exit the screen and calls onScreenEnter/onScreenExit
   * @param {number} entityIndex - The entity's index
   * @param {GameObject} obj - The entity instance
   */
  checkScreenVisibility(entityIndex, obj) {
    const currentlyVisible = Camera.isOnScreen(
      Transform.x[entityIndex],
      Transform.y[entityIndex],
    ) ? 1 : 0;
    const wasVisible = this.previousScreenVisibility[entityIndex];
    noteScreenVisibility(currentlyVisible, wasVisible, obj);
    this.previousScreenVisibility[entityIndex] = currentlyVisible;
  }

  /**
   * Handle custom messages from Scene or other workers
   * Implements spawning and despawning commands
   */
  /**
   * Logic0 side of a save load: despawn the serializable types, respawn the
   * saved entities, then chains, fixtures, meshes, tweens, id remaps and
   * joints. Returns the restoreSaveComplete reply.
   * @param {object} data restoreSave message
   * @returns {object}
   */
  _restoreSave(data) {
    const {
      serializableClassNames = [],
      entities = [],
      joints = [],
      chains = [],
      fixtures = [],
      meshes = [],
      tweens = [],
    } = data;
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

    const restoredPairs = [];
    const mapGet = (old) => {
      const key = old | 0;
      return oldToNew.has(key) ? oldToNew.get(key) | 0 : null;
    };
    for (const [old, neu] of oldToNew) {
      restoredPairs.push({ old, neu });
    }
    applyChains(chains, restoredPairs);
    applyFixtures(fixtures, restoredPairs);
    applyMeshes(meshes, restoredPairs);
    applyTweens(tweens, mapGet, restoredPairs);
    for (let r = 0; r < entities.length; r++) {
      const rec = entities[r];
      if (rec.entityIndex == null) continue;
      const neu = mapGet(rec.entityIndex);
      if (neu == null) continue;
      const EntityClass = self[rec.typeName];
      if (!EntityClass) continue;
      remapEntityIdFields(EntityClass, neu, rec.components, mapGet);
    }

    if (joints.length && typeof Joint.restoreFromSave === 'function') {
      Joint.restoreFromSave(joints, oldToNew);
    }

    const idPairs = [];
    for (let p = 0; p < restoredPairs.length; p++) {
      idPairs.push(restoredPairs[p].old | 0, restoredPairs[p].neu | 0);
    }

    // Flush active lists before ack so entities are fully in the scene.
    this.processListUpdates();
    return {
      msg: 'restoreSaveComplete',
      restored,
      failed,
      idPairs,
    };
  }

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
          debugWorkerLog(`LOGIC WORKER ${this.workerIndex}: Box2D contact ring bound`);
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

        // HEAP bound — construct pools so onSpawned writes live Transform.x, then signal ready.
        if (!this._gameObjectInstancesCreated) {
          this.createGameObjectInstances();
          this._gameObjectInstancesCreated = true;
          this.reportReady();
          debugWorkerLog(
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

        debugWorkerLog(
          `LOGIC WORKER ${this.workerIndex}: Despawned ${despawnedCount} ${className} entities`
        );
        break;
      }

      case 'restoreSave': {
        if (this.workerIndex !== 0) break;
        // Always answer: main awaits this reply, and a throw that skipped it
        // left the load waiting forever.
        let reply;
        try {
          reply = this._restoreSave(data);
        } catch (err) {
          console.error(`LOGIC WORKER ${this.workerIndex}: restoreSave failed`, err);
          reply = {
            msg: 'restoreSaveComplete',
            error: String((err && err.stack) || err),
            restored: 0,
            failed: 0,
            jointsRestored: 0,
            idPairs: [],
          };
        }
        self.postMessage(reply);
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
          this.enqueueListUpdateBatch(deserializedSpawns, deserializedDespawns);
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
      // The index was reserved on main (an empty pool is reported there), so a
      // null here is onSpawned despawning its own entity: a choice, not an error.
      debugWorkerLog(`LOGIC WORKER ${this.workerIndex}: ${className}[${entityIndex}] spawn did not complete`);
    }
  }

  /**
   * Ring drain runs on logic0. A class pinned to another worker makes spawn()
   * post the setup there and return null. That null is the handoff, not a miss.
   */
  _ringSpawnHandedOff(EntityClass, cfg) {
    const requested =
      cfg && typeof cfg.forceProcessOnLogicWorker === 'number'
        ? cfg.forceProcessOnLogicWorker
        : typeof EntityClass.forceProcessOnLogicWorker === 'number'
          ? EntityClass.forceProcessOnLogicWorker
          : -1;
    const owner = resolveForceProcessOnLogicWorker(requested, this.totalLogicWorkers);
    return owner >= 0 && owner !== this.workerIndex;
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
      if (!instance && !this._ringSpawnHandedOff(EntityClass, cfg)) {
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
    // WAIT_MS is the real blocked-on-physics time from the sync Box2D queries.
    this._writeFrameMeters(LOGIC_STATS);
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
    // E-27. Always on, like IDLE_MS: the live pair count is a premise, not a
    // detailed diagnostic. Map.size is one load of a field the map already keeps.
    this.stats[LOGIC_STATS.PAIR_COUNT] = this._pairSlot.size;
    // M11: every worker's map holds every pair; this is the share it validates.
    this.stats[LOGIC_STATS.PAIR_OWN] = this._pairCount;
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
