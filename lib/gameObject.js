// GameObject.js - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays

class GameObject {
  // Shared memory buffer
  static sharedBuffer = null;
  static entityCount = 0;

  // Entity class metadata (for spawning system)
  static startIndex = 0; // Starting index in arrays for this entity type
  static totalCount = 0; // Total allocated entities of this type

  // Array schema - defines all shared arrays and their types
  // Order matters! Arrays are laid out in this exact order in memory
  // Properties are created dynamically in initializeArrays()
  static ARRAY_SCHEMA = {
    // Transform
    x: Float32Array,
    y: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    rotation: Float32Array,
    velocityAngle: Float32Array,
    speed: Float32Array,
    // Physics
    maxVel: Float32Array,
    maxAcc: Float32Array,
    friction: Float32Array,
    radius: Float32Array,
    // Perception
    visualRange: Float32Array,
    // State
    active: Uint8Array,
    entityType: Uint8Array, // 0=Boid, 1=Prey, 2=Predator
    isItOnScreen: Uint8Array,
  };

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  static instances = [];

  /**
   * Initialize static arrays from SharedArrayBuffer
   * Called by GameEngine and by each worker
   *
   * This is a generic method that works for both GameObject and all subclasses (Boid, etc)
   * by using 'this' which refers to the class it's called on.
   *
   * @param {SharedArrayBuffer} buffer - The shared memory
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Optional neighbor data buffer
   * @param {SharedArrayBuffer} [distanceBuffer] - Optional distance data buffer
   */
  static initializeArrays(
    buffer,
    count,
    neighborBuffer = null,
    distanceBuffer = null
  ) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    // 'this' refers to the class this method is called on (GameObject, Boid, etc.)
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Ensure proper alignment for this typed array
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // Initialize neighbor data if provided (only for GameObject)
    if (neighborBuffer && this === GameObject) {
      this.neighborData = new Int32Array(neighborBuffer);
    }

    // Initialize distance data if provided (only for GameObject)
    if (distanceBuffer && this === GameObject) {
      this.distanceData = new Float32Array(distanceBuffer);
    }

    // console.log(
    //   `${this.name}: Initialized ${Object.keys(this.ARRAY_SCHEMA).length} arrays for ${count} entities (${offset} bytes total)`
    // );
  }

  /**
   * Calculate total buffer size needed
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    let offset = 0;

    for (const type of Object.values(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Add alignment padding
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      offset += count * bytesPerElement;
    }

    return offset;
  }

  /**
   * Constructor - just stores the index
   * Subclasses should initialize their values in their constructors
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}, logicWorker = null) {
    this.index = index;
    this.config = config; // Store config for instance access
    this.logicWorker = logicWorker;
    GameObject.active[index] = 1; // Set active in shared array (1 = true, 0 = false)
    //take the entity type from the class
    GameObject.entityType[index] = this.constructor.entityType;
    GameObject.instances.push(this);
    this.constructor.instances.push(this);

    // Neighbor properties (updated each frame before tick)
    this.neighborCount = 0;
    this.neighbors = null; // Will be a TypedArray subarray
    this.neighborDistances = null; // Will be a TypedArray subarray of squared distances
  }

  /**
   * LIFECYCLE: Called when entity is first created (one-time initialization)
   * Override in subclasses for setup that should only happen once
   */
  start() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes active (spawned from pool)
   * Override in subclasses to reset/initialize state for reuse
   */
  awake() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes inactive (returned to pool)
   * Override in subclasses for cleanup, saving state, etc.
   */
  sleep() {
    // Override in subclasses
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn() {
    GameObject.active[this.index] = 0;

    // Call lifecycle callback
    if (this.sleep) {
      this.sleep();
    }
  }

  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker
   * @param {Float32Array} distanceData - Precomputed squared distances from spatial worker
   */
  updateNeighbors(neighborData, distanceData = null) {
    if (!neighborData || !this.config.maxNeighbors) {
      this.neighborCount = 0;
      this.neighbors = null;
      this.neighborDistances = null;
      return;
    }

    // Parse neighbor data buffer: [count, id1, id2, ..., id_MAX]
    const offset = this.index * (1 + this.config.maxNeighbors);
    this.neighborCount = neighborData[offset];
    this.neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + this.neighborCount
    );

    // Parse distance data buffer (same structure as neighborData)
    if (distanceData) {
      this.neighborDistances = distanceData.subarray(
        offset + 1,
        offset + 1 + this.neighborCount
      );
    } else {
      this.neighborDistances = null;
    }
  }

  /**
   * Main update method - called every frame by logic worker
   * Override this in subclasses to define entity behavior
   *
   * Note: this.neighbors and this.neighborCount are updated before this is called
   *
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   * @param {Int32Array} inputData - Mouse and keyboard input
   */
  tick(dtRatio, inputData) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity collides with another
   * Override in subclasses to handle collision start events
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionEnter(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called every frame while this entity is colliding with another
   * Override in subclasses to handle continuous collision
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionStay(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
   * Override in subclasses to handle collision end events
   *
   * @param {number} otherIndex - Index of the other entity that was in collision
   */
  onCollisionExit(otherIndex) {
    // Override in subclasses
  }

  /**
   * Helper method to dynamically create getters/setters from ARRAY_SCHEMA
   * This is called in static initialization blocks by GameObject and all subclasses
   *
   * @param {Class} targetClass - The class to create properties for
   */
  static _createSchemaProperties(targetClass) {
    Object.entries(targetClass.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(targetClass.prototype, name, {
        get() {
          return targetClass[name][this.index];
        },
        // Special handling for Uint8Array to convert boolean to 0/1
        set(value) {
          targetClass[name][this.index] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });
  }

  /**
   * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
   *
   * @param {Class} EntityClass - The entity class to spawn (e.g., Prey, Predator)
   * @param {Object} spawnConfig - Initial configuration (position, velocity, etc.)
   * @returns {GameObject|null} - The spawned entity instance, or null if pool exhausted
   *
   * @example
   * const prey = GameObject.spawn(Prey, { x: 500, y: 300, vx: 2, vy: -1 });
   */
  static spawn(EntityClass, spawnConfig = {}) {
    // Validate EntityClass has required metadata
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/totalCount metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = startIndex + EntityClass.totalCount;

    // Find first inactive entity of this type
    for (let i = startIndex; i < endIndex; i++) {
      if (GameObject.active[i] === 0) {
        // Get the instance (already created during initialization)
        const instance = EntityClass.instances[i - startIndex];
        console.log(instance);

        if (!instance) {
          console.error(
            `No instance found at index ${i} for ${EntityClass.name}`
          );
          return null;
        }

        instance.ax = 0;
        instance.ay = 0;
        instance.vx = 0;
        instance.vy = 0;

        instance.speed = 0;
        instance.velocityAngle = 0;
        instance.x = 0;
        instance.y = 0;
        instance.rotation = 0;
        instance.setTint(0xffffff); // White when healthy
        instance.setAlpha(1.0); // Fully visible

        // IMPORTANT: Apply spawn config BEFORE activating to prevent race condition
        // If entity is active, it can start ticking immediately on next frame
        Object.keys(spawnConfig).forEach((key) => {
          if (instance[key] !== undefined) {
            instance[key] = spawnConfig[key];
          }
        });

        // Call lifecycle method BEFORE activating
        if (instance.awake) {
          instance.awake();
        }

        // NOW activate the entity (after config and awake are done)
        GameObject.active[i] = 1;

        return instance;
      }
    }

    console.warn(
      `No inactive ${EntityClass.name} available in pool! All ${EntityClass.totalCount} entities are active.`
    );
    return null;
  }

  /**
   * SPAWNING SYSTEM: Get pool statistics for an entity class
   *
   * @param {Class} EntityClass - The entity class to check
   * @returns {Object} - { total, active, available }
   *
   * @example
   * const stats = GameObject.getPoolStats(Prey);
   * console.log(`Prey: ${stats.active}/${stats.total} active, ${stats.available} available`);
   */
  static getPoolStats(EntityClass) {
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      return { total: 0, active: 0, available: 0 };
    }

    const startIndex = EntityClass.startIndex;
    const total = EntityClass.totalCount;
    let activeCount = 0;

    for (let i = startIndex; i < startIndex + total; i++) {
      if (GameObject.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }

  /**
   * SPAWNING SYSTEM: Despawn all entities of a specific type
   *
   * @param {Class} EntityClass - The entity class to despawn
   * @returns {number} - Number of entities despawned
   */
  static despawnAll(EntityClass) {
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = startIndex + EntityClass.totalCount;
    let despawnedCount = 0;

    for (let i = startIndex; i < endIndex; i++) {
      if (GameObject.active[i]) {
        const instance = EntityClass.instances[i - startIndex];
        if (instance && instance.despawn) {
          instance.despawn();
          despawnedCount++;
        } else {
          GameObject.active[i] = 0;
          despawnedCount++;
        }
      }
    }

    return despawnedCount;
  }

  // Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
  static {
    GameObject._createSchemaProperties(GameObject);
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = GameObject;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.GameObject = GameObject;
}
