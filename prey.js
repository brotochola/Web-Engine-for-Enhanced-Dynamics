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

    // Apply flocking behaviors (uses Template Method Pattern from Boid)
    // processNeighbor() hook will accumulate fleeing data during the loop
    const context = super.applyFlockingBehaviors(i, dtRatio);

    // Apply fleeing force based on accumulated context
    const predatorNearby = this.applyFleeing(i, dtRatio, context);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);

    // Update animation based on speed and state (cached)
    this.updateAnimation(i, predatorNearby);
  }

  /**
   * HOOK: Create context object for accumulating fleeing data during neighbor loop
   */
  createNeighborContext() {
    return {
      fleeX: 0,
      fleeY: 0,
      predatorCount: 0,
    };
  }

  /**
   * HOOK: Process each neighbor - called by Boid.applyFlockingBehaviors()
   * Accumulates flee forces from all predators during the same loop that does flocking
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
    // Flee from predators (inverse square law for panic effect)
    if (neighborType === Predator.entityType && dist2 > 0) {
      context.fleeX += -dx / dist2; // Flee away from predator
      context.fleeY += -dy / dist2;
      context.predatorCount++;
    }
  }

  /**
   * Apply fleeing force away from predators (if any found)
   * @returns {boolean} True if predator is nearby
   */
  applyFleeing(i, dtRatio, context) {
    if (context.predatorCount > 0) {
      GameObject.ax[i] += context.fleeX * Prey.predatorAvoidFactor[i] * dtRatio;
      GameObject.ay[i] += context.fleeY * Prey.predatorAvoidFactor[i] * dtRatio;
      return true;
    }
    return false;
  }

  /**
   * OPTIMIZED: Update animation based on movement speed and state
   * Uses caching to avoid unnecessary writes when state hasn't changed
   */
  updateAnimation(i, predatorNearby) {
    const speed = GameObject.speed[i];
    const vx = GameObject.vx[i];
    const currentAnimState = RenderableGameObject.animationState[i];
    const currentTint = RenderableGameObject.tint[i];

    // Determine new animation state based on speed and danger
    let newAnimState;
    let newTint;
    let newAnimSpeed;

    if (speed > 0.1) {
      newAnimState = Prey.ANIM_WALK;
      newTint = 0xffffff;
      newAnimSpeed = speed * 0.1;
    } else {
      newAnimState = Prey.ANIM_IDLE;
      newTint = 0xff0000;
      newAnimSpeed = RenderableGameObject.animationSpeed[i]; // Keep current
    }

    // Only write if state changed
    if (newAnimState !== currentAnimState) {
      RenderableGameObject.animationState[i] = newAnimState;
    }

    // Only write if tint changed
    if (newTint !== currentTint) {
      RenderableGameObject.tint[i] = newTint;
    }

    // Only write animation speed when walking
    if (speed > 0.1) {
      RenderableGameObject.animationSpeed[i] = newAnimSpeed;
    }

    // Flip sprite based on movement direction (only if moving significantly)
    if (Math.abs(vx) > 0.1) {
      const newFlipX = vx < 0 ? 1 : 0;
      if (RenderableGameObject.flipX[i] !== newFlipX) {
        RenderableGameObject.flipX[i] = newFlipX;
      }
    }
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
