// GameObject.js - Base class for all game entities
// This provides a clean OOP interface while maintaining cache-friendly array access

class GameObject {
  /**
   * Base class for all game entities
   * @param {number} index - Position in the shared arrays (which boid/entity am I?)
   */
  constructor(index) {
    this.index = index;
    this.active = true; // Can be used to disable entities without removing them
  }

  /**
   * Main update method - called every frame by logic worker
   * Override this in subclasses to define entity behavior
   *
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   * @param {BoidArrays} arrays - Shared memory arrays (x, y, vx, vy, ax, ay, rotation, scale)
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker
   * @param {Int32Array} inputData - Mouse and keyboard input
   */
  tick(dtRatio, arrays, neighborData, inputData) {
    // Override in subclasses
    // This base implementation does nothing
  }
}

// Export for use in workers
if (typeof module !== "undefined" && module.exports) {
  module.exports = GameObject;
}
