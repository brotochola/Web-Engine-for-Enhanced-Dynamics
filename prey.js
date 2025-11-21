// Prey.js - Prey that flock like boids but avoid predators
// Extends Boid to inherit flocking behavior

class Prey extends Boid {
  static entityType = 1; // 1 = Prey
  static instances = []; // Instance tracking for this class

  // Define prey-specific properties schema
  static ARRAY_SCHEMA = {
    predatorAvoidFactor: Float32Array, // How strongly to flee from predators
    life: Float32Array,
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
    },
  };

  static anims = {
    IDLE: 0,
    WALK: 1,
  };

  /**
   * Prey constructor - initializes prey properties
   * @param {number} index - Position in shared arrays
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, config = {}, logicWorker = null) {
    super(index, config, logicWorker);

    const i = index;

    // Initialize prey-specific properties
    this.predatorAvoidFactor = 311.5; // Strong avoidance of predators
    this.life = 1;
    // Initialize GameObject physics properties
    this.maxVel = 10;
    this.maxAcc = 0.2;
    this.friction = 0.05;
    this.radius = 10;

    // Initialize GameObject perception
    this.visualRange = 70; // How far boid can see
    this.animationSpeed = 0.15;

    // Initialize Boid-specific behavior properties (with slight randomization)
    this.protectedRange = this.radius * 2; // Minimum distance from others
    this.centeringFactor = 0.0005; // Cohesion strength
    this.avoidFactor = 2; // Separation strength
    this.matchingFactor = 0.01; // Alignment strength
    this.turnFactor = 0.1; // Boundary avoidance strength
    this.margin = 20; // Distance from edge to start turning
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    // Reset health
    this.life = 1.0;

    // Reset visual properties

    this.setAnimationState(Prey.anims.IDLE);
    this.setAnimationSpeed(0.15);

    // console.log(
    //   `Prey ${this.index} spawned at (${this.x.toFixed(1)}, ${this.y.toFixed(
    //     1
    //   )})`
    // );
  }

  /**
   * LIFECYCLE: Called when prey is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  sleep() {
    // console.log(`Prey ${this.index} despawned (life: ${this.life.toFixed(2)})`);
    // Could save stats, play death effects, etc.
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
   * Uses helper methods with dirty flag optimization for efficient rendering
   */
  updateAnimation(i, predatorNearby) {
    const speed = GameObject.speed[i];
    const vx = GameObject.vx[i];

    // Determine animation state based on speed
    if (speed > 0.1) {
      this.setAnimationState(Prey.anims.WALK);
      this.setAnimationSpeed(speed * 0.1);
    } else {
      this.setAnimationState(Prey.anims.IDLE);
    }

    // Update tint based on life (white = healthy, red = damaged)
    // Map life from white (0xffffff) to red (0xff0000) based on remaining life ratio
    let newTint;
    if (Prey.life[i] > 0) {
      const maxLife = Prey.maxLife ? Prey.maxLife[i] : 1;
      const ratio = Math.max(0, Math.min(1, Prey.life[i] / maxLife));
      // Interpolate green/blue channel from 255 (white) to 0 (red)
      const gb = Math.round(255 * ratio);
      newTint = (0xff << 16) | (gb << 8) | gb;
    } else {
      newTint = 0xff0000; // Dead = red
    }
    this.setTint(newTint);

    // Flip sprite based on movement direction (only if moving significantly)
    if (Math.abs(vx) > 0.1) {
      this.setFlip(vx < 0); // Flip X when moving left
    }
  }

  /**
   * Unity-style collision callback: Called when prey collides with predator
   * This demonstrates the collision detection system
   */
  onCollisionEnter(otherIndex) {}

  /**
   * Unity-style collision callback: Called while prey is colliding with another entity
   */
  onCollisionStay(otherIndex) {
    // Could add ongoing collision effects here
    // For example: losing health over time while touching hazards

    const i = this.index;

    // Check if we collided with a predator
    if (GameObject.entityType[otherIndex] === Predator.entityType) {
      Prey.life[i] -= 0.01;
      if (Prey.life[i] <= 0) {
        this.despawn(); // Use proper despawn instead of directly setting active
      }

      // Optional: Could post message to main thread for sound/particle effects
      // this.logicWorker.self.postMessage({
      //   msg: 'preyCaught',
      //   preyIndex: i,
      //   predatorIndex: otherIndex
      // });
    }
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
