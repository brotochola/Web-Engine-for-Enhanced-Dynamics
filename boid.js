// Boid.js - Flocking behavior implementation
// Extends GameObject to implement the classic boids algorithm

// Import GameObject base class (in workers, this will be loaded via importScripts)
// importScripts("GameObject.js");

class Boid extends GameObject {
  static config = {
    VISUAL_RANGE: 25, // How far boids can see neighbors
    PROTECTED_RANGE: 7, // Minimum distance to maintain from others
    CENTERING_FACTOR: 0.001, // Strength of cohesion (move toward center of mass)
    AVOID_FACTOR: 0.3, // Strength of separation (avoid crowding)
    MATCHING_FACTOR: 0.1, // Strength of alignment (match neighbor velocity)
    TURN_FACTOR: 0.1, // How strongly to turn when near boundaries
    MARGIN: 20, // Distance from edge to start turning
  };
  /**
   * Boid - a simple creature that follows three rules:
   * 1. Cohesion: Move toward the center of mass of nearby boids
   * 2. Separation: Avoid getting too close to neighbors
   * 3. Alignment: Match the average velocity of neighbors
   *
   * @param {number} index - Position in shared arrays
   */
  constructor(index) {
    super(index);
    this.squaredVisualRange =
      Boid.config.VISUAL_RANGE * Boid.config.VISUAL_RANGE;
    this.squaredProtectedRange =
      Boid.config.PROTECTED_RANGE * Boid.config.PROTECTED_RANGE;
  }

  /**
   * Main update - applies all boid rules
   * The spatial worker has already found neighbors for us!
   */
  tick(dtRatio, arrays, neighborData, inputData) {
    const i = this.index;

    // Get precomputed neighbors for this boid
    // Neighbor buffer layout: [count, id1, id2, id3, ...]
    const offset = i * (1 + MAX_NEIGHBORS_PER_ENTITY);
    const neighborCount = neighborData[offset];
    const neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + neighborCount
    );

    // Apply the three rules of boids
    this.applyCohesion(i, dtRatio, arrays, neighborCount, neighbors);
    this.applySeparation(i, dtRatio, arrays, neighborCount, neighbors);
    this.applyAlignment(i, dtRatio, arrays, neighborCount, neighbors);

    // Additional behaviors
    this.avoidMouse(i, dtRatio, arrays, inputData);
    this.keepWithinBounds(i, dtRatio, arrays);
  }

  /**
   * Rule 1: Cohesion - Steer toward the center of mass of neighbors
   * This makes boids cluster together
   */
  applyCohesion(i, dtRatio, arrays, neighborCount, neighbors) {
    if (neighborCount === 0) return; // No neighbors, nothing to do

    // Calculate center of mass of all neighbors
    let centerX = 0;
    let centerY = 0;
    let count = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n]; // Index of neighbor boid
      const dist2 =
        Math.pow(arrays.x[j] - arrays.x[i], 2) +
        Math.pow(arrays.y[j] - arrays.y[i], 2);
      if (
        dist2 < this.squaredVisualRange &&
        dist2 > 0 &&
        dist2 > this.squaredProtectedRange
      ) {
        centerX += arrays.x[j];
        centerY += arrays.y[j];
        count++;
      }
    }
    if (count === 0) return;
    centerX /= count;
    centerY /= count;

    // Accelerate toward the center
    arrays.ax[i] +=
      (centerX - arrays.x[i]) * Boid.config.CENTERING_FACTOR * dtRatio;
    arrays.ay[i] +=
      (centerY - arrays.y[i]) * Boid.config.CENTERING_FACTOR * dtRatio;
  }

  /**
   * Rule 2: Separation - Avoid crowding neighbors
   * This prevents boids from overlapping
   */
  applySeparation(i, dtRatio, arrays, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    const myX = arrays.x[i];
    const myY = arrays.y[i];

    let moveX = 0;
    let moveY = 0;

    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];
      const dx = arrays.x[j] - myX;
      const dy = arrays.y[j] - myY;
      const dist2 = dx * dx + dy * dy; // Distance squared (faster than sqrt)

      // If too close, move away (strength inversely proportional to distance)
      if (
        dist2 < Boid.config.PROTECTED_RANGE * Boid.config.PROTECTED_RANGE &&
        dist2 > 0
      ) {
        moveX -= dx / dist2;
        moveY -= dy / dist2;
      }
    }

    arrays.ax[i] += moveX * Boid.config.AVOID_FACTOR * dtRatio;
    arrays.ay[i] += moveY * Boid.config.AVOID_FACTOR * dtRatio;
  }

  /**
   * Rule 3: Alignment - Match velocity with neighbors
   * This makes the flock move in coordinated direction
   */
  applyAlignment(i, dtRatio, arrays, neighborCount, neighbors) {
    if (neighborCount === 0) return;

    // Calculate average velocity of neighbors
    let avgVX = 0;
    let avgVY = 0;
    let count = 0;
    for (let n = 0; n < neighborCount; n++) {
      const j = neighbors[n];
      const dist2 =
        Math.pow(arrays.x[j] - arrays.x[i], 2) +
        Math.pow(arrays.y[j] - arrays.y[i], 2);
      if (
        dist2 < this.squaredVisualRange &&
        dist2 > 0 &&
        dist2 > this.squaredProtectedRange
      ) {
        avgVX += arrays.vx[j];
        avgVY += arrays.vy[j];
        count++;
      }
    }
    if (count === 0) return;

    avgVX /= count;
    avgVY /= count;

    // Accelerate toward average velocity
    arrays.ax[i] +=
      (avgVX - arrays.vx[i]) * Boid.config.MATCHING_FACTOR * dtRatio;
    arrays.ay[i] +=
      (avgVY - arrays.vy[i]) * Boid.config.MATCHING_FACTOR * dtRatio;
  }

  /**
   * Avoid the mouse cursor - adds interactivity
   * Boids flee from mouse position
   */
  avoidMouse(i, dtRatio, arrays, inputData) {
    const myX = arrays.x[i];
    const myY = arrays.y[i];

    // Read mouse position from shared input buffer
    const mouseX = inputData[0];
    const mouseY = inputData[1];

    const dx = myX - mouseX;
    const dy = myY - mouseY;
    const dist2 = dx * dx + dy * dy;

    // Prevent division by zero and limit effect range
    if (dist2 < 1e-4 || dist2 > 10000) return;

    const strength = 4;
    arrays.ax[i] += (dx / dist2) * strength * dtRatio;
    arrays.ay[i] += (dy / dist2) * strength * dtRatio;
  }

  /**
   * Keep boids within world boundaries
   * Gradually turn them around when approaching edges
   */
  keepWithinBounds(i, dtRatio, arrays) {
    const x = arrays.x[i];
    const y = arrays.y[i];

    // Turn back when near left/right edges
    if (x < Boid.config.MARGIN)
      arrays.ax[i] += Boid.config.TURN_FACTOR * dtRatio;
    if (x > WIDTH - Boid.config.MARGIN)
      arrays.ax[i] -= Boid.config.TURN_FACTOR * dtRatio;

    // Turn back when near top/bottom edges
    if (y < Boid.config.MARGIN)
      arrays.ay[i] += Boid.config.TURN_FACTOR * dtRatio;
    if (y > HEIGHT - Boid.config.MARGIN)
      arrays.ay[i] -= Boid.config.TURN_FACTOR * dtRatio;
  }
}

// Export for use in workers
if (typeof module !== "undefined" && module.exports) {
  module.exports = Boid;
}
