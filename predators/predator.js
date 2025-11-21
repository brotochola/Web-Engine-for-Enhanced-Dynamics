// Predator.js - Predator that flocks with other predators and hunts prey
// Extends Boid to inherit flocking behavior

class Predator extends Boid {
  static entityType = 2; // 2 = Predator
  static instances = []; // Instance tracking for this class

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
    },
  };

  static anims = {
    IDLE: 0,
    WALK: 1,
  };

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

    this.x = 2000;
    this.y = 1000;

    // Initialize predator-specific properties
    this.huntFactor = 0.2; // Chase strength

    // Make predators slightly slower than prey (hunt by strategy, not speed)
    this.maxVel = 7;

    this.radius = 12;

    this.maxAcc = 0.2;
    this.minSpeed = 1; // Keep predators moving
    this.friction = 0.05;
    this.radius = 10;

    this.animationSpeed = 0.15;

    // Initialize GameObject perception
    this.visualRange = 70; // How far boid can see

    // Initialize Boid-specific behavior properties (with slight randomization)
    this.protectedRange = this.radius * 2; // Minimum distance from others
    this.centeringFactor = 0.0005; // Cohesion strength
    this.avoidFactor = 2; // Separation strength
    this.matchingFactor = 0.01; // Alignment strength
    this.turnFactor = 0.1; // Boundary avoidance strength
    this.margin = 20; // Distance from edge to start turning
  }

  /**
   * LIFECYCLE: Called when predator is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    this.setAnimationState(Predator.anims.IDLE);
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when predator is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  sleep() {
    console.log(`Predator ${this.index} despawned`);
    // Could save hunting stats, etc.
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
        this.ax += (dx / dist) * this.huntFactor * dtRatio;
        this.ay += (dy / dist) * this.huntFactor * dtRatio;
      }
      return true;
    }
    return false;
  }

  /**
   * OPTIMIZED: Update animation based on movement speed and hunting state
   * Uses helper methods with dirty flag optimization for efficient rendering
   */
  updateAnimation(i, huntingPrey) {
    const speed = GameObject.speed[i];

    // Determine animation state based on speed
    if (speed > 1) {
      this.setAnimationState(Predator.anims.WALK);
    } else {
      this.setAnimationState(Predator.anims.IDLE);
    }

    // Change tint when hunting (reddish tint = aggressive state)
    if (huntingPrey) {
      this.setTint(0xffaaaa); // Pink/red tint when hunting
    } else {
      this.setTint(0xffffff); // Normal white
    }

    // Flip sprite based on movement direction (only if moving significantly)
    if (Math.abs(this.vx) > 0.1) {
      this.setFlip(this.vx < 0); // Flip X when moving left
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
