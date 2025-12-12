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
 * Resolve a value that can be a number or { min, max } range
 * @param {number|{min:number, max:number}} value - Value or range
 * @param {number} defaultVal - Default if value is undefined
 * @returns {number} - Resolved value (randomized if range)
 */
export function randomRange(value, defaultVal = 0) {
  if (value === undefined || value === null) return defaultVal;
  if (typeof value === "number") return value;
  // { min, max } object - return random value in range
  const min = value.min ?? defaultVal;
  const max = value.max ?? defaultVal;
  return min + Math.random() * (max - min);
}

/**
 * Resolve a color value that can be a number or { min, max } range
 * Properly interpolates RGB channels separately
 * @param {number|{min:number, max:number}} value - Color value or range (e.g., 0xff0000 or { min: 0xaaaaaa, max: 0xffffff })
 * @param {number} defaultVal - Default if value is undefined
 * @returns {number} - Resolved color value
 */
export function randomColor(value, defaultVal = 0xffffff) {
  if (value === undefined || value === null) return defaultVal;
  if (typeof value === "number") return value;

  // { min, max } object - interpolate each RGB channel separately
  const minColor = value.min ?? defaultVal;
  const maxColor = value.max ?? defaultVal;

  // Extract RGB components from min color
  const minR = (minColor >> 16) & 0xff;
  const minG = (minColor >> 8) & 0xff;
  const minB = minColor & 0xff;

  // Extract RGB components from max color
  const maxR = (maxColor >> 16) & 0xff;
  const maxG = (maxColor >> 8) & 0xff;
  const maxB = maxColor & 0xff;

  // Random interpolation factor
  const t = Math.random();

  // Interpolate each channel
  const r = Math.round(minR + t * (maxR - minR));
  const g = Math.round(minG + t * (maxG - minG));
  const b = Math.round(minB + t * (maxB - minB));

  // Combine back into hex color
  return (r << 16) | (g << 8) | b;
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

export function seededRandom(seed) {
  let t = seed;
  const fn = function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return fn;
}

/**
 * Seeded random number generator - wrapper that accesses globalThis.rng
 * This allows entity code to use rng() which gets initialized in workers
 * In worker context: globalThis.rng is set by AbstractWorker.initSeendedRandom()
 * In main thread: can be set via seededRandom() if needed
 * @returns {number} Random number between 0 and 1
 */
export function rng() {
  if (typeof globalThis.rng === "function") {
    return globalThis.rng();
  }

  // Fallback to Math.random if not initialized (shouldn't happen in worker context)
  console.warn("rng() called before initialization, using Math.random()");
  return Math.random();
}

// ============================================================================
// LIGHTING UTILITIES
// ============================================================================

/**
 * Calculate light contribution using inverse square falloff
 * Formula: intensity / (distance² + epsilon)
 *
 * @param {number} intensity - Light intensity
 * @param {number} distanceSquared - Squared distance from light to target
 * @param {number} epsilon - Small value to prevent division by zero (default: 1.0)
 * @returns {number} Light contribution (0 to infinity, typically clamped later)
 */
export function calculateLightAttenuation(
  intensity,
  distanceSquared,
  epsilon = 1.0
) {
  return intensity / (distanceSquared + epsilon);
}

/**
 * Calculate total light received at a position from multiple light sources
 * Uses inverse square falloff: totalLight = ambient + Σ(intensity / d²)
 *
 * @param {number} targetX - Target position X (world space)
 * @param {number} targetY - Target position Y (world space)
 * @param {Object} lightData - Object containing light arrays:
 *   - lightX: Float32Array of light X positions
 *   - lightY: Float32Array of light Y positions
 *   - lightIntensity: Float32Array of light intensities
 *   - lightEnabled: Uint8Array of enabled flags
 *   - lightCount: Number of potential lights to check
 * @param {number} ambient - Ambient light level (0-1)
 * @param {number} maxLight - Maximum light value (default: 1.5)
 * @returns {number} Total light level (clamped to maxLight)
 */
export function calculateTotalLightAtPosition(
  targetX,
  targetY,
  lightData,
  ambient = 0.05,
  maxLight = 1.5
) {
  let totalLight = ambient;

  const { lightX, lightY, lightIntensity, lightEnabled, lightCount } =
    lightData;

  for (let i = 0; i < lightCount; i++) {
    if (!lightEnabled[i]) continue;

    const dx = targetX - lightX[i];
    const dy = targetY - lightY[i];
    const distSq = dx * dx + dy * dy;

    totalLight += calculateLightAttenuation(lightIntensity[i], distSq);
  }

  return Math.min(totalLight, maxLight);
}

/**
 * Calculate total light for an entity using precomputed neighbor distances
 * Uses the spatial worker's distanceData to avoid recalculating distances
 * Only considers neighbors (lights within visualRange), so this is an optimization
 * for dense scenes where lights are typically nearby entities
 *
 * @param {number} entityIndex - The entity's index
 * @param {Int32Array} neighborData - Neighbor indices buffer from spatial worker
 * @param {Float32Array} distanceData - Precomputed squared distances from spatial worker
 * @param {Float32Array} lightIntensity - Light intensity per entity
 * @param {Uint8Array} lightEnabled - Light enabled flags per entity
 * @param {number} stride - Neighbor buffer stride (1 + maxNeighbors)
 * @param {number} ambient - Ambient light level (0-1)
 * @param {number} maxLight - Maximum light value (default: 1.5)
 * @returns {number} Total light level (clamped to maxLight)
 */
export function calculateLightFromNeighbors(
  entityIndex,
  neighborData,
  distanceData,
  lightIntensity,
  lightEnabled,
  stride,
  ambient = 0.05,
  maxLight = 1.5
) {
  let totalLight = ambient;

  const offset = entityIndex * stride;
  const neighborCount = neighborData[offset];

  for (let k = 0; k < neighborCount; k++) {
    const neighborIdx = neighborData[offset + 1 + k];

    // Skip if this neighbor is not a light
    if (!lightEnabled[neighborIdx]) continue;

    // Use precomputed squared distance
    const distSq = distanceData[offset + 1 + k];

    totalLight += calculateLightAttenuation(
      lightIntensity[neighborIdx],
      distSq
    );
  }

  return Math.min(totalLight, maxLight);
}

/**
 * Convert a brightness value (0-1+) to a tint color
 * Brightness 1.0 = white (0xFFFFFF), 0.0 = black (0x000000)
 *
 * @param {number} brightness - Light level (0 to 1+, will be clamped)
 * @returns {number} Tint color in 0xRRGGBB format
 */
export function brightnessToTint(brightness) {
  const clamped = Math.max(0, Math.min(1, brightness));
  const value = Math.round(clamped * 255);
  return (value << 16) | (value << 8) | value;
}

/**
 * Convert a brightness value and color to a tinted color
 * Multiplies the base color by the brightness
 *
 * @param {number} brightness - Light level (0 to 1+, will be clamped)
 * @param {number} baseColor - Base color in 0xRRGGBB format (default: white)
 * @returns {number} Tinted color in 0xRRGGBB format
 */
export function brightnessToColoredTint(brightness, baseColor = 0xffffff) {
  const clamped = Math.max(0, Math.min(1, brightness));

  // Extract base RGB
  const baseR = (baseColor >> 16) & 0xff;
  const baseG = (baseColor >> 8) & 0xff;
  const baseB = baseColor & 0xff;

  // Apply brightness
  const r = Math.round(baseR * clamped);
  const g = Math.round(baseG * clamped);
  const b = Math.round(baseB * clamped);

  return (r << 16) | (g << 8) | b;
}
