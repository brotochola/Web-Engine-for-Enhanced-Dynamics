// ============================================================================
// GAME ENGINE UTILITIES
// Shared utility functions for the multithreaded game engine
// ============================================================================

import { PHYSICS_DEFAULTS } from "./ConfigDefaults.js";
import { GameObject } from "./gameObject.js";

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

// ============================================================================
// RAY INTERSECTION UTILITIES
// Pure geometric functions - no object allocation, return distance or -1
// ============================================================================

/**
 * Ray-Circle intersection test
 * Returns distance to hit point, or -1 if no hit
 *
 * @param {number} rayX - Ray origin X
 * @param {number} rayY - Ray origin Y
 * @param {number} dirX - Normalized ray direction X
 * @param {number} dirY - Normalized ray direction Y
 * @param {number} circleX - Circle center X
 * @param {number} circleY - Circle center Y
 * @param {number} radius - Circle radius
 * @param {number} maxDist - Maximum ray distance
 * @returns {number} Distance to intersection, or -1 if no hit
 */
export function rayCircleIntersect(
  rayX,
  rayY,
  dirX,
  dirY,
  circleX,
  circleY,
  radius,
  maxDist
) {
  // Vector from ray origin to circle center
  const toCircleX = circleX - rayX;
  const toCircleY = circleY - rayY;

  // Project circle center onto ray
  const projection = toCircleX * dirX + toCircleY * dirY;

  // If projection is negative, circle is behind ray
  if (projection < 0) {
    return -1;
  }

  // Find closest point on ray to circle center
  const closestX = rayX + dirX * projection;
  const closestY = rayY + dirY * projection;

  // Distance from closest point to circle center
  const distX = circleX - closestX;
  const distY = circleY - closestY;
  const distSq = distX * distX + distY * distY;
  const radiusSq = radius * radius;

  // Check if ray intersects circle
  if (distSq > radiusSq) {
    return -1;
  }

  // Calculate intersection distance
  const halfChord = Math.sqrt(radiusSq - distSq);
  const distance = projection - halfChord;

  // Check if within max distance and not behind ray origin
  if (distance > maxDist || distance < 0) {
    return -1;
  }

  return distance;
}

/**
 * Ray-Circle hit test (fast path when distance not needed)
 * Returns true if ray hits circle, false otherwise
 *
 * @param {number} rayX - Ray origin X
 * @param {number} rayY - Ray origin Y
 * @param {number} dirX - Normalized ray direction X
 * @param {number} dirY - Normalized ray direction Y
 * @param {number} circleX - Circle center X
 * @param {number} circleY - Circle center Y
 * @param {number} radius - Circle radius
 * @param {number} maxDist - Maximum ray distance
 * @returns {boolean} True if hit, false otherwise
 */
export function rayCircleHit(
  rayX,
  rayY,
  dirX,
  dirY,
  circleX,
  circleY,
  radius,
  maxDist
) {
  return (
    rayCircleIntersect(
      rayX,
      rayY,
      dirX,
      dirY,
      circleX,
      circleY,
      radius,
      maxDist
    ) >= 0
  );
}

/**
 * Ray-Box (AABB) intersection test
 * Returns distance to hit point, or -1 if no hit
 *
 * @param {number} rayX - Ray origin X
 * @param {number} rayY - Ray origin Y
 * @param {number} dirX - Normalized ray direction X
 * @param {number} dirY - Normalized ray direction Y
 * @param {number} boxX - Box center X
 * @param {number} boxY - Box center Y
 * @param {number} width - Box width
 * @param {number} height - Box height
 * @param {number} maxDist - Maximum ray distance
 * @returns {number} Distance to intersection, or -1 if no hit
 */
export function rayBoxIntersect(
  rayX,
  rayY,
  dirX,
  dirY,
  boxX,
  boxY,
  width,
  height,
  maxDist
) {
  // Box bounds (assuming center-aligned)
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const minX = boxX - halfW;
  const maxX = boxX + halfW;
  const minY = boxY - halfH;
  const maxY = boxY + halfH;

  // Compute intersection distances for each axis
  const invDirX = dirX !== 0 ? 1 / dirX : Infinity;
  const invDirY = dirY !== 0 ? 1 / dirY : Infinity;

  const t1 = (minX - rayX) * invDirX;
  const t2 = (maxX - rayX) * invDirX;
  const t3 = (minY - rayY) * invDirY;
  const t4 = (maxY - rayY) * invDirY;

  const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4));
  const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4));

  // No intersection if tmax < 0 or tmin > tmax
  if (tmax < 0 || tmin > tmax) {
    return -1;
  }

  // Distance to intersection
  const distance = tmin >= 0 ? tmin : tmax;

  // Check if within max distance and not behind ray origin
  if (distance > maxDist || distance < 0) {
    return -1;
  }

  return distance;
}

/**
 * Ray-Box hit test (fast path when distance not needed)
 * Returns true if ray hits box, false otherwise
 *
 * @param {number} rayX - Ray origin X
 * @param {number} rayY - Ray origin Y
 * @param {number} dirX - Normalized ray direction X
 * @param {number} dirY - Normalized ray direction Y
 * @param {number} boxX - Box center X
 * @param {number} boxY - Box center Y
 * @param {number} width - Box width
 * @param {number} height - Box height
 * @param {number} maxDist - Maximum ray distance
 * @returns {boolean} True if hit, false otherwise
 */
export function rayBoxHit(
  rayX,
  rayY,
  dirX,
  dirY,
  boxX,
  boxY,
  width,
  height,
  maxDist
) {
  return (
    rayBoxIntersect(
      rayX,
      rayY,
      dirX,
      dirY,
      boxX,
      boxY,
      width,
      height,
      maxDist
    ) >= 0
  );
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
 * Generate a unique numeric key for an ordered pair using Cantor pairing function
 * Maps two natural numbers to a single unique natural number.
 * Used for collision tracking to avoid string allocation.
 *
 * Note: cantorPair(a, b) !== cantorPair(b, a) - the order matters!
 * For unordered pairs, ensure consistent ordering (e.g., always min first).
 *
 * @param {number} a - First number (must be non-negative integer)
 * @param {number} b - Second number (must be non-negative integer)
 * @returns {number} Unique numeric key
 *
 * @example
 *   const key = cantorPair(entityA, entityB);
 *   collisionSet.add(key);
 */
export function cantorPair(a, b) {
  return ((a + b) * (a + b + 1)) / 2 + b;
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
export function collectComponents(
  EntityClass,
  BaseClass = GameObject,
  DefaultComponent
) {
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
  // Handle null/undefined currentConfig (first initialization) - use centralized defaults
  const current = currentConfig || PHYSICS_DEFAULTS;
  return {
    subStepCount: Math.max(1, newConfig.subStepCount ?? current.subStepCount),
    boundaryElasticity: clamp01(
      newConfig.boundaryElasticity ?? current.boundaryElasticity,
      current.boundaryElasticity
    ),
    collisionResponseStrength: clamp01(
      newConfig.collisionResponseStrength ?? current.collisionResponseStrength,
      current.collisionResponseStrength
    ),
    verletDamping: clamp01(
      newConfig.verletDamping ?? current.verletDamping,
      current.verletDamping
    ),
    minSpeedForRotation:
      newConfig.minSpeedForRotation ?? current.minSpeedForRotation,
    gravity: {
      x:
        newConfig.gravity && typeof newConfig.gravity.x === "number"
          ? newConfig.gravity.x
          : current.gravity?.x ?? 0,
      y:
        newConfig.gravity && typeof newConfig.gravity.y === "number"
          ? newConfig.gravity.y
          : current.gravity?.y ?? 0,
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

/**
 * Query entities by component combination - wrapper that accesses globalThis.query
 * This allows entity code to use query() which gets initialized in workers
 * In worker context: globalThis.query is set by logic_worker, physics_worker, etc.
 *
 * @param {Array<Component>} componentClasses - Array of component classes to query
 * @returns {Int32Array} - Indices of entities that have ALL specified components
 *
 * @example
 * // Inside entity code (Prey.tick(), etc.):
 * const allPredators = query([RigidBody, PredatorBehavior]);
 * const visibleEntities = query([SpriteRenderer, Transform]);
 *
 * // Or via WEED namespace:
 * import WEED from "/src/index.js";
 * const entities = WEED.query([RigidBody, Collider]);
 */
export function query(componentClasses) {
  if (typeof globalThis.query === "function") {
    return globalThis.query(componentClasses);
  }

  // Not available in main thread context
  console.warn("[query] Query system only available in worker context");
  return new Int32Array(0);
}

// ============================================================================
// LIGHTING UTILITIES
// ============================================================================

/**
 * Calculate light contribution using capped inverse square falloff
 * Formula: intensity / (intensity + distance²)
 *
 * This formula ensures:
 * - Maximum attenuation is 1.0 at distance=0 (no white centers)
 * - Higher intensity = light reaches farther
 * - sqrt(intensity) = distance at which brightness is 50%
 *
 * @param {number} intensity - Light intensity (also controls reach)
 * @param {number} distanceSquared - Squared distance from light to target
 * @returns {number} Light contribution (0 to 1.0)
 */
export function calculateLightAttenuation(intensity, distanceSquared) {
  return intensity / (intensity + distanceSquared);
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

// ============================================================================
// TEXTURE GENERATION UTILITIES
// ============================================================================

/**
 * Create a circular gradient canvas for light glow effects
 * Generates a radial gradient from center (opaque) to edge (transparent)
 * with exponential falloff for realistic light attenuation
 *
 * @param {number} radius - Radius of the gradient circle (default: 100, so 200px diameter)
 * @param {number} color - Color in 0xRRGGBB format (default: white)
 * @returns {HTMLCanvasElement} Canvas with the gradient drawn
 */
export function createCircularGradientCanvas(radius = 100, color = 0xffffff) {
  radius = Math.round(radius);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const size = radius * 2;
  canvas.width = size;
  canvas.height = size;

  // Create radial gradient centered in canvas
  const gradient = ctx.createRadialGradient(
    radius,
    radius,
    0, // Inner circle (center)
    radius,
    radius,
    radius // Outer circle (edge)
  );

  // Extract RGB components
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;

  // Exponential falloff for realistic light attenuation
  // Uses 2^(1-i) for smooth falloff: 1.0 → 0.5 → 0.25 → 0.125 → ...
  const numStops = 50;
  for (let i = 1; i <= numStops; i++) {
    const alpha = Math.pow(2, 1 - i);
    gradient.addColorStop(i / numStops, `rgba(${r},${g},${b},${alpha})`);
  }

  // Fill with transparent background first
  ctx.fillStyle = "transparent";
  ctx.fillRect(0, 0, size, size);

  // Draw the gradient circle
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

export function convertRGBtoBGR(color) {
  const colorR = (color >> 16) & 0xff;
  const colorG = (color >> 8) & 0xff;
  const colorB = color & 0xff;
  return (colorB << 16) | (colorG << 8) | colorR;
}

/**
 * Load entity scripts dynamically and register them globally
 * Unified function used by both main thread and workers
 *
 * @param {Array<string>} scriptsToLoad - Array of script paths to load
 * @param {Object} globalContext - Global context to register classes (window for main thread, self for workers)
 * @param {boolean} verbose - Whether to log detailed information (optional)
 * @returns {Promise<Object>} - Object mapping class names to classes
 */
export async function loadEntityScripts(
  scriptsToLoad,
  globalContext = null,
  verbose = null
) {
  const loadedClasses = {};

  if (!scriptsToLoad || scriptsToLoad.length === 0) {
    return loadedClasses;
  }

  // Auto-detect context if not provided
  if (!globalContext) {
    globalContext = typeof window !== "undefined" ? window : self;
  }

  // Auto-detect verbosity if not specified (verbose in main thread, quiet in workers)
  if (verbose === null) {
    verbose = typeof window !== "undefined";
  }

  const contextName = typeof window !== "undefined" ? "Main Thread" : "Worker";

  if (verbose) {
    console.log(
      `📦 ${contextName}: Loading ${scriptsToLoad.length} entity scripts...`
    );
  }

  for (const scriptPath of scriptsToLoad) {
    try {
      const module = await import(scriptPath);

      // Make the exported class(es) available globally
      Object.keys(module).forEach((key) => {
        globalContext[key] = module[key];
        loadedClasses[key] = module[key];
        if (verbose) {
          console.log(`  ✓ Registered ${key} from ${scriptPath}`);
        }
      });
    } catch (error) {
      console.error(`  ✗ ${contextName}: Failed to load ${scriptPath}:`, error);
      console.error(`Error stack:`, error.stack);
    }
  }

  if (verbose) {
    console.log(
      `✅ ${contextName}: Loaded ${
        Object.keys(loadedClasses).length
      } entity classes globally`
    );
  }

  return loadedClasses;
}

// ============================================================================
// COMPONENT & ENTITY INITIALIZATION UTILITIES
// These functions unify component/entity initialization between Scene and Workers
// ============================================================================

/**
 * Collect all unique component classes from an array of registered entity classes
 * Works in both main thread (Scene) and workers
 *
 * @param {Array} registeredClasses - Array of { class, name, ... } objects
 * @param {Object} globalRef - Global reference (window or self) to look up classes by name
 * @returns {Map<string, Class>} Map of componentName -> ComponentClass
 */
export function collectAllComponentsFromClasses(registeredClasses, globalRef) {
  const componentClasses = new Map();

  if (!registeredClasses || registeredClasses.length === 0) {
    return componentClasses;
  }

  for (const classInfo of registeredClasses) {
    // Get EntityClass - either directly from classInfo.class or from global reference
    const EntityClass = classInfo.class || globalRef[classInfo.name];
    if (!EntityClass) continue;

    // Use GameObject's static method to collect components (handles inheritance)
    const components = GameObject._collectComponents(EntityClass);
    for (const ComponentClass of components) {
      componentClasses.set(ComponentClass.name, ComponentClass);
    }
  }

  return componentClasses;
}

/**
 * Initialize component array views from SharedArrayBuffers
 * Creates typed array views over SABs for each component
 *
 * @param {Map<string, Class>} componentMap - Map of componentName -> ComponentClass
 * @param {Object} componentBuffers - Object containing SABs: { componentName: SharedArrayBuffer }
 * @param {Object} componentPools - Object containing pool info: { componentName: { count, componentId } }
 * @param {number} defaultEntityCount - Default entity count if pool.count is not set
 * @returns {number} Number of components successfully initialized
 */
export function initializeComponentViews(
  componentMap,
  componentBuffers,
  componentPools,
  defaultEntityCount
) {
  let initializedCount = 0;

  for (const [componentName, ComponentClass] of componentMap) {
    const pool = componentPools?.[componentName];
    const buffer = componentBuffers?.[componentName];

    // Assign componentId from pool data
    if (pool && pool.componentId !== undefined) {
      ComponentClass.componentId = pool.componentId;
    }

    // Initialize SharedArrayBuffer connection if data is available
    if (buffer) {
      const count = pool?.count || defaultEntityCount;
      if (count > 0) {
        ComponentClass.initializeArrays(buffer, count);
        initializedCount++;
      }
    }
  }

  return initializedCount;
}

/**
 * Expose component classes globally for easy access
 *
 * @param {Map<string, Class>} componentMap - Map of componentName -> ComponentClass
 * @param {Object} globalRef - Global reference (window or self)
 */
export function exposeComponentsGlobally(componentMap, globalRef) {
  for (const [componentName, ComponentClass] of componentMap) {
    globalRef[componentName] = ComponentClass;
  }
}

/**
 * Expose entity classes globally for easy access
 *
 * @param {Array} registeredClasses - Array of { class, name, ... } objects
 * @param {Object} globalRef - Global reference (window or self)
 * @returns {Array<string>} Array of exposed class names
 */
export function exposeEntityClassesGlobally(registeredClasses, globalRef) {
  const exposedNames = [];

  for (const classInfo of registeredClasses) {
    const EntityClass = classInfo.class || globalRef[classInfo.name];
    if (!EntityClass) continue;

    const className = EntityClass.name;
    globalRef[className] = EntityClass;
    exposedNames.push(className);
  }

  return exposedNames;
}

// ============================================================================
// DEBUG DRAWING UTILITIES
// Helper functions for debug visualization in PixiJS
// ============================================================================

/**
 * Draw a debug line on a PIXI Graphics layer
 * Can optionally draw a dashed "remainder" portion after a hit point
 *
 * @param {PIXI.Graphics} graphics - The Graphics layer to draw on
 * @param {Object} options - Drawing options:
 *   - startX, startY: Line start position
 *   - endX, endY: Line end position
 *   - color: Line color (hex, e.g. 0x00ff00)
 *   - alpha: Line alpha (0-1)
 *   - width: Line width (will be scaled by zoom)
 *   - zoom: Camera zoom level (for consistent line width)
 *   - dashed: If true, draw as dashed line
 *   - dashLength: Length of each dash (default 10)
 */
export function drawLine(graphics, options) {
  const {
    startX,
    startY,
    endX,
    endY,
    color = 0xffffff,
    alpha = 1.0,
    width = 1,
    zoom = 1,
    dashed = false,
    dashLength = 10,
  } = options;

  const scaledWidth = width / zoom;

  if (!dashed) {
    // Solid line
    graphics
      .moveTo(startX, startY)
      .lineTo(endX, endY)
      .stroke({ width: scaledWidth, color, alpha });
  } else {
    // Dashed line
    const dx = endX - startX;
    const dy = endY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const segments = Math.ceil(dist / dashLength);
    const stepX = dx / segments;
    const stepY = dy / segments;

    for (let s = 0; s < segments; s += 2) {
      const x1 = startX + stepX * s;
      const y1 = startY + stepY * s;
      const x2 = startX + stepX * Math.min(s + 1, segments);
      const y2 = startY + stepY * Math.min(s + 1, segments);

      graphics
        .moveTo(x1, y1)
        .lineTo(x2, y2)
        .stroke({ width: scaledWidth, color, alpha });
    }
  }
}

/**
 * Draw a debug circle on a PIXI Graphics layer
 *
 * @param {PIXI.Graphics} graphics - The Graphics layer to draw on
 * @param {Object} options - Drawing options:
 *   - x, y: Circle center position
 *   - radius: Circle radius
 *   - color: Fill/stroke color (hex)
 *   - alpha: Alpha (0-1)
 *   - zoom: Camera zoom level (for consistent size)
 *   - fill: If true, fill the circle (default true)
 *   - stroke: If true, stroke the circle (default false)
 *   - strokeWidth: Stroke width (default 1)
 */
export function drawCircle(graphics, options) {
  const {
    x,
    y,
    radius,
    color = 0xffffff,
    alpha = 1.0,
    zoom = 1,
    fill = true,
    stroke = false,
    strokeWidth = 1,
  } = options;

  const scaledRadius = radius / zoom;

  graphics.circle(x, y, scaledRadius);

  if (fill) {
    graphics.fill({ color, alpha });
  }
  if (stroke) {
    graphics.stroke({ width: strokeWidth / zoom, color, alpha });
  }
}

/**
 * Draw a debug cross marker on a PIXI Graphics layer
 *
 * @param {PIXI.Graphics} graphics - The Graphics layer to draw on
 * @param {Object} options - Drawing options:
 *   - x, y: Cross center position
 *   - size: Cross arm length
 *   - color: Line color (hex)
 *   - alpha: Alpha (0-1)
 *   - width: Line width
 *   - zoom: Camera zoom level
 */
export function drawCross(graphics, options) {
  const {
    x,
    y,
    size = 8,
    color = 0xffffff,
    alpha = 1.0,
    width = 2,
    zoom = 1,
  } = options;

  const scaledSize = size / zoom;
  const scaledWidth = width / zoom;

  graphics
    .moveTo(x - scaledSize, y)
    .lineTo(x + scaledSize, y)
    .stroke({ width: scaledWidth, color, alpha });
  graphics
    .moveTo(x, y - scaledSize)
    .lineTo(x, y + scaledSize)
    .stroke({ width: scaledWidth, color, alpha });
}

export function printLogo() {
  console.log(
    `%c
  +%                                           :  
  *@             .                            +@- 
  #@            #@                             @# 
  #@            @%     -***:   :*@@@@@-        %% 
  @%            @#   :%@#*@@  +@%=:::@*        #% 
  @*      :    :@+  .@@. =@+ +@+   .#@-    ..  %% 
  @*     =@+   =@   @@  *@#  @@ .-*@@-   -%@@#-@* 
  @*    .@@=   @%  -@+-@@=   @@@@@#=    +@#:-%@@- 
  @#    =@@=  =@:  @@%@*    +@-:.      -@+   .@@: 
  %%   .@@@= .@%  .@@+.   : *@.        *@.    %@. 
  *@  .%@+@= #@:  :@.    =@##@.      =+*@.    %@::
  -@%*@@:.@@%@-   .@*-=*@@* :@:   .=%@*:@@=:.:@@@%
   :**+.  :+*:     =%@@#=    %@%%@@@+.  .+@@@@%*- 
                      :+=     :==-:         .     
                 :=*#@@@+   =#%@@@@%              
             =+#@@@@+-.    @@*=----.              
            :%#+-..@%     @@.                     
                   +@:    @@                      
                    @@    @@-.   ..:.             
                    :@:   .#@@@@@@@@@             
                     @%      .:::=@@:             
              .%=    @%      -=*@@#:              
               +@@*-:@@   -%@@%#=.                
                 =#@@%-   =*-                     
 
%c
🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿
🌿🏵️🌿🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼                                    🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼              WeedJS                🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼  Web Engine for Enhanced Dynamics  🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼                                    🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌼🌺🌿🏵️🌿
🌿🏵️🌿🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌺🌿🏵️🌿
🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿
  `,
    `font-family: monospace; 
       font-size: 12px; 
       background: linear-gradient(135deg, #0f0 0%, #ff4 25%, #0f0 50%, #ff0 75%, #0f0 100%);
       -webkit-background-clip: text;
       -webkit-text-fill-color: transparent;
       background-clip: text;
       font-weight: 100;`,

    `font-family: monospace; 
       font-size: 10px;   
       font-weight: 100;`
  );
}
