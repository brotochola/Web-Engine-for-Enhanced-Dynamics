// logic_worker.js - Calculates game logic using GameObject pattern
// This worker runs independently, calculating accelerations for all entities

// Import dependencies
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
  }

  /**
   * Initialize the logic worker (implementation of AbstractWorker.initialize)
   * Sets up shared memory and creates GameObject instances
   */
  initialize(data) {
    console.log("LOGIC WORKER: Initializing with GameObject pattern");

    // Initialize common buffers from AbstractWorker
    // This now handles registeredClasses, entityBuffers, and neighborData automatically

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
          this.gameObjects[index] = new EntityClass(index, this.config);
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
