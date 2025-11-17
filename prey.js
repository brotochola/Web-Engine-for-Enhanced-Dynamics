// Prey.js - Prey that flock like boids but avoid predators
// Extends Boid to inherit flocking behavior

class Prey extends Boid {
  static entityType = 1; // 1 = Prey
  static textureName = "sheep"; // Texture to use for rendering

  // Define prey-specific properties schema
  static ARRAY_SCHEMA = {
    predatorAvoidFactor: Float32Array, // How strongly to flee from predators
  };

  /**
   * Prey constructor - initializes prey properties
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}) {
    super(index, config);

    const i = index;

    // Initialize prey-specific properties
    Prey.predatorAvoidFactor[i] = 311.5; // Strong avoidance of predators

    // Initialize GameObject physics properties
    GameObject.maxVel[i] = 10;
    GameObject.maxAcc[i] = 0.2;
    GameObject.friction[i] = 0.05;
    GameObject.radius[i] = 10;
    GameObject.scale[i] = 0.2;

    // Initialize GameObject perception
    GameObject.visualRange[i] = 70; // How far boid can see

    // Initialize Boid-specific behavior properties (with slight randomization)
    Boid.protectedRange[i] = GameObject.radius[i] * 2; // Minimum distance from others
    Boid.centeringFactor[i] = 0.0005; // Cohesion strength
    Boid.avoidFactor[i] = 2; // Separation strength
    Boid.matchingFactor[i] = 0.01; // Alignment strength
    Boid.turnFactor[i] = 0.1; // Boundary avoidance strength
    Boid.margin[i] = 20; // Distance from edge to start turning
  }

  /**
   * Main update - applies boid behaviors plus predator avoidance
   */
  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Do all normal boid behaviors (cohesion, separation, alignment, boundaries)
    super.tick(dtRatio, neighborData, inputData);

    // Add predator avoidance behavior
    this.avoidPredators(i, dtRatio, neighborData);
  }

  /**
   * Avoid predators - flee from any predators in visual range
   */
  avoidPredators(i, dtRatio, neighborData) {
    const myX = GameObject.x[i];
    const myY = GameObject.y[i];

    // Get neighbors for this prey
    const offset = i * (1 + (this.config.maxNeighbors || 100));
    const neighborCount = neighborData[offset];
    const neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + neighborCount
    );

    let fleeX = 0;
    let fleeY = 0;
    let predatorCount = 0;

    // Check all neighbors to find predators
    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];

      // Check if this neighbor is a predator (entityType = 2)
      if (GameObject.entityType[j] === Predator.entityType) {
        const dx = myX - GameObject.x[j];
        const dy = myY - GameObject.y[j];
        const dist2 = dx * dx + dy * dy;

        // Flee from predator (inverse square law for panic effect)
        if (dist2 > 0) {
          fleeX += dx / dist2;
          fleeY += dy / dist2;
          predatorCount++;
        }
      }
    }

    // Apply fleeing force if any predators nearby
    if (predatorCount > 0) {
      GameObject.ax[i] += fleeX * Prey.predatorAvoidFactor[i] * dtRatio;
      GameObject.ay[i] += fleeY * Prey.predatorAvoidFactor[i] * dtRatio;
    }
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Prey;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Prey = Prey;
}
