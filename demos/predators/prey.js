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

  defineSpritesheets() {
    // Choose random spritesheet for visual variety
    const spritesheets = ["civil1", "civil2", "civil3", "civil4", "civil5"];
    const randomSheet =
      spritesheets[Math.floor(Math.random() * spritesheets.length)];

    // Set the spritesheet for THIS instance
    this.setSpritesheet(randomSheet);
    this.setAnimation("idle_down");
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Call parent Boid.onSpawned() to initialize position
    super.onSpawned(spawnConfig);
    this.defineSpritesheets();

    // Set random scale and match collider to visual size
    const scale = Math.random() * 0.3 + 0.85;
    this.setScale((1 + scale) * 0.5, scale);

    // Set collider radius to match the scaled visual size
    this.collider.radius = 10 * Math.pow(scale, 2);

    // Reset health
    this.preyBehavior.life = 1.0;
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

    if (speed > 0.1) {
      // Choose walk or run based on speed threshold
      const isRunning = speed > 2;
      const animPrefix = isRunning ? "run" : "walk";

      // Set animation and speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.15);
    } else {
      // Use idle animation in last facing direction
      this.setAnimation(`idle_${direction}`);
    }
  }
}

// ES6 module export
export { Prey };
