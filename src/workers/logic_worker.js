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
import { SpriteSheetRegistry } from "../core/SpriteSheetRegistry.js";
import { ParticleEmitter } from "../core/ParticleEmitter.js";
import { AbstractWorker } from "./AbstractWorker.js";

// Make imported classes globally available for dynamic instantiation
self.GameObject = GameObject;
self.Transform = Transform;
self.RigidBody = RigidBody;
self.Collider = Collider;
self.SpriteRenderer = SpriteRenderer;
self.ParticleComponent = ParticleComponent;
self.Mouse = Mouse;
self.Keyboard = Keyboard;
self.ParticleEmitter = ParticleEmitter;

// Game-specific scripts will be loaded dynamically during initialization

/**
 * LogicWorker - Handles game logic and AI for all entities
 * Extends AbstractWorker for common worker functionality
 */
class LogicWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Logic worker NEEDS game scripts (entity classes)
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
    this.entitiesProcessedThisFrame = 0; // Track actual entities processed
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
    this.previousScreenVisibility = new Uint8Array(data.entityCount);
    // Initialize to 0 (off-screen) - first frame will trigger onScreenEnter for visible entities
    this.previousScreenVisibility.fill(0);
    // console.log("LOGIC WORKER: Screen visibility tracking enabled");

    // Note: Game-specific scripts are loaded automatically by AbstractWorker.initializeCommonBuffers()
    // This makes entity classes available in the worker's global scope

    // Initialize ALL components (core and custom) - must be done AFTER entity classes are loaded
    this.initializeAllComponents(data);

    // Initialize ParticleEmitter if particles are configured
    // Particles are NOT entities - they have their own separate pool
    const maxParticles = data.maxParticles || 0;
    if (maxParticles > 0) {
      // Initialize ParticleComponent arrays for the emitter to write to
      if (data.buffers.componentData.ParticleComponent) {
        ParticleComponent.initializeArrays(
          data.buffers.componentData.ParticleComponent,
          maxParticles
        );
        ParticleComponent.particleCount = maxParticles;
      }
      ParticleEmitter.initialize(maxParticles);
    }

    // Create GameObject instances
    this.createGameObjectInstances();

    // console.log(
    //   `LOGIC WORKER ${this.workerIndex}: Total ${this.entityCount} GameObjects ready (job-based processing)`
    // );
    // console.log(
    //   `LOGIC WORKER ${this.workerIndex}: Initialization complete, waiting for start signal...`
    // );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Initialize ALL components by collecting them from entity classes
   * This handles both core (Transform, RigidBody, etc.) and custom (Flocking, etc.) components
   */
  initializeAllComponents(data) {
    // console.log("LOGIC WORKER: Initializing component arrays...");

    const componentClasses = new Map(); // componentName -> ComponentClass

    // Collect ALL components from all registered entity classes
    for (const classInfo of this.registeredClasses) {
      const EntityClass = self[classInfo.name];
      if (!EntityClass) continue;

      const components = GameObject._collectComponents(EntityClass);
      for (const ComponentClass of components) {
        const componentName = ComponentClass.name;
        componentClasses.set(componentName, ComponentClass);
      }
    }

    // Initialize all component arrays
    for (const [componentName, ComponentClass] of componentClasses) {
      const pool = data.componentPools[componentName];
      const buffer = data.buffers.componentData[componentName];

      if (buffer && pool && pool.count > 0) {
        ComponentClass.initializeArrays(buffer, pool.count);
        // console.log(`  ✅ ${componentName}: ${pool.count} slots`);
      }
    }
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   * DENSE ALLOCATION: entityIndex === componentIndex for all components
   */
  createGameObjectInstances() {
    for (const classInfo of this.registeredClasses) {
      const { name, count, startIndex, entityType } = classInfo;

      const EntityClass = self[name]; // Get class by name from global scope

      if (EntityClass) {
        // Store metadata for spawning system
        EntityClass.startIndex = startIndex;
        EntityClass.totalCount = count;
        EntityClass.entityType = entityType; // Auto-assigned entity type ID

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

        for (let i = 0; i < count; i++) {
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

    // Initialize Keyboard static class with input data
    // Note: Mouse position/state is now read directly from Transform/MouseComponent
    Keyboard.initialize(this.inputData, this.keyIndexMap);

    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      if (this.enableProfiling) {
        t0 = performance.now();
      }

      this.processCollisionCallbacks();

      if (this.enableProfiling) {
        t1 = performance.now();
        this.profilingStats.collisionTime += t1 - t0;
      }
    }

    // Count active entities while processing jobs
    let activeCount = 0;
    this.jobsProcessedThisFrame = 0;
    this.entitiesProcessedThisFrame = 0;
    let totalNeighborsThisFrame = 0;

    if (this.enableProfiling) {
      t2 = performance.now();
    }

    // Job-based processing: atomically claim jobs until none remain
    while (true) {
      // Atomically claim the next job
      const jobIndex = Atomics.add(this.jobQueueData, 0, 1);
      const totalJobs = this.jobQueueData[1];

      // Check if all jobs are claimed
      if (jobIndex >= totalJobs) {
        break; // No more jobs, this worker is done
      }

      this.jobsProcessedThisFrame++;

      // Get job range from buffer
      const jobStartIndex = this.jobQueueData[2 + jobIndex * 2];
      const jobEndIndex = this.jobQueueData[2 + jobIndex * 2 + 1];

      // Process all entities in this job's range
      for (let i = jobStartIndex; i < jobEndIndex; i++) {
        if (this.gameObjects[i] && Transform.active[i]) {
          const obj = this.gameObjects[i];
          activeCount++;
          this.entitiesProcessedThisFrame++;

          // Update neighbor references before tick
          const neighborStart = this.enableProfiling ? performance.now() : 0;
          obj.updateNeighbors(this.neighborData, this.distanceData);

          if (this.enableProfiling) {
            const neighborEnd = performance.now();
            this.profilingStats.neighborUpdateTime +=
              neighborEnd - neighborStart;
            // Track how many neighbors this entity has
            const neighborOffset =
              i * (1 + (this.config.spatial?.maxNeighbors || 100));
            totalNeighborsThisFrame += this.neighborData[neighborOffset];
          }

          // Tick entity logic (no inputData parameter - use this.mouse / this.keyboard instead)
          const tickStart = this.enableProfiling ? performance.now() : 0;
          obj.tick(dtRatio);

          if (this.enableProfiling) {
            const tickEnd = performance.now();
            this.profilingStats.tickTime += tickEnd - tickStart;
          }

          // Check for screen visibility changes and call lifecycle methods
          this.checkScreenVisibility(i, obj);
        }
      }
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
    // Cantor pairing function: maps two naturals to a unique natural
    // key = (a + b) * (a + b + 1) / 2 + b
    return ((a + b) * (a + b + 1)) / 2 + b;
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

      case "despawnAll": {
        const { className } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER ${this.workerIndex}: Cannot despawn ${className} - class not found!`
          );
          return;
        }

        // Despawn all entities of this type that this worker "owns" (using modulo partitioning)
        let count = 0;
        const entityType = EntityClass.entityType;

        for (let i = 0; i < this.entityCount; i++) {
          // Only process entities that belong to this worker (modulo partitioning)
          if (i % this.totalLogicWorkers !== this.workerIndex) {
            continue;
          }

          if (
            Transform.active[i] &&
            Transform.entityType[i] === entityType &&
            this.gameObjects[i]
          ) {
            this.gameObjects[i].despawn();
            count++;
          }
        }

        // console.log(
        //   `LOGIC WORKER ${this.workerIndex}: Despawned ${count} ${className} entities`
        // );
        break;
      }

      case "clearAll": {
        // Despawn all entities that this worker "owns" (using modulo partitioning)
        let totalDespawned = 0;

        for (let i = 0; i < this.entityCount; i++) {
          // Only process entities that belong to this worker (modulo partitioning)
          if (i % this.totalLogicWorkers !== this.workerIndex) {
            continue;
          }

          if (Transform.active[i] && this.gameObjects[i]) {
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
}

// Create singleton instance and setup message handler
self.logicWorker = new LogicWorker(self);
