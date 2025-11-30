self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import engine dependencies
import { GameObject } from "../core/gameObject.js";
import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { AbstractWorker } from "./AbstractWorker.js";

// Make imported classes globally available for dynamic instantiation
self.GameObject = GameObject;
self.Transform = Transform;
self.RigidBody = RigidBody;
self.Collider = Collider;
self.SpriteRenderer = SpriteRenderer;

// Game-specific scripts will be loaded dynamically during initialization

/**
 * LogicWorker - Handles game logic and AI for all entities
 * Extends AbstractWorker for common worker functionality
 */
class LogicWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Game objects - one per entity
    this.gameObjects = [];

    // Worker identification
    this.workerIndex = 0; // Which worker am I? (0, 1, 2, ...)

    // Frame synchronization (for multi-worker coordination)
    this.syncData = null; // Int32Array for Atomics-based synchronization
    this.totalLogicWorkers = 1; // Total number of logic workers

    // Job queue for dynamic work distribution
    this.jobQueueData = null; // Int32Array: [currentJobIndex, totalJobs, job0_start, job0_end, ...]

    // Performance tracking
    this.activeEntityCount = 0; // Number of active entities this worker is processing

    // Collision tracking (Unity-style Enter/Stay/Exit)
    this.collisionData = null; // SharedArrayBuffer for collision pairs from physics worker
    this.previousCollisions = new Set(); // Track collisions from last frame
    this.currentCollisions = new Set(); // Track collisions in current frame
  }

  /**
   * Initialize the logic worker (implementation of AbstractWorker.initialize)
   * Sets up shared memory and creates GameObject instances
   */
  initialize(data) {
    // Set worker index for identification
    this.workerIndex = data.workerIndex || 0;

    // Initialize synchronization buffer for multi-worker coordination
    if (data.buffers.syncData) {
      this.syncData = new Int32Array(data.buffers.syncData);
      this.totalLogicWorkers = this.syncData[2]; // Total workers stored at index 2

      console.log(
        `LOGIC WORKER ${this.workerIndex}: Frame synchronization enabled (${this.totalLogicWorkers} workers total)`
      );
    }

    // Initialize job queue for dynamic work distribution
    if (data.buffers.jobQueueData) {
      this.jobQueueData = new Int32Array(data.buffers.jobQueueData);
      const totalJobs = this.jobQueueData[1];
      console.log(
        `LOGIC WORKER ${this.workerIndex}: Job queue initialized (${totalJobs} jobs total)`
      );
    }

    console.log("LOGIC WORKER: Initializing with component system");

    // Initialize collision buffer
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      console.log("LOGIC WORKER: Collision callbacks enabled");
    }

    // Note: Game-specific scripts are loaded automatically by AbstractWorker.initializeCommonBuffers()
    // This makes entity classes available in the worker's global scope

    // Initialize ALL components (core and custom) - must be done AFTER entity classes are loaded
    this.initializeAllComponents(data);

    // Create GameObject instances
    this.createGameObjectInstances();

    console.log(
      `LOGIC WORKER ${this.workerIndex}: Total ${this.entityCount} GameObjects ready (job-based processing)`
    );
    console.log(
      `LOGIC WORKER ${this.workerIndex}: Initialization complete, waiting for start signal...`
    );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Initialize ALL components by collecting them from entity classes
   * This handles both core (Transform, RigidBody, etc.) and custom (Flocking, etc.) components
   */
  initializeAllComponents(data) {
    console.log("LOGIC WORKER: Initializing component arrays...");

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
        console.log(`  ✅ ${componentName}: ${pool.count} slots`);
      }
    }
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   */
  createGameObjectInstances() {
    for (const classInfo of this.registeredClasses) {
      const { name, count, startIndex, componentIndices } = classInfo;

      const EntityClass = self[name]; // Get class by name from global scope

      if (EntityClass) {
        // Store metadata for spawning system
        EntityClass.startIndex = startIndex;
        EntityClass.totalCount = count;

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

          // Calculate component indices for this entity instance
          const entityComponentIndices = {};
          for (const [componentName, allocation] of Object.entries(
            componentIndices
          )) {
            // Each entity gets its slot in the component pool
            // Convert PascalCase (ClassName) to camelCase for property access
            const camelCaseName =
              componentName.charAt(0).toLowerCase() + componentName.slice(1);
            entityComponentIndices[camelCaseName] = allocation.start + i;
          }

          // CRITICAL: Transform always uses entity index (not a separate component pool index)
          // Every entity has Transform at its entity index
          entityComponentIndices.transform = index;

          // Create instance with component indices
          const instance = new EntityClass(
            index,
            entityComponentIndices,
            this.config,
            this
          );
          this.gameObjects[index] = instance;

          // Call start() lifecycle method (one-time initialization)
          if (instance.start) {
            instance.start();
          }
        }
        console.log(
          `LOGIC WORKER: Created ${count} ${name} instances with components: ${Object.keys(
            componentIndices
          ).join(", ")}`
        );
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
    // Reset job queue at the start of each frame (only first worker to arrive)
    // This is safe because of the barrier at the end of the previous frame
    if (this.jobQueueData) {
      Atomics.store(this.jobQueueData, 0, 0); // Reset current job index to 0
    }

    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      this.processCollisionCallbacks();
    }

    // Count active entities while processing jobs
    let activeCount = 0;

    // Job-based processing: atomically claim jobs until none remain
    while (true) {
      // Atomically claim the next job
      const jobIndex = Atomics.add(this.jobQueueData, 0, 1);
      const totalJobs = this.jobQueueData[1];

      // Check if all jobs are claimed
      if (jobIndex >= totalJobs) {
        break; // No more jobs, this worker is done
      }

      // Get job range from buffer
      const jobStartIndex = this.jobQueueData[2 + jobIndex * 2];
      const jobEndIndex = this.jobQueueData[2 + jobIndex * 2 + 1];

      // Process all entities in this job's range
      for (let i = jobStartIndex; i < jobEndIndex; i++) {
        if (this.gameObjects[i] && Transform.active[i]) {
          const obj = this.gameObjects[i];
          activeCount++;

          // Update neighbor references before tick
          obj.updateNeighbors(this.neighborData, this.distanceData);
          // Tick entity logic
          obj.tick(dtRatio, this.inputData);
        }
      }
    }

    // Store active count for FPS reporting
    this.activeEntityCount = activeCount;

    // Synchronize with other logic workers (barrier ensures all workers finish frame)
    if (this.syncData && this.totalLogicWorkers > 1) {
      this.synchronizeFrame();
    }
  }

  /**
   * Synchronize this worker with other logic workers using Atomics
   * Ensures all workers finish their frame before any proceeds to the next
   */
  synchronizeFrame() {
    // Atomically increment the completion counter
    const completedWorkers = Atomics.add(this.syncData, 1, 1) + 1;

    if (completedWorkers === this.totalLogicWorkers) {
      // This is the last worker to complete this frame
      // Reset the completion counter for the next frame
      Atomics.store(this.syncData, 1, 0);

      // Increment frame counter
      Atomics.add(this.syncData, 0, 1);

      // Wake up all waiting workers
      Atomics.notify(this.syncData, 3, this.totalLogicWorkers - 1);
    } else {
      // Not the last worker - wait for others to complete
      // Use a spinlock with wait to avoid blocking the event loop completely
      const startValue = Atomics.load(this.syncData, 3);

      // Wait with timeout to prevent deadlock (1 frame = ~16ms worst case)
      const result = Atomics.wait(this.syncData, 3, startValue, 50);

      // If timeout, just continue (failsafe - better to jitter than hang)
      if (result === "timed-out") {
        console.warn(`LOGIC WORKER ${this.workerIndex}: Frame sync timeout`);
      }
    }
  }

  /**
   * Process collision callbacks (Unity-style)
   * Determines Enter/Stay/Exit states and calls appropriate callbacks
   * Partitions collision processing across workers using modulo (entityA % workers == myIndex)
   */
  processCollisionCallbacks() {
    // Read collision pairs from physics worker
    const pairCount = this.collisionData[0];

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

      // Create unique pair keys (both directions for easy lookup)
      const keyAB = `${entityA},${entityB}`;
      const keyBA = `${entityB},${entityA}`;

      this.currentCollisions.add(keyAB);
      this.currentCollisions.add(keyBA);

      // Determine if this is a new collision or continuing
      const isNewCollision = !this.previousCollisions.has(keyAB);

      const objA = this.gameObjects[entityA];
      // const objB = this.gameObjects[entityB];

      if (isNewCollision) {
        // OnCollisionEnter - First frame of collision
        if (objA && objA.onCollisionEnter) {
          objA.onCollisionEnter(entityB);
        }
        // Note: We DON'T call objB's callback here since another worker might process entityB
      } else {
        // OnCollisionStay - Continuous collision
        if (objA && objA.onCollisionStay) {
          objA.onCollisionStay(entityB);
        }
        // Note: We DON'T call objB's callback here since another worker might process entityB
      }
    }

    // Check for collisions that ended (OnCollisionExit)
    for (const prevKey of this.previousCollisions) {
      if (!this.currentCollisions.has(prevKey)) {
        // Parse the key to get entity indices
        const [entityA, entityB] = prevKey.split(",").map(Number);

        // Only process if this worker "owns" entityA (using same partitioning)
        if (entityA % this.totalLogicWorkers === this.workerIndex) {
          const objA = this.gameObjects[entityA];
          if (objA && objA.onCollisionExit) {
            objA.onCollisionExit(entityB);
          }
        }
      }
    }

    // Swap current and previous for next frame
    const temp = this.previousCollisions;
    this.previousCollisions = this.currentCollisions;
    this.currentCollisions = temp;
  }

  /**
   * Handle custom messages from main thread or other workers
   * Implements spawning and despawning commands
   */
  handleCustomMessage(data) {
    const { msg } = data;

    switch (msg) {
      case "spawn": {
        const { className, spawnConfig } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            `LOGIC WORKER: Cannot spawn ${className} - class not found!`
          );
          return;
        }

        const instance = GameObject.spawn(EntityClass, spawnConfig);
        if (!instance)
          console.warn(
            `LOGIC WORKER: Failed to spawn ${className} - pool exhausted!`
          );
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
            GameObject.entityType[i] === entityType &&
            this.gameObjects[i]
          ) {
            this.gameObjects[i].despawn();
            count++;
          }
        }

        console.log(
          `LOGIC WORKER ${this.workerIndex}: Despawned ${count} ${className} entities`
        );
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

        console.log(
          `LOGIC WORKER ${this.workerIndex}: Cleared ${totalDespawned} entities`
        );
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
