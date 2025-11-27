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
    console.log("LOGIC WORKER: Initializing with component system");

    // Initialize collision buffer
    if (data.buffers.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      console.log("LOGIC WORKER: Collision callbacks enabled");
    }

    // Initialize component arrays from SharedArrayBuffers
    console.log("LOGIC WORKER: Initializing component arrays...");

    // Transform (all entities have this)
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );
    console.log(`  ✅ Transform: ${this.entityCount} slots`);

    // RigidBody
    if (data.buffers.componentData.RigidBody) {
      RigidBody.initializeArrays(
        data.buffers.componentData.RigidBody,
        data.componentPools.RigidBody.count
      );
      console.log(
        `  ✅ RigidBody: ${data.componentPools.RigidBody.count} slots`
      );
    }

    // Collider
    if (data.buffers.componentData.Collider) {
      Collider.initializeArrays(
        data.buffers.componentData.Collider,
        data.componentPools.Collider.count
      );
      console.log(`  ✅ Collider: ${data.componentPools.Collider.count} slots`);
    }

    // SpriteRenderer
    if (data.buffers.componentData.SpriteRenderer) {
      SpriteRenderer.initializeArrays(
        data.buffers.componentData.SpriteRenderer,
        data.componentPools.SpriteRenderer.count
      );
      console.log(
        `  ✅ SpriteRenderer: ${data.componentPools.SpriteRenderer.count} slots`
      );
    }

    // Note: Game-specific scripts are loaded automatically by AbstractWorker.initializeCommonBuffers()
    // This makes entity classes available in the worker's global scope

    // Create GameObject instances
    this.createGameObjectInstances();

    console.log(`LOGIC WORKER: Total ${this.entityCount} GameObjects ready`);
    console.log(
      "LOGIC WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
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
   * Calls tick() on all game objects
   */
  update(deltaTime, dtRatio, resuming) {
    // Process collision callbacks BEFORE entity logic (Unity-style)
    if (this.collisionData) {
      this.processCollisionCallbacks();
    }

    // console.log(this.inputData[3],this.inputData[4],this.inputData[5])

    // Tick all game objects
    // Each GameObject applies its logic, reading/writing directly to shared arrays
    for (let i = 0; i < this.entityCount; i++) {
      if (this.gameObjects[i] && Transform.active[i]) {
        const obj = this.gameObjects[i];

        // Update neighbor references before tick (parsed once per frame)
        // Now includes pre-calculated squared distances from spatial worker
        obj.updateNeighbors(this.neighborData, this.distanceData);
        // Now tick with cleaner API (no neighborData parameter)
        obj.tick(dtRatio, this.inputData);
      }
    }
  }

  /**
   * Process collision callbacks (Unity-style)
   * Determines Enter/Stay/Exit states and calls appropriate callbacks
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

      // Create unique pair keys (both directions for easy lookup)
      const keyAB = `${entityA},${entityB}`;
      const keyBA = `${entityB},${entityA}`;

      this.currentCollisions.add(keyAB);
      this.currentCollisions.add(keyBA);

      // Determine if this is a new collision or continuing
      const isNewCollision = !this.previousCollisions.has(keyAB);

      const objA = this.gameObjects[entityA];
      const objB = this.gameObjects[entityB];

      if (isNewCollision) {
        // OnCollisionEnter - First frame of collision
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
        // Parse the key to get entity indices
        const [entityA, entityB] = prevKey.split(",").map(Number);

        const objA = this.gameObjects[entityA];
        if (objA && objA.onCollisionExit) {
          objA.onCollisionExit(entityB);
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
            `LOGIC WORKER: Cannot despawn ${className} - class not found!`
          );
          return;
        }

        // Despawn all entities of this type using instance despawn (calls sleep())
        let count = 0;
        const entityType = EntityClass.entityType;

        for (let i = 0; i < this.entityCount; i++) {
          if (
            Transform.active[i] &&
            GameObject.entityType[i] === entityType &&
            this.gameObjects[i]
          ) {
            this.gameObjects[i].despawn();
            count++;
          }
        }

        console.log(`LOGIC WORKER: Despawned ${count} ${className} entities`);
        break;
      }

      case "clearAll": {
        // Despawn all entities of all types
        let totalDespawned = 0;

        // Iterate through all game objects and despawn active ones
        for (let i = 0; i < this.entityCount; i++) {
          if (Transform.active[i] && this.gameObjects[i]) {
            this.gameObjects[i].despawn();
            totalDespawned++;
          }
        }

        console.log(
          `LOGIC WORKER: Cleared all entities (${totalDespawned} total)`
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
