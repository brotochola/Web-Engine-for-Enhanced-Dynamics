// Prey.js - Prey that flock like boids but avoid predators
// Extends Boid to inherit flocking behavior

class Prey extends Boid {
  static entityType = 1; // 1 = Prey

  // Define prey-specific properties schema
  static ARRAY_SCHEMA = {
    predatorAvoidFactor: Float32Array, // How strongly to flee from predators
  };

  // Sprite configuration - standardized format for animated sprites
  static spriteConfig = {
    type: "animated",
    spritesheet: "person",
    defaultAnimation: "parado",
    animationSpeed: 0.15,

    // Animation states - maps state index to animation name
    animStates: {
      0: { name: "parado", label: "IDLE" }, // Idle/standing
      1: { name: "caminar", label: "WALK" }, // Walking
      2: { name: "caminar", label: "RUN" }, // Running (uses walk animation)
      3: { name: "caminar", label: "FLEE" }, // Fleeing (uses walk animation)
    },
  };

  // Animation state constants (for easy reference in code)
  static ANIM_IDLE = 0;
  static ANIM_WALK = 1;
  static ANIM_RUN = 2;
  static ANIM_FLEE = 3;

  /**
   * Prey constructor - initializes prey properties
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    // Initialize prey-specific properties
    Prey.predatorAvoidFactor[i] = 311.5; // Strong avoidance of predators

    // Initialize GameObject physics properties
    GameObject.maxVel[i] = 10;
    GameObject.maxAcc[i] = 0.2;
    GameObject.friction[i] = 0.05;
    GameObject.radius[i] = 10;

    // Initialize GameObject perception
    GameObject.visualRange[i] = 70; // How far boid can see
    RenderableGameObject.animationSpeed[i] = 0.15;

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
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio, inputData) {
    const i = this.index;

    // Do all normal boid behaviors (cohesion, separation, alignment, boundaries)
    super.tick(dtRatio, inputData);

    // Add predator avoidance behavior
    const predatorNearby = this.avoidPredators(i, dtRatio);

    // Update animation based on speed and state
    this.updateAnimation(i, predatorNearby);
  }

  /**
   * Avoid predators - flee from any predators in visual range
   * @returns {boolean} True if predator is nearby
   */
  avoidPredators(i, dtRatio) {
    const myX = GameObject.x[i];
    const myY = GameObject.y[i];

    let fleeX = 0;
    let fleeY = 0;
    let predatorCount = 0;

    // Check all neighbors to find predators
    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.neighbors[n];

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

    return predatorCount > 0;
  }

  /**
   * Update animation based on movement speed and state
   */
  updateAnimation(i, predatorNearby) {
    // Get speed from physics worker (already calculated and stored)
    const speed = GameObject.speed[i];

    // Get velocity components for sprite flipping
    const vx = GameObject.vx[i];

    // Determine animation state based on speed and danger
    let newAnimState;

    if (speed > 0.1) {
      newAnimState = Prey.ANIM_WALK; // Walking
      RenderableGameObject.tint[i] = 0xffffff; // Normal color
      RenderableGameObject.animationSpeed[i] = speed * 0.1;
    } else {
      newAnimState = Prey.ANIM_IDLE; // Idle/standing
      RenderableGameObject.tint[i] = 0xff0000; // Normal color
    }

    // Update animation state
    RenderableGameObject.animationState[i] = newAnimState;

    // Flip sprite based on movement direction
    if (Math.abs(vx) > 0.1) {
      RenderableGameObject.flipX[i] = vx < 0 ? 1 : 0;
    }

    // this.setSpriteProp("alpha", 0.1);
  }

  /**
   * Unity-style collision callback: Called when prey collides with predator
   * This demonstrates the collision detection system
   */
  onCollisionEnter(otherIndex) {
    const i = this.index;

    // Check if we collided with a predator
    if (GameObject.entityType[otherIndex] === Predator.entityType) {
      // Prey is caught! Deactivate (die)
      GameObject.active[i] = 0;

      // Optional: Could post message to main thread for sound/particle effects
      // this.logicWorker.self.postMessage({
      //   msg: 'preyCaught',
      //   preyIndex: i,
      //   predatorIndex: otherIndex
      // });
    }
  }

  /**
   * Unity-style collision callback: Called while prey is colliding with another entity
   */
  onCollisionStay(otherIndex) {
    // Could add ongoing collision effects here
    // For example: losing health over time while touching hazards
  }

  /**
   * Unity-style collision callback: Called when collision ends
   */
  onCollisionExit(otherIndex) {
    // Could add effects when prey escapes from predator
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
