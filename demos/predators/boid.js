// Boid.js - Flocking behavior implementation
// Extends GameObject to implement the classic boids algorithm

import { GameObject } from "/src/core/gameObject.js";
import { RigidBody } from "/src/components/RigidBody.js";
import { Collider } from "/src/components/Collider.js";
import { SpriteRenderer } from "/src/components/SpriteRenderer.js";
import { Flocking } from "./Flocking.js";

class Boid extends GameObject {
  static entityType = 0; // 0 = Boid
  static instances = []; // Instance tracking for this class

  // Define components this entity uses (including custom Flocking component)
  static components = [RigidBody, Collider, SpriteRenderer, Flocking];

  // Sprite configuration - standardized format for static sprites
  static spriteConfig = {
    type: "static",
    textureName: "bunny",
  };

  // Note: Flocking behavior properties are now in the Flocking component
  // (protectedRange, centeringFactor, avoidFactor, matchingFactor, turnFactor, margin)

  /**
   * Boid constructor - initializes this boid's properties
   * Sets both GameObject properties (transform/physics) and Boid properties (behavior)
   *
   * @param {number} index - Position in shared arrays
   * @param {Object} componentIndices - Component indices { transform, rigidBody, collider, spriteRenderer, flocking }
   * @param {Object} config - Configuration object from GameEngine
   */
  constructor(index, componentIndices, config = {}, logicWorker = null) {
    super(index, componentIndices, config, logicWorker);

    const i = index;

    // Initialize RigidBody constraints
    this.rigidBody.maxVel = 10;
    this.rigidBody.maxAcc = 0.2;
    this.rigidBody.minSpeed = 0; // Keep boids moving
    this.rigidBody.friction = 0.01;

    // Initialize Collider
    this.collider.radius = 10;
    this.collider.visualRange = 100; // How far boid can see

    // Initialize SpriteRenderer
    this.spriteRenderer.scaleX = 1;
    this.spriteRenderer.scaleY = 1;

    // Initialize Flocking component behavior properties
    this.flocking.protectedRange = this.collider.radius * 2; // Minimum distance from others
    this.flocking.centeringFactor = 0.001; // Cohesion strength
    this.flocking.avoidFactor = 0.3; // Separation strength
    this.flocking.matchingFactor = 0.1; // Alignment strength
    this.flocking.turnFactor = 0.1; // Boundary avoidance strength
    this.flocking.margin = 20; // Distance from edge to start turning
  }

  // Note: this.flocking is automatically available because Flocking is in static components[]
  // GameObject._createComponentAccessors() creates instances for all components automatically

  /**
   * LIFECYCLE: Called when boid is spawned/respawned from pool
   * Reset all properties to initial state
   */
  awake() {
    // Get config from instance (passed during construction)
    const config = this.config || {};

    // Initialize Transform position
    // NOTE: Spawn config already sets position, so only randomize if not set
    if (this.transform.x === undefined || this.transform.x === 0) {
      this.x = Math.random() * (config.worldWidth || 800);
      this.y = Math.random() * (config.worldHeight || 600);
    }

    this.transform.rotation = 0;

    this.rigidBody.vx = this.rigidBody.vx || 0;
    this.rigidBody.vy = this.rigidBody.vy || 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;
  }

  /**
   * LIFECYCLE: Called when boid is despawned (returned to pool)
   */
  sleep() {
    console.log(`Boid ${this.index} despawned`);
  }

  /**
   * Main update - applies all boid rules
   * The spatial worker has already found neighbors for us!
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio, inputData) {
    const i = this.index;

    // Apply all three boid rules in a single optimized loop
    this.applyFlockingBehaviors(i, dtRatio);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, inputData);
    this.keepWithinBounds(i, dtRatio);
  }

  /**
   * OPTIMIZED: Apply all three boid rules (cohesion, separation, alignment) in a single loop
   * Uses Template Method Pattern - subclasses can override processNeighbor() to add custom logic
   * This reduces neighbor iteration from 3+ loops to 1 loop
   *
   * NEW: Uses pre-calculated distances from spatial worker (no need to recalculate!)
   * CACHE-FRIENDLY: Direct array access instead of getters (50-100x faster!)
   *
   * @returns {Object} neighborContext - Data that subclasses accumulated during the loop
   */
  applyFlockingBehaviors(i, dtRatio) {
    if (this.neighborCount === 0) return {};

    // PERFORMANCE: Cache array references once (avoids getter overhead)
    const entityTypes = GameObject.entityType;
    const tX = Transform.x;
    const tY = Transform.y;
    const rbVX = RigidBody.vx;
    const rbVY = RigidBody.vy;
    const rbAX = RigidBody.ax;
    const rbAY = RigidBody.ay;

    const myEntityType = entityTypes[i];
    const myX = tX[i];
    const myY = tY[i];
    const protectedRange2 =
      this.flocking.protectedRange * this.flocking.protectedRange;

    // Cohesion accumulators (same type only)
    let centerX = 0;
    let centerY = 0;

    // Alignment accumulators (same type only)
    let avgVX = 0;
    let avgVY = 0;

    // Separation accumulators (all types)
    let separateX = 0;
    let separateY = 0;

    let sameTypeCount = 0;

    // Create context object for subclass to accumulate custom data
    const neighborContext = this.createNeighborContext();

    // Performance optimization: limit processing to reasonable neighbor count
    const maxProcessed = this.neighborCount; // Math.min(this.neighborCount, 30); // Process max 30 neighbors

    // Single loop through all neighbors
    for (let n = 0; n < maxProcessed; n++) {
      const j = this.neighbors[n];
      const neighborType = entityTypes[j];
      const isSameType = neighborType === myEntityType;

      // Use pre-calculated squared distance from spatial worker (OPTIMIZATION!)
      // This eliminates duplicate distance calculations between spatial & logic workers
      const dist2 = this.neighborDistances ? this.neighborDistances[n] : 0;

      // Calculate delta using direct array access
      const dx = tX[j] - myX;
      const dy = tY[j] - myY;

      // Cohesion & Alignment (same type only)
      if (isSameType) {
        if (dist2 < protectedRange2) continue;
        centerX += tX[j];
        centerY += tY[j];
        avgVX += rbVX[j];
        avgVY += rbVY[j];
        sameTypeCount++;
      }

      // Separation (all types)
      if (dist2 < protectedRange2 && dist2 > 0) {
        separateX -= dx / dist2;
        separateY -= dy / dist2;
      }

      // HOOK: Allow subclasses to process this neighbor (e.g., hunt prey, flee predators)
      this.processNeighbor(
        j,
        neighborType,
        dx,
        dy,
        dist2,
        isSameType,
        neighborContext
      );
    }

    // Apply cohesion force
    if (sameTypeCount > 0) {
      centerX /= sameTypeCount;
      centerY /= sameTypeCount;
      rbAX[i] += (centerX - myX) * this.flocking.centeringFactor * dtRatio;
      rbAY[i] += (centerY - myY) * this.flocking.centeringFactor * dtRatio;

      // Apply alignment force
      avgVX /= sameTypeCount;
      avgVY /= sameTypeCount;
      rbAX[i] += (avgVX - rbVX[i]) * this.flocking.matchingFactor * dtRatio;
      rbAY[i] += (avgVY - rbVY[i]) * this.flocking.matchingFactor * dtRatio;
    }

    // Apply separation force
    rbAX[i] += separateX * this.flocking.avoidFactor * dtRatio;
    rbAY[i] += separateY * this.flocking.avoidFactor * dtRatio;

    // Return context so subclass can use accumulated data
    return neighborContext;
  }

  /**
   * HOOK: Create context object for subclasses to accumulate custom data during neighbor loop
   * Override this in subclasses to add custom properties
   * @returns {Object} Empty context object (subclasses extend this)
   */
  createNeighborContext() {
    return {};
  }

  /**
   * HOOK: Process individual neighbor - called once per neighbor during flocking loop
   * Override this in subclasses to add custom per-neighbor logic (hunting, fleeing, etc.)
   *
   * @param {number} neighborIndex - Index of the neighbor entity
   * @param {number} neighborType - Entity type of the neighbor
   * @param {number} dx - Delta X (neighbor.x - my.x)
   * @param {number} dy - Delta Y (neighbor.y - my.y)
   * @param {number} dist2 - Squared distance to neighbor
   * @param {boolean} isSameType - Whether neighbor is same entity type
   * @param {Object} context - Context object to accumulate data
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
    // Default: do nothing (base Boid doesn't need extra logic)
  }

  /**
   * Avoid the mouse cursor
   * CACHE-FRIENDLY: Direct array access
   */
  avoidMouse(i, dtRatio, inputData) {
    if (inputData[2] === 0) return;
    if (inputData[3] === 0) return;

    // Cache array references
    const tX = Transform.x;
    const tY = Transform.y;
    const rbAX = RigidBody.ax;
    const rbAY = RigidBody.ay;

    const mouseX = inputData[0];
    const mouseY = inputData[1];

    const dx = tX[i] - mouseX;
    const dy = tY[i] - mouseY;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < 1e-4 || dist2 > 100000) return;

    const strength = 10;
    rbAX[i] += (dx / dist2) * strength * dtRatio;
    rbAY[i] += (dy / dist2) * strength * dtRatio;
  }

  /**
   * Keep boids within world boundaries
   * CACHE-FRIENDLY: Direct array access
   */
  keepWithinBounds(i, dtRatio) {
    // Cache array references
    const tX = Transform.x;
    const tY = Transform.y;
    const rbAX = RigidBody.ax;
    const rbAY = RigidBody.ay;

    const x = tX[i];
    const y = tY[i];
    const worldWidth = this.config.worldWidth || 800;
    const worldHeight = this.config.worldHeight || 600;

    if (x < this.flocking.margin) rbAX[i] += this.flocking.turnFactor * dtRatio;
    if (x > worldWidth - this.flocking.margin)
      rbAX[i] -= this.flocking.turnFactor * dtRatio;

    if (y < this.flocking.margin) rbAY[i] += this.flocking.turnFactor * dtRatio;
    if (y > worldHeight - this.flocking.margin)
      rbAY[i] -= this.flocking.turnFactor * dtRatio;
  }
}

// ES6 module export
export { Boid };
