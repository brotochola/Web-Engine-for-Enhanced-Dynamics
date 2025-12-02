// Prey.js - Boid that tries to survive by avoiding predators
// Extends Boid to implement prey-specific behaviors

import { GameObject } from "/src/core/gameObject.js";
import { RigidBody } from "/src/components/RigidBody.js";
import { Boid } from "./boid.js";
import { Predator } from "./predator.js";
import { PreyBehavior } from "./PreyBehavior.js";
import { getDirectionFromAngle } from "../../src/core/utils.js";

class Prey extends Boid {
  static entityType = 1; // 1 = Prey
  static instances = []; // Instance tracking for this class

  // Add PreyBehavior component for prey-specific properties
  static components = [...Boid.components, PreyBehavior];

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

  // Sprite configuration - NEW SIMPLIFIED API!
  // Just specify the spritesheet - all animations from lpc.json are automatically available!
  static spriteConfig = {
    type: "animated",
    spritesheet: "lpc", // References the loaded "lpc" spritesheet
    defaultAnimation: "idle_down", // Starting animation
    animationSpeed: 0.15, // Default playback speed
  };

  // No more manual mapping needed! Use animation names directly from the spritesheet.
  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * Overrides and extends Boid's setup()
   */
  setup() {
    // Call parent Boid.setup() first
    super.setup();

    // Initialize prey-specific properties
    this.preyBehavior.predatorAvoidFactor = 5; // Strong avoidance of predators
    this.preyBehavior.life = 1;

    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.1;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.05;
    this.collider.radius = 6;

    // Override Boid's perception
    this.collider.visualRange = 60; // Reduced for performance (fewer neighbor checks)
    this.spriteRenderer.animationSpeed = 0.15;

    // Set sprite scale
    const scale = 1;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

    // Set anchor for character sprite (bottom-center for ground alignment)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;

    // Override Boid's Flocking component properties - OPTIMIZED for performance
    this.flocking.protectedRange = this.collider.radius * 4; // Minimum distance from others
    this.flocking.centeringFactor = 0.003; // Cohesion: gentle attraction to flock center
    this.flocking.avoidFactor = 3; // Separation: moderate avoidance (reduced from 3)
    this.flocking.matchingFactor = 0.05; // Alignment: match flock velocity
    this.flocking.turnFactor = 0.1; // Boundary avoidance strength
    this.flocking.margin = 20; // Distance from edge to start turning
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Call parent Boid.onSpawned() to initialize position
    super.onSpawned(spawnConfig);

    // Reset health
    this.preyBehavior.life = 1.0;

    // Reset visual properties
    this.setScale(1, 1); // CRITICAL: Set sprite scale!
    this.setAnimation("idle_down"); // Use string name directly!
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when prey is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  /**
   * Main update - applies boid behaviors plus predator avoidance
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio) {
    const i = this.index;

    // Apply flocking behaviors (uses Template Method Pattern from Boid)
    // processNeighbor() hook will accumulate fleeing data during the loop
    const context = super.applyFlockingBehaviors(i, dtRatio);

    // Apply fleeing force based on accumulated context
    const predatorNearby = this.applyFleeing(i, dtRatio, context);

    // Additional behaviors
    this.avoidMouse(i, dtRatio);
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
    const rbVelocityAngle = RigidBody.velocityAngle;

    const speed = rbSpeed[i];

    // Determine animation state based on speed and direction
    // NEW API: Use animation names directly from the spritesheet!
    if (speed > 0.1) {
      // Use precalculated velocity angle from RigidBody
      const angle = rbVelocityAngle[i];

      // Convert angle to direction (8 directions -> 4 cardinal directions)
      // atan2 returns [-PI, PI] where 0 = right, PI/2 = down, -PI/2 = up, PI/-PI = left
      const direction = getDirectionFromAngle(angle);

      // Choose walk or run based on speed threshold
      const isRunning = speed > 2; // Threshold for running animation
      const animPrefix = isRunning ? "run" : "walk";

      // Store last direction for idle state
      if (!this.lastDirection) this.lastDirection = "down";
      this.lastDirection = direction;

      // Set animation and speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.1);
    } else {
      // Use idle animation in last facing direction
      const direction = this.lastDirection || "down";
      this.setAnimation(`idle_${direction}`);
    }

    // Update tint based on life (white = healthy, red = damaged)
    // Map life from white (0xffffff) to red (0xff0000) based on remaining life ratio
    // let newTint;
    // if (this.preyBehavior.life > 0) {
    //   const maxLife = 1; // Default max life
    //   const ratio = Math.max(0, Math.min(1, this.preyBehavior.life / maxLife));
    //   // Interpolate green/blue channel from 255 (white) to 0 (red)
    //   const gb = Math.round(255 * ratio);
    //   newTint = (0xff << 16) | (gb << 8) | gb;
    // } else {
    //   newTint = 0xff0000; // Dead = red
    // }
    // this.setTint(newTint);

    // Flip sprite based on movement direction (only if moving significantly)
    // if (Math.abs(vx) > 0.1) {
    //   this.setScale(vx < 0 ? -1 : 1, 1); // Flip X when moving left
    // }
  }

  /**
   * Unity-style collision callback: Called when prey collides with predator
   * This demonstrates the collision detection system
   */
  onCollisionEnter(otherIndex) {
    // this.setTint(0xff0000);
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
    // this.setTint(0xffffff);
    // Could add effects when prey escapes from predator
  }
}

// ES6 module export
export { Prey };
