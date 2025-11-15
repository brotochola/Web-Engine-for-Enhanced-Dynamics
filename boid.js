// Boid.js - Flocking behavior implementation
// Extends GameObject to implement the classic boids algorithm

class Boid extends GameObject {
  // Shared memory buffer for boid-specific data
  static sharedBuffer = null;
  static entityCount = 0;

  // Boid-specific behavior arrays
  static protectedRange = null;
  static centeringFactor = null;
  static avoidFactor = null;
  static matchingFactor = null;
  static turnFactor = null;
  static margin = null;

  /**
   * Initialize boid-specific arrays from SharedArrayBuffer
   * @param {SharedArrayBuffer} buffer - The shared memory for boid data
   * @param {number} count - Number of boids
   */
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    const ARRAYS_COUNT = 6; // Number of boid-specific arrays
    const BYTES_PER_ARRAY = count * 4; // Float32 = 4 bytes

    let offset = 0;

    this.protectedRange = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.centeringFactor = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.avoidFactor = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.matchingFactor = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.turnFactor = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;
    this.margin = new Float32Array(buffer, offset, count);
    offset += BYTES_PER_ARRAY;

    console.log(
      `Boid: Initialized ${ARRAYS_COUNT} arrays for ${count} boids (${offset} bytes total)`
    );
  }

  /**
   * Calculate total buffer size needed for boid-specific data
   * @param {number} count - Number of boids
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    const ARRAYS_COUNT = 6;
    return ARRAYS_COUNT * count * 4;
  }

  /**
   * Boid constructor - initializes this boid's properties
   * Sets both GameObject properties (transform/physics) and Boid properties (behavior)
   *
   * @param {number} index - Position in shared arrays
   */
  constructor(index) {
    super(index);

    const i = index;

    // Initialize GameObject transform properties (random position)
    GameObject.x[i] = Math.random() * WIDTH;
    GameObject.y[i] = Math.random() * HEIGHT;
    GameObject.vx[i] = (Math.random() - 0.5) * 2;
    GameObject.vy[i] = (Math.random() - 0.5) * 2;
    GameObject.ax[i] = 0;
    GameObject.ay[i] = 0;
    GameObject.rotation[i] = 0;
    GameObject.scale[i] = 0.45 + Math.random() * 0.15;

    // Initialize GameObject physics properties
    GameObject.maxVel[i] = 20; // Maximum speed
    GameObject.maxAcc[i] = 0.5; // Maximum acceleration
    GameObject.friction[i] = 0; // No friction for boids
    GameObject.radius[i] = 5; // Collision radius

    // Initialize GameObject perception
    GameObject.visualRange[i] = 25; // How far boid can see

    // Initialize Boid-specific behavior properties (with slight randomization)
    Boid.protectedRange[i] = 7; // Minimum distance from others
    Boid.centeringFactor[i] = 0.001; // Cohesion strength
    Boid.avoidFactor[i] = 0.3; // Separation strength
    Boid.matchingFactor[i] = 0.1; // Alignment strength
    Boid.turnFactor[i] = 0.1; // Boundary avoidance strength
    Boid.margin[i] = 20; // Distance from edge to start turning

    // Cache squared ranges for performance
    this.squaredVisualRange =
      GameObject.visualRange[i] * GameObject.visualRange[i];
    this.squaredProtectedRange =
      Boid.protectedRange[i] * Boid.protectedRange[i];
  }

  /**
   * Main update - applies all boid rules
   * The spatial worker has already found neighbors for us!
   */
  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Get precomputed neighbors for this boid
    const offset = i * (1 + MAX_NEIGHBORS_PER_ENTITY);
    const neighborCount = neighborData[offset];
    const neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + neighborCount
    );

    // Apply the three rules of boids
    this.applyCohesion(i, dtRatio, neighborCount, neighbors);
    this.applySeparation(i, dtRatio, neighborCount, neighbors);
    this.applyAlignment(i, dtRatio, neighborCount, neighbors);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);
  }

  /**
   * Rule 1: Cohesion - Steer toward the center of mass of neighbors
   */
  applyCohesion(i, dtRatio, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    let centerX = 0;
    let centerY = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];

      centerX += GameObject.x[j];
      centerY += GameObject.y[j];
    }

    centerX /= neighborCount;
    centerY /= neighborCount;

    GameObject.ax[i] +=
      (centerX - GameObject.x[i]) * Boid.centeringFactor[i] * dtRatio;
    GameObject.ay[i] +=
      (centerY - GameObject.y[i]) * Boid.centeringFactor[i] * dtRatio;
  }

  /**
   * Rule 2: Separation - Avoid crowding neighbors
   */
  applySeparation(i, dtRatio, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    const myX = GameObject.x[i];
    const myY = GameObject.y[i];

    let moveX = 0;
    let moveY = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];
      const dx = GameObject.x[j] - myX;
      const dy = GameObject.y[j] - myY;
      const dist2 = dx * dx + dy * dy;

      if (
        dist2 < Boid.protectedRange[i] * Boid.protectedRange[i] &&
        dist2 > 0
      ) {
        moveX -= dx / dist2;
        moveY -= dy / dist2;
      }
    }

    GameObject.ax[i] += moveX * Boid.avoidFactor[i] * dtRatio;
    GameObject.ay[i] += moveY * Boid.avoidFactor[i] * dtRatio;
  }

  /**
   * Rule 3: Alignment - Match velocity with neighbors
   */
  applyAlignment(i, dtRatio, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    let avgVX = 0;
    let avgVY = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];

      avgVX += GameObject.vx[j];
      avgVY += GameObject.vy[j];
    }

    avgVX /= neighborCount;
    avgVY /= neighborCount;

    GameObject.ax[i] +=
      (avgVX - GameObject.vx[i]) * Boid.matchingFactor[i] * dtRatio;
    GameObject.ay[i] +=
      (avgVY - GameObject.vy[i]) * Boid.matchingFactor[i] * dtRatio;
  }

  /**
   * Avoid the mouse cursor
   */
  avoidMouse(i, dtRatio, inputData) {
    const myX = GameObject.x[i];
    const myY = GameObject.y[i];

    const mouseX = inputData[0];
    const mouseY = inputData[1];

    const dx = myX - mouseX;
    const dy = myY - mouseY;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < 1e-4 || dist2 > 10000) return;

    const strength = 4;
    GameObject.ax[i] += (dx / dist2) * strength * dtRatio;
    GameObject.ay[i] += (dy / dist2) * strength * dtRatio;
  }

  /**
   * Keep boids within world boundaries
   */
  keepWithinBounds(i, dtRatio) {
    const x = GameObject.x[i];
    const y = GameObject.y[i];

    if (x < Boid.margin[i]) GameObject.ax[i] += Boid.turnFactor[i] * dtRatio;
    if (x > WIDTH - Boid.margin[i])
      GameObject.ax[i] -= Boid.turnFactor[i] * dtRatio;

    if (y < Boid.margin[i]) GameObject.ay[i] += Boid.turnFactor[i] * dtRatio;
    if (y > HEIGHT - Boid.margin[i])
      GameObject.ay[i] -= Boid.turnFactor[i] * dtRatio;
  }
}

// Export for use in workers
if (typeof module !== "undefined" && module.exports) {
  module.exports = Boid;
}
