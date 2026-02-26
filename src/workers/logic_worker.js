self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { Mouse } from '../core/Mouse.js';
import Keyboard from '../core/Keyboard.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';
import { ParticleEmitter } from '../core/ParticleEmitter.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { Flash } from '../core/Flash.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import { LOGIC_STATS, createMultiWorkerStatsWriter } from './workers-utils.js';
import { cantorUnpair, _cantorResult } from '../core/utils.js';

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

    // Collision tracking (Unity-style Enter/Stay/Exit)
    this.collisionData = null; // SharedArrayBuffer for collision pairs from physics worker

    // Optimized collision tracking using numeric keys instead of strings
    // Uses Cantor pairing function: key = (a + b) * (a + b + 1) / 2 + b
    // This eliminates string allocation and GC pressure
    // Reverse lookups use cantorUnpair() - no Map needed (zero GC)
    this.previousCollisions = new Set(); // Track collisions from last frame (numeric keys)
    this.currentCollisions = new Set(); // Track collisions in current frame (numeric keys)

    // Screen visibility tracking (for onScreenEnter/Exit lifecycle methods)
    // Track previous frame's visibility state to detect transitions
    this.previousScreenVisibility = new Uint8Array(0); // Will be sized in initialize()

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

    // Store key index mapping for Keyboard class
    this.keyIndexMap = data.keyIndexMap || {};

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

    // console.log("LOGIC WORKER: Initializing with component system");

    // Initialize collision buffer
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      console.log('LOGIC WORKER: Collision callbacks enabled');
    }

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

    // Create GameObject instances
    this.createGameObjectInstances();

    // Initialize Keyboard static class with input data (once, not every frame)
    // Note: Mouse position/state is read from Mouse static class (SharedArrayBuffer)
    Keyboard.initialize(this.inputData, this.keyIndexMap);

    // console.log(
    //   `LOGIC WORKER ${this.workerIndex}: Total ${this.globalEntityCount} GameObjects ready (job-based processing)`
    // );
    // console.log(
    //   `LOGIC WORKER ${this.workerIndex}: Initialization complete, waiting for start signal...`
    // );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   * DENSE ALLOCATION: entityIndex === componentIndex for all components
   */
  createGameObjectInstances() {
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

        // Create component class map for this entity
        // Get component classes directly from the entity's static components array
        const componentClassMap = {};
        const components = GameObject._collectComponents(EntityClass);

        for (const ComponentClass of components) {
          const componentName = ComponentClass.name;
          const camelCaseName = componentName.charAt(0).toLowerCase() + componentName.slice(1);
          componentClassMap[camelCaseName] = ComponentClass;
        }
        EntityClass._componentClassMap = componentClassMap;

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
            });
          } else {
            // Non-decimated type: simple loop, zero overhead
            this.nonDecimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              startIndex,
            });
          }
        }
      } else {
        console.warn(`LOGIC WORKER: Class ${name} not found in worker scope!`);
      }
    }
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
    // ORDERING: Despawns first, then spawns.
    // This ensures rapid despawn→re-spawn cycles at the same index resolve correctly:
    // the old entry is removed before the new one is added (with dedup preventing duplicates).

    // Process own pending updates
    this._processDespawnUpdates(this.pendingDespawnListUpdates);
    this._processSpawnUpdates(this.pendingSpawnListUpdates);
    this.pendingDespawnListUpdates = [];
    this.pendingSpawnListUpdates = [];

    // Process updates received from other workers (same order)
    for (const batch of this.receivedListUpdates) {
      if (batch.despawns) {
        this._processDespawnUpdates(batch.despawns);
      }
      if (batch.spawns) {
        this._processSpawnUpdates(batch.spawns);
      }
    }
    this.receivedListUpdates = [];
  }

  /**
   * Process spawn list updates - add entities to active lists
   */
  _processSpawnUpdates(updates) {
    for (const update of updates) {
      const { entityIndex, entityType, EntityClass } = update;
      // Only add if entity is still active (wasn't despawned in same frame)
      if (Transform.active[entityIndex] === 1) {
        GameObject._addToActiveEntities(entityIndex);
        GameObject._addToTypeActiveList(EntityClass, entityIndex);
        GameObject._addToMatchingQueries(entityIndex, entityType);
      }
    }
  }

  /**
   * Process despawn list updates - remove entities from active lists
   * No active-state guard: despawns are processed BEFORE spawns, so a re-spawned
   * entity will be re-added in the subsequent spawn pass (with dedup protection).
   */
  _processDespawnUpdates(updates) {
    for (const update of updates) {
      const { entityIndex, entityType, EntityClass } = update;
      GameObject._removeFromMatchingQueries(entityIndex, entityType);
      GameObject._removeFromActiveEntities(entityIndex);
      GameObject._removeFromTypeActiveList(EntityClass, entityIndex);
    }
  }

  /**
   * Send pending list updates to logic0 (called at end of frame by non-logic0 workers)
   */
  sendListUpdatesToLogic0() {
    if (this.pendingSpawnListUpdates.length === 0 && this.pendingDespawnListUpdates.length === 0) {
      return;
    }

    // Serialize EntityClass to class name for message passing
    const spawns = this.pendingSpawnListUpdates.map(u => ({
      entityIndex: u.entityIndex,
      entityType: u.entityType,
      className: u.EntityClass.name,
    }));
    const despawns = this.pendingDespawnListUpdates.map(u => ({
      entityIndex: u.entityIndex,
      entityType: u.entityType,
      className: u.EntityClass.name,
    }));

    this.sendDataToWorker('logic0', {
      msg: 'listUpdates',
      spawns,
      despawns,
    });

    this.pendingSpawnListUpdates = [];
    this.pendingDespawnListUpdates = [];
  }

  update(deltaTime, dtRatio, resuming) {
    this.frameStartTime = performance.now();

    // Reset stats for this frame
    this.entitiesProcessedThisFrame = 0;
    this.systemsExecutedThisFrame = 0;

    // ========================================
    // PHASE 0: PROCESS LIST UPDATES (logic0 only)
    // ========================================
    // All spawn/despawn list updates are queued and processed here BEFORE any ticks.
    // This ensures single-threaded list operations, avoiding race conditions.
    if (this.workerIndex === 0) {
      this.processListUpdates();
    }

    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      this.processCollisionCallbacks();
      this.systemsExecutedThisFrame++; // Collision system executed
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

      // Worker partitioning within this type's active list
      for (let idx = myIndex; idx < count; idx += totalWorkers) {
        const entityIndex = activeList[1 + idx];

        // Skip despawned entities (may still be in list until logic0 processes removal)
        if (transformActive[entityIndex] === 0) continue;

        const obj = gameObjects[entityIndex];
        if (!obj || typeof obj.tick !== 'function') continue;

        activeCount++;
        this.entitiesProcessedThisFrame++;

        // Tick entity logic - no decimation checks needed!
        obj.tick(dtRatio, deltaTime, accTime, frameNum);

        // Check for screen visibility changes
        this.checkScreenVisibility(entityIndex, obj);
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

        // Worker partitioning within this type's active list
        for (let idx = myIndex; idx < count; idx += totalWorkers) {
          const entityIndex = activeList[1 + idx];

          // Skip despawned entities (may still be in list until logic0 processes removal)
          if (transformActive[entityIndex] === 0) continue;

          const obj = gameObjects[entityIndex];
          if (!obj || typeof obj.tick !== 'function') continue;

          activeCount++;
          this.entitiesProcessedThisFrame++;

          // TICK DECIMATION: Check countdown
          if (--nextTick[entityIndex] > 0) {
            // Skip tick, but still check screen visibility
            this.checkScreenVisibility(entityIndex, obj);
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

          // Check for screen visibility changes
          this.checkScreenVisibility(entityIndex, obj);
        }
      }
    }

    // Entity processing system executed
    if (this.entitiesProcessedThisFrame > 0) {
      this.systemsExecutedThisFrame++; // Entity tick system executed
    }

    // Store active count for FPS reporting
    this.activeEntityCount = activeCount;

    // Update previous mouse values for next frame
    // This allows entities to access Mouse.prevX, Mouse.prevY, Mouse.prevButton0 in their tick() methods
    if (this.workerIndex === 0) Mouse.updatePreviousValues();

    // ========================================
    // PHASE 3: SEND LIST UPDATES TO LOGIC0 (non-logic0 workers)
    // ========================================
    // At end of frame, send any queued spawn/despawn list updates to logic0
    if (this.workerIndex !== 0) {
      this.sendListUpdatesToLogic0();
    }
  }

  /**
   * Process collision callbacks (Unity-style)
   * Determines Enter/Stay/Exit states and calls appropriate callbacks
   * Partitions collision processing across workers using modulo (minEntity % workers == myIndex)
   * OPTIMIZED: Normalized (min,max) ordering - ONE key per collision pair (half the storage)
   * ZERO ALLOC: Cantor pairing + inline min/max comparison, no string concat
   */
  processCollisionCallbacks() {
    // Read collision pairs from physics worker
    const pairCount = this.collisionData[0];

    // Clear current collisions set
    this.currentCollisions.clear();

    // Cache for hot loop
    const collisionData = this.collisionData;
    const totalWorkers = this.totalLogicWorkers;
    const myIndex = this.workerIndex;
    const gameObjects = this.gameObjects;
    const prevCollisions = this.previousCollisions;
    const currCollisions = this.currentCollisions;

    // Read all collision pairs and populate current collisions
    for (let i = 0; i < pairCount; i++) {
      const rawA = collisionData[1 + i * 2];
      const rawB = collisionData[1 + i * 2 + 1];

      // Normalize to (min, max) - ensures consistent key regardless of collision order
      // Branch-free would be slower here; ternary is ~2 cycles
      const minE = rawA < rawB ? rawA : rawB;
      const maxE = rawA < rawB ? rawB : rawA;

      // Partition by minEntity for deterministic worker assignment
      // Same entity pair always handled by same worker (Enter + Stay + Exit)
      if (minE % totalWorkers !== myIndex) {
        continue;
      }

      // Single normalized key per collision pair (half the storage of bidirectional)
      // Cantor pairing: key = (a + b) * (a + b + 1) / 2 + b
      const sum = minE + maxE;
      const key = ((sum * (sum + 1)) >> 1) + maxE;

      currCollisions.add(key);

      // Check previous frame - was this pair already colliding?
      const isNewCollision = !prevCollisions.has(key);

      const objA = gameObjects[rawA];
      const objB = gameObjects[rawB];

      if (isNewCollision) {
        // OnCollisionEnter - First frame of collision
        if (objA && objA.onCollisionEnter) objA.onCollisionEnter(rawB);
        if (objB && objB.onCollisionEnter) objB.onCollisionEnter(rawA);
      } else {
        // OnCollisionStay - Continuous collision
        if (objA && objA.onCollisionStay) objA.onCollisionStay(rawB);
        if (objB && objB.onCollisionStay) objB.onCollisionStay(rawA);
      }
    }

    // Check for collisions that ended (OnCollisionExit)
    // cantorUnpair recovers (min, max) from normalized key - zero allocation
    for (const prevKey of prevCollisions) {
      if (!currCollisions.has(prevKey)) {
        // Inverse Cantor: recover (minEntity, maxEntity) from key
        cantorUnpair(prevKey, _cantorResult);
        const minE = _cantorResult.a;
        const maxE = _cantorResult.b;

        // Same partitioning as entry path (minEntity % workers)
        if (minE % totalWorkers === myIndex) {
          const objA = gameObjects[minE];
          const objB = gameObjects[maxE];

          if (objA && objA.onCollisionExit) objA.onCollisionExit(maxE);
          if (objB && objB.onCollisionExit) objB.onCollisionExit(minE);
        }
      }
    }

    // Swap current and previous for next frame (no allocation)
    const temp = this.previousCollisions;
    this.previousCollisions = this.currentCollisions;
    this.currentCollisions = temp;
  }

  /**
   * Check screen visibility changes and trigger lifecycle methods
   * Detects when entities enter or exit the screen and calls onScreenEnter/onScreenExit
   * @param {number} entityIndex - The entity's index
   * @param {GameObject} obj - The entity instance
   */
  checkScreenVisibility(entityIndex, obj) {
    // Get current visibility state from SpriteRenderer (updated by spatial worker)
    const currentlyVisible = SpriteRenderer.isItOnScreen[entityIndex];
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

        // Deserialize class names to EntityClass references
        const { spawns, despawns } = data;

        const deserializedSpawns = spawns?.map(u => ({
          entityIndex: u.entityIndex,
          entityType: u.entityType,
          EntityClass: self[u.className],
        })).filter(u => u.EntityClass) || [];

        const deserializedDespawns = despawns?.map(u => ({
          entityIndex: u.entityIndex,
          entityType: u.entityType,
          EntityClass: self[u.className],
        })).filter(u => u.EntityClass) || [];

        // Queue for processing at start of next frame
        if (deserializedSpawns.length > 0 || deserializedDespawns.length > 0) {
          this.receivedListUpdates.push({
            spawns: deserializedSpawns,
            despawns: deserializedDespawns,
          });
        }
        break;
      }

      default:
        // Unknown message - ignore or log
        break;
    }
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */
  reportFPS() {
    // Write stats to SharedArrayBuffer every frame
    if (this.stats) {
      this.stats[LOGIC_STATS.FPS] = this.currentFPS;
      this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
      this.stats[LOGIC_STATS.SYSTEMS_EXECUTED] = this.systemsExecutedThisFrame;
    }
  }
}

// Create singleton instance and setup message handler
self.logicWorker = new LogicWorker(self);

/**
 * Global query function for component-based entity filtering
 * Available to all entity code running in logic workers
 * @param {Array<Component>} componentClasses - Array of component classes to query
 * @returns {Int32Array} - Indices of matching entities
 *
 * @example
 * // Inside Prey.tick() or any entity method:
 * const allPredators = query([RigidBody, PredatorBehavior]);
 * const visibleEntities = query([SpriteRenderer, Transform]);
 *
 * // Or use via WEED namespace:
 * import WEED from "/src/index.js";
 * const { query } = WEED;
 */
function query(componentClasses) {
  return self.logicWorker.query(componentClasses);
}

// Make query available globally and in WEED namespace for entity code
self.query = query;
globalThis.query = query;
