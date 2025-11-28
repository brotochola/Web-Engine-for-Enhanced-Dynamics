// Prey.js - Boid that tries to survive by avoiding predators
// Extends Boid to implement prey-specific behaviors

import { GameObject } from "/src/core/gameObject.js";
import { RigidBody } from "/src/components/RigidBody.js";
import { Boid } from "./boid.js";
import { Predator } from "./predator.js";
import { PreyBehavior } from "./PreyBehavior.js";

class Prey extends Boid {
  static entityType = 1; // 1 = Prey
  static instances = []; // Instance tracking for this class

  // Add PreyBehavior component for prey-specific properties
  static components = [...Boid.components, PreyBehavior];

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

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

  /**
   * Prey constructor - initializes prey properties
   * @param {number} index - Position in shared arrays
   * @param {Object} componentIndices - Component indices { transform, rigidBody, collider, spriteRenderer }
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, componentIndices, config = {}, logicWorker = null) {
    super(index, componentIndices, config, logicWorker);

    const i = index;

    // Initialize prey-specific properties
    this.preyBehavior.predatorAvoidFactor = 3; // Strong avoidance of predators
    this.preyBehavior.life = 1;

    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.1;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.05;
    this.collider.radius = 5;

    // Override Boid's perception
    this.collider.visualRange = 60; // How far prey can see
    this.spriteRenderer.animationSpeed = 0.15;

    // Set sprite scale
    const scale = 1;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

    // Override Boid's Flocking component properties
    this.flocking.protectedRange = this.collider.radius * 4; // Minimum distance from others
    this.flocking.centeringFactor = 0; //0.005; // Cohesion strength
    this.flocking.avoidFactor = 3; // Separation strength
    this.flocking.matchingFactor = 0.01; // Alignment strength
    this.flocking.turnFactor = 0.1; // Boundary avoidance strength
    this.flocking.margin = 20; // Distance from edge to start turning
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    // Call parent Boid.awake() to initialize position
    super.awake();

    // Reset health
    this.preyBehavior.life = 1.0;

    // Reset visual properties
    this.setScale(1, 1); // CRITICAL: Set sprite scale!
    this.setAnimationState(Prey.anims.IDLE);
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when prey is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  sleep() {
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
   * CACHE-FRIENDLY: Direct array access
   * @returns {boolean} True if predator is nearby
   */
  applyFleeing(i, dtRatio, context) {
    if (context.predatorCount > 0) {
      // Cache array references
      const rbAX = RigidBody.ax;
      const rbAY = RigidBody.ay;

      rbAX[i] +=
        context.fleeX * this.preyBehavior.predatorAvoidFactor * dtRatio;
      rbAY[i] +=
        context.fleeY * this.preyBehavior.predatorAvoidFactor * dtRatio;
      return true;
    }
    return false;
  }

  /**
   * OPTIMIZED: Update animation based on movement speed and state
   * Uses helper methods with dirty flag optimization for efficient rendering
   * CACHE-FRIENDLY: Direct array access for reading physics data
   */
  updateAnimation(i, predatorNearby) {
    // Cache array references for reading
    const rbSpeed = RigidBody.speed;
    const rbVX = RigidBody.vx;

    const speed = rbSpeed[i];
    const vx = rbVX[i];

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
    if (this.preyBehavior.life > 0) {
      const maxLife = 1; // Default max life
      const ratio = Math.max(0, Math.min(1, this.preyBehavior.life / maxLife));
      // Interpolate green/blue channel from 255 (white) to 0 (red)
      const gb = Math.round(255 * ratio);
      newTint = (0xff << 16) | (gb << 8) | gb;
    } else {
      newTint = 0xff0000; // Dead = red
    }
    this.setTint(newTint);

    // Flip sprite based on movement direction (only if moving significantly)
    if (Math.abs(vx) > 0.1) {
      this.setScale(vx < 0 ? -1 : 1, 1); // Flip X when moving left
    }
  }

  /**
   * Unity-style collision callback: Called when prey collides with predator
   * This demonstrates the collision detection system
   */
  onCollisionEnter(otherIndex) {
    // console.log(`Prey ${this.index} collided with ${otherIndex}`);
  }

  /**
   * Unity-style collision callback: Called while prey is colliding with another entity
   */
  onCollisionStay(otherIndex) {
    // Could add ongoing collision effects here
    // For example: losing health over time while touching hazards
    // const i = this.index;
    // // Check if we collided with a predator
    // if (GameObject.entityType[otherIndex] === Predator.entityType) {
    //   this.preyBehavior.life -= 0.1;
    //   if (this.preyBehavior.life <= 0) {
    //     this.despawn(); // Use proper despawn instead of directly setting active
    //   }
    //   // Optional: Could post message to main thread for sound/particle effects
    //   // this.logicWorker.self.postMessage({
    //   //   msg: 'preyCaught',
    //   //   preyIndex: i,
    //   //   predatorIndex: otherIndex
    //   // });
    // }
  }

  /**
   * Unity-style collision callback: Called when collision ends
   */
  onCollisionExit(otherIndex) {
    // Could add effects when prey escapes from predator
  }
}

// ES6 module export
export { Prey };
