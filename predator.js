// Predator.js - Predator that flocks with other predators and hunts prey
// Extends Boid to inherit flocking behavior

class Predator extends Boid {
  static entityType = 2; // 2 = Predator

  // Sprite configuration - standardized format for animated sprites
  static spriteConfig = {
    type: "animated",
    spritesheet: "personaje",
    defaultAnimation: "caminarDerecha",
    animationSpeed: 0.15,

    // Animation states - maps state index to animation name
    animStates: {
      0: { name: "caminarDerecha", label: "IDLE" }, // Idle (using walk for now)
      1: { name: "caminarDerecha", label: "WALK" }, // Walking
      2: { name: "caminarDerecha", label: "RUN" }, // Running
      3: { name: "caminarDerecha", label: "HUNT" }, // Hunting
    },
  };

  // Animation state constants (for easy reference in code)
  static ANIM_IDLE = 0;
  static ANIM_WALK = 1;
  static ANIM_RUN = 2;
  static ANIM_HUNT = 3;

  // Define predator-specific properties schema
  static ARRAY_SCHEMA = {
    huntFactor: Float32Array, // How strongly to chase prey
  };

  /**
   * Predator constructor - initializes predator properties
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    GameObject.x[i] = 2000;
    GameObject.y[i] = 1000;

    // Initialize predator-specific properties
    Predator.huntFactor[i] = 0.2; // Chase strength

    // Make predators slightly slower than prey (hunt by strategy, not speed)
    GameObject.maxVel[i] = 7;

    GameObject.radius[i] = 12;

    GameObject.maxAcc[i] = 0.2;
    GameObject.friction[i] = 0.05;
    GameObject.radius[i] = 10;

    RenderableGameObject.animationSpeed[i] = 0.15;

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
   * Main update - applies boid behaviors plus prey hunting
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio, inputData) {
    const i = this.index;

    // Apply flocking behaviors (uses Template Method Pattern from Boid)
    // processNeighbor() hook will accumulate hunting data during the loop
    const context = super.applyFlockingBehaviors(i, dtRatio);

    // Apply hunting force based on accumulated context
    const huntingPrey = this.applyHunting(i, dtRatio, context);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);

    // Update animation based on speed and state (cached)
    this.updateAnimation(i, huntingPrey);
  }

  /**
   * HOOK: Create context object for accumulating hunting data during neighbor loop
   */
  createNeighborContext() {
    return {
      closestPreyIndex: -1,
      closestDist2: Infinity,
    };
  }

  /**
   * HOOK: Process each neighbor - called by Boid.applyFlockingBehaviors()
   * Finds closest prey during the same loop that does flocking
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
    // Track closest prey
    if (neighborType === Prey.entityType && dist2 < context.closestDist2) {
      context.closestDist2 = dist2;
      context.closestPreyIndex = neighborIndex;
    }
  }

  /**
   * Apply hunting force toward closest prey (if found)
   * @returns {boolean} True if actively hunting prey
   */
  applyHunting(i, dtRatio, context) {
    if (context.closestPreyIndex !== -1) {
      const myX = GameObject.x[i];
      const myY = GameObject.y[i];
      const dx = GameObject.x[context.closestPreyIndex] - myX;
      const dy = GameObject.y[context.closestPreyIndex] - myY;
      const dist = Math.sqrt(context.closestDist2);

      if (dist > 0) {
        GameObject.ax[i] += (dx / dist) * Predator.huntFactor[i] * dtRatio;
        GameObject.ay[i] += (dy / dist) * Predator.huntFactor[i] * dtRatio;
      }
      return true;
    }
    return false;
  }

  /**
   * OPTIMIZED: Update animation based on movement speed and hunting state
   * Uses caching to avoid unnecessary writes when state hasn't changed
   */
  updateAnimation(i, huntingPrey) {
    const speed = GameObject.speed[i];
    const currentAnimState = RenderableGameObject.animationState[i];
    const currentTint = RenderableGameObject.tint[i];

    // Determine new animation state based on speed and hunting
    let newAnimState;
    let newTint;

    if (huntingPrey && speed > 4) {
      newAnimState = Predator.ANIM_HUNT;
      newTint = 0xffaaaa; // Slight red tint when hunting
    } else if (speed > 4) {
      newAnimState = Predator.ANIM_RUN;
      newTint = 0xffffff;
    } else if (speed > 1) {
      newAnimState = Predator.ANIM_WALK;
      newTint = 0xffffff;
    } else {
      newAnimState = Predator.ANIM_IDLE;
      newTint = 0xffffff;
    }

    // Only write if state changed
    if (newAnimState !== currentAnimState) {
      RenderableGameObject.animationState[i] = newAnimState;
    }

    // Only write if tint changed
    if (newTint !== currentTint) {
      RenderableGameObject.tint[i] = newTint;
    }

    // Flip sprite based on movement direction (only if moving significantly)
    if (Math.abs(GameObject.vx[i]) > 0.1) {
      const newFlipX = GameObject.vx[i] < 0 ? 1 : 0;
      if (RenderableGameObject.flipX[i] !== newFlipX) {
        RenderableGameObject.flipX[i] = newFlipX;
      }
    }
  }

  /**
   * Unity-style collision callback: Called when predator catches prey
   * This demonstrates the collision detection system
   */
  onCollisionEnter(otherIndex) {
    const i = this.index;

    // Check if we caught a prey
    if (GameObject.entityType[otherIndex] === Prey.entityType) {
      // Success! Caught prey
      // The prey will deactivate itself via its own collision callback
      // Could add effects here:
      // - Increase predator health/energy
      // - Play sound effect
      // - Spawn particle effect
      // Optional: Post message to main thread
      // this.logicWorker.self.postMessage({
      //   msg: 'preyCaught',
      //   predatorIndex: i,
      //   preyIndex: otherIndex
      // });
    }
  }

  /**
   * Unity-style collision callback: Called while predator is colliding with prey
   * This is called every frame while the collision continues
   */
  onCollisionStay(otherIndex) {
    // Could add continuous collision effects here
    // For example: draining prey health over time
  }

  /**
   * Unity-style collision callback: Called when collision ends
   */
  onCollisionExit(otherIndex) {
    // Could add effects when prey escapes
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Predator;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Predator = Predator;
}
