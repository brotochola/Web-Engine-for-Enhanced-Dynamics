// Predator.js - Predator that flocks with other predators and hunts prey
// Extends Boid to inherit flocking behavior

import { GameObject } from "/src/core/gameObject.js";
import { RigidBody } from "/src/components/RigidBody.js";
import { Boid } from "./boid.js";
import { Prey } from "./prey.js";
import { PredatorBehavior } from "./PredatorBehavior.js";

class Predator extends Boid {
  static entityType = 2; // 2 = Predator
  static instances = []; // Instance tracking for this class

  // Add PredatorBehavior component for predator-specific properties
  static components = [...Boid.components, PredatorBehavior];

  // Sprite configuration - standardized format for animated sprites
  static spriteConfig = {
    type: "animated",
    spritesheet: "lpc",
    defaultAnimation: "idle_down",
    animationSpeed: 0.15,

    // Animation states - maps state index to animation name
    animStates: {
      0: { name: "idle_down", label: "IDLE" }, // Idle (using walk for now)
      1: { name: "walk_right", label: "WALK" }, // Walking
    },
  };

  static anims = {
    IDLE: 0,
    WALK: 1,
  };

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * Overrides and extends Boid's setup()
   */
  setup() {
    // Call parent Boid.setup() first
    super.setup();

    // Initialize predator-specific properties
    this.predatorBehavior.huntFactor = 0.2; // Chase strength

    // Override Boid's physics properties for predator behavior
    this.rigidBody.maxVel = 7;
    this.rigidBody.maxAcc = 0.2;
    this.rigidBody.minSpeed = 0; //1; // Keep predators moving
    this.rigidBody.friction = 0.05;

    this.collider.radius = 30;
    this.spriteRenderer.animationSpeed = 0.15;

    // Override Boid's perception
    this.collider.visualRange = 200; // How far predator can see

    // Override Boid's Flocking component properties
    this.flocking.protectedRange = 0; //this.collider.radius * 3; // Minimum distance from others
    this.flocking.centeringFactor = 0; //0.0005; // Cohesion strength
    this.flocking.avoidFactor = 0; //0.5; // Separation strength
    this.flocking.matchingFactor = 0; //0.01; // Alignment strength
    this.flocking.turnFactor = 0.1; // Boundary avoidance strength
    this.flocking.margin = 20; // Distance from edge to start turning

    const scale = 2;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;

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

    this.setAnimationState(Predator.anims.IDLE);
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

  onCollisionEnter(otherIndex) {
    // console.log(`Predator ${this.index} collided with ${otherIndex}`);
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
    const rbVX = RigidBody.vx;

    const speed = rbSpeed[i];
    const vx = rbVX[i];

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
    if (Math.abs(vx) > 0.1) {
      this.setScale(vx < 0 ? -2 : 2, 2); // Flip X when moving left
    }
  }
}

// ES6 module export
export { Predator };
