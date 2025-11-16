// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import dependencies
importScripts("config.js");
importScripts("gameObject.js");
importScripts("AbstractWorker.js");
importScripts("boid.js");

/**
 * LogicWorker - Handles game logic and AI for all entities
 * Extends AbstractWorker for common worker functionality
 */
class LogicWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Game objects - one per entity
    this.gameObjects = [];

    // Neighbor data from spatial worker
    this.neighborData = null;

    // Registered entity classes information
    this.registeredClasses = [];
  }

  /**
   * Initialize the logic worker (implementation of AbstractWorker.initialize)
   * Sets up shared memory and creates GameObject instances
   */
  initialize(data) {
    console.log("LOGIC WORKER: Initializing with GameObject pattern");

    // Initialize common buffers from AbstractWorker (includes neighborBuffer now)
    this.initializeCommonBuffers(data);

    // Store registered classes
    this.registeredClasses = data.registeredClasses || [];

    // Initialize subclass arrays - dynamically for any entity type
    for (const classInfo of this.registeredClasses) {
      const EntityClass = self[classInfo.name]; // Get class by name from global scope

      if (EntityClass && EntityClass.initializeArrays && data.entityBuffers) {
        const buffer = data.entityBuffers[classInfo.name];
        if (buffer) {
          EntityClass.initializeArrays(buffer, classInfo.count);
          console.log(`LOGIC WORKER: Initialized ${classInfo.name} arrays`);
        }
      }
    }

    // Keep a reference to neighbor data for tick() calls
    this.neighborData = GameObject.neighborData;

    // Create GameObject instances
    this.createGameObjectInstances();

    console.log(`LOGIC WORKER: Total ${this.entityCount} GameObjects ready`);

    // Start the game loop
    this.startGameLoop();
  }

  /**
   * Create GameObject instances for all registered entity classes - dynamically
   */
  createGameObjectInstances() {
    for (const classInfo of this.registeredClasses) {
      const { name, count, startIndex } = classInfo;
      const EntityClass = self[name]; // Get class by name from global scope

      if (EntityClass) {
        for (let i = 0; i < count; i++) {
          const index = startIndex + i;
          this.gameObjects[index] = new EntityClass(index);
        }
        console.log(`LOGIC WORKER: Created ${count} ${name} instances`);
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
    // Tick all game objects
    // Each GameObject applies its logic, reading/writing directly to shared arrays
    for (let i = 0; i < this.entityCount; i++) {
      if (this.gameObjects[i] && this.gameObjects[i].active) {
        this.gameObjects[i].tick(dtRatio, this.neighborData, this.inputData);
      }
    }
  }
}

// Create singleton instance and setup message handler
const logicWorker = new LogicWorker(self);
