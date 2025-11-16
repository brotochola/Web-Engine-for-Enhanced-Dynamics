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
  };

  // Neighbor data (from spatial worker)
  static neighborData = null;

  static instances = [];

  /**
   * Initialize static arrays from SharedArrayBuffer
   * Called by GameEngine and by each worker
   * @param {SharedArrayBuffer} buffer - The shared memory
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Optional neighbor data buffer
   */
  static initializeArrays(buffer, count, neighborBuffer = null) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // Initialize neighbor data if provided
    if (neighborBuffer) {
      this.neighborData = new Int32Array(neighborBuffer);
    }

    // console.log(
    //   `GameObject: Initialized ${this.ARRAY_SCHEMA.length} arrays for ${count} entities (${offset} bytes total)`
    // );
  }

  /**
   * Calculate total buffer size needed
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    return Object.values(this.ARRAY_SCHEMA).reduce((total, type) => {
      return total + count * type.BYTES_PER_ELEMENT;
    }, 0);
  }

  /**
   * Constructor - just stores the index
   * Subclasses should initialize their values in their constructors
   * @param {number} index - Position in shared arrays
   */
  constructor(index) {
    this.index = index;
    GameObject.active[index] = 1; // Set active in shared array (1 = true, 0 = false)
    GameObject.instances.push(this);
  }

  /**
   * Main update method - called every frame by logic worker
   * Override this in subclasses to define entity behavior
   *
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker
   * @param {Int32Array} inputData - Mouse and keyboard input
   */
  tick(dtRatio, neighborData, inputData) {
    // Override in subclasses
  }

  /**
   * Get neighbors for this entity from the spatial worker's neighbor data
   * @returns {number[]} Array of neighbor indices
   */
  get neighbors() {
    if (!GameObject.neighborData) return [];

    // Neighbor buffer layout: For each entity: [count, id1, id2, ..., id_MAX]
    const offset = this.index * (1 + MAX_NEIGHBORS_PER_ENTITY);
    const count = GameObject.neighborData[offset];

    // Extract neighbor indices
    const neighbors = [];
    for (let i = 0; i < count; i++) {
      neighbors.push(GameObject.neighborData[offset + 1 + i]);
    }

    return neighbors;
  }

  // Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
  static {
    Object.entries(this.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(this.prototype, name, {
        get() {
          return GameObject[name][this.index];
        },
        // Special handling for Uint8Array to convert boolean to 0/1
        set(value) {
          GameObject[name][this.index] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });
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
