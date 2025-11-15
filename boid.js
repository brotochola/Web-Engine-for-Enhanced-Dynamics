// Boid configuration - shared between all workers
// Using SharedArrayBuffer architecture

const ENTITY_COUNT = 20000;

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const WIDTH = 2200;
const HEIGHT = 1500;

// Boid parameters
const VISUAL_RANGE = 15; //distance to detect other boids
const PROTECTED_RANGE = 10; //distance to avoid other boids
const CENTERING_FACTOR = 0.005; //factor to move towards center of mass
const AVOID_FACTOR = 0.3; //factor to avoid other boids
const MATCHING_FACTOR = 0.1; //factor to match velocity with neighbors
const MAX_ACCELERATION = 0.5; //maximum acceleration
const MAX_SPEED = 20; //maximum speed
const MIN_SPEED = 1; //minimum speed
const TURN_FACTOR = 0.1; //factor to turn boids
const MARGIN = 20; //margin to keep boids within bounds

// Spatial hash grid configuration
const MAX_NEIGHBORS_PER_BOID = 100; // Maximum neighbors we'll store per boid
///////////////////////////////////////////

// Structure of Arrays layout:
// 8 separate Float32Arrays in the SharedArrayBuffer
// Each array has ENTITY_COUNT elements
// This gives much better cache locality when iterating

const ARRAYS_COUNT = 8;
const ARRAY_SIZE = ENTITY_COUNT;
const BYTES_PER_ARRAY = ARRAY_SIZE * 4; // Float32 = 4 bytes
const TOTAL_BUFFER_SIZE = ARRAYS_COUNT * BYTES_PER_ARRAY;

// Array offsets in the buffer
const OFFSET_X = 0;
const OFFSET_Y = BYTES_PER_ARRAY;
const OFFSET_VX = BYTES_PER_ARRAY * 2;
const OFFSET_VY = BYTES_PER_ARRAY * 3;
const OFFSET_AX = BYTES_PER_ARRAY * 4;
const OFFSET_AY = BYTES_PER_ARRAY * 5;
const OFFSET_ROTATION = BYTES_PER_ARRAY * 6;
const OFFSET_SCALE = BYTES_PER_ARRAY * 7;

// Helper class to access SharedArrayBuffer as Structure of Arrays
class BoidArrays {
  constructor(sharedBuffer) {
    this.buffer = sharedBuffer;

    // Create views for each array
    this.x = new Float32Array(sharedBuffer, OFFSET_X, ARRAY_SIZE);
    this.y = new Float32Array(sharedBuffer, OFFSET_Y, ARRAY_SIZE);
    this.vx = new Float32Array(sharedBuffer, OFFSET_VX, ARRAY_SIZE);
    this.vy = new Float32Array(sharedBuffer, OFFSET_VY, ARRAY_SIZE);
    this.ax = new Float32Array(sharedBuffer, OFFSET_AX, ARRAY_SIZE);
    this.ay = new Float32Array(sharedBuffer, OFFSET_AY, ARRAY_SIZE);
    this.rotation = new Float32Array(sharedBuffer, OFFSET_ROTATION, ARRAY_SIZE);
    this.scale = new Float32Array(sharedBuffer, OFFSET_SCALE, ARRAY_SIZE);
  }
}

// Boid logic class - operates on array indices
// NOTE: This class is kept for backwards compatibility but is no longer used
// with the spatial worker integration. The logic worker now directly implements
// the boid rules using precomputed neighbors from the spatial worker.
class BoidLogic {
  constructor(arrays) {
    this.arrays = arrays;

    // Temporary storage for neighbor calculations
    this.tempNeighbors = new Int32Array(ENTITY_COUNT); // Max possible neighbors
    this.neighborCount = 0;
  }

  // Find neighbors for boid at index i
  findNeighbors(i) {
    this.neighborCount = 0;
    const x = this.arrays.x;
    const y = this.arrays.y;
    const myX = x[i];
    const myY = y[i];
    const rangeSq = VISUAL_RANGE * VISUAL_RANGE;

    for (let j = 0; j < ENTITY_COUNT; j++) {
      if (i === j) continue;

      const dx = x[j] - myX;
      const dy = y[j] - myY;
      const distSq = dx * dx + dy * dy;

      if (distSq < rangeSq) {
        this.tempNeighbors[this.neighborCount++] = j;
      }
    }
  }

  // Rule 1: Cohesion
  cohesion(i, dtRatio) {
    if (this.neighborCount === 0) return;

    const x = this.arrays.x;
    const y = this.arrays.y;
    const ax = this.arrays.ax;
    const ay = this.arrays.ay;

    let centerX = 0;
    let centerY = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.tempNeighbors[n];
      centerX += x[j];
      centerY += y[j];
    }

    centerX /= this.neighborCount;
    centerY /= this.neighborCount;

    ax[i] += (centerX - x[i]) * CENTERING_FACTOR * dtRatio;
    ay[i] += (centerY - y[i]) * CENTERING_FACTOR * dtRatio;
  }

  // Rule 2: Separation
  separation(i, dtRatio) {
    const x = this.arrays.x;
    const y = this.arrays.y;
    const ax = this.arrays.ax;
    const ay = this.arrays.ay;
    const myX = x[i];
    const myY = y[i];

    let moveX = 0;
    let moveY = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.tempNeighbors[n];
      const dx = x[j] - myX;
      const dy = y[j] - myY;
      const dist2 = dx * dx + dy * dy;

      if (dist2 < PROTECTED_RANGE * PROTECTED_RANGE && dist2 > 0) {
        moveX -= dx / dist2;
        moveY -= dy / dist2;
      }
    }

    ax[i] += moveX * AVOID_FACTOR * dtRatio;
    ay[i] += moveY * AVOID_FACTOR * dtRatio;
  }

  // Rule 3: Alignment
  alignment(i, dtRatio) {
    if (this.neighborCount === 0) return;

    const vx = this.arrays.vx;
    const vy = this.arrays.vy;
    const ax = this.arrays.ax;
    const ay = this.arrays.ay;

    let avgVX = 0;
    let avgVY = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.tempNeighbors[n];
      avgVX += vx[j];
      avgVY += vy[j];
    }

    avgVX /= this.neighborCount;
    avgVY /= this.neighborCount;

    ax[i] += (avgVX - vx[i]) * MATCHING_FACTOR * dtRatio;
    ay[i] += (avgVY - vy[i]) * MATCHING_FACTOR * dtRatio;
  }

  // Keep within bounds
  keepWithinBounds(i, dtRatio) {
    const x = this.arrays.x;
    const y = this.arrays.y;
    const ax = this.arrays.ax;
    const ay = this.arrays.ay;

    if (x[i] < MARGIN) ax[i] += TURN_FACTOR * dtRatio;
    if (x[i] > WIDTH - MARGIN) ax[i] -= TURN_FACTOR * dtRatio;
    if (y[i] < MARGIN) ay[i] += TURN_FACTOR * dtRatio;
    if (y[i] > HEIGHT - MARGIN) ay[i] -= TURN_FACTOR * dtRatio;
  }

  // Calculate accelerations for boid i
  calculateAccelerations(i, dtRatio) {
    // Reset acceleration
    // this.arrays.ax[i] = 0;
    // this.arrays.ay[i] = 0;

    // Find neighbors
    this.findNeighbors(i);

    // Apply rules
    this.cohesion(i, dtRatio);
    this.separation(i, dtRatio);
    this.alignment(i, dtRatio);
    this.keepWithinBounds(i, dtRatio);
  }
}
