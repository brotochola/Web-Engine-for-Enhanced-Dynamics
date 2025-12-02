// ============================================================================
// GAME ENGINE UTILITIES
// Shared utility functions for the multithreaded game engine
// ============================================================================

// ============================================================================
// MATH UTILITIES
// ============================================================================

/**
 * Clamp a value between 0 and 1
 * @param {number} value - The value to clamp
 * @param {number} fallback - Fallback value if input is invalid
 * @returns {number} Clamped value
 */
export function clamp01(value, fallback) {
  if (typeof value !== "number") return fallback;
  return Math.max(0, Math.min(1, value));
}

/**
 * Clamp a value between min and max
 * @param {number} value - The value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between two values
 * @param {number} a - Start value
 * @param {number} b - End value
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated value
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Calculate squared distance between two 2D points (faster than distance)
 * @param {number} x1 - First point X
 * @param {number} y1 - First point Y
 * @param {number} x2 - Second point X
 * @param {number} y2 - Second point Y
 * @returns {number} Squared distance
 */
export function distanceSq2D(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/**
 * Calculate distance between two 2D points
 * @param {number} x1 - First point X
 * @param {number} y1 - First point Y
 * @param {number} x2 - Second point X
 * @param {number} y2 - Second point Y
 * @returns {number} Distance
 */
export function distance2D(x1, y1, x2, y2) {
  return Math.sqrt(distanceSq2D(x1, y1, x2, y2));
}

// ============================================================================
// SPATIAL/GRID UTILITIES
// ============================================================================

/**
 * Convert world position to spatial grid cell index
 * @param {number} x - World X position
 * @param {number} y - World Y position
 * @param {number} cellSize - Size of each grid cell
 * @param {number} gridCols - Number of grid columns
 * @param {number} gridRows - Number of grid rows
 * @returns {number} Cell index in 1D array
 */
export function getCellIndex(x, y, cellSize, gridCols, gridRows) {
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);

  // Clamp to grid bounds
  const clampedCol = Math.max(0, Math.min(gridCols - 1, col));
  const clampedRow = Math.max(0, Math.min(gridRows - 1, row));

  return clampedRow * gridCols + clampedCol;
}

/**
 * Get grid cell coordinates from world position
 * @param {number} x - World X position
 * @param {number} y - World Y position
 * @param {number} cellSize - Size of each grid cell
 * @param {number} gridCols - Number of grid columns
 * @param {number} gridRows - Number of grid rows
 * @returns {Object} {col, row} Grid coordinates
 */
export function getCellCoords(x, y, cellSize, gridCols, gridRows) {
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);

  return {
    col: Math.max(0, Math.min(gridCols - 1, col)),
    row: Math.max(0, Math.min(gridRows - 1, row)),
  };
}

// ============================================================================
// COMPONENT/CLASS UTILITIES
// ============================================================================

/**
 * Get all parent classes in the inheritance chain
 * @param {Class} childClass - The class to get parents for
 * @returns {Array<Class>} Array of parent classes
 */
export function getParentClasses(childClass) {
  const parentClasses = [];
  let currentClass = childClass;

  // Loop until the prototype chain reaches null (beyond Object.prototype)
  while (currentClass && currentClass !== Object) {
    const parent = Object.getPrototypeOf(currentClass);
    if (parent && parent !== Object.prototype.constructor) {
      // Exclude the base Object constructor
      parentClasses.push(parent);
      currentClass = parent;
    } else {
      break; // Reached the top of the inheritance chain
    }
  }
  return parentClasses;
}

/**
 * Collect all components from a class hierarchy
 * Walks up the prototype chain and collects all unique components
 * @param {Class} EntityClass - The entity class to collect components from
 * @param {Class} BaseClass - The base class to stop at (e.g., GameObject)
 * @param {Class} DefaultComponent - Default component to always include (e.g., Transform)
 * @returns {Array<Component>} Array of unique component classes
 */
export function collectComponents(EntityClass, BaseClass, DefaultComponent) {
  const components = new Set();
  let currentClass = EntityClass;

  // Walk up the prototype chain
  while (
    currentClass &&
    currentClass !== Object &&
    currentClass !== BaseClass
  ) {
    if (currentClass.components && Array.isArray(currentClass.components)) {
      currentClass.components.forEach((c) => components.add(c));
    }
    currentClass = Object.getPrototypeOf(currentClass);
  }

  // Add default component if provided
  if (DefaultComponent) {
    components.add(DefaultComponent);
  }

  return Array.from(components);
}

// ============================================================================
// WORKER COMMUNICATION UTILITIES
// ============================================================================

/**
 * Setup direct MessagePort communication between workers
 * This allows workers to communicate without going through the main thread
 * @param {Array<Object>} connections - Array of {from, to} connections
 * @returns {Object} workerPorts - Object mapping worker names to their ports
 *
 * @example
 * const connections = [
 *   { from: "logic", to: "renderer" },
 *   { from: "physics", to: "renderer" }
 * ];
 * const ports = setupWorkerCommunication(connections);
 * // Returns: { logic: { renderer: port }, renderer: { logic: port, physics: port }, ... }
 */
export function setupWorkerCommunication(connections) {
  const workerPorts = {};

  connections.forEach(({ from, to }) => {
    const channel = new MessageChannel();

    // Initialize nested objects if they don't exist
    if (!workerPorts[from]) workerPorts[from] = {};
    if (!workerPorts[to]) workerPorts[to] = {};

    // Assign ports (bidirectional communication)
    workerPorts[from][to] = channel.port1;
    workerPorts[to][from] = channel.port2;
  });

  return workerPorts;
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate and merge physics configuration
 * @param {Object} currentConfig - Current configuration
 * @param {Object} newConfig - New configuration to merge
 * @returns {Object} Validated and merged configuration
 */
export function validatePhysicsConfig(currentConfig, newConfig) {
  return {
    subStepCount: Math.max(
      1,
      newConfig.subStepCount ?? currentConfig.subStepCount
    ),
    boundaryElasticity: clamp01(
      newConfig.boundaryElasticity ?? currentConfig.boundaryElasticity,
      currentConfig.boundaryElasticity
    ),
    collisionResponseStrength: clamp01(
      newConfig.collisionResponseStrength ??
        currentConfig.collisionResponseStrength,
      currentConfig.collisionResponseStrength
    ),
    verletDamping: clamp01(
      newConfig.verletDamping ?? currentConfig.verletDamping,
      currentConfig.verletDamping
    ),
    minSpeedForRotation:
      newConfig.minSpeedForRotation ?? currentConfig.minSpeedForRotation,
    gravity: {
      x:
        newConfig.gravity && typeof newConfig.gravity.x === "number"
          ? newConfig.gravity.x
          : currentConfig.gravity?.x ?? 0,
      y:
        newConfig.gravity && typeof newConfig.gravity.y === "number"
          ? newConfig.gravity.y
          : currentConfig.gravity?.y ?? 0,
    },
  };
}

/**
 * Convert angle (radians) to cardinal direction string
 * @param {number} angle - Angle from RigidBody.velocityAngle (already has +PI/2 offset for rotation)
 * @returns {string} One of: "right", "down", "left", "up"
 */
export function getDirectionFromAngle(angle) {
  // velocityAngle = atan2(vy, vx) + PI/2 (for sprite rotation)
  // So we need to account for that offset:
  // Moving RIGHT: velocityAngle = PI/2
  // Moving DOWN: velocityAngle = PI
  // Moving LEFT: velocityAngle = 3*PI/2
  // Moving UP: velocityAngle = 0 (or 2*PI)

  // Normalize angle to [0, 2*PI]
  const normalizedAngle = angle < 0 ? angle + Math.PI * 2 : angle;
  const PI = Math.PI;
  const PI_4 = PI / 4;

  // Map velocityAngle to cardinal directions (accounting for +PI/2 offset)
  if (normalizedAngle < PI_4 || normalizedAngle >= (PI * 7) / 4) {
    return "up"; // 315° to 45° (North)
  } else if (normalizedAngle < (PI * 3) / 4) {
    return "right"; // 45° to 135° (East)
  } else if (normalizedAngle < (PI * 5) / 4) {
    return "down"; // 135° to 225° (South)
  } else {
    return "left"; // 225° to 315° (West)
  }
}
