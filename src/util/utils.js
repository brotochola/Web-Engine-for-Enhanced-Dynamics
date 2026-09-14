// ============================================================================
// GAME ENGINE UTILITIES
// Shared utility functions for the multithreaded game engine
// ============================================================================

import { PHYSICS_DEFAULTS } from './configDefaults.js';
import { GameObject } from '../core/gameObject.js';

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
 * 2D rotation helpers (cos/sin as unit complex). Zero alloc.
 */

/** Compose R0 * R1 into out = { c, s } (caller reuses out). */
export function composeRotTo(out, c0, s0, c1, s1) {
  out.c = c0 * c1 - s0 * s1;
  out.s = s0 * c1 + c0 * s1;
  return out;
}

/** Compose R0 * R1 into typed arrays at index. */
export function composeRotInto(c0, s0, c1, s1, cArr, sArr, index) {
  cArr[index] = c0 * c1 - s0 * s1;
  sArr[index] = s0 * c1 + c0 * s1;
}

/** Write cos/sin of radians into typed arrays at index. */
export function setRotCSFromAngle(cArr, sArr, index, angle) {
  cArr[index] = Math.cos(angle);
  sArr[index] = Math.sin(angle);
}

/**
 * Random unit complex into out = { c, s } (one cos/sin of uniform angle).
 * @param {{ c: number, s: number }} out
 */
export function randomUnitCS(out) {
  const a = rng() * Math.PI * 2;
  out.c = Math.cos(a);
  out.s = Math.sin(a);
  return out;
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

export const LIGHT_GRADIENT_TEXTURE_RADIUS = 100;
/** Soft-disk for fluid / metaball density splat (smaller than light glow). */
export const METABALL_TEXTURE_RADIUS = 32;
/** World radius = sqrtIntensity * this. Used by lighting + shadow culls. */
export const LIGHT_INFLUENCE_RADIUS_SCALE = 10;

/** World-space light influence radius for LIGHTING / CASTED_SHADOWS culls. */
export function lightInfluenceRadius(sqrtIntensity) {
  return (sqrtIntensity || 0) * LIGHT_INFLUENCE_RADIUS_SCALE;
}

/** Rows in the lighting data texture: 0 = xy+intensity, 1 = rgb. */
export const LIGHT_DATA_TEX_HEIGHT = 2;

/** Float count for an RGBA32F light-data texture of width `maxLights`. */
export function lightDataTextureFloatCount(maxLights) {
  return (maxLights | 0) * LIGHT_DATA_TEX_HEIGHT * 4;
}

/**
 * Pack one light into the 2-row RGBA32F layout used by the lighting fragment shader.
 * Row 0 texel i: x, y, intensity, 0
 * Row 1 texel i: r, g, b, 0
 */
export function packLightDataTexel(data, maxLights, lightIndex, x, y, intensity, r, g, b) {
  const i0 = lightIndex * 4;
  data[i0] = x;
  data[i0 + 1] = y;
  data[i0 + 2] = intensity;
  data[i0 + 3] = 0;
  const i1 = maxLights * 4 + lightIndex * 4;
  data[i1] = r;
  data[i1 + 1] = g;
  data[i1 + 2] = b;
  data[i1 + 3] = 0;
}

/**
 * Zero compact slots [liveCount, maxLights) so leftover lights cannot ghost.
 * Row 0 and row 1 are contiguous; two fills, no alloc.
 */
export function clearUnusedLightDataTexels(data, maxLights, liveCount) {
  const n = maxLights | 0;
  const live = Math.max(0, Math.min(liveCount | 0, n));
  if (live >= n) return;
  data.fill(0, live * 4, n * 4);
  data.fill(0, n * 4 + live * 4, n * 8);
}

/** Read back a packed light (for tests / debug). Writes into `out` and returns it. */
export function readLightDataTexel(data, maxLights, lightIndex, out = {}) {
  const i0 = lightIndex * 4;
  const i1 = maxLights * 4 + lightIndex * 4;
  out.x = data[i0];
  out.y = data[i0 + 1];
  out.intensity = data[i0 + 2];
  out.r = data[i1];
  out.g = data[i1 + 1];
  out.b = data[i1 + 2];
  return out;
}

/** Instanced sprite scale so cookie world radius == lightInfluenceRadius. */
export function lightCookieScale(sqrtIntensity) {
  return lightInfluenceRadius(sqrtIntensity) / LIGHT_GRADIENT_TEXTURE_RADIUS;
}

/** Soft glow world radius = √I * this. Calibrated: I=20000 matches old (visualRange*4) at VR=300. */
export const LIGHT_GLOW_RADIUS_SCALE = (300 * 4) / Math.sqrt(20000); // ~8.485

/** Instanced sprite scale for soft light glow (independent of Collider.visualRange). */
export function lightGlowScale(sqrtIntensity) {
  return ((sqrtIntensity || 0) * LIGHT_GLOW_RADIUS_SCALE) / LIGHT_GRADIENT_TEXTURE_RADIUS;
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
 * 2D dot product (JS Math has no Math.dot).
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number} ax*bx + ay*by
 */
export function dot2(ax, ay, bx, by) {
  return ax * bx + ay * by;
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

// Pre-allocated RGB scratch for extractRGBMut / extractRGBNormalizedMut
export const _rgbResult = { r: 0, g: 0, b: 0 };

// ============================================================================
// MASS COMPUTATION UTILITIES
// ============================================================================

/**
 * Update RigidBody mass arrays from circle radius
 * Low-level helper used by RigidBody.syncMassFromCollider().
 *
 * @param {number} index - Entity index in component arrays
 * @param {number} radius - Circle radius
 * @param {Object} RigidBody - RigidBody component class with mass/invMass arrays
 *
 * @example
 *   // In RigidBody.syncMassFromCollider():
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
 * Low-level helper used by RigidBody.syncMassFromCollider().
 *
 * @param {number} index - Entity index in component arrays
 * @param {number} width - Box width
 * @param {number} height - Box height
 * @param {Object} RigidBody - RigidBody component class with mass/invMass arrays
 *
 * @example
 *   // In RigidBody.syncMassFromCollider():
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
 * Ray vs convex polygon (local verts). Transform ray to local; clip against half-planes.
 * @returns {number} Distance along ray, or -1 if miss
 */
export function rayPolygonIntersect(
  rayX, rayY, dirX, dirY,
  polyX, polyY, cos, sin,
  vx, vy, nx, ny, count, base,
  maxDist
) {
  if (count < 3) return -1;
  const dx = rayX - polyX;
  const dy = rayY - polyY;
  const ox = cos * dx + sin * dy;
  const oy = -sin * dx + cos * dy;
  const rdx = cos * dirX + sin * dirY;
  const rdy = -sin * dirX + cos * dirY;

  let tEnter = 0;
  let tExit = maxDist;

  for (let i = 0; i < count; i++) {
    const px = vx[base + i];
    const py = vy[base + i];
    const nnx = nx[base + i];
    const nny = ny[base + i];
    // Outward plane: (p - vert) · n <= 0 inside
    const denom = rdx * nnx + rdy * nny;
    const numer = (ox - px) * nnx + (oy - py) * nny;
    if (denom > 1e-12) {
      // Leaving
      const t = -numer / denom;
      if (t < tExit) tExit = t;
    } else if (denom < -1e-12) {
      // Entering
      const t = -numer / denom;
      if (t > tEnter) tEnter = t;
    } else if (numer > 0) {
      return -1; // parallel and outside
    }
    if (tEnter > tExit) return -1;
  }

  if (tEnter < 0) {
    // Starts inside — treat as miss (Box2D solid convention) or hit at 0?
    // Match circle/box: no hit from inside for ray casts in this engine's circle path
    // rayCircle returns miss if origin inside in some cases — check rayBox...
    // For consistency with solid shapes: miss if start inside
    return -1;
  }
  return tEnter <= tExit ? tEnter : -1;
}

// ============================================================================
// COMPONENT/CLASS UTILITIES
// ============================================================================

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

/**
 * Collect transferable objects from a worker port group.
 * Returns an empty array when the worker has no direct MessagePorts.
 *
 * @param {Object|null|undefined} portGroup - Object mapping peer worker names to MessagePorts
 * @returns {Array<MessagePort>} Transferable ports
 */
export function getPortTransferables(portGroup) {
  return portGroup ? Object.values(portGroup) : [];
}

/**
 * Post a worker init message using a shared base payload plus per-worker extras.
 *
 * @param {Worker} worker - Target worker-like object with postMessage()
 * @param {Object} baseInitData - Shared init payload for all workers
 * @param {Object} [extraData={}] - Worker-specific init fields
 * @param {Array<Transferable>} [transferables=[]] - Transferables for postMessage
 */
export function postWorkerInitMessage(
  worker,
  baseInitData,
  extraData = {},
  transferables = []
) {
  const workerName = extraData.workerName ?? worker.name;
  worker.postMessage(
    {
      ...baseInitData,
      ...extraData,
      ...(workerName ? { workerName } : {}),
    },
    transferables
  );
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
    contactHertz: Math.max(
      0,
      newConfig.contactHertz ?? current.contactHertz ?? PHYSICS_DEFAULTS.contactHertz
    ),
    contactDampingRatio: Math.max(
      0,
      newConfig.contactDampingRatio ??
      current.contactDampingRatio ??
      PHYSICS_DEFAULTS.contactDampingRatio
    ),
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
    lengthUnitsPerMeter: Math.max(
      1e-6,
      newConfig.lengthUnitsPerMeter ??
      current.lengthUnitsPerMeter ??
      PHYSICS_DEFAULTS.lengthUnitsPerMeter
    ),
    contactSpeed: Math.max(
      0,
      newConfig.contactSpeed ?? current.contactSpeed ?? PHYSICS_DEFAULTS.contactSpeed
    ),
    maximumLinearSpeed: Math.max(
      1,
      newConfig.maximumLinearSpeed ??
      current.maximumLinearSpeed ??
      PHYSICS_DEFAULTS.maximumLinearSpeed
    ),
    box2dWorkerCount: Math.max(
      1,
      Math.min(
        4,
        (newConfig.box2dWorkerCount ??
          current.box2dWorkerCount ??
          PHYSICS_DEFAULTS.box2dWorkerCount) | 0
      )
    ),
    contactRingCapacity: Math.max(
      256,
      (newConfig.contactRingCapacity ??
        current.contactRingCapacity ??
        PHYSICS_DEFAULTS.contactRingCapacity) | 0
    ),
    commandRingCapacity: Math.max(
      64,
      (newConfig.commandRingCapacity ??
        current.commandRingCapacity ??
        PHYSICS_DEFAULTS.commandRingCapacity) | 0
    ),
    liquidFun: mergeLiquidFunConfig(current.liquidFun, newConfig.liquidFun),
  };
}

function mergeLiquidFunConfig(currentLf, newLf) {
  const d = PHYSICS_DEFAULTS.liquidFun;
  const src = { ...d, ...(currentLf || {}), ...(newLf || {}) };
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    enabled: !!src.enabled,
    radius: Math.max(1e-6, src.radius > 0 ? src.radius : d.radius),
    maxCount: Math.min(65535, Math.max(1, (src.maxCount != null ? src.maxCount : d.maxCount) | 0)),
    subSteps: Math.max(1, (src.subSteps != null ? src.subSteps : d.subSteps) | 0),
    density: num(src.density, d.density),
    strictContactCheck: !!src.strictContactCheck,
    dampingStrength: num(src.dampingStrength, d.dampingStrength),
    pressureStrength: num(src.pressureStrength, d.pressureStrength),
    viscousStrength: num(src.viscousStrength, d.viscousStrength),
    tensileStrength: num(src.tensileStrength, d.tensileStrength),
    powderStrength: num(src.powderStrength, d.powderStrength),
    springStrength: num(src.springStrength, d.springStrength),
    staticPressureStrength: num(src.staticPressureStrength, d.staticPressureStrength),
    staticPressureRelaxation: num(src.staticPressureRelaxation, d.staticPressureRelaxation),
    staticPressureIterations: Math.max(
      1,
      (src.staticPressureIterations != null ? src.staticPressureIterations : d.staticPressureIterations) | 0,
    ),
    ejectionStrength: num(src.ejectionStrength, d.ejectionStrength),
    colorMixingStrength: num(src.colorMixingStrength, d.colorMixingStrength),
    repulsiveStrength: num(src.repulsiveStrength, d.repulsiveStrength),
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
 * Normalize an angle to [-PI, PI)
 * Used by angular-sweep visibility (event ordering around a light).
 * @param {number} angle - Angle in radians
 * @returns {number} Normalized angle in [-PI, PI)
 */
export function normalizeAngleSigned(angle) {
  const TWO_PI = Math.PI * 2;
  angle = angle % TWO_PI;
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle <= -Math.PI) angle += TWO_PI;
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
 * Convert angle (radians, atan2(vy,vx)+PI/2 convention) to cardinal string.
 * Prefer getDirectionFromVector for new code.
 * @returns {"right"|"down"|"left"|"up"}
 */
export function getDirectionFromAngle(angle) {
  const normalizedAngle = normalizeAngle(angle);
  const PI = Math.PI;
  const PI_4 = PI / 4;

  if (normalizedAngle < PI_4 || normalizedAngle >= (PI * 7) / 4) {
    return 'up';
  } else if (normalizedAngle < (PI * 3) / 4) {
    return 'right';
  } else if (normalizedAngle < (PI * 5) / 4) {
    return 'down';
  } else {
    return 'left';
  }
}

/**
 * Cardinal facing from world delta (no atan2).
 * Same octants as getDirectionFromAngle(atan2(dy,dx)+PI/2).
 */
export function getDirectionFromVector(dx, dy) {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  if (ay >= ax) return dy >= 0 ? 'down' : 'up';
  return dx >= 0 ? 'right' : 'left';
}

/** tan(22.5°) — 8-way sector boundaries */
const _TAN_22_5 = 0.41421356237;

/**
 * 8-way facing from velocity/delta (no atan2).
 * Matches demos/bug.js: getDirection8(atan2(dy,dx)+PI/2) ≡ octant of (-dx,-dy).
 * @returns {'e'|'se'|'s'|'sw'|'w'|'nw'|'n'|'ne'}
 */
export function getDirection8FromVector(dx, dy) {
  const x = -dx;
  const y = -dy;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  if (ax * _TAN_22_5 > ay) return x >= 0 ? 'e' : 'w';
  if (ay * _TAN_22_5 > ax) return y >= 0 ? 's' : 'n';
  if (x >= 0 && y >= 0) return 'se';
  if (x < 0 && y >= 0) return 'sw';
  if (x < 0 && y < 0) return 'nw';
  return 'ne';
}

/**
 * Mix scene seed with a per-thread id so main + each worker get independent
 * mulberry32 streams. Same (seed, workerId) always same uint32.
 * @param {number} seed
 * @param {number|string} [workerId=0]
 * @returns {number}
 */
export function mixSeed(seed, workerId = 0) {
  const sid = typeof workerId === 'string' ? stringToHash(workerId) : workerId | 0;
  let z = ((seed >>> 0) + Math.imul(sid, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export function seededRandom(seed, workerId) {
  let t = workerId == null ? seed : mixSeed(seed, workerId);
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
 * In worker context: globalThis.rng is set by AbstractWorker.initSeededRandom()
 * In main thread: can be set via seededRandom() if needed
 * @returns {number} Random number between 0 and 1
 */
export function rng() {
  if (typeof globalThis.rng === 'function') {
    return globalThis.rng();
  }

  console.warn('rng() called before initialization, seeding with 0');
  globalThis.rng = seededRandom(0, 'uninit');
  return globalThis.rng();
}

/**
 * Query entities by component combination - wrapper that accesses globalThis.query
 * This allows entity code to use query() which gets initialized in all workers.
 * query() returns ALL matching entity slots for matching entity types, including inactive pooled slots.
 *
 * @param {Array<Component>} componentClasses - Array of component classes to query
 * @returns {Uint16Array} - Indices of entities that have ALL specified components
 *
 * @example
 * // Inside entity code (Prey.tick(), etc.):
 * const allPredators = query([RigidBody, PredatorBehavior]);
 * const activeSprites = queryActiveEntities([SpriteRenderer]);
 *
 * // Query helpers are worker globals, not part of the public WEED namespace.
 */
export function query(componentClasses) {
  if (typeof globalThis.query === 'function') {
    return globalThis.query(componentClasses);
  }

  // Not available in main thread context
  console.warn('[query] Query system only available in worker context');
  return new Uint16Array(0);
}

/**
 * Query ACTIVE entities by component combination - wrapper that accesses globalThis.queryActiveEntities
 * This allows entity code to use queryActiveEntities() in any worker context.
 * Requires a precomputed active query.
 *
 * @param {Array<Component>} componentClasses - Array of component classes to query
 * @returns {Uint16Array} - Active entity indices
 */
export function queryActiveEntities(componentClasses) {
  if (typeof globalThis.queryActiveEntities === 'function') {
    return globalThis.queryActiveEntities(componentClasses);
  }

  console.warn('[queryActiveEntities] Query system only available in worker context');
  return new Uint16Array(0);
}

/**
 * Explicit slow active query path for ad hoc component combinations.
 * Prefer GameObject/type APIs or precomputed queries in hot code.
 *
 * @param {Array<Component>} componentClasses - Array of component classes to query
 * @returns {Uint16Array} - Active entity indices
 */
export function queryActiveEntitiesSlow(componentClasses) {
  if (typeof globalThis.queryActiveEntitiesSlow === 'function') {
    return globalThis.queryActiveEntitiesSlow(componentClasses);
  }

  console.warn('[queryActiveEntitiesSlow] Query system only available in worker context');
  return new Uint16Array(0);
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
/** Canvas usable on main thread or in workers (OffscreenCanvas). */
export function create2dCanvas(width = 1, height = 1) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  throw new Error('No canvas API available');
}

export function createCircularGradientCanvas(radius = LIGHT_GRADIENT_TEXTURE_RADIUS, color = 0xffffff) {
  radius = Math.round(radius);
  const size = radius * 2;
  const canvas = create2dCanvas(size, size);
  const ctx = canvas.getContext('2d');

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
 * Soft-disk RGBA into an existing ImageData buffer (length size*size*4).
 * Alpha = max(0, 1 - d²), d = distance from center / radius.
 */
export function fillMetaballRgba(data, size, radius, color = 0xffffff) {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const cx = radius - 0.5;
  const cy = radius - 0.5;
  const invR = 1 / radius;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) * invR;
      const dy = (y - cy) * invR;
      const d2 = dx * dx + dy * dy;
      const a = d2 >= 1 ? 0 : 1 - d2;
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = (a * 255 + 0.5) | 0;
    }
  }
}

/**
 * Soft disk for fluid / metaball accumulation. Alpha = max(0, 1 - d²)
 * where d is distance from center normalized to [0, 1] by radius.
 *
 * @param {number} [radius=METABALL_TEXTURE_RADIUS]
 * @param {number} [color=0xffffff] 0xRRGGBB
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function createMetaballCanvas(radius = METABALL_TEXTURE_RADIUS, color = 0xffffff) {
  radius = Math.max(1, Math.round(radius));
  const size = radius * 2;
  const canvas = create2dCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  fillMetaballRgba(img.data, size, radius, color);
  ctx.putImageData(img, 0, 0);
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
  const canvas = create2dCanvas(width, height);
  const ctx = canvas.getContext('2d');

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

/** Wrapper params in loadSingleScript — must not emit `const X = ...` for these. */
const BLOB_SCRIPT_PARAM_NAMES = new Set([
  'exports', 'WEED', 'GameObject', 'Component', 'FSM', 'FSMState', 'Transform', 'RigidBody',
  'Collider', 'SpriteRenderer', 'ParticleComponent', 'ShadowCaster', 'LightEmitter',
  'FlashComponent', 'DecorationComponent', 'ParticleEmitter', 'DecorationPool', 'Flash',
  'Mouse', 'Camera', 'NavGrid', 'Ray', 'ShapeType', 'rng', 'randomColor', 'distanceSq2D',
  'getDirectionFromAngle', 'getDirection8FromVector', 'containerRadius', 'SpriteSheetRegistry',
  'Keyboard', 'SoundManager', 'CollisionListener', 'CameraInOutListener', 'JointBreakListener',
  'Grab', 'BLEND_MODES', 'DEFAULT_LAYERS', 'CAMERA_TYPES', 'DECAL_STAMPS_BLEND_MODE',
  'DEBUG_FLAGS', 'DEBUG_SELECTED_ENTITY_OFFSET',
]);

function isEngineImportSpec(spec) {
  return (
    spec.startsWith('/src/') ||
    spec.startsWith('http://') ||
    spec.startsWith('https://') ||
    spec.startsWith('blob:') ||
    spec.startsWith('data:')
  );
}

function blobImportBinding(imported, local) {
  if (!local || !/^[A-Za-z_$][\w$]*$/.test(local) || BLOB_SCRIPT_PARAM_NAMES.has(local)) {
    return '';
  }
  const from = imported && /^[A-Za-z_$][\w$]*$/.test(imported) ? imported : local;
  return `if (!globalThis.${from}) throw new Error('blob-dep ${from}');
const ${local} = globalThis.${from};`;
}

/**
 * Blob eval cannot `import()`. Devs still write `import { MySoldier }`.
 * Engine specs are dropped (wrapper params). Sibling/demo imports become
 * `const Name = globalThis.Name` so tick sees the class after it is registered.
 */
export function rewriteBlobImports(scriptText) {
  return scriptText
    .replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g, (match, names, spec) => {
      if (isEngineImportSpec(spec)) return '';
      return names
        .split(',')
        .map((part) => {
          const bits = part.trim().split(/\s+as\s+/);
          const imported = bits[0].trim();
          const local = bits[bits.length - 1].trim();
          return blobImportBinding(imported, local);
        })
        .filter(Boolean)
        .join('\n');
    })
    .replace(/import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]+['"]\s*;?/g, '')
    .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g, (match, name, spec) => {
      if (isEngineImportSpec(spec) || name === 'WEED') return '';
      return blobImportBinding(name, name);
    })
    .replace(/import\s+['"][^'"]+['"]\s*;?/g, '');
}

/**
 * Relative / demo / test module specifiers blob-eval must fetch.
 * `/src/` is already in the worker bundle — do not fetch it as an entity script.
 */
export function collectBlobScriptDeps(scriptText, scriptUrl) {
  const deps = [];
  const re = /(?:from|import)\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(scriptText))) {
    const spec = m[1];
    if (
      spec.startsWith('/src/') ||
      spec.startsWith('http://') ||
      spec.startsWith('https://') ||
      spec.startsWith('blob:') ||
      spec.startsWith('data:')
    ) {
      continue;
    }
    if (spec.startsWith('.') || spec.startsWith('/demos/') || spec.startsWith('/tests/')) {
      try {
        deps.push(new URL(spec, scriptUrl).href);
      } catch {
        /* invalid specifier */
      }
    }
  }
  return deps;
}

/** DFS post-order so imported files eval before the importer. */
export async function expandBlobEntityScripts(entryUrls, fetchText = fetch) {
  const ordered = [];
  const seen = new Set();

  async function visit(url) {
    if (seen.has(url)) return;
    seen.add(url);
    try {
      const response = await fetchText(url);
      if (response && response.ok) {
        const text = await response.text();
        const deps = collectBlobScriptDeps(text, url);
        for (let i = 0; i < deps.length; i++) {
          await visit(deps[i]);
        }
      }
    } catch {
      /* loadSingleScript reports fetch failures */
    }
    ordered.push(url);
  }

  for (let i = 0; i < entryUrls.length; i++) {
    await visit(entryUrls[i]);
  }
  return ordered;
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

  // Blob: DFS then retry (Function eval, missing sibling on globalThis).
  // Module import() failures stick in the module map — retry cannot unpoison.
  let pendingScripts = isBlobWorker
    ? await expandBlobEntityScripts(scriptsToLoad)
    : [...scriptsToLoad];

  if (!isBlobWorker) {
    for (const scriptPath of pendingScripts) {
      await loadSingleScript(
        scriptPath,
        loadedClasses,
        globalContext,
        isBlobWorker,
        contextName,
        verbose
      );
    }
  } else {
    const maxPasses = 8;
    let pass = 0;

    while (pendingScripts.length > 0 && pass < maxPasses) {
      pass++;
      const failedScripts = [];

      for (const scriptPath of pendingScripts) {
        const success = await loadSingleScript(
          scriptPath,
          loadedClasses,
          globalContext,
          isBlobWorker,
          contextName,
          verbose
        );
        if (!success) {
          failedScripts.push(scriptPath);
        }
      }

      if (failedScripts.length === pendingScripts.length) {
        if (verbose) {
          console.warn(
            `⚠️ ${contextName}: Could not load ${failedScripts.length} scripts after ${pass} passes`
          );
        }
        break;
      }

      pendingScripts = failedScripts;
    }
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
      let transformedScript = rewriteBlobImports(scriptText)
        // Remove const/let destructuring from WEED (we provide these as parameters).
        // Also strip destructuring of any local that came from WEED (e.g.
        // `const { ShapeType } = enums;` after `const { enums } = WEED;` was stripped).
        // The names destructured from `enums` collide with same-named Function
        // parameters below (`ShapeType`, etc.) and would crash the wrapper with
        // "Identifier 'X' has already been declared". Stripping the line is safe
        // because every member that scripts use from `enums` is already provided
        // as a wrapper parameter.
        .replace(/const\s*\{[\s\S]*?\}\s*=\s*WEED\s*;?/g, '')
        .replace(/let\s*\{[\s\S]*?\}\s*=\s*WEED\s*;?/g, '')
        .replace(/const\s*\{[\s\S]*?\}\s*=\s*enums\s*;?/g, '')
        .replace(/let\s*\{[\s\S]*?\}\s*=\s*enums\s*;?/g, '')
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

      // Build the wrapper with WEED globals as function parameters.
      // All enum members are passed individually so scripts can reference them
      // even after we strip their `const { X } = enums;` line above.
      const moduleWrapper = new Function(
        'exports', 'WEED',
        'GameObject', 'Component', 'FSM', 'FSMState', 'Transform', 'RigidBody', 'Collider',
        'SpriteRenderer', 'ParticleComponent', 'ShadowCaster', 'LightEmitter', 'FlashComponent',
        'DecorationComponent', 'ParticleEmitter', 'DecorationPool', 'Flash', 'Mouse', 'Camera',
        'NavGrid', 'Ray', 'ShapeType', 'rng', 'randomColor', 'distanceSq2D', 'getDirectionFromAngle', 'getDirection8FromVector',
        'containerRadius', 'SpriteSheetRegistry', 'Keyboard', 'SoundManager',
        'CollisionListener', 'CameraInOutListener', 'JointBreakListener', 'Grab',
        // Enum members (previously only ShapeType — anything destructured from
        // `enums` in user scripts must be provided here, otherwise the script
        // gets a ReferenceError after we strip the destructuring line).
        'BLEND_MODES', 'DEFAULT_LAYERS', 'CAMERA_TYPES', 'DECAL_STAMPS_BLEND_MODE',
        'DEBUG_FLAGS', 'DEBUG_SELECTED_ENTITY_OFFSET',
        transformedScript
      );

      // Get references - in workers, classes are directly on self, not self.WEED
      const WEED = globalContext.WEED || globalContext;
      const g = globalContext; // shorthand for getting classes
      const e = WEED.enums || {};

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
          g.ShapeType || e.ShapeType,
          g.rng || WEED.rng,
          g.randomColor || WEED.randomColor,
          g.distanceSq2D || WEED.distanceSq2D,
          g.getDirectionFromAngle || WEED.getDirectionFromAngle,
          g.getDirection8FromVector || WEED.getDirection8FromVector,
          g.containerRadius || WEED.containerRadius,
          g.SpriteSheetRegistry || WEED.SpriteSheetRegistry,
          g.Keyboard || WEED.Keyboard,
          g.SoundManager || WEED.SoundManager,
          g.CollisionListener || WEED.CollisionListener,
          g.CameraInOutListener || WEED.CameraInOutListener,
          g.JointBreakListener || WEED.JointBreakListener,
          g.Grab || WEED.Grab,
          e.BLEND_MODES,
          e.DEFAULT_LAYERS,
          e.CAMERA_TYPES,
          e.DECAL_STAMPS_BLEND_MODE,
          e.DEBUG_FLAGS,
          e.DEBUG_SELECTED_ENTITY_OFFSET
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
    if (isBlobWorker) {
      if (verbose) {
        console.warn(`  ⏳ ${contextName}: Deferred ${scriptPath} (dependency not ready)`);
      }
      return false;
    }
    console.error(`${contextName}: failed to load ${scriptPath}`, error);
    return false;
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

  // These use dedicated pool sizes (maxParticles / maxDecorations / maxBullets), not globalEntityCount.
  // They are absent from componentPools, so pool?.count || defaultEntityCount would use the entity count
  // and recreate views larger than the SharedArrayBuffer (RangeError). AbstractWorker.initializeCommonBuffers
  // already connects them to the correct SABs.
  const poolSizedComponentNames = new Set([
    'ParticleComponent',
    'DecorationComponent',
    'BulletComponent',
  ]);

  for (const [componentName, ComponentClass] of componentMap) {
    const pool = componentPools?.[componentName];
    const buffer = componentBuffers?.[componentName];

    // No componentPools row → count would fall back to globalEntityCount (wrong for these types).
    // If a scene later adds explicit pool metadata, initialize normally.
    if (poolSizedComponentNames.has(componentName) && !pool) {
      continue;
    }

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
  return Object.keys(ComponentClass.ARRAY_SCHEMA).filter((key) => {
    if (key === 'active') return false;
    const entry = ComponentClass.ARRAY_SCHEMA[key];
    // Skip strided multi-element fields (e.g. polygon verts)
    if (entry && typeof entry === 'object' && entry.type && (entry.length | 0) > 1) return false;
    return true;
  });
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