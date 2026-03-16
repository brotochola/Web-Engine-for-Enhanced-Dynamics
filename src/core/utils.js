// ============================================================================
// GAME ENGINE UTILITIES
// Shared utility functions for the multithreaded game engine
// ============================================================================

import { PHYSICS_DEFAULTS } from './ConfigDefaults.js';
import { GameObject } from './gameObject.js';

// ============================================================================
// MATH UTILITIES
// ============================================================================

/**
 * Convert an array of layer indices (0-31) into a 32-bit bitmask.
 * @param {number[]} layers - e.g. [0, 4, 12, 15]
 * @returns {number} Uint32 bitmask with those bits set
 */
export function layerMask(layers) {
  let mask = 0;
  for (let i = 0; i < layers.length; i++) {
    mask |= (1 << (layers[i] & 31));
  }
  return mask >>> 0;
}

/**
 * Count trailing zeros in BigInt (position of lowest set bit)
 * OPTIMIZED: Binary search approach - O(log n) instead of O(n)
 * Uses bitmask checks to halve search space each step (max 6 checks)
 * @param {bigint} n - BigInt value to check
 * @returns {number} Number of trailing zeros (0-64)
 */
export function countTrailingZeros(n) {
  if (n === 0n) return 64;
  let count = 0;
  // Binary search: check larger chunks first, halving search space each step
  if ((n & 0xFFFFFFFFn) === 0n) { count += 32; n >>= 32n; }
  if ((n & 0xFFFFn) === 0n) { count += 16; n >>= 16n; }
  if ((n & 0xFFn) === 0n) { count += 8; n >>= 8n; }
  if ((n & 0xFn) === 0n) { count += 4; n >>= 4n; }
  if ((n & 0x3n) === 0n) { count += 2; n >>= 2n; }
  if ((n & 0x1n) === 0n) { count += 1; }
  return count;
}

/**
 * Binary search for range [start, end) in sorted array with count at index 0
 * Used by query system to find entity indices in a given pool range
 * @param {TypedArray} data - Sorted array with count at index 0
 * @param {number} start - Range start (inclusive)
 * @param {number} end - Range end (exclusive)
 * @returns {TypedArray} Subarray view of elements in range
 */
export function binarySearchRange(data, start, end) {
  const totalCount = data[0];
  if (totalCount === 0) return data.subarray(1, 1);

  let lo = 1;
  let hi = 1 + totalCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;

  hi = 1 + totalCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid] < end) lo = mid + 1;
    else hi = mid;
  }
  const last = lo;

  return data.subarray(first, last);
}

/**
 * Binary search to find insertion point for sorted insert
 * Returns the index where value should be inserted to maintain sorted order
 * @param {TypedArray} data - The array (layout: [count, idx0, idx1, ...])
 * @param {number} value - The value to insert
 * @param {number} count - Number of elements (data[0])
 * @returns {number} Insertion index (1-based, into data array)
 */
export function binarySearchInsertPoint(data, value, count) {
  let lo = 1;
  let hi = count + 1;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/**
 * Binary search to find an element in a sorted array
 * @param {TypedArray} data - The array (layout: [count, idx0, idx1, ...])
 * @param {number} value - The value to find
 * @param {number} count - Number of elements (data[0])
 * @returns {number} Index where found (1-based), or -1 if not found
 */
export function binarySearchFind(data, value, count) {
  let lo = 1;
  let hi = count;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = data[mid];
    if (val === value) {
      return mid;
    } else if (val < value) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return -1;
}

/**
 * Format a number with underscore thousand separators
 * OPTIMIZED: No regex, no allocations for common cases
 * @param {number} num - Number to format
 * @param {string} fallback - Fallback string for invalid numbers (default: "--")
 * @returns {string} Formatted number (e.g., "1_000_000")
 */
export function formatNumber(num, fallback = '--') {
  if (num === null || num === undefined || num !== num) return fallback; // num !== num is faster isNaN check
  const n = (num + 0.5) | 0; // Fast Math.round for positive numbers
  if (n < 1000) return String(n);
  if (n < 10000) return String((n / 1000) | 0) + '_' + String(n % 1000).padStart(3, '0');
  if (n < 100000) return String((n / 1000) | 0) + '_' + String(n % 1000).padStart(3, '0');
  if (n < 1000000) return String((n / 1000) | 0) + '_' + String(n % 1000).padStart(3, '0');
  // For millions+
  const millions = (n / 1000000) | 0;
  const thousands = ((n % 1000000) / 1000) | 0;
  const ones = n % 1000;
  return (
    String(millions) +
    '_' +
    String(thousands).padStart(3, '0') +
    '_' +
    String(ones).padStart(3, '0')
  );
}

/**
 * Clamp a value between 0 and 1
 * @param {number} value - The value to clamp
 * @param {number} fallback - Fallback value if input is invalid
 * @returns {number} Clamped value
 */
export function clamp01(value, fallback) {
  if (typeof value !== 'number') return fallback;
  return Math.max(0, Math.min(1, value));
}

/**
 * Clamp a value between 0 and 1 (fast path - no type checking)
 * OPTIMIZED: Assumes value is already a number, uses ternary instead of Math.min/max
 * Use this in hot loops where you know the input is always a valid number
 * @param {number} value - The value to clamp (must be a number)
 * @returns {number} Clamped value
 */
export function clamp01Fast(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
 * Compute screen-space camera bounds (with culling margin) into a reusable object.
 * Result shape: { zoom, cameraOffsetX, cameraOffsetY, minX, maxX, minY, maxY }.
 */
export function calculateCameraScreenBounds(
  zoom,
  cameraX,
  cameraY,
  canvasWidth,
  canvasHeight,
  cullingRatio,
  result
) {
  const cameraOffsetX = cameraX * zoom;
  const cameraOffsetY = cameraY * zoom;
  const marginX = canvasWidth * cullingRatio;
  const marginY = canvasHeight * cullingRatio;

  result.zoom = zoom;
  result.cameraOffsetX = cameraOffsetX;
  result.cameraOffsetY = cameraOffsetY;
  result.minX = -marginX;
  result.maxX = canvasWidth + marginX;
  result.minY = -marginY;
  result.maxY = canvasHeight + marginY;
  return result;
}

/**
 * Convert screen-space camera bounds to world-space bounds.
 * Optional world margins are applied after conversion.
 * Result shape: { minX, maxX, minY, maxY }.
 */
export function screenBoundsToWorldBounds(screenBounds, worldMarginX = 0, worldMarginY = 0, result) {
  const invZoom = 1 / screenBounds.zoom;
  result.minX = (screenBounds.minX + screenBounds.cameraOffsetX) * invZoom - worldMarginX;
  result.maxX = (screenBounds.maxX + screenBounds.cameraOffsetX) * invZoom + worldMarginX;
  result.minY = (screenBounds.minY + screenBounds.cameraOffsetY) * invZoom - worldMarginY;
  result.maxY = (screenBounds.maxY + screenBounds.cameraOffsetY) * invZoom + worldMarginY;
  return result;
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
export function rayCircleIntersect(rayX, rayY, dirX, dirY, circleX, circleY, radius, maxDist) {
  // Vector from ray origin to circle center
  const toCircleX = circleX - rayX;
  const toCircleY = circleY - rayY;

  // OPTIMIZATION: Early exit if circle is too far to possibly intersect
  // This avoids the more expensive projection/sqrt calculations for distant objects
  const distToCircleSq = toCircleX * toCircleX + toCircleY * toCircleY;
  const maxPossibleDist = maxDist + radius;
  if (distToCircleSq > maxPossibleDist * maxPossibleDist) {
    return -1;
  }

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
export function rayCircleHit(rayX, rayY, dirX, dirY, circleX, circleY, radius, maxDist) {
  return rayCircleIntersect(rayX, rayY, dirX, dirY, circleX, circleY, radius, maxDist) >= 0;
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
export function rayBoxIntersect(rayX, rayY, dirX, dirY, boxX, boxY, width, height, maxDist) {
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
export function rayBoxHit(rayX, rayY, dirX, dirY, boxX, boxY, width, height, maxDist) {
  return rayBoxIntersect(rayX, rayY, dirX, dirY, boxX, boxY, width, height, maxDist) >= 0;
}

/**
 * Resolve a value that can be a number or { min, max } range
 * @param {number|{min:number, max:number}} value - Value or range
 * @param {number} defaultVal - Default if value is undefined
 * @returns {number} - Resolved value (randomized if range)
 */
export function randomRange(value, defaultVal = 0) {
  if (value === undefined || value === null) return defaultVal;
  if (typeof value === 'number') return value;
  // { min, max } object - return random value in range
  const min = value.min ?? defaultVal;
  const max = value.max ?? defaultVal;
  return min + rng() * (max - min);
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
  if (typeof value === 'number') return value;

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
  const t = rng();

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
  return (x2 - x1) ** 2 + (y2 - y1) ** 2;
}

/**
 * Normalize a 2D direction vector (make it unit length)
 * Mutates the result object to avoid GC pressure
 *
 * @param {number} dx - X component
 * @param {number} dy - Y component
 * @param {Object} result - Result object to mutate {x, y, length}
 * @returns {Object} The result object with normalized x, y and original length
 *
 * @example
 *   const dir = { x: 0, y: 0, length: 0 };
 *   normalizeDirection(targetX - sourceX, targetY - sourceY, dir);
 *   // dir.x and dir.y are now unit length, dir.length has original magnitude
 */
export function normalizeDirection(dx, dy, result) {
  const length = Math.sqrt(dx * dx + dy * dy);
  result.length = length;

  if (length === 0) {
    result.x = 0;
    result.y = 0;
  } else {
    result.x = dx / length;
    result.y = dy / length;
  }

  return result;
}

/**
 * Normalize a 2D direction vector - FAST version (no zero-length check)
 * OPTIMIZED: Skips the zero-length check for cases where you KNOW the vector is non-zero
 * Use this in hot paths where division by zero is impossible (e.g., after distance check)
 *
 * WARNING: Will produce NaN/Infinity if dx=dy=0. Only use when you're certain length > 0
 *
 * @param {number} dx - X component (must not be zero if dy is also zero)
 * @param {number} dy - Y component (must not be zero if dx is also zero)
 * @param {Object} result - Result object to mutate {x, y, length}
 * @returns {Object} The result object with normalized x, y and original length
 */
export function normalizeDirectionFast(dx, dy, result) {
  const length = Math.sqrt(dx * dx + dy * dy);
  const invLength = 1 / length; // Single division, two multiplications (faster)
  result.length = length;
  result.x = dx * invLength;
  result.y = dy * invLength;
  return result;
}

/**
 * Normalize a 2D direction vector using pre-calculated squared distance
 * OPTIMIZED: Avoids recalculating dx² + dy² when you already have distSq
 * Use this when you already have distSq from distanceSq2D or inline calculation
 *
 * @param {number} dx - X component
 * @param {number} dy - Y component
 * @param {number} distSq - Pre-calculated squared distance (dx² + dy²)
 * @param {Object} result - Result object to mutate {x, y, length}
 * @returns {Object} The result object with normalized x, y and original length
 */
export function normalizeDirectionFromDistSq(dx, dy, distSq, result) {
  const length = Math.sqrt(distSq);
  const invLength = 1 / length; // Single division, two multiplications (faster)
  result.length = length;
  result.x = dx * invLength;
  result.y = dy * invLength;
  return result;
}

/**
 * Get normalized direction from point A to point B
 * Convenience wrapper for normalizeDirection
 *
 * @param {number} x1 - Source X
 * @param {number} y1 - Source Y
 * @param {number} x2 - Target X
 * @param {number} y2 - Target Y
 * @param {Object} result - Result object to mutate {x, y, length}
 * @returns {Object} The result object
 */
export function directionTo(x1, y1, x2, y2, result) {
  return normalizeDirection(x2 - x1, y2 - y1, result);
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
 * Inverse of Cantor pairing function - recovers (a, b) from a Cantor key
 * ZERO ALLOCATION: Mutates the result object instead of creating a new one
 * Used for collision exit events to recover entity IDs without a lookup Map
 *
 * Mathematical inverse:
 * - w = floor((sqrt(8z + 1) - 1) / 2)
 * - t = (w² + w) / 2
 * - b = z - t
 * - a = w - b
 *
 * @param {number} z - Cantor pairing key (from cantorPair)
 * @param {Object} result - Result object to mutate {a, b}
 * @returns {Object} The result object with recovered values
 *
 * @example
 *   const result = { a: 0, b: 0 };
 *   cantorUnpair(key, result);
 *   // result.a and result.b now contain the original values
 */
export function cantorUnpair(z, result) {
  // w = floor((sqrt(8z + 1) - 1) / 2)
  const w = ((Math.sqrt(8 * z + 1) - 1) / 2) | 0;
  // t = (w² + w) / 2 = triangular number
  const t = (w * w + w) / 2;
  result.b = z - t;
  result.a = w - result.b;
  return result;
}

// Pre-allocated result object for cantorUnpair (zero GC in hot paths)
export const _cantorResult = { a: 0, b: 0 };

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

/**
 * Check if distance between two points is within a range
 * OPTIMIZED: Uses squared distance comparison to avoid sqrt
 * This is faster than: distance2D(x1, y1, x2, y2) <= range
 *
 * @param {number} x1 - First point X
 * @param {number} y1 - First point Y
 * @param {number} x2 - Second point X
 * @param {number} y2 - Second point Y
 * @param {number} range - Maximum distance to check
 * @returns {boolean} True if distance <= range
 */
export function isWithinRange(x1, y1, x2, y2, range) {
  return distanceSq2D(x1, y1, x2, y2) <= range * range;
}

/**
 * Check if distance between two points is within a range (squared version)
 * OPTIMIZED: When you already have rangeSq precomputed (e.g., in a loop)
 *
 * @param {number} x1 - First point X
 * @param {number} y1 - First point Y
 * @param {number} x2 - Second point X
 * @param {number} y2 - Second point Y
 * @param {number} rangeSq - Maximum distance SQUARED to check
 * @returns {boolean} True if distanceSq <= rangeSq
 */
export function isWithinRangeSq(x1, y1, x2, y2, rangeSq) {
  return distanceSq2D(x1, y1, x2, y2) <= rangeSq;
}

/**
 * Apply brightness multiplier to a color while preserving hue
 * OPTIMIZED: Inlines RGB extraction to avoid function call + object allocation
 * Uses bitwise ops instead of Math.round for speed
 * @param {number} color - Original color in 0xRRGGBB format
 * @param {number} brightness - Brightness multiplier (0 to 1+)
 * @returns {number} Lit color in 0xRRGGBB format
 */
export function applyBrightnessToColor(color, brightness) {
  // Clamp brightness to prevent over-saturation
  const b = brightness > 1.0 ? 1.0 : brightness;

  // OPTIMIZED: Inline RGB extraction instead of calling extractRGB()
  // This avoids both the function call overhead and object allocation
  // Bitwise truncation (| 0) is faster than Math.round
  const litR = (((color >> 16) & 0xff) * b) | 0;
  const litG = (((color >> 8) & 0xff) * b) | 0;
  const litB = ((color & 0xff) * b) | 0;

  return (litR << 16) | (litG << 8) | litB;
}

// ============================================================================
// COLLISION/GEOMETRY UTILITIES
// ============================================================================

// ============================================================================
// PRE-ALLOCATED RESULT OBJECTS (for zero-GC hot paths)
// These can be reused across frames to avoid garbage collection pressure.
// WARNING: Not thread-safe - use separate instances per worker if needed.
//
// Usage example:
//   import { testCircleCircleCollision, _collisionResult } from './utils.js';
//
//   // In hot loop - zero allocations per iteration
//   for (const entity of entities) {
//     if (testCircleCircleCollision(x1, y1, r1, x2, y2, r2, _collisionResult)) {
//       // use _collisionResult.depth, _collisionResult.nx, etc.
//     }
//   }
//
// For multi-threaded scenarios, create your own result objects:
//   const myResult = { collided: false, depth: 0, nx: 0, ny: 0 };
// ============================================================================
export const _collisionResult = { collided: false, depth: 0, nx: 0, ny: 0 };
export const _directionResult = { x: 0, y: 0, length: 0 };
export const _velocityResult = { vx: 0, vy: 0 };
export const _cellResult = { col: 0, row: 0 };
export const _pointResult = { x: 0, y: 0 };
export const _rgbResult = { r: 0, g: 0, b: 0 };

/**
 * Find the closest point on an AABB (Axis-Aligned Bounding Box) to a given point
 * NOTE: Allocates a new object - use closestPointOnAABBMut() in hot paths
 * @param {number} pointX - Point X coordinate
 * @param {number} pointY - Point Y coordinate
 * @param {number} boxX - Box center X
 * @param {number} boxY - Box center Y
 * @param {number} boxW - Box width
 * @param {number} boxH - Box height
 * @returns {Object} Closest point {x, y} on the AABB
 */
export function closestPointOnAABB(pointX, pointY, boxX, boxY, boxW, boxH) {
  const halfW = boxW * 0.5;
  const halfH = boxH * 0.5;
  return {
    x: Math.max(boxX - halfW, Math.min(pointX, boxX + halfW)),
    y: Math.max(boxY - halfH, Math.min(pointY, boxY + halfH)),
  };
}

/**
 * Find the closest point on an AABB - ZERO ALLOCATION version
 * OPTIMIZED: Mutates result object instead of allocating
 * @param {number} pointX - Point X coordinate
 * @param {number} pointY - Point Y coordinate
 * @param {number} boxX - Box center X
 * @param {number} boxY - Box center Y
 * @param {number} boxW - Box width
 * @param {number} boxH - Box height
 * @param {Object} result - Result object to mutate {x, y}
 * @returns {Object} The result object with closest point
 */
export function closestPointOnAABBMut(pointX, pointY, boxX, boxY, boxW, boxH, result) {
  const halfW = boxW * 0.5;
  const halfH = boxH * 0.5;
  result.x = Math.max(boxX - halfW, Math.min(pointX, boxX + halfW));
  result.y = Math.max(boxY - halfH, Math.min(pointY, boxY + halfH));
  return result;
}

/**
 * Clamp velocity vector to a maximum speed
 * NOTE: Allocates a new object - use clampVelocityMut() in hot paths
 * @param {number} vx - Velocity X component
 * @param {number} vy - Velocity Y component
 * @param {number} maxSpeed - Maximum speed (magnitude)
 * @returns {Object} Clamped velocity {vx, vy}
 */
export function clampVelocity(vx, vy, maxSpeed) {
  const speedSquared = vx * vx + vy * vy;
  const maxSpeedSquared = maxSpeed * maxSpeed;

  if (speedSquared > maxSpeedSquared) {
    const velScale = maxSpeed / Math.sqrt(speedSquared);
    return {
      vx: vx * velScale,
      vy: vy * velScale,
    };
  }

  return { vx, vy };
}

/**
 * Clamp velocity vector to a maximum speed - ZERO ALLOCATION version
 * OPTIMIZED: Mutates result object instead of allocating
 * @param {number} vx - Velocity X component
 * @param {number} vy - Velocity Y component
 * @param {number} maxSpeed - Maximum speed (magnitude)
 * @param {Object} result - Result object to mutate {vx, vy}
 * @returns {Object} The result object with clamped velocity
 */
export function clampVelocityMut(vx, vy, maxSpeed, result) {
  const speedSquared = vx * vx + vy * vy;
  const maxSpeedSquared = maxSpeed * maxSpeed;

  if (speedSquared > maxSpeedSquared) {
    const velScale = maxSpeed / Math.sqrt(speedSquared);
    result.vx = vx * velScale;
    result.vy = vy * velScale;
  } else {
    result.vx = vx;
    result.vy = vy;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASS COMPUTATION UTILITIES
// Used by Collider component to auto-compute mass when radius/width/height change.
// Mass is derived from collider area (2D surface), enabling mass-weighted physics.
//
// Why area-based mass?
// - Simple and intuitive: bigger objects = more mass
// - Works well for 2D games where "volume" isn't meaningful
// - Easily computed from existing collider dimensions
//
// How it's used in physics (physics_worker.js):
// - invMass (inverse mass) determines how much an object moves when hit
// - Light objects (high invMass) bounce off heavy objects
// - Heavy objects (low invMass) barely move when hit by light objects
// - Static objects have invMass = 0 (infinite mass, never move)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute mass from circle radius (area = π * r²)
 * @param {number} radius - Circle radius
 * @returns {number} Mass value (area in square units)
 */
export function computeCircleMass(radius) {
  return Math.PI * radius * radius;
}

/**
 * Compute mass from box dimensions (area = width * height)
 * @param {number} width - Box width
 * @param {number} height - Box height
 * @returns {number} Mass value (area in square units)
 */
export function computeBoxMass(width, height) {
  return width * height;
}

/**
 * Update RigidBody mass arrays from circle radius
 * Called by Collider.radius setter to auto-compute mass when radius changes.
 *
 * @param {number} index - Entity index in component arrays
 * @param {number} radius - Circle radius
 * @param {Object} RigidBody - RigidBody component class with mass/invMass arrays
 *
 * @example
 *   // In Collider.js radius setter:
 *   updateMassFromCircle(this.index, value, RigidBody);
 */
export function updateMassFromCircle(index, radius, RigidBody) {
  if (radius > 0) {
    const mass = Math.PI * radius * radius;
    RigidBody.mass[index] = mass;
    RigidBody.invMass[index] = 1 / mass;
  }
}

/**
 * Update RigidBody mass arrays from box dimensions
 * Called by Collider.width/height setters to auto-compute mass when size changes.
 *
 * @param {number} index - Entity index in component arrays
 * @param {number} width - Box width
 * @param {number} height - Box height
 * @param {Object} RigidBody - RigidBody component class with mass/invMass arrays
 *
 * @example
 *   // In Collider.js width setter:
 *   updateMassFromBox(this.index, value, existingHeight, RigidBody);
 */
export function updateMassFromBox(index, width, height, RigidBody) {
  if (width > 0 && height > 0) {
    const mass = width * height;
    RigidBody.mass[index] = mass;
    RigidBody.invMass[index] = 1 / mass;
  }
}

export function mixTint(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;

  const r = Math.round(ar + (br - ar) * clamped);
  const g = Math.round(ag + (bg - ag) * clamped);
  const bCh = Math.round(ab + (bb - ab) * clamped);
  return (r << 16) | (g << 8) | bCh;
}

/**
 * Test Circle vs Circle collision
 * Mutates the result object to avoid GC pressure (reuse same object in hot loops)
 * @param {number} x1 - First circle center X
 * @param {number} y1 - First circle center Y
 * @param {number} r1 - First circle radius
 * @param {number} x2 - Second circle center X
 * @param {number} y2 - Second circle center Y
 * @param {number} r2 - Second circle radius
 * @param {Object} result - Result object to mutate {collided, depth, nx, ny}
 * @returns {Object|null} Result object if collision, null if no collision
 */
export function testCircleCircleCollision(x1, y1, r1, x2, y2, r2, result) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  // DOT PRODUCT OPTIMIZATION: |v|² = v · v = dx² + dy²
  // Avoids redundant recomputation of dx, dy inside distanceSq2D()
  const dist2 = dx * dx + dy * dy;
  const minDist = r1 + r2;

  if (dist2 >= minDist * minDist) return null;

  const dist = Math.sqrt(dist2);

  // Mutate result object to avoid GC pressure
  result.collided = true;

  // Handle exact overlap
  if (dist === 0) {
    // Use random angle for exact overlap
    // rng() is available globally in workers, fallback to Math.random
    const rngFn =
      typeof globalThis !== 'undefined' && typeof globalThis.rng === 'function'
        ? globalThis.rng
        : Math.random;
    const angle = rngFn() * Math.PI * 2;
    result.depth = minDist;
    result.nx = Math.cos(angle);
    result.ny = Math.sin(angle);
  } else {
    result.depth = minDist - dist;
    result.nx = dx / dist;
    result.ny = dy / dist;
  }

  return result;
}

/**
 * Test Circle vs AABB collision
 * OPTIMIZED: Inlines closest point calculation to avoid function call + allocation
 * Mutates the result object to avoid GC pressure (reuse same object in hot loops)
 * @param {number} circleX - Circle center X
 * @param {number} circleY - Circle center Y
 * @param {number} circleR - Circle radius
 * @param {number} boxX - Box center X
 * @param {number} boxY - Box center Y
 * @param {number} boxW - Box width
 * @param {number} boxH - Box height
 * @param {Object} result - Result object to mutate {collided, depth, nx, ny}
 * @returns {Object|null} Result object if collision, null if no collision
 */
export function testCircleAABBCollision(circleX, circleY, circleR, boxX, boxY, boxW, boxH, result) {
  const halfW = boxW * 0.5;
  const halfH = boxH * 0.5;

  // OPTIMIZED: Inline closest point calculation instead of calling closestPointOnAABB()
  // This avoids both the function call overhead and object allocation
  const minX = boxX - halfW;
  const maxX = boxX + halfW;
  const minY = boxY - halfH;
  const maxY = boxY + halfH;
  const closestX = circleX < minX ? minX : circleX > maxX ? maxX : circleX;
  const closestY = circleY < minY ? minY : circleY > maxY ? maxY : circleY;

  // Calculate distance from circle center to closest point
  const dx = circleX - closestX;
  const dy = circleY - closestY;
  // DOT PRODUCT OPTIMIZATION: |v|² = v · v = dx² + dy²
  // Avoids redundant recomputation of dx, dy inside distanceSq2D()
  const dist2 = dx * dx + dy * dy;

  if (dist2 >= circleR * circleR) return null;

  const dist = Math.sqrt(dist2);

  // Mutate result object to avoid GC pressure
  result.collided = true;

  // Circle center is inside the box
  if (dist === 0) {
    // Find which edge is closest
    const distToLeft = circleX - minX;
    const distToRight = maxX - circleX;
    const distToTop = circleY - minY;
    const distToBottom = maxY - circleY;

    const minDistX = distToLeft < distToRight ? distToLeft : distToRight;
    const minDistY = distToTop < distToBottom ? distToTop : distToBottom;

    if (minDistX < minDistY) {
      // Push horizontally
      result.depth = minDistX + circleR;
      result.nx = distToLeft < distToRight ? -1 : 1;
      result.ny = 0;
    } else {
      // Push vertically
      result.depth = minDistY + circleR;
      result.nx = 0;
      result.ny = distToTop < distToBottom ? -1 : 1;
    }
  } else {
    result.depth = circleR - dist;
    result.nx = dx / dist;
    result.ny = dy / dist;
  }

  return result;
}

/**
 * Test AABB vs AABB collision
 * Mutates the result object to avoid GC pressure (reuse same object in hot loops)
 * @param {number} x1 - First box center X
 * @param {number} y1 - First box center Y
 * @param {number} w1 - First box width
 * @param {number} h1 - First box height
 * @param {number} x2 - Second box center X
 * @param {number} y2 - Second box center Y
 * @param {number} w2 - Second box width
 * @param {number} h2 - Second box height
 * @param {Object} result - Result object to mutate {collided, depth, nx, ny}
 * @returns {Object|null} Result object if collision, null if no collision
 */
export function testAABBAABBCollision(x1, y1, w1, h1, x2, y2, w2, h2, result) {
  const halfW1 = w1 * 0.5;
  const halfH1 = h1 * 0.5;
  const halfW2 = w2 * 0.5;
  const halfH2 = h2 * 0.5;

  // Calculate overlap on each axis
  const dx = x1 - x2;
  const dy = y1 - y2;

  const overlapX = halfW1 + halfW2 - Math.abs(dx);
  const overlapY = halfH1 + halfH2 - Math.abs(dy);

  // No collision if no overlap on either axis
  if (overlapX <= 0 || overlapY <= 0) return null;

  // Mutate result object to avoid GC pressure
  result.collided = true;

  // Push along axis with smallest overlap (Separating Axis Theorem)
  if (overlapX < overlapY) {
    // Push horizontally
    result.depth = overlapX;
    result.nx = dx > 0 ? 1 : -1;
    result.ny = 0;
  } else {
    // Push vertically
    result.depth = overlapY;
    result.nx = 0;
    result.ny = dy > 0 ? 1 : -1;
  }

  return result;
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
 * NOTE: Allocates a new object - use getCellCoordsMut() in hot paths
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

/**
 * Get grid cell coordinates from world position - ZERO ALLOCATION version
 * OPTIMIZED: Mutates result object instead of allocating
 * @param {number} x - World X position
 * @param {number} y - World Y position
 * @param {number} cellSize - Size of each grid cell
 * @param {number} gridCols - Number of grid columns
 * @param {number} gridRows - Number of grid rows
 * @param {Object} result - Result object to mutate {col, row}
 * @returns {Object} The result object with grid coordinates
 */
export function getCellCoordsMut(x, y, cellSize, gridCols, gridRows, result) {
  const col = Math.floor(x / cellSize);
  const row = Math.floor(y / cellSize);

  // Use ternary instead of Math.max/min for micro-optimization
  result.col = col < 0 ? 0 : col >= gridCols ? gridCols - 1 : col;
  result.row = row < 0 ? 0 : row >= gridRows ? gridRows - 1 : row;

  return result;
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
export function collectComponents(EntityClass, BaseClass = GameObject, DefaultComponent) {
  const components = new Set();
  let currentClass = EntityClass;

  // Walk up the prototype chain
  while (currentClass && currentClass !== Object && currentClass !== BaseClass) {
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
    verletDamping: clamp01(newConfig.verletDamping ?? current.verletDamping, current.verletDamping),
    minSpeedForRotation: newConfig.minSpeedForRotation ?? current.minSpeedForRotation,
    gravity: {
      x:
        newConfig.gravity && typeof newConfig.gravity.x === 'number'
          ? newConfig.gravity.x
          : (current.gravity?.x ?? 0),
      y:
        newConfig.gravity && typeof newConfig.gravity.y === 'number'
          ? newConfig.gravity.y
          : (current.gravity?.y ?? 0),
    },
  };
}

/**
 * Normalize an angle to [0, 2*PI] range
 * @param {number} angle - Angle in radians (can be any value)
 * @returns {number} Normalized angle in [0, 2*PI]
 */
export function normalizeAngle(angle) {
  const TWO_PI = Math.PI * 2;
  // Use modulo for efficiency, handle negative angles
  angle = angle % TWO_PI;
  if (angle < 0) {
    angle += TWO_PI;
  }
  return angle;
}

/**
 * Normalize the difference between two angles to [-PI, PI] range
 * Useful for interpolation to avoid taking the long way around the circle
 * @param {number} angle1 - First angle in radians
 * @param {number} angle2 - Second angle in radians
 * @returns {number} Normalized angle difference in [-PI, PI]
 */
export function normalizeAngleDifference(angle1, angle2) {
  let diff = angle2 - angle1;
  if (diff > Math.PI) {
    diff -= 2 * Math.PI;
  } else if (diff < -Math.PI) {
    diff += 2 * Math.PI;
  }
  return diff;
}

/**
 * Linear interpolation between two angles (handles wrap-around)
 * OPTIMIZED: Takes the shortest path around the circle
 * @param {number} a - Start angle in radians
 * @param {number} b - End angle in radians
 * @param {number} t - Interpolation factor (0-1)
 * @returns {number} Interpolated angle in radians
 */
export function lerpAngle(a, b, t) {
  // Normalize the difference to take the shortest path
  let diff = b - a;
  if (diff > Math.PI) {
    diff -= 2 * Math.PI;
  } else if (diff < -Math.PI) {
    diff += 2 * Math.PI;
  }
  return a + diff * t;
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
  const normalizedAngle = normalizeAngle(angle);
  const PI = Math.PI;
  const PI_4 = PI / 4;

  // Map velocityAngle to cardinal directions (accounting for +PI/2 offset)
  if (normalizedAngle < PI_4 || normalizedAngle >= (PI * 7) / 4) {
    return 'up'; // 315° to 45° (North)
  } else if (normalizedAngle < (PI * 3) / 4) {
    return 'right'; // 45° to 135° (East)
  } else if (normalizedAngle < (PI * 5) / 4) {
    return 'down'; // 135° to 225° (South)
  } else {
    return 'left'; // 225° to 315° (West)
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
  if (typeof globalThis.rng === 'function') {
    return globalThis.rng();
  }

  // Fallback to Math.random if not initialized (shouldn't happen in worker context)
  console.warn('rng() called before initialization, using Math.random()');
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
  if (typeof globalThis.query === 'function') {
    return globalThis.query(componentClasses);
  }

  // Not available in main thread context
  console.warn('[query] Query system only available in worker context');
  return new Uint16Array(0);
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

  const { lightX, lightY, lightIntensity, lightEnabled, lightCount } = lightData;

  for (let i = 0; i < lightCount; i++) {
    if (!lightEnabled[i]) continue;

    const distSq = distanceSq2D(targetX, targetY, lightX[i], lightY[i]);

    totalLight += calculateLightAttenuation(lightIntensity[i], distSq);
  }

  return Math.min(totalLight, maxLight);
}

/**
 * Calculate total light for an entity using neighbor distances calculated on-the-fly
 * Only considers neighbors (lights within visualRange), so this is an optimization
 * for dense scenes where lights are typically nearby entities
 *
 * @param {number} entityIndex - The entity's index
 * @param {Int32Array} neighborData - Neighbor indices buffer from spatial worker
 * @param {Float32Array} lightIntensity - Light intensity per entity
 * @param {Uint8Array} lightEnabled - Light enabled flags per entity
 * @param {number} stride - Neighbor buffer stride (1 + maxNeighbors)
 * @param {Float32Array} transformX - Transform.x array
 * @param {Float32Array} transformY - Transform.y array
 * @param {Float32Array} colliderOffsetX - Collider.offsetX array
 * @param {Float32Array} colliderOffsetY - Collider.offsetY array
 * @param {number} ambient - Ambient light level (0-1)
 * @param {number} maxLight - Maximum light value (default: 1.5)
 * @returns {number} Total light level (clamped to maxLight)
 */
export function calculateLightFromNeighbors(
  entityIndex,
  neighborData,
  lightIntensity,
  lightEnabled,
  stride,
  transformX,
  transformY,
  colliderOffsetX,
  colliderOffsetY,
  ambient = 0.05,
  maxLight = 1.5
) {
  let totalLight = ambient;

  const offset = entityIndex * stride;
  const neighborCount = neighborData[offset];

  // Get entity's collider position
  const entityX = transformX[entityIndex] + (colliderOffsetX[entityIndex] || 0);
  const entityY = transformY[entityIndex] + (colliderOffsetY[entityIndex] || 0);

  for (let k = 0; k < neighborCount; k++) {
    const neighborIdx = neighborData[offset + 2 + k];

    // Skip if this neighbor is not a light
    if (!lightEnabled[neighborIdx]) continue;

    // Calculate squared distance on-the-fly (collider positions)
    const neighborX = transformX[neighborIdx] + (colliderOffsetX[neighborIdx] || 0);
    const neighborY = transformY[neighborIdx] + (colliderOffsetY[neighborIdx] || 0);
    const distSq = distanceSq2D(entityX, entityY, neighborX, neighborY);

    totalLight += calculateLightAttenuation(lightIntensity[neighborIdx], distSq);
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
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
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
  ctx.fillStyle = 'transparent';
  ctx.fillRect(0, 0, size, size);

  // Draw the gradient circle
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

/**
 * Create a horizontal line texture (e.g. 10x1) with white pixels and gradient alpha.
 * Used for bullet trails: left edge fades (prev position), right edge bright (curr position).
 *
 * @param {number} width - Texture width (default: 10)
 * @param {number} height - Texture height (default: 1)
 * @param {number} color - Color in 0xRRGGBB format (default: white)
 * @returns {HTMLCanvasElement} Canvas with the gradient drawn
 */
export function createBulletTrailCanvas(width = 10, height = 1, color = 0xffffff) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = width;
  canvas.height = height;

  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},1)`);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}

/**
 * Extract RGB components from a color value (0xRRGGBB format)
 * NOTE: Allocates a new object - use extractRGBMut() in hot paths
 * @param {number} color - Color in 0xRRGGBB format
 * @returns {Object} Object with r, g, b properties (0-255)
 */
export function extractRGB(color) {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff,
  };
}

/**
 * Extract RGB components from a color value - ZERO ALLOCATION version
 * OPTIMIZED: Mutates result object instead of allocating
 * @param {number} color - Color in 0xRRGGBB format
 * @param {Object} result - Result object to mutate {r, g, b}
 * @returns {Object} The result object with r, g, b properties (0-255)
 */
export function extractRGBMut(color, result) {
  result.r = (color >> 16) & 0xff;
  result.g = (color >> 8) & 0xff;
  result.b = color & 0xff;
  return result;
}

/**
 * Extract RGB components from a color value and return as normalized values [0-1]
 * NOTE: Allocates a new object - use extractRGBNormalizedMut() in hot paths
 * @param {number} color - Color in 0xRRGGBB format
 * @returns {Object} Object with r, g, b properties (0.0-1.0)
 */
export function extractRGBNormalized(color) {
  return {
    r: ((color >> 16) & 0xff) / 255,
    g: ((color >> 8) & 0xff) / 255,
    b: (color & 0xff) / 255,
  };
}

/**
 * Extract RGB components as normalized values [0-1] - ZERO ALLOCATION version
 * OPTIMIZED: Mutates result object instead of allocating
 * @param {number} color - Color in 0xRRGGBB format
 * @param {Object} result - Result object to mutate {r, g, b}
 * @returns {Object} The result object with r, g, b properties (0.0-1.0)
 */
export function extractRGBNormalizedMut(color, result) {
  result.r = ((color >> 16) & 0xff) / 255;
  result.g = ((color >> 8) & 0xff) / 255;
  result.b = (color & 0xff) / 255;
  return result;
}

/**
 * Calculate speed from velocity components
 * @param {number} vx - Velocity X component
 * @param {number} vy - Velocity Y component
 * @returns {number} Speed (magnitude of velocity vector)
 */
export function calculateSpeed(vx, vy) {
  return Math.sqrt(vx * vx + vy * vy);
}

/**
 * Calculate velocity angle for sprite rotation
 * Returns angle in radians, adjusted for sprite rotation (adds PI/2)
 * @param {number} vx - Velocity X component
 * @param {number} vy - Velocity Y component
 * @returns {number} Angle in radians [0, 2*PI] for sprite rotation
 */
export function calculateVelocityAngle(vx, vy) {
  return Math.atan2(vy, vx) + Math.PI / 2;
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
export async function loadEntityScripts(scriptsToLoad, globalContext = null, verbose = null) {
  const loadedClasses = {};

  if (!scriptsToLoad || scriptsToLoad.length === 0) {
    return loadedClasses;
  }

  // Auto-detect context if not provided
  if (!globalContext) {
    globalContext = typeof window !== 'undefined' ? window : self;
  }

  // Auto-detect verbosity if not specified (verbose in main thread, quiet in workers)
  if (verbose === null) {
    verbose = typeof window !== 'undefined';
  }

  const contextName = typeof window !== 'undefined' ? 'Main Thread' : 'Worker';
  const isWorker = typeof window === 'undefined';

  // Detect if we're in a Blob-based worker (bundle mode) - import() won't work
  const isBlobWorker = isWorker && typeof self !== 'undefined' &&
    self.location && self.location.href && self.location.href.startsWith('blob:');

  if (verbose) {
    console.log(`📦 ${contextName}: Loading ${scriptsToLoad.length} entity scripts...`);
  }

  // For Blob workers, load scripts in multiple passes to handle dependencies
  // Scripts that fail (due to missing dependencies) are retried after others load
  let pendingScripts = [...scriptsToLoad];
  const maxPasses = 5;
  let pass = 0;

  while (pendingScripts.length > 0 && pass < maxPasses) {
    pass++;
    const failedScripts = [];

    for (const scriptPath of pendingScripts) {
      const success = await loadSingleScript(
        scriptPath, loadedClasses, globalContext, isBlobWorker, contextName, verbose
      );
      if (!success) {
        failedScripts.push(scriptPath);
      }
    }

    // If no progress was made, break to avoid infinite loop
    if (failedScripts.length === pendingScripts.length) {
      if (verbose) {
        console.warn(`⚠️ ${contextName}: Could not load ${failedScripts.length} scripts after ${pass} passes`);
      }
      break;
    }

    pendingScripts = failedScripts;
  }

  if (verbose) {
    console.log(
      `✅ ${contextName}: Loaded ${Object.keys(loadedClasses).length} entity classes globally`
    );
  }

  return loadedClasses;
}

async function loadSingleScript(scriptPath, loadedClasses, globalContext, isBlobWorker, contextName, verbose) {
  try {
    let module;

    if (isBlobWorker) {
      // In Blob-based workers, use fetch + evaluation instead of import()
      // This handles the case where workers are created from bundled strings
      const response = await fetch(scriptPath);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const scriptText = await response.text();

      // Create a module-like wrapper that captures exports
      // We need to handle ES module syntax (export class, export const, etc.)
      const exports = {};

      // Transform the script to work in non-module context
      let transformedScript = scriptText
        // Remove ALL import statements (we provide WEED via parameters, other classes are already global)
        .replace(/import\s+[\w\s{},*]+\s+from\s+['"][^'"]+['"]\s*;?/g, '')
        .replace(/import\s+['"][^'"]+['"]\s*;?/g, '') // side-effect imports
        // Remove const/let destructuring from WEED (we provide these as parameters)
        .replace(/const\s*\{[\s\S]*?\}\s*=\s*WEED\s*;?/g, '')
        .replace(/let\s*\{[\s\S]*?\}\s*=\s*WEED\s*;?/g, '')
        // Replace import.meta.url with the script path
        .replace(/import\.meta\.url/g, `'${scriptPath}'`)
        // Transform exports to assignments on our exports object
        .replace(/export\s+class\s+(\w+)/g, 'exports.$1 = class $1')
        .replace(/export\s+const\s+(\w+)\s*=/g, 'exports.$1 =')
        .replace(/export\s+function\s+(\w+)/g, 'exports.$1 = function $1')
        .replace(/export\s+\{\s*([^}]+)\s*\}/g, (match, names) => {
          return names.split(',').map(n => {
            const name = n.trim().split(/\s+as\s+/);
            return `exports.${name[name.length - 1].trim()} = ${name[0].trim()};`;
          }).join('\n');
        });

      // Build the wrapper with WEED globals as function parameters
      const moduleWrapper = new Function(
        'exports', 'WEED',
        'GameObject', 'Component', 'FSM', 'FSMState', 'Transform', 'RigidBody', 'Collider',
        'SpriteRenderer', 'ParticleComponent', 'ShadowCaster', 'LightEmitter', 'FlashComponent',
        'DecorationComponent', 'ParticleEmitter', 'DecorationPool', 'Flash', 'Mouse', 'Camera',
        'NavGrid', 'Ray', 'ShapeType', 'rng', 'randomColor', 'distanceSq2D', 'getDirectionFromAngle',
        'containerRadius', 'SpriteSheetRegistry', 'Keyboard', 'SoundManager',
        transformedScript
      );

      // Get references - in workers, classes are directly on self, not self.WEED
      const WEED = globalContext.WEED || globalContext;
      const g = globalContext; // shorthand for getting classes

      try {
        moduleWrapper(
          exports, WEED,
          g.GameObject || WEED.GameObject,
          g.Component || WEED.Component,
          g.FSM || WEED.FSM,
          g.FSMState || WEED.FSMState,
          g.Transform || WEED.Transform,
          g.RigidBody || WEED.RigidBody,
          g.Collider || WEED.Collider,
          g.SpriteRenderer || WEED.SpriteRenderer,
          g.ParticleComponent || WEED.ParticleComponent,
          g.ShadowCaster || WEED.ShadowCaster,
          g.LightEmitter || WEED.LightEmitter,
          g.FlashComponent || WEED.FlashComponent,
          g.DecorationComponent || WEED.DecorationComponent,
          g.ParticleEmitter || WEED.ParticleEmitter,
          g.DecorationPool || WEED.DecorationPool,
          g.Flash || WEED.Flash,
          g.Mouse || WEED.Mouse,
          g.Camera || WEED.Camera,
          g.NavGrid || WEED.NavGrid,
          g.Ray || WEED.Ray,
          g.ShapeType || WEED.enums?.ShapeType,
          g.rng || WEED.rng,
          g.randomColor || WEED.randomColor,
          g.distanceSq2D || WEED.distanceSq2D,
          g.getDirectionFromAngle || WEED.getDirectionFromAngle,
          g.containerRadius || WEED.containerRadius,
          g.SpriteSheetRegistry || WEED.SpriteSheetRegistry,
          g.Keyboard || WEED.Keyboard,
          g.SoundManager || WEED.SoundManager
        );
      } catch (evalError) {
        console.error(`  ✗ Error evaluating ${scriptPath}:`, evalError);
        console.error('First 500 chars of transformed script:', transformedScript.substring(0, 500));
        throw evalError;
      }

      module = exports;
    } else {
      // Standard dynamic import for module-based workers and main thread
      module = await import(scriptPath);
    }

    // Make the exported class(es) available globally
    Object.keys(module).forEach((key) => {
      globalContext[key] = module[key];
      loadedClasses[key] = module[key];
      if (verbose) {
        console.log(`  ✓ Registered ${key} from ${scriptPath}`);
      }
    });
    return true; // Success
  } catch (error) {
    // Only log on first pass or if verbose
    if (verbose) {
      console.warn(`  ⏳ ${contextName}: Deferred ${scriptPath} (dependency not ready)`);
    }
    return false; // Failed, will retry
  }
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
// URL/PATH UTILITIES
// ============================================================================

/**
 * Convert a URL to a file path (extracts pathname)
 * Useful for converting script URLs to file paths
 * @param {string} url - Full URL or path string
 * @returns {string} Pathname portion of URL, or original string if URL parsing fails
 */
export function urlToPath(url) {
  if (url && url.startsWith('blob:')) return url;
  try {
    const urlObj = new URL(url);
    return urlObj.pathname;
  } catch (e) {
    return url;
  }
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
    graphics.moveTo(startX, startY).lineTo(endX, endY).stroke({ width: scaledWidth, color, alpha });
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

      graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: scaledWidth, color, alpha });
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
  const { x, y, size = 8, color = 0xffffff, alpha = 1.0, width = 2, zoom = 1 } = options;

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

/**
 * Comparator for Y-sorting entities (e.g. for depth sorting in rendering)
 * Usage: array.sort(sortByY)
 * @param {Object} a - First object { y: number }
 * @param {Object} b - Second object { y: number }
 * @returns {number} Difference in Y
 */
export function sortByY(a, b) {
  return a.y - b.y;
}

// ============================================================================
// COLOR UTILITIES (for Debug UI)
// ============================================================================

/**
 * Generate a deterministic hash from a string
 * Uses djb2 algorithm - fast and good distribution
 * @param {string} str - Input string
 * @returns {number} 32-bit hash value
 */
export function stringToHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

/**
 * Convert a hash to a pastel color (HSL with high lightness, medium saturation)
 * Returns CSS color string for use in HTML elements
 * @param {number} hash - Hash value
 * @returns {string} CSS HSL color string
 */
export function hashToPastelColorCSS(hash) {
  const hue = hash % 360;
  const saturation = 50 + (hash % 20); // 50-70%
  const lightness = 70 + (hash % 15); // 70-85%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Convert a hash to a pastel color as hex number (for canvas/PIXI rendering)
 * @param {number} hash - Hash value
 * @returns {number} Hex color (0xRRGGBB)
 */
export function hashToPastelColorHex(hash) {
  const hue = hash % 360;
  const saturation = 0.6; // 60%
  const lightness = 0.75; // 75%
  return hslToHex(hue, saturation, lightness);
}

/**
 * Convert HSL to hex color
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-1)
 * @param {number} l - Lightness (0-1)
 * @returns {number} Hex color (0xRRGGBB)
 */
export function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }

  const ri = ((r + m) * 255) | 0;
  const gi = ((g + m) * 255) | 0;
  const bi = ((b + m) * 255) | 0;

  return (ri << 16) | (gi << 8) | bi;
}

/**
 * Predefined colors for core components (consistent, visually distinct)
 * Custom components will get auto-generated pastel colors based on their name
 */
export const COMPONENT_COLORS = Object.freeze({
  Transform: Object.freeze({ css: 'hsl(120, 60%, 75%)', hex: 0x8fbc8f }),
  RigidBody: Object.freeze({ css: 'hsl(210, 70%, 75%)', hex: 0x87ceeb }),
  Collider: Object.freeze({ css: 'hsl(45, 80%, 70%)', hex: 0xf4d03f }),
  SpriteRenderer: Object.freeze({ css: 'hsl(280, 60%, 75%)', hex: 0xb19cd9 }),
  LightEmitter: Object.freeze({ css: 'hsl(30, 80%, 70%)', hex: 0xf5a962 }),
  ShadowCaster: Object.freeze({ css: 'hsl(0, 0%, 65%)', hex: 0xa8a8a8 }),
});

/**
 * Get color for a component (core or custom)
 * Core components use predefined colors, custom components get deterministic pastel colors
 * @param {string} componentName - Name of the component
 * @returns {{ css: string, hex: number }} Color object with CSS and hex values
 */
export function getComponentColor(componentName) {
  // Return predefined color for core components
  if (COMPONENT_COLORS[componentName]) {
    return COMPONENT_COLORS[componentName];
  }

  // Generate deterministic pastel color for custom components
  const hash = stringToHash(componentName);
  return {
    css: hashToPastelColorCSS(hash),
    hex: hashToPastelColorHex(hash),
  };
}

/**
 * Get all property names from a component's ARRAY_SCHEMA
 * Filters out 'active' since it's internal
 * @param {Object} ComponentClass - Component class with ARRAY_SCHEMA
 * @returns {string[]} Array of property names
 */
export function getComponentPropertyNames(ComponentClass) {
  if (!ComponentClass || !ComponentClass.ARRAY_SCHEMA) {
    return [];
  }
  return Object.keys(ComponentClass.ARRAY_SCHEMA).filter((key) => key !== 'active');
}

// ============================================================================
// DECAL/TILE STAMPING UTILITIES
// Pure functions for calculating tile regions when stamping decals
// ============================================================================

/**
 * Calculate which tiles a decal touches based on its world-space bounding box
 * Returns tile index bounds (inclusive) for iteration
 *
 * @param {number} worldX - Decal center X in world coordinates
 * @param {number} worldY - Decal center Y in world coordinates
 * @param {number} halfWidth - Half of the decal's width in world units
 * @param {number} halfHeight - Half of the decal's height in world units
 * @param {number} tileSize - Size of each tile in world units
 * @param {number} tilesX - Total number of tiles horizontally
 * @param {number} tilesY - Total number of tiles vertically
 * @param {Object} result - Result object to mutate {minTileX, maxTileX, minTileY, maxTileY, valid}
 * @returns {Object} The result object with tile bounds
 */
export function calculateDecalTileBounds(
  worldX,
  worldY,
  halfWidth,
  halfHeight,
  tileSize,
  tilesX,
  tilesY,
  result
) {
  // Calculate world-space bounding box
  const minWorldX = worldX - halfWidth;
  const maxWorldX = worldX + halfWidth;
  const minWorldY = worldY - halfHeight;
  const maxWorldY = worldY + halfHeight;

  // Convert to tile indices (floor for min, floor for max since we want inclusive)
  let minTileX = (minWorldX / tileSize) | 0;
  let maxTileX = (maxWorldX / tileSize) | 0;
  let minTileY = (minWorldY / tileSize) | 0;
  let maxTileY = (maxWorldY / tileSize) | 0;

  // Clamp to valid tile range
  minTileX = minTileX < 0 ? 0 : minTileX;
  maxTileX = maxTileX >= tilesX ? tilesX - 1 : maxTileX;
  minTileY = minTileY < 0 ? 0 : minTileY;
  maxTileY = maxTileY >= tilesY ? tilesY - 1 : maxTileY;

  // Check if any valid tiles remain after clamping
  result.minTileX = minTileX;
  result.maxTileX = maxTileX;
  result.minTileY = minTileY;
  result.maxTileY = maxTileY;
  result.valid = minTileX <= maxTileX && minTileY <= maxTileY;

  return result;
}

/**
 * Calculate the clip region for stamping a decal onto a specific tile
 * Returns the pixel ranges to iterate over (both source texture and destination tile)
 *
 * This function calculates the intersection between the decal's bounding box
 * and the tile's bounding box, returning only the pixels that need to be processed.
 *
 * @param {number} worldX - Decal center X in world coordinates
 * @param {number} worldY - Decal center Y in world coordinates
 * @param {number} halfWidthWorld - Half of decal width in world units
 * @param {number} halfHeightWorld - Half of decal height in world units
 * @param {number} tileX - Tile X index
 * @param {number} tileY - Tile Y index
 * @param {number} tileSize - Tile size in world units
 * @param {number} tilePixelSize - Tile size in pixels
 * @param {number} texWidth - Source texture width in pixels
 * @param {number} texHeight - Source texture height in pixels
 * @param {number} scaledWidth - Scaled decal width in pixels
 * @param {number} scaledHeight - Scaled decal height in pixels
 * @param {Object} result - Result object to mutate
 * @returns {Object} Result with: dstStartX, dstStartY, dstEndX, dstEndY, srcOffsetX, srcOffsetY, valid
 */
export function calculateTileClipRegion(
  worldX,
  worldY,
  halfWidthWorld,
  halfHeightWorld,
  tileX,
  tileY,
  tileSize,
  tilePixelSize,
  texWidth,
  texHeight,
  scaledWidth,
  scaledHeight,
  result
) {
  // Tile bounds in world space
  const tileMinWorldX = tileX * tileSize;
  const tileMaxWorldX = (tileX + 1) * tileSize;
  const tileMinWorldY = tileY * tileSize;
  const tileMaxWorldY = (tileY + 1) * tileSize;

  // Decal bounds in world space
  const decalMinWorldX = worldX - halfWidthWorld;
  const decalMaxWorldX = worldX + halfWidthWorld;
  const decalMinWorldY = worldY - halfHeightWorld;
  const decalMaxWorldY = worldY + halfHeightWorld;

  // Calculate intersection in world space
  const clipMinWorldX = decalMinWorldX > tileMinWorldX ? decalMinWorldX : tileMinWorldX;
  const clipMaxWorldX = decalMaxWorldX < tileMaxWorldX ? decalMaxWorldX : tileMaxWorldX;
  const clipMinWorldY = decalMinWorldY > tileMinWorldY ? decalMinWorldY : tileMinWorldY;
  const clipMaxWorldY = decalMaxWorldY < tileMaxWorldY ? decalMaxWorldY : tileMaxWorldY;

  // Check for valid intersection
  if (clipMinWorldX >= clipMaxWorldX || clipMinWorldY >= clipMaxWorldY) {
    result.valid = false;
    return result;
  }

  // Convert world-to-pixel ratio
  const worldToPixel = tilePixelSize / tileSize;

  // Destination (tile) pixel coordinates
  result.dstStartX = ((clipMinWorldX - tileMinWorldX) * worldToPixel) | 0;
  result.dstStartY = ((clipMinWorldY - tileMinWorldY) * worldToPixel) | 0;
  result.dstEndX = ((clipMaxWorldX - tileMinWorldX) * worldToPixel) | 0;
  result.dstEndY = ((clipMaxWorldY - tileMinWorldY) * worldToPixel) | 0;

  // Source texture UV offset (where to start sampling in the scaled decal)
  // This is the offset from the decal's top-left corner to the clip region's top-left
  const decalWidthWorld = halfWidthWorld * 2;
  const decalHeightWorld = halfHeightWorld * 2;

  result.srcOffsetX = ((clipMinWorldX - decalMinWorldX) / decalWidthWorld) * scaledWidth;
  result.srcOffsetY = ((clipMinWorldY - decalMinWorldY) / decalHeightWorld) * scaledHeight;

  // Dimensions to iterate (in pixels)
  result.clipWidth = result.dstEndX - result.dstStartX;
  result.clipHeight = result.dstEndY - result.dstStartY;

  // UV scale factors for sampling (scaled texture pixels per destination pixel)
  result.uvScaleX = scaledWidth / (decalWidthWorld * worldToPixel);
  result.uvScaleY = scaledHeight / (decalHeightWorld * worldToPixel);

  result.valid = true;
  return result;
}

// Pre-allocated result objects for decal utilities (zero GC in hot paths)
export const _decalTileBounds = {
  minTileX: 0,
  maxTileX: 0,
  minTileY: 0,
  maxTileY: 0,
  valid: false,
};
export const _tileClipRegion = {
  dstStartX: 0,
  dstStartY: 0,
  dstEndX: 0,
  dstEndY: 0,
  srcOffsetX: 0,
  srcOffsetY: 0,
  clipWidth: 0,
  clipHeight: 0,
  uvScaleX: 1,
  uvScaleY: 1,
  valid: false,
};

// ============================================================================
// DEBUG UI / FORMATTING UTILITIES
// ============================================================================

/**
 * Format a component property value for display
 * Handles different types: numbers (with precision), hex colors, etc.
 * @param {string} propName - Property name (for type detection)
 * @param {*} value - Raw value
 * @returns {string} Formatted string
 */
export function formatComponentValue(propName, value) {
  if (value === undefined || value === null) return 'N/A';

  // Detect color properties (tint, baseTint, color)
  const isColor =
    propName.toLowerCase().includes('tint') || propName.toLowerCase().includes('color');
  if (isColor && typeof value === 'number') {
    return '0x' + value.toString(16).toUpperCase().padStart(6, '0');
  }

  // Format numbers with appropriate precision
  if (typeof value === 'number') {
    // Integer check: if it's very close to an integer, display as integer
    if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 0.0001) {
      return String(Math.round(value));
    }
    // Float: show 2 decimal places
    return value.toFixed(2);
  }

  return String(value);
}

/**
 * Computes an approximate radius of a container circle
 * that can fit N circles of radius R.
 *
 * Uses an area-based approximation with a safety margin.
 * Suitable for real-time simulations and games.
 *
 * @param {number} N - Number of circles to fit (N >= 0)
 * @param {number} R - Radius of each circle (R > 0)
 * @param {number} [margin=1.05] - Safety margin multiplier
 * @returns {number} Radius of the container circle
 */
export function containerRadius(N, R, margin = 1.05) {
  if (N <= 0) return 0;
  if (N === 1) return R;

  return R * Math.sqrt(N) * margin;
}

// Symmetrical Algorithm: Circle centered at center of (0,0) cell
/**
 * Generate a circle pattern of cell offsets for neighbor search
 * Returns Int32Array with format [dr, dc, dr, dc, ...] for efficient iteration
 * @param {number} cellRadius - Radius in cells (0, 1, 2, 3, ...)
 * @param {number} cellSize - Size of each cell in world units
 * @returns {Int32Array} Pattern array with [dr, dc, dr, dc, ...] pairs
 */
export function generateSymmetricalCirclePattern(cellRadius, cellSize) {
  const cells = [];
  const radius = cellRadius * cellSize;
  const radiusSq = radius ** 2;

  // Circle is centered at the center of the (0,0) cell
  const centerX = cellSize / 2;
  const centerY = cellSize / 2;

  for (let dr = -cellRadius; dr <= cellRadius; dr++) {
    for (let dc = -cellRadius; dc <= cellRadius; dc++) {
      const left = dc * cellSize, right = (dc + 1) * cellSize;
      const top = dr * cellSize, bottom = (dr + 1) * cellSize;

      // Find closest point on cell boundary to circle center
      const closestX = Math.max(left, Math.min(centerX, right));
      const closestY = Math.max(top, Math.min(centerY, bottom));

      const dx = closestX - centerX;
      const dy = closestY - centerY;
      const closestDistSq = dx ** 2 + dy ** 2;

      if (closestDistSq <= radiusSq) {
        // Store cell with its distance squared for sorting
        // Use cell center distance for sorting (spiral outward from center)
        const cellCenterDistSq = dr * dr + dc * dc;
        cells.push({ dr, dc, distSq: cellCenterDistSq });
      }
    }
  }

  // Sort cells by distance from center (spiral pattern: closest cells first)
  // This makes neighbor lists approximately distance-sorted at zero runtime cost
  cells.sort((a, b) => a.distSq - b.distSq);

  // Flatten to [dr, dc, dr, dc, ...] format
  const pattern = new Int32Array(cells.length * 2);
  for (let i = 0; i < cells.length; i++) {
    pattern[i * 2] = cells[i].dr;
    pattern[i * 2 + 1] = cells[i].dc;
  }

  return pattern;
}