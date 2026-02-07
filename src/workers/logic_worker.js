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

    // Frame synchronization (for multi-worker coordination)
    this.syncData = null; // Int32Array for Atomics-based work coordination
    this.totalLogicWorkers = 1; // Total number of logic workers

    // Job queue for dynamic work distribution
    this.jobQueueData = null; // Int32Array: [currentJobIndex, totalJobs, job0_start, job0_end, ...]

    // Performance tracking
    this.activeEntityCount = 0; // Number of active entities this worker is processing
    this.jobsProcessedThisFrame = 0; // Track jobs claimed
    this.jobsStolenThisFrame = 0; // Track jobs stolen from queue (same as jobs processed)
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

    // Initialize synchronization buffer for multi-worker coordination
    if (data.buffers.syncData) {
      this.syncData = new Int32Array(data.buffers.syncData);
      this.totalLogicWorkers = this.syncData[2]; // Total workers stored at index 2

      // console.log(
      //   `LOGIC WORKER ${this.workerIndex}: Job-based work distribution with ${this.totalLogicWorkers} workers`
      // );
    }

    // Initialize job queue for dynamic work distribution
    if (data.buffers.jobQueueData) {
      this.jobQueueData = new Int32Array(data.buffers.jobQueueData);
      const totalJobs = this.jobQueueData[1];
      //  console.log(
      //   `LOGIC WORKER ${this.workerIndex}: Job queue initialized (${totalJobs} jobs total)`
      // );
    }

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

    // Initialize ParticleEmitter if particles are configured
    // Particles are NOT entities - they have their own separate pool
    // Note: ParticleComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    const maxParticles = data.maxParticles || 0;
    if (maxParticles > 0) {
      ParticleEmitter.initialize(maxParticles);

      // Initialize shared free list for O(1) particle allocation
      if (data.particleFreeList && data.particleFreeListTop) {
        ParticleEmitter.initializeFreeList(data.particleFreeList, data.particleFreeListTop);
      }
    }

    // Initialize DecorationPool if decorations are configured
    // Decorations are NOT entities - they have their own separate pool
    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    const maxDecorations = data.maxDecorations || 0;
    if (maxDecorations > 0) {
      DecorationPool.initialize(maxDecorations);
    }

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
        EntityClass.entityIndices = new Int32Array(poolSize);
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
      } else {
        console.warn(`LOGIC WORKER: Class ${name} not found in worker scope!`);
      }
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * Uses job-based system: workers atomically claim jobs and process them
   */
  update(deltaTime, dtRatio, resuming) {
    this.frameStartTime = performance.now();

    // Reset stats for this frame
    this.jobsProcessedThisFrame = 0;
    this.jobsStolenThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;
    this.systemsExecutedThisFrame = 0;

    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      this.processCollisionCallbacks();
      this.systemsExecutedThisFrame++; // Collision system executed
    }

    // Count active entities while processing jobs
    let activeCount = 0;

    // OPTIMIZED: Use activeEntitiesData to skip inactive entities entirely
    // particle_worker builds this list at the start of each frame
    const totalActiveEntities = this.activeEntitiesData ? this.activeEntitiesData[0] : 0;

    // PERFORMANCE: Cache Grid arrays once to avoid property lookups per entity
    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    // Job-based processing: atomically claim jobs until none remain
    // Jobs are now ranges in the active entity list, not entity index ranges
    while (true) {
      // Atomically claim the next job
      const jobIndex = Atomics.add(this.jobQueueData, 0, 1);
      const totalJobs = this.jobQueueData[1];

      // Check if all jobs are claimed
      if (jobIndex >= totalJobs) {
        break; // No more jobs, this worker is done
      }

      this.jobsProcessedThisFrame++;
      this.jobsStolenThisFrame++; // Track as stolen job

      // Get job range from buffer (these are indices into the active entity list)
      const jobStartIndex = this.jobQueueData[2 + jobIndex * 2];
      const jobEndIndex = this.jobQueueData[2 + jobIndex * 2 + 1];

      // Clamp job range to actual active entity count
      const actualEndIndex = Math.min(jobEndIndex, totalActiveEntities);

      // Process all active entities in this job's range
      for (let activeIdx = jobStartIndex; activeIdx < actualEndIndex; activeIdx++) {
        // Get actual entity index from active list (one extra indirection)
        const entityIndex = this.activeEntitiesData[1 + activeIdx];
        const obj = this.gameObjects[entityIndex];

        if (obj) {
          activeCount++;
          this.entitiesProcessedThisFrame++;

          // OPTIMIZED: updating neighbors uses cached Grid arrays (GC free)
          // Pass cached arrays to avoid property lookups per entity
          obj.updateNeighbors(neighborData, null, stride);

          // TICK DECIMATION: Skip tick if countdown hasn't reached 0
          // Entities with tickInterval > 1 only tick every N frames (staggered by index)
          // Cost: ~3 cycles (decrement + compare + branch) vs ~20 cycles for modulo
          let tickInterval = 1;
          if (GameObject.nextTick) {
            tickInterval = obj.constructor.tickInterval || 1;
            if (tickInterval > 1) {
              if (--GameObject.nextTick[entityIndex] > 0) {
                // Skip tick, but still check screen visibility
                this.checkScreenVisibility(entityIndex, obj);
                continue;
              }
              // Reset countdown for next cycle
              GameObject.nextTick[entityIndex] = tickInterval;
            }
          }

          // Tick entity logic with full timing info
          // dtRatio: normalized to 60fps (1.0 = 16.67ms), deltaTime: actual ms, accumulatedTime: total ms, frameNumber
          obj.tick(dtRatio, deltaTime, this.accumulatedTime, this.frameNumber);

          // ACCELERATION SCALING: Compensate for tick decimation
          // If entity ticks every N frames, scale acceleration by N so physics
          // integrates the same total impulse. Without this, entities with
          // tickInterval > 1 would move N times slower.
          // console.log("tickInterval", tickInterval);

          if (tickInterval > 1) {
            RigidBody.ax[entityIndex] *= tickInterval;
            RigidBody.ay[entityIndex] *= tickInterval;
          }

          // Check for screen visibility changes and call lifecycle methods
          this.checkScreenVisibility(entityIndex, obj);
        }
      }
    }

    // Entity processing system executed
    if (this.jobsProcessedThisFrame > 0) {
      this.systemsExecutedThisFrame++; // Entity tick system executed
    }

    // Reset job queue for next frame
    // Use syncData[1] as a "workers finished" counter for this frame
    if (this.syncData && this.totalLogicWorkers > 1) {
      const finishedCount = Atomics.add(this.syncData, 1, 1) + 1;

      if (finishedCount === this.totalLogicWorkers) {
        // Last worker to finish - reset for next frame
        Atomics.store(this.jobQueueData, 0, 0); // Reset job counter
        Atomics.store(this.syncData, 1, 0); // Reset finished counter
      }
    } else if (this.totalLogicWorkers === 1) {
      // Single worker mode - just reset directly
      Atomics.store(this.jobQueueData, 0, 0);
    }

    // Store active count for FPS reporting
    this.activeEntityCount = activeCount;

    // Update previous mouse values for next frame
    // This allows entities to access Mouse.prevX, Mouse.prevY, Mouse.prevButton0 in their tick() methods
    Mouse.updatePreviousValues();

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
      if (obj.onScreenEnter) {
        obj.onScreenEnter();
      }
    } else if (!currentlyVisible && wasVisible) {
      // Entity just exited the screen
      if (obj.onScreenExit) {
        obj.onScreenExit();
      }
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

        const { className, spawnConfig } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot spawn ${className} - class not found!`
          );
          return;
        }

        const instance = GameObject.spawn(EntityClass, spawnConfig);
        if (!instance) {
          console.warn(
            `LOGIC WORKER ${this.workerIndex}: Failed to spawn ${className} - pool exhausted!`
          );
        }
        break;
      }

      case 'despawn': {
        // Only worker 0 handles despawn to keep freeList synchronized with spawn
        if (this.workerIndex !== 0) {
          break;
        }

        const { entityIndex } = data;

        // Validate entity index
        if (
          entityIndex < 0 ||
          entityIndex >= this.globalEntityCount ||
          !Transform.active[entityIndex]
        ) {
          break;
        }

        // Get the instance and despawn it
        const instance = this.gameObjects[entityIndex];
        if (instance && instance.despawn) {
          instance.despawn();
        }
        break;
      }

      // Handle spawn requests from other logic workers (worker-to-worker message)
      case 'spawnRequest': {
        // This should only be received by worker 0 (routed from other workers)
        if (this.workerIndex !== 0) {
          console.warn(
            `LOGIC WORKER ${this.workerIndex}: Received spawnRequest but I'm not worker 0!`
          );
          break;
        }

        const { className, spawnConfig } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot spawn ${className} - class not found!`
          );
          break;
        }

        const instance = GameObject.spawn(EntityClass, spawnConfig);
        if (!instance) {
          // console.warn(
          //   `LOGIC WORKER ${this.workerIndex}: Failed to spawn ${className} - pool exhausted!`
          // );
        }
        break;
      }

      // Handle despawn requests from other logic workers (worker-to-worker message)
      case 'despawnRequest': {
        // This should only be received by worker 0 (routed from other workers)
        if (this.workerIndex !== 0) {
          console.warn(
            `LOGIC WORKER ${this.workerIndex}: Received despawnRequest but I'm not worker 0!`
          );
          break;
        }

        const { entityIndex, className } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot despawn ${className} - class not found!`
          );
          break;
        }

        // Entity is already deactivated by the requesting worker
        // We just need to return the index to the freeList
        if (EntityClass.freeList) {
          EntityClass.freeList[++EntityClass.freeListTop] = entityIndex;
        }
        break;
      }

      case 'despawnAll': {
        // Only worker 0 handles despawnAll to keep freeList synchronized with spawn
        // (spawn also only runs on worker 0)
        if (this.workerIndex !== 0) {
          break;
        }

        const { className } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot despawn ${className} - class not found!`
          );
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Available classes:`,
            Object.keys(self).filter((key) => typeof self[key] === 'function')
          );
          return;
        }

        // Despawn ALL entities of this type (no partitioning - worker 0 handles all)
        // OPTIMIZED: Use activeEntitiesData to skip inactive entities
        let count = 0;
        let skippedNoInstance = 0;
        const entityType = EntityClass.entityType;
        const totalActiveEntities = this.activeEntitiesData ? this.activeEntitiesData[0] : 0;

        // Only iterate through active entities, not the entire pool
        for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
          const i = this.activeEntitiesData[1 + activeIdx];
          if (Transform.entityType[i] === entityType) {
            if (this.gameObjects[i]) {
              this.gameObjects[i].despawn();
              count++;
            } else {
              // Fallback: manually deactivate if no instance exists
              // Also update all active lists (incremental active entity management)
              GameObject._removeFromMatchingQueries(i, entityType);
              GameObject._removeFromActiveEntities(i);
              GameObject._removeFromTypeActiveList(EntityClass, i);

              Transform.active[i] = 0;
              if (RigidBody.active && RigidBody.active[i]) RigidBody.active[i] = 0;
              if (Collider.active && Collider.active[i]) Collider.active[i] = 0;
              if (SpriteRenderer.active && SpriteRenderer.active[i]) SpriteRenderer.active[i] = 0;

              // Return to free list
              if (EntityClass.freeList) {
                EntityClass.freeList[++EntityClass.freeListTop] = i;
              }

              skippedNoInstance++;
              count++;
            }
          }
        }

        console.log(
          `LOGIC WORKER ${this.workerIndex}: Despawned ${count} ${className} entities (${skippedNoInstance} without instances)`
        );
        break;
      }

      case 'clearAll': {
        // Only worker 0 handles clearAll to keep freeList synchronized with spawn
        if (this.workerIndex !== 0) {
          break;
        }

        // Despawn ALL entities (no partitioning - worker 0 handles all)
        // OPTIMIZED: Use activeEntitiesData to skip inactive entities
        let totalDespawned = 0;
        const totalActiveEntities = this.activeEntitiesData ? this.activeEntitiesData[0] : 0;

        // Only iterate through active entities, not the entire pool
        for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
          const i = this.activeEntitiesData[1 + activeIdx];
          if (this.gameObjects[i]) {
            this.gameObjects[i].despawn();
            totalDespawned++;
          }
        }

        // console.log(
        //   `LOGIC WORKER ${this.workerIndex}: Cleared ${totalDespawned} entities`
        // );
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
      this.stats[LOGIC_STATS.JOBS_STOLEN] = this.jobsStolenThisFrame;
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
