// Boid.js - Flocking behavior implementation
// Extends RenderableGameObject to implement the classic boids algorithm

class Boid extends RenderableGameObject {
  static entityType = 0; // 0 = Boid

  // Sprite configuration - standardized format for static sprites
  static spriteConfig = {
    type: "static",
    textureName: "bunny",
  };

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
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    // Initialize GameObject transform properties (random position)
    GameObject.x[i] = Math.random() * (config.worldWidth || 800);
    GameObject.y[i] = Math.random() * (config.worldHeight || 600);
    GameObject.vx[i] = (Math.random() - 0.5) * 2;
    GameObject.vy[i] = (Math.random() - 0.5) * 2;
    GameObject.ax[i] = 0;
    GameObject.ay[i] = 0;
    GameObject.rotation[i] = 0;

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
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio, inputData) {
    const i = this.index;

    // Apply all three boid rules in a single optimized loop
    this.applyFlockingBehaviors(i, dtRatio);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);
  }

  /**
   * OPTIMIZED: Apply all three boid rules (cohesion, separation, alignment) in a single loop
   * Uses Template Method Pattern - subclasses can override processNeighbor() to add custom logic
   * This reduces neighbor iteration from 3+ loops to 1 loop
   *
   * NEW: Uses pre-calculated distances from spatial worker (no need to recalculate!)
   *
   * @returns {Object} neighborContext - Data that subclasses accumulated during the loop
   */
  applyFlockingBehaviors(i, dtRatio) {
    if (this.neighborCount === 0) return {};

    const myEntityType = GameObject.entityType[i];
    const myX = GameObject.x[i];
    const myY = GameObject.y[i];
    const protectedRange2 = Boid.protectedRange[i] * Boid.protectedRange[i];

    // Cohesion accumulators (same type only)
    let centerX = 0;
    let centerY = 0;

    // Alignment accumulators (same type only)
    let avgVX = 0;
    let avgVY = 0;

    // Separation accumulators (all types)
    let separateX = 0;
    let separateY = 0;

    let sameTypeCount = 0;

    // Create context object for subclass to accumulate custom data
    const neighborContext = this.createNeighborContext();

    // Single loop through all neighbors
    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.neighbors[n];
      const neighborType = GameObject.entityType[j];
      const isSameType = neighborType === myEntityType;

      // Use pre-calculated squared distance from spatial worker (OPTIMIZATION!)
      // This eliminates duplicate distance calculations between spatial & logic workers
      const dist2 = this.neighborDistances ? this.neighborDistances[n] : 0;

      // Calculate delta only when needed (for separation direction)
      const dx = GameObject.x[j] - myX;
      const dy = GameObject.y[j] - myY;

      // Cohesion & Alignment (same type only)
      if (isSameType) {
        centerX += GameObject.x[j];
        centerY += GameObject.y[j];
        avgVX += GameObject.vx[j];
        avgVY += GameObject.vy[j];
        sameTypeCount++;
      }

      // Separation (all types)
      if (dist2 < protectedRange2 && dist2 > 0) {
        separateX -= dx / dist2;
        separateY -= dy / dist2;
      }

      // HOOK: Allow subclasses to process this neighbor (e.g., hunt prey, flee predators)
      this.processNeighbor(
        j,
        neighborType,
        dx,
        dy,
        dist2,
        isSameType,
        neighborContext
      );
    }

    // Apply cohesion force
    if (sameTypeCount > 0) {
      centerX /= sameTypeCount;
      centerY /= sameTypeCount;
      GameObject.ax[i] += (centerX - myX) * Boid.centeringFactor[i] * dtRatio;
      GameObject.ay[i] += (centerY - myY) * Boid.centeringFactor[i] * dtRatio;

      // Apply alignment force
      avgVX /= sameTypeCount;
      avgVY /= sameTypeCount;
      GameObject.ax[i] +=
        (avgVX - GameObject.vx[i]) * Boid.matchingFactor[i] * dtRatio;
      GameObject.ay[i] +=
        (avgVY - GameObject.vy[i]) * Boid.matchingFactor[i] * dtRatio;
    }

    // Apply separation force
    GameObject.ax[i] += separateX * Boid.avoidFactor[i] * dtRatio;
    GameObject.ay[i] += separateY * Boid.avoidFactor[i] * dtRatio;

    // Return context so subclass can use accumulated data
    return neighborContext;
  }

  /**
   * HOOK: Create context object for subclasses to accumulate custom data during neighbor loop
   * Override this in subclasses to add custom properties
   * @returns {Object} Empty context object (subclasses extend this)
   */
  createNeighborContext() {
    return {};
  }

  /**
   * HOOK: Process individual neighbor - called once per neighbor during flocking loop
   * Override this in subclasses to add custom per-neighbor logic (hunting, fleeing, etc.)
   *
   * @param {number} neighborIndex - Index of the neighbor entity
   * @param {number} neighborType - Entity type of the neighbor
   * @param {number} dx - Delta X (neighbor.x - my.x)
   * @param {number} dy - Delta Y (neighbor.y - my.y)
   * @param {number} dist2 - Squared distance to neighbor
   * @param {boolean} isSameType - Whether neighbor is same entity type
   * @param {Object} context - Context object to accumulate data
   */
  processNeighbor(
    neighborIndex,
    neighborType,
    dx,
    dy,
    dist2,
    isSameType,
    context
  ) {
    // Default: do nothing (base Boid doesn't need extra logic)
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
