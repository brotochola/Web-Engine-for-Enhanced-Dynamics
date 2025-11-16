// GameObject.js - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays

class GameObject {
  // Shared memory buffer
  static sharedBuffer = null;
  static entityCount = 0;

  // Transform arrays (position, velocity, acceleration, rotation, scale)
  static x = null;
  static y = null;
  static vx = null;
  static vy = null;
  static ax = null;
  static ay = null;
  static rotation = null;
  static scale = null;

  // Physics arrays
  static maxVel = null;
  static maxAcc = null;
  static friction = null;
  static radius = null;

  // Perception arrays
  static visualRange = null;
  static instances = [];

  /**
   * Initialize static arrays from SharedArrayBuffer
   * Called by GameEngine and by each worker
   * @param {SharedArrayBuffer} buffer - The shared memory
   * @param {number} count - Total number of entities
   */
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    const ARRAYS_COUNT = 14; // Total number of arrays
    const BYTES_PER_ARRAY = count * 4; // Float32 = 4 bytes

    // Create typed array views for each property
    let offset = 0;

    // Transform
    this.x = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.y = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.vx = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.vy = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.ax = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.ay = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.rotation = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.scale = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;

    // Physics
    this.maxVel = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.maxAcc = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.friction = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.radius = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;

    // Perception
    this.visualRange = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;

    // console.log(
    //   `GameObject: Initialized ${ARRAYS_COUNT} arrays for ${count} entities (${offset} bytes total)`
    // );
  }

  /**
   * Calculate total buffer size needed
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    const ARRAYS_COUNT = 14;
    return ARRAYS_COUNT * count * 4; // Float32 = 4 bytes
  }

  /**
   * Constructor - just stores the index
   * Subclasses should initialize their values in their constructors
   * @param {number} index - Position in shared arrays
   */
  constructor(index) {
    this.index = index;
    this.active = true;
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

  get x() {
    return GameObject.x[this.index];
  }
  get y() {
    return GameObject.y[this.index];
  }
  get vx() {
    return GameObject.vx[this.index];
  }
  get vy() {
    return GameObject.vy[this.index];
  }
}

// Export for use in workers
if (typeof module !== "undefined" && module.exports) {
  module.exports = GameObject;
}
