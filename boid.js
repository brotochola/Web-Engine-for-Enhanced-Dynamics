// Boid.js - Flocking behavior implementation
// Extends GameObject to implement the classic boids algorithm

class Boid extends GameObject {
  // Boid-specific behavior arrays schema
  // Following the same pattern as GameObject.ARRAY_SCHEMA
  static ARRAY_SCHEMA = {
    protectedRange: Float32Array,
    centeringFactor: Float32Array,
    avoidFactor: Float32Array,
    matchingFactor: Float32Array,
    turnFactor: Float32Array,
    margin: Float32Array,
  };

  // Shared memory buffer for boid-specific data
  static sharedBuffer = null;
  static entityCount = 0;
  static instances = [];

  /**
   * Initialize boid-specific arrays from SharedArrayBuffer
   * @param {SharedArrayBuffer} buffer - The shared memory for boid data
   * @param {number} count - Number of boids
   */
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // console.log(
    //   `Boid: Initialized ${Object.keys(this.ARRAY_SCHEMA).length} arrays for ${count} boids (${offset} bytes total)`
    // );
  }

  /**
   * Calculate total buffer size needed for boid-specific data
   * @param {number} count - Number of boids
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    return Object.values(this.ARRAY_SCHEMA).reduce((total, type) => {
      return total + count * type.BYTES_PER_ELEMENT;
    }, 0);
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

    Boid.instances.push(this);

    // Initialize GameObject transform properties (random position)
    GameObject.x[i] = Math.random() * WIDTH;
    GameObject.y[i] = Math.random() * HEIGHT;
    GameObject.vx[i] = (Math.random() - 0.5) * 2;
    GameObject.vy[i] = (Math.random() - 0.5) * 2;
    GameObject.ax[i] = 0;
    GameObject.ay[i] = 0;
    GameObject.rotation[i] = 0;
    GameObject.scale[i] = 1;

    // Initialize GameObject physics properties
    GameObject.maxVel[i] = 10;
    GameObject.maxAcc[i] = 0.2;
    GameObject.friction[i] = 0.01;
    GameObject.radius[i] = 10;

    // Initialize GameObject perception
    GameObject.visualRange[i] = 50; // How far boid can see

    // Initialize Boid-specific behavior properties (with slight randomization)
    Boid.protectedRange[i] = GameObject.radius[i] * 2; // Minimum distance from others
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

  // Auto-generated getters/setters for Boid-specific properties
  // Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
  static {
    Object.entries(this.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(this.prototype, name, {
        get() {
          return Boid[name][this.index];
        },
        set(value) {
          Boid[name][this.index] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });
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

    if (dist2 < 1e-4 || dist2 > 100000) return;

    const strength = 1004545000;
    GameObject.ax[i] = (dx / dist2) * strength * dtRatio;
    GameObject.ay[i] = (dy / dist2) * strength * dtRatio;
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

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Boid;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Boid = Boid;
}
