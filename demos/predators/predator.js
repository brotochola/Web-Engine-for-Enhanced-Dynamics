// Predator.js - Predator that flocks with other predators and hunts prey
// Extends Boid to inherit flocking behavior

import WEED from "/src/index.js";
import { Boid } from "./boid.js";
import { Prey } from "./prey.js";
import { PredatorBehavior } from "./PredatorBehavior.js";

// Destructure what we need from WEED
const { GameObject, RigidBody, Transform, getDirectionFromAngle, rng } = WEED;

export class Predator extends Boid {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // Add PredatorBehavior component for predator-specific properties
  static components = [...Boid.components, PredatorBehavior];

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
      closestPreyIndex: -1,
      closestDist2: Infinity,
    };

    // Initialize predator-specific properties
    this.predatorBehavior.huntFactor = 0.2; // Chase strength

    // Override Boid's physics properties for predator behavior
    this.rigidBody.maxVel = 7;
    this.rigidBody.maxAcc = 0.2;
    this.rigidBody.minSpeed = 0; //1; // Keep predators moving
    this.rigidBody.friction = 0.05;

    // Set predator scale and collider
    const normalRadius = 10; // Base radius of character body at scale 1.0
    const scale = 2; // Predators are 2x larger than prey
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;
    this.collider.radius = normalRadius * scale; // Match scaled visual size (40px)

    this.spriteRenderer.animationSpeed = 0.15;

    // Override Boid's perception
    this.collider.visualRange = 150; // How far predator can see

    // Override Boid's Flocking component properties
    this.flocking.protectedRange = 0; //this.collider.radius * 3; // Minimum distance from others
    this.flocking.centeringFactor = 0; //0.0005; // Cohesion strength
    this.flocking.avoidFactor = 0; //0.5; // Separation strength
    this.flocking.matchingFactor = 0; //0.01; // Alignment strength
    this.flocking.turnFactor = 0.1; // Boundary avoidance strength
    this.flocking.margin = 20; // Distance from edge to start turning

    // Set anchor for character sprite (bottom-center for ground alignment)
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;
  }

  /**
   * LIFECYCLE: Called when predator is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    // Call parent Boid.onSpawned() to initialize position
    super.onSpawned(spawnConfig);

    // Set spritesheet for this instance
    this.setSpritesheet("civil3");
    this.setAnimation("idle_down");
    this.setAnimationSpeed(0.15);
  }

  /**
   * LIFECYCLE: Called when predator is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  onDespawned() {
    // Could save hunting stats, etc.
  }

  /**
   * Main update - applies boid behaviors plus prey hunting
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio) {
    const i = this.index;

    // Apply flocking behaviors (uses Template Method Pattern from Boid)
    // processNeighbor() hook will accumulate hunting data during the loop
    const context = super.applyFlockingBehaviors(i, dtRatio);

    // Apply hunting force based on accumulated context
    const huntingPrey = this.applyHunting(i, dtRatio, context);

    // Additional behaviors
    this.avoidMouse(i, dtRatio);
    this.keepWithinBounds(i, dtRatio);

    // Update animation based on speed and state (cached)
    this.updateAnimation(i, huntingPrey);
  }

  /**
   * HOOK: Create context object for accumulating hunting data during neighbor loop
   * OPTIMIZATION: Reuses cached object to avoid per-frame allocations (GC pressure)
   */
  createNeighborContext() {
    // Reset values and return cached object - no new allocation per frame
    this._neighborContext.closestPreyIndex = -1;
    this._neighborContext.closestDist2 = Infinity;
    return this._neighborContext;
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
   * CACHE-FRIENDLY: Direct array access
   * @returns {boolean} True if actively hunting prey
   */
  applyHunting(i, dtRatio, context) {
    if (context.closestPreyIndex !== -1) {
      // Cache array references
      const tX = Transform.x;
      const tY = Transform.y;
      const rbAX = RigidBody.ax;
      const rbAY = RigidBody.ay;

      const myX = tX[i];
      const myY = tY[i];

      const preyIndex = context.closestPreyIndex;
      const dx = tX[preyIndex] - myX;
      const dy = tY[preyIndex] - myY;
      const dist = Math.sqrt(context.closestDist2);

      if (dist > 0) {
        rbAX[i] += (dx / dist) * this.predatorBehavior.huntFactor * dtRatio;
        rbAY[i] += (dy / dist) * this.predatorBehavior.huntFactor * dtRatio;
      }
      return true;
    }
    return false;
  }

  /**
   * OPTIMIZED: Update animation based on movement speed and hunting state
   * Uses helper methods with dirty flag optimization for efficient rendering
   * CACHE-FRIENDLY: Direct array access for reading physics data
   */
  updateAnimation(i, huntingPrey) {
    // Cache array references for reading
    const rbSpeed = RigidBody.speed;
    const rbVelocityAngle = RigidBody.velocityAngle;

    const speed = rbSpeed[i];

    // Determine animation state based on speed and direction
    // NEW API: Use animation names directly from the spritesheet!
    if (speed > 0.5) {
      // Use precalculated velocity angle from RigidBody
      const angle = rbVelocityAngle[i];

      // Convert angle to direction (8 directions -> 4 cardinal directions)
      const direction = getDirectionFromAngle(angle);

      // Choose walk or run based on speed threshold (predators run faster)
      const isRunning = speed > 2.5; // Higher threshold for predator running
      const animPrefix = isRunning ? "run" : "walk";

      // Store last direction for idle state
      if (!this.lastDirection) this.lastDirection = "down";
      this.lastDirection = direction;

      // Set animation with speed-based animation speed
      this.setAnimation(`${animPrefix}_${direction}`);
      this.setAnimationSpeed(speed * 0.08);
    } else {
      // Use idle animation in last facing direction
      const direction = this.lastDirection || "down";
      this.setAnimation(`idle_${direction}`);
    }
  }
}
