// GameObject.js - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays

class GameObject {
  // Shared memory buffer
  static sharedBuffer = null;
  static entityCount = 0;

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
    scale: Float32Array,
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
  };

  // Neighbor data (from spatial worker)
  static neighborData = null;

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
   */
  static initializeArrays(buffer, count, neighborBuffer = null) {
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
  }

  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker
   */
  updateNeighbors(neighborData) {
    if (!neighborData || !this.config.maxNeighbors) {
      this.neighborCount = 0;
      this.neighbors = null;
      return;
    }

    // Parse neighbor data buffer: [count, id1, id2, ..., id_MAX]
    const offset = this.index * (1 + this.config.maxNeighbors);
    this.neighborCount = neighborData[offset];
    this.neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + this.neighborCount
    );
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
