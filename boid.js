// Boid.js - Flocking behavior implementation
// Extends GameObject to implement the classic boids algorithm

class Boid extends GameObject {
  static entityType = 0; // 0 = Boid
  static textureName = "bunny"; // Texture to use for rendering

  // Define the boid-specific properties schema
  // GameEngine will automatically create all the required static properties!
  static ARRAY_SCHEMA = {
    protectedRange: Float32Array,
    centeringFactor: Float32Array,
    avoidFactor: Float32Array,
    matchingFactor: Float32Array,
    turnFactor: Float32Array,
    margin: Float32Array,
  };

  /**
   * Boid constructor - initializes this boid's properties
   * Sets both GameObject properties (transform/physics) and Boid properties (behavior)
   *
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}) {
    super(index, config);

    const i = index;

    // Initialize GameObject transform properties (random position)
    GameObject.x[i] = Math.random() * (config.worldWidth || 800);
    GameObject.y[i] = Math.random() * (config.worldHeight || 600);
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
  }

  // Getters/setters are auto-generated when this class is registered with GameEngine!
  // No static block needed - GameEngine.registerEntityClass() handles it automatically.

  /**
   * Main update - applies all boid rules
   * The spatial worker has already found neighbors for us!
   */
  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Get precomputed neighbors for this boid
    const offset = i * (1 + (this.config.maxNeighbors || 100));
    const neighborCount = neighborData[offset];
    const neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + neighborCount
    );

    // Apply the three rules of boids
    this.applyCohesion(i, dtRatio, neighborCount, neighbors); // Only same type
    this.applySeparation(i, dtRatio, neighborCount, neighbors); // All entities
    this.applyAlignment(i, dtRatio, neighborCount, neighbors); // Only same type

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);
  }

  /**
   * Rule 1: Cohesion - Steer toward the center of mass of neighbors (same type only)
   */
  applyCohesion(i, dtRatio, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    const myEntityType = GameObject.entityType[i];
    let centerX = 0;
    let centerY = 0;
    let sameTypeCount = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];
      if (GameObject.entityType[j] !== myEntityType) continue;

      centerX += GameObject.x[j];
      centerY += GameObject.y[j];
      sameTypeCount++;
    }

    if (sameTypeCount === 0) return;

    centerX /= sameTypeCount;
    centerY /= sameTypeCount;

    GameObject.ax[i] +=
      (centerX - GameObject.x[i]) * Boid.centeringFactor[i] * dtRatio;
    GameObject.ay[i] +=
      (centerY - GameObject.y[i]) * Boid.centeringFactor[i] * dtRatio;
  }

  /**
   * Rule 2: Separation - Avoid crowding neighbors (all entity types)
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
   * Rule 3: Alignment - Match velocity with neighbors (same type only)
   */
  applyAlignment(i, dtRatio, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    const myEntityType = GameObject.entityType[i];
    let avgVX = 0;
    let avgVY = 0;
    let sameTypeCount = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];
      if (GameObject.entityType[j] !== myEntityType) continue;

      avgVX += GameObject.vx[j];
      avgVY += GameObject.vy[j];
      sameTypeCount++;
    }

    if (sameTypeCount === 0) return;

    avgVX /= sameTypeCount;
    avgVY /= sameTypeCount;

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
    const worldWidth = this.config.worldWidth || 800;
    const worldHeight = this.config.worldHeight || 600;

    if (x < Boid.margin[i]) GameObject.ax[i] += Boid.turnFactor[i] * dtRatio;
    if (x > worldWidth - Boid.margin[i])
      GameObject.ax[i] -= Boid.turnFactor[i] * dtRatio;

    if (y < Boid.margin[i]) GameObject.ay[i] += Boid.turnFactor[i] * dtRatio;
    if (y > worldHeight - Boid.margin[i])
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
