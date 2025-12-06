// Prey.js - Boid that tries to survive by avoiding predators
// Extends Boid to implement prey-specific behaviors

import WEED from "/src/index.js";
import { Boid } from "./boid.js";
import { Predator } from "./predator.js";
import { PreyBehavior } from "./PreyBehavior.js";

// Destructure what we need from WEED
const { GameObject, RigidBody, getDirectionFromAngle } = WEED;

class Prey extends Boid {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // entityType auto-assigned during registration (no manual ID needed!)
  static instances = []; // Instance tracking for this class

  // Add PreyBehavior component for prey-specific properties
  static components = [...Boid.components, PreyBehavior];

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

  // Sprite configuration - NEW SIMPLIFIED API!
  // Just specify the spritesheet - all animations from lpc.json are automatically available!
  static spriteConfig = {
    type: "animated",
    spritesheet: "civil2", // References the loaded "lpc" spritesheet
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

    // OPTIMIZATION: Pre-allocate reusable context object to avoid per-frame allocations
    this._neighborContext = {
      fleeX: 0,
      fleeY: 0,
      predatorCount: 0,
    };

    // Initialize prey-specific properties
    this.preyBehavior.predatorAvoidFactor = 10; // Strong avoidance of predators
    this.preyBehavior.life = 1;

    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.1;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.05;

    // Override Boid's perception
    this.collider.visualRange = 120; // Must be >= max collision distance (6 + 60 = 66) for collision detection to work!
    this.spriteRenderer.animationSpeed = 0.15;

    // Set anchor for character sprite (bottom-center for ground alignment)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;

    // Override Boid's Flocking component properties - OPTIMIZED for performance
    this.flocking.protectedRange = this.collider.radius * 1.25; // Minimum distance from others
    this.flocking.centeringFactor = 0.0005; // Cohesion: gentle attraction to flock center
    this.flocking.avoidFactor = 6; // Separation: moderate avoidance (reduced from 3)
    this.flocking.matchingFactor = 0.05; // Alignment: match flock velocity
    this.flocking.turnFactor = 0.001; // Boundary avoidance strength
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
    // Set random scale and match collider to visual size
    // 64x64 sprite, character body/feet width is ~16-20px, so radius ~8-10px at scale 1.0
    // const normalRadius = 10; // Base radius of character body at scale 1.0
    const scale = Math.random() * 0.3 + 0.85; // Random scale 0.5-2.0x

    // Apply scale to sprite
    this.setScale((1 + scale) * 0.5, scale);

    // Set collider radius to match the scaled visual size
    this.collider.radius = 10 * Math.pow(scale, 2);

    // Reset health
    this.preyBehavior.life = 1.0;

    // Reset visual properties
    // this.setScale(1, 1); // CRITICAL: Set sprite scale!
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
   * OPTIMIZATION: Reuses cached object to avoid per-frame allocations (GC pressure)
   */
  createNeighborContext() {
    // Reset values and return cached object - no new allocation per frame
    this._neighborContext.fleeX = 0;
    this._neighborContext.fleeY = 0;
    this._neighborContext.predatorCount = 0;
    return this._neighborContext;
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

    const velocityAngle = this.rigidBody.velocityAngle;

    const speed = this.rigidBody.speed;

    // Determine animation state based on speed and direction
    // NEW API: Use animation names directly from the spritesheet!

    // Only update lastDirection when speed is high enough for stable velocity angle
    // At very low speeds, atan2 becomes unstable and causes direction flickering

    const direction = getDirectionFromAngle(velocityAngle);
    this.lastDirection = direction;

    if (speed > 0.2) {
      // Choose walk or run based on speed threshold
      const isRunning = speed > 2;
      const animPrefix = isRunning ? "run" : "walk";

      // Set animation and speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.1);
    } else {
      // Use idle animation in last facing direction
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
    // console.log("collision prey", Transform.entityType[otherIndex]);
  }

  /**
   * Unity-style collision callback: Called while prey is colliding with another entity
   */
  onCollisionStay(otherIndex) {
    // Could add ongoing collision effects here
    // For example: losing health over time while touching hazards
    // const i = this.index;
    // // Check if we collided with a predator
    // if (Transform.entityType[otherIndex] === Predator.entityType) {
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
