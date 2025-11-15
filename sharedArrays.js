// SharedArrays.js - Defines the Structure of Arrays (SoA) layout
// This file is shared between all workers to access the same memory

// Total number of entities in the simulation

/**
 * Structure of Arrays (SoA) Layout
 * ================================
 * Instead of storing data as: [{x, y, vx, vy}, {x, y, vx, vy}, ...]
 * We store it as: {x: [x1, x2, ...], y: [y1, y2, ...], vx: [...], vy: [...]}
 *
 * Why? CACHE PERFORMANCE!
 * - When we process all X positions, they're sequential in memory
 * - CPU can prefetch entire cache lines efficiently
 * - This is 2-3x faster than scattered object access
 *
 * Layout in SharedArrayBuffer:
 * [x0, x1, x2, ..., x19999] <- All X positions (80KB)
 * [y0, y1, y2, ..., y19999] <- All Y positions (80KB)
 * [vx0, vx1, ...]           <- All X velocities (80KB)
 * [vy0, vy1, ...]           <- All Y velocities (80KB)
 * [ax0, ax1, ...]           <- All X accelerations (80KB)
 * [ay0, ay1, ...]           <- All Y accelerations (80KB)
 * [r0, r1, ...]             <- All rotations (80KB)
 * [s0, s1, ...]             <- All scales (80KB)
 * Total: 640KB of contiguous memory
 */

// Array configuration
const ARRAYS_COUNT = 8; // Number of separate arrays
const ARRAY_SIZE = ENTITY_COUNT; // Elements per array
const BYTES_PER_ARRAY = ARRAY_SIZE * 4; // Float32 = 4 bytes per element
const TOTAL_BUFFER_SIZE = ARRAYS_COUNT * BYTES_PER_ARRAY;

// Byte offsets for each array in the SharedArrayBuffer
const OFFSET_X = 0; // Position X
const OFFSET_Y = BYTES_PER_ARRAY; // Position Y
const OFFSET_VX = BYTES_PER_ARRAY * 2; // Velocity X
const OFFSET_VY = BYTES_PER_ARRAY * 3; // Velocity Y
const OFFSET_AX = BYTES_PER_ARRAY * 4; // Acceleration X
const OFFSET_AY = BYTES_PER_ARRAY * 5; // Acceleration Y
const OFFSET_ROTATION = BYTES_PER_ARRAY * 6; // Sprite rotation (radians)
const OFFSET_SCALE = BYTES_PER_ARRAY * 7; // Sprite scale

/**
 * BoidArrays - Helper class to access SharedArrayBuffer as Structure of Arrays
 * Creates typed array views into different sections of the shared memory
 */
class BoidArrays {
  constructor(sharedBuffer) {
    this.buffer = sharedBuffer;

    // Create Float32Array views for each property
    // Each view points to a different section of the same SharedArrayBuffer
    this.x = new Float32Array(sharedBuffer, OFFSET_X, ARRAY_SIZE);
    this.y = new Float32Array(sharedBuffer, OFFSET_Y, ARRAY_SIZE);
    this.vx = new Float32Array(sharedBuffer, OFFSET_VX, ARRAY_SIZE);
    this.vy = new Float32Array(sharedBuffer, OFFSET_VY, ARRAY_SIZE);
    this.ax = new Float32Array(sharedBuffer, OFFSET_AX, ARRAY_SIZE);
    this.ay = new Float32Array(sharedBuffer, OFFSET_AY, ARRAY_SIZE);
    this.rotation = new Float32Array(sharedBuffer, OFFSET_ROTATION, ARRAY_SIZE);
    this.scale = new Float32Array(sharedBuffer, OFFSET_SCALE, ARRAY_SIZE);
  }
}

// Export for use
if (typeof module !== "undefined" && module.exports) {
  module.exports = { BoidArrays, ENTITY_COUNT, TOTAL_BUFFER_SIZE };
}
