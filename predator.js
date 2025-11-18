// Predator.js - Predator that flocks with other predators and hunts prey
// Extends Boid to inherit flocking behavior

class Predator extends Boid {
  static entityType = 2; // 2 = Predator

  // Sprite configuration for rendering
  static spriteConfig = {
    spritesheet: "personaje", // Use personaje spritesheet
    animations: {
      0: "caminarDerecha", // Animation state 0 = idle (using walk for now)
      1: "caminarDerecha", // Animation state 1 = walk
      2: "caminarDerecha", // Animation state 2 = run
      3: "caminarDerecha", // Animation state 3 = hunt (using walk)
    },
    defaultAnimation: "caminarDerecha", // Start with walking animation
    animationSpeed: 0.15, // Animation playback speed
  };

  // Animation state constants
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
    GameObject.scale[i] = 1;

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

    // Do normal boid behaviors (still flock with other predators)
    super.tick(dtRatio, inputData);

    // Add hunting behavior
    const huntingPrey = this.chaseClosestPrey(i, dtRatio);

    // Update animation based on speed and state
    this.updateAnimation(i, huntingPrey);
  }

  /**
   * Chase the closest prey in visual range
   * @returns {boolean} True if actively hunting prey
   */
  chaseClosestPrey(i, dtRatio) {
    const myX = GameObject.x[i];
    const myY = GameObject.y[i];

    let closestPreyIndex = -1;
    let closestDist2 = Infinity;

    // Find the closest prey
    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.neighbors[n];

      // Check if this neighbor is a prey (entityType = 1)
      if (GameObject.entityType[j] === Prey.entityType) {
        const dx = GameObject.x[j] - myX;
        const dy = GameObject.y[j] - myY;
        const dist2 = dx * dx + dy * dy;

        if (dist2 < closestDist2) {
          closestDist2 = dist2;
          closestPreyIndex = j;
        }
      }
    }

    // Chase the closest prey if found
    if (closestPreyIndex !== -1) {
      const dx = GameObject.x[closestPreyIndex] - myX;
      const dy = GameObject.y[closestPreyIndex] - myY;
      const dist = Math.sqrt(closestDist2);

      if (dist > 0) {
        // Apply seeking force toward prey
        GameObject.ax[i] += (dx / dist) * Predator.huntFactor[i] * dtRatio;
        GameObject.ay[i] += (dy / dist) * Predator.huntFactor[i] * dtRatio;
      }
      return true;
    }
    return false;
  }

  /**
   * Update animation based on movement speed and hunting state
   */
  updateAnimation(i, huntingPrey) {
    // Get speed from physics worker (already calculated and stored)
    const speed = GameObject.speed[i];

    // Determine animation state based on speed and hunting
    let newAnimState;

    if (huntingPrey && speed > 4) {
      newAnimState = Predator.ANIM_HUNT; // Hunting prey
      RenderableGameObject.tint[i] = 0xffaaaa; // Slight red tint when hunting
    } else if (speed > 4) {
      newAnimState = Predator.ANIM_RUN; // Running
      RenderableGameObject.tint[i] = 0xffffff; // Normal color
    } else if (speed > 1) {
      newAnimState = Predator.ANIM_WALK; // Walking
      RenderableGameObject.tint[i] = 0xffffff; // Normal color
    } else {
      newAnimState = Predator.ANIM_IDLE; // Idle
      RenderableGameObject.tint[i] = 0xffffff; // Normal color
    }

    // Update animation state
    RenderableGameObject.animationState[i] = newAnimState;

    // Flip sprite based on movement direction
    if (Math.abs(GameObject.vx[i]) > 0.1) {
      RenderableGameObject.flipX[i] = GameObject.vx[i] < 0 ? 1 : 0;
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
