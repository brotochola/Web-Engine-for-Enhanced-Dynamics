self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import engine dependencies
import { GameObject } from "../core/gameObject.js";
import { Mouse } from "../core/Mouse.js";
import Keyboard from "../core/Keyboard.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { ParticleComponent } from "../components/ParticleComponent.js";
import { FlashComponent } from "../components/FlashComponent.js";
import { SpriteSheetRegistry } from "../core/SpriteSheetRegistry.js";
import { ParticleEmitter } from "../core/ParticleEmitter.js";
import { DecorationPool } from "../core/DecorationPool.js";
import { Flash } from "../core/Flash.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { LOGIC_STATS, createMultiWorkerStatsWriter } from "./workers-utils.js";
import { cantorPair } from "../core/utils.js";

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
    this.gameObjects = [];

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

    // Detailed profiling (only tracked when enabled)
    this.enableProfiling = false; // Set to true to enable detailed profiling
    this.profilingStats = {
      collisionTime: 0,
      jobProcessingTime: 0,
      neighborUpdateTime: 0,
      tickTime: 0,
      totalFrameTime: 0,
      totalNeighborsProcessed: 0,
    };
    this.profileReportInterval = 120; // Report every N frames

    // Collision tracking (Unity-style Enter/Stay/Exit)
    this.collisionData = null; // SharedArrayBuffer for collision pairs from physics worker

    // Optimized collision tracking using numeric keys instead of strings
    // Uses Cantor pairing function: key = (a + b) * (a + b + 1) / 2 + b
    // This eliminates string allocation and GC pressure
    this.previousCollisions = new Set(); // Track collisions from last frame (numeric keys)
    this.currentCollisions = new Set(); // Track collisions in current frame (numeric keys)

    // Collision pair cache for reverse lookups (key -> [entityA, entityB])
    this.collisionPairCache = new Map(); // Only for exit events

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
        for (const [sheetName, proxyData] of Object.entries(
          data.bigAtlasProxySheets
        )) {
          SpriteSheetRegistry.registerProxy(sheetName, proxyData);
        }
        console.log(
          `LOGIC WORKER ${this.workerIndex}: Registered ${
            Object.keys(data.bigAtlasProxySheets).length
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
      console.log("LOGIC WORKER: Collision callbacks enabled");
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
    }

    // Initialize DecorationPool if decorations are configured
    // Decorations are NOT entities - they have their own separate pool
    // Note: DecorationComponent is automatically initialized by AbstractWorker.initializeCommonBuffers()
    const maxDecorations = data.maxDecorations || 0;
    if (maxDecorations > 0) {
      DecorationPool.initialize(maxDecorations);
    }

    // Create GameObject instances
    this.createGameObjectInstances();

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
        if (!EntityClass.hasOwnProperty("instances")) {
          EntityClass.instances = [];
        }

        // Create component class map for this entity
        // Get component classes directly from the entity's static components array
        const componentClassMap = {};
        const components = GameObject._collectComponents(EntityClass);

        for (const ComponentClass of components) {
          const componentName = ComponentClass.name;
          const camelCaseName =
            componentName.charAt(0).toLowerCase() + componentName.slice(1);
          componentClassMap[camelCaseName] = ComponentClass;
        }
        EntityClass._componentClassMap = componentClassMap;

        // Special initialization for internal engine classes
        // Flash needs its initialize() called with the pool size
        // Note: Flash uses Camera class directly for off-screen culling
        if (name === "Flash" && EntityClass.initialize) {
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
    let t0, t1, t2, t3, t4;

    // Reset stats for this frame
    this.jobsProcessedThisFrame = 0;
    this.jobsStolenThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;
    this.systemsExecutedThisFrame = 0;

    // Initialize Keyboard static class with input data
    // Note: Mouse position/state is now read directly from Transform/MouseComponent
    Keyboard.initialize(this.inputData, this.keyIndexMap);

    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      if (this.enableProfiling) {
        t0 = performance.now();
      }

      this.processCollisionCallbacks();
      this.systemsExecutedThisFrame++; // Collision system executed

      if (this.enableProfiling) {
        t1 = performance.now();
        this.profilingStats.collisionTime += t1 - t0;
      }
    }

    // Count active entities while processing jobs
    let activeCount = 0;
    let totalNeighborsThisFrame = 0;

    if (this.enableProfiling) {
      t2 = performance.now();
    }

    // OPTIMIZED: Use activeEntitiesData to skip inactive entities entirely
    // particle_worker builds this list at the start of each frame
    const totalActiveEntities = this.activeEntitiesData
      ? this.activeEntitiesData[0]
      : 0;

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
      for (
        let activeIdx = jobStartIndex;
        activeIdx < actualEndIndex;
        activeIdx++
      ) {
        // Get actual entity index from active list (one extra indirection)
        const entityIndex = this.activeEntitiesData[1 + activeIdx];
        const obj = this.gameObjects[entityIndex];

        if (obj) {
          activeCount++;
          this.entitiesProcessedThisFrame++;

          // Update neighbor references before tick
          const neighborStart = this.enableProfiling ? performance.now() : 0;

          // OPTIMIZED: updating neighbors no longer allocates subarrays (GC free)
          // It just updates _neighborOffset and neighborCount integers
          obj.updateNeighbors(this.neighborData, this.distanceData);

          if (this.enableProfiling) {
            const neighborEnd = performance.now();
            this.profilingStats.neighborUpdateTime +=
              neighborEnd - neighborStart;
            // Track how many neighbors this entity has
            totalNeighborsThisFrame += obj.neighborCount;
          }

          // Tick entity logic (no inputData parameter - use this.mouse / this.keyboard instead)
          const tickStart = this.enableProfiling ? performance.now() : 0;
          obj.tick(dtRatio);

          if (this.enableProfiling) {
            const tickEnd = performance.now();
            this.profilingStats.tickTime += tickEnd - tickStart;
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
      // Check if main thread is active (syncData[4] = 1 means active, 0 means hidden tab)
      // When window is hidden, requestAnimationFrame stops, so main thread won't participate
      const mainThreadActive = Atomics.load(this.syncData, 4);
      const effectiveWorkers = mainThreadActive
        ? this.totalLogicWorkers
        : this.totalLogicWorkers - 1;

      const finishedCount = Atomics.add(this.syncData, 1, 1) + 1;

      if (finishedCount === effectiveWorkers) {
        // Last worker to finish - reset for next frame
        Atomics.store(this.jobQueueData, 0, 0); // Reset job counter
        Atomics.store(this.syncData, 1, 0); // Reset finished counter
      }
    } else if (this.totalLogicWorkers === 1) {
      // Single worker mode - just reset directly
      Atomics.store(this.jobQueueData, 0, 0);
    }

    if (this.enableProfiling) {
      t3 = performance.now();
      this.profilingStats.jobProcessingTime += t3 - t2;
      this.profilingStats.totalNeighborsProcessed += totalNeighborsThisFrame;
      this.profilingStats.totalFrameTime += t3 - t0;

      // Report profiling stats periodically
      if (this.frameNumber % this.profileReportInterval === 0) {
        this.reportProfilingStats(totalNeighborsThisFrame);
      }
    }

    // Store active count for FPS reporting
    this.activeEntityCount = activeCount;
  }

  /**
   * Generate a unique numeric key for a collision pair using Cantor pairing function
   * This eliminates string allocation and GC pressure
   * @param {number} a - First entity ID
   * @param {number} b - Second entity ID
   * @returns {number} - Unique numeric key
   */
  getCollisionKey(a, b) {
    return cantorPair(a, b);
  }

  /**
   * Process collision callbacks (Unity-style)
   * Determines Enter/Stay/Exit states and calls appropriate callbacks
   * Partitions collision processing across workers using modulo (entityA % workers == myIndex)
   * OPTIMIZED: Uses numeric keys instead of string concatenation for zero-allocation tracking
   */
  processCollisionCallbacks() {
    // Read collision pairs from physics worker
    const pairCount = this.collisionData[0];

    // DEBUG: Log collision processing
    if (this.frameCount % 60 === 0 && pairCount > 0 && this.workerIndex === 0) {
      // console.log(
      //   `[Logic ${this.workerIndex}] Frame ${this.frameCount}: Processing ${pairCount} collision pairs`
      // );
    }

    // Clear current collisions set
    this.currentCollisions.clear();

    // Read all collision pairs and populate current collisions
    for (let i = 0; i < pairCount; i++) {
      const entityA = this.collisionData[1 + i * 2];
      const entityB = this.collisionData[1 + i * 2 + 1];

      // Partition collision processing across workers using modulo
      // This avoids duplicate processing across multiple logic workers
      if (entityA % this.totalLogicWorkers !== this.workerIndex) {
        continue;
      }

      // Create unique numeric keys (both directions for easy lookup)
      // NO STRING ALLOCATION - uses Cantor pairing function
      const keyAB = this.getCollisionKey(entityA, entityB);
      const keyBA = this.getCollisionKey(entityB, entityA);

      this.currentCollisions.add(keyAB);
      this.currentCollisions.add(keyBA);

      // Cache the pair for potential exit events (only if new)
      if (!this.previousCollisions.has(keyAB)) {
        this.collisionPairCache.set(keyAB, [entityA, entityB]);
        this.collisionPairCache.set(keyBA, [entityB, entityA]);
      }

      // Determine if this is a new collision or continuing
      const isNewCollision = !this.previousCollisions.has(keyAB);

      const objA = this.gameObjects[entityA];
      const objB = this.gameObjects[entityB];

      if (isNewCollision) {
        // OnCollisionEnter - First frame of collision
        // Call BOTH entities' callbacks since physics only stores pairs once (i < j)
        if (objA && objA.onCollisionEnter) {
          objA.onCollisionEnter(entityB);
        }
        if (objB && objB.onCollisionEnter) {
          objB.onCollisionEnter(entityA);
        }
      } else {
        // OnCollisionStay - Continuous collision
        if (objA && objA.onCollisionStay) {
          objA.onCollisionStay(entityB);
        }
        if (objB && objB.onCollisionStay) {
          objB.onCollisionStay(entityA);
        }
      }
    }

    // Check for collisions that ended (OnCollisionExit)
    for (const prevKey of this.previousCollisions) {
      if (!this.currentCollisions.has(prevKey)) {
        // Retrieve entity indices from cache (no string parsing!)
        const pair = this.collisionPairCache.get(prevKey);
        if (!pair) continue; // Shouldn't happen, but safety check

        const [entityA, entityB] = pair;

        // Only process if this worker "owns" entityA (using same partitioning)
        if (entityA % this.totalLogicWorkers === this.workerIndex) {
          const objA = this.gameObjects[entityA];
          const objB = this.gameObjects[entityB];

          // Call BOTH entities' callbacks
          if (objA && objA.onCollisionExit) {
            objA.onCollisionExit(entityB);
          }
          if (objB && objB.onCollisionExit) {
            objB.onCollisionExit(entityA);
          }
        }

        // Clean up cache entry for ended collision
        this.collisionPairCache.delete(prevKey);
      }
    }

    // Swap current and previous for next frame
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
   * Report detailed profiling statistics
   */
  reportProfilingStats(neighborsThisFrame) {
    const frames = this.profileReportInterval;
    const avgFrameTime = this.profilingStats.totalFrameTime / frames;
    const avgCollisionTime = this.profilingStats.collisionTime / frames;
    const avgJobProcessingTime = this.profilingStats.jobProcessingTime / frames;
    const avgNeighborUpdateTime =
      this.profilingStats.neighborUpdateTime / frames;
    const avgTickTime = this.profilingStats.tickTime / frames;
    const avgNeighborsPerFrame =
      this.profilingStats.totalNeighborsProcessed / frames;

    console.log(
      `\n📊 LOGIC WORKER ${this.workerIndex} PROFILING (avg over ${frames} frames):\n` +
        `  Total frame time: ${avgFrameTime.toFixed(2)}ms\n` +
        `    ├─ Collision cbs:     ${avgCollisionTime.toFixed(2)}ms (${(
          (avgCollisionTime / avgFrameTime) *
          100
        ).toFixed(1)}%)\n` +
        `    └─ Job processing:    ${avgJobProcessingTime.toFixed(2)}ms (${(
          (avgJobProcessingTime / avgFrameTime) *
          100
        ).toFixed(1)}%)\n` +
        `        ├─ Neighbor update: ${avgNeighborUpdateTime.toFixed(2)}ms (${(
          (avgNeighborUpdateTime / avgJobProcessingTime) *
          100
        ).toFixed(1)}%)\n` +
        `        └─ Entity tick():   ${avgTickTime.toFixed(2)}ms (${(
          (avgTickTime / avgJobProcessingTime) *
          100
        ).toFixed(1)}%)\n` +
        `  Work distribution:\n` +
        `    - Jobs/frame:      ${this.jobsProcessedThisFrame.toFixed(1)}\n` +
        `    - Entities/frame:  ${this.entitiesProcessedThisFrame.toFixed(
          0
        )}\n` +
        `    - Neighbors/frame: ${avgNeighborsPerFrame.toFixed(0)}\n` +
        `    - μs/entity:       ${(
          (avgFrameTime / this.entitiesProcessedThisFrame) *
          1000
        ).toFixed(1)}μs`
    );

    // Reset stats for next interval
    this.profilingStats.collisionTime = 0;
    this.profilingStats.jobProcessingTime = 0;
    this.profilingStats.neighborUpdateTime = 0;
    this.profilingStats.tickTime = 0;
    this.profilingStats.totalFrameTime = 0;
    this.profilingStats.totalNeighborsProcessed = 0;
  }

  /**
   * Handle custom messages from main thread or other workers
   * Implements spawning and despawning commands
   */
  handleCustomMessage(data) {
    const { msg } = data;

    switch (msg) {
      case "enableProfiling": {
        this.enableProfiling = data.enabled !== undefined ? data.enabled : true;
        console.log(
          `LOGIC WORKER ${this.workerIndex}: Profiling ${
            this.enableProfiling ? "ENABLED" : "DISABLED"
          }`
        );
        break;
      }

      case "spawn": {
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

      case "despawn": {
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
      case "spawnRequest": {
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
      case "despawnRequest": {
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

      case "despawnAll": {
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
            Object.keys(self).filter((key) => typeof self[key] === "function")
          );
          return;
        }

        // Despawn ALL entities of this type (no partitioning - worker 0 handles all)
        // OPTIMIZED: Use activeEntitiesData to skip inactive entities
        let count = 0;
        let skippedNoInstance = 0;
        const entityType = EntityClass.entityType;
        const totalActiveEntities = this.activeEntitiesData
          ? this.activeEntitiesData[0]
          : 0;

        // Only iterate through active entities, not the entire pool
        for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
          const i = this.activeEntitiesData[1 + activeIdx];
          if (Transform.entityType[i] === entityType) {
            if (this.gameObjects[i]) {
              this.gameObjects[i].despawn();
              count++;
            } else {
              // Fallback: manually deactivate if no instance exists
              Transform.active[i] = 0;
              if (RigidBody.active && RigidBody.active[i])
                RigidBody.active[i] = 0;
              if (Collider.active && Collider.active[i]) Collider.active[i] = 0;
              if (SpriteRenderer.active && SpriteRenderer.active[i])
                SpriteRenderer.active[i] = 0;

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

      case "clearAll": {
        // Only worker 0 handles clearAll to keep freeList synchronized with spawn
        if (this.workerIndex !== 0) {
          break;
        }

        // Despawn ALL entities (no partitioning - worker 0 handles all)
        // OPTIMIZED: Use activeEntitiesData to skip inactive entities
        let totalDespawned = 0;
        const totalActiveEntities = this.activeEntitiesData
          ? this.activeEntitiesData[0]
          : 0;

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
      this.stats[LOGIC_STATS.ENTITIES_PROCESSED] =
        this.entitiesProcessedThisFrame;
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
