// AngularSweep.js - Visibility polygon computation for circle occluders
//
// Computes the area visible from a light source, blocked by circular occluders.
// Uses angular sweep: for each circle, compute 2 tangent angles from the light,
// then sweep all events sorted by angle to build the visibility polygon.
//
// All functions are allocation-free in the hot path (pre-allocated output arrays).

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-5;
const MAX_ARC_STEP = Math.PI / 8; // ~22.5° max gap between boundary vertices

/**
 * Normalize angle to [-PI, PI)
 */
function normalizeAngle(a) {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * Compute the two tangent angles from a point to a circle.
 * Returns the half-angle offset from the center angle.
 * tangentAngle1 = angleToCenter - offset
 * tangentAngle2 = angleToCenter + offset
 *
 * Returns -1 if the point is inside the circle (no valid tangent).
 */
function tangentHalfAngle(dist, radius) {
  if (dist <= radius) return -1;
  return Math.asin(radius / dist);
}

/**
 * Ray-circle intersection: returns distance from ray origin to the nearest
 * intersection point with the circle, or Infinity if no intersection.
 *
 * Ray: origin (ox, oy), direction (cos(angle), sin(angle))
 * Circle: center (cx, cy), radius r
 */
function rayCircleDist(ox, oy, angle, cx, cy, r) {
  const dx = cx - ox;
  const dy = cy - oy;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  // Project circle center onto ray
  const tca = dx * dirX + dy * dirY;
  if (tca < 0) return Infinity; // circle is behind ray

  const d2 = dx * dx + dy * dy - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return Infinity; // ray misses circle

  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;

  // t0 < 0 means origin is inside circle
  return t0 > 0 ? t0 : tca + thc;
}

// Pre-allocated event pool (reused across calls)
// Each event: angle, circleIndex, isOpen (1=open, 0=close)
const MAX_EVENTS = 2048;
const _eventAngles = new Float64Array(MAX_EVENTS);
const _eventCircleIdx = new Int32Array(MAX_EVENTS);
const _eventType = new Uint8Array(MAX_EVENTS); // 1=open, 0=close
const _sortIndices = new Int32Array(MAX_EVENTS);

// Active circle set (simple array, max simultaneous overlaps)
const MAX_ACTIVE = 256;
const _activeCircles = new Int32Array(MAX_ACTIVE);
let _activeCount = 0;
let _warnedEventOverflow = false;
let _warnedActiveOverflow = false;

function warnEventOverflow(circleCount) {
  if (_warnedEventOverflow) return;
  _warnedEventOverflow = true;
  console.warn(
    `[AngularSweep] Event cap exceeded (${MAX_EVENTS} max events, ${circleCount} circles considered). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

function warnActiveOverflow() {
  if (_warnedActiveOverflow) return;
  _warnedActiveOverflow = true;
  console.warn(
    `[AngularSweep] Active occluder cap exceeded (${MAX_ACTIVE} max simultaneous occluders). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

/**
 * Build a visibility polygon from a light source, blocked by circle occluders.
 *
 * @param {number} lightX - Light source X position
 * @param {number} lightY - Light source Y position
 * @param {number} maxRadius - Maximum light influence radius
 * @param {Float32Array} circleX - Circle center X positions
 * @param {Float32Array} circleY - Circle center Y positions
 * @param {Float32Array} circleR - Circle radii
 * @param {Float32Array} circleOpacity - Circle opacity (0-1)
 * @param {number} circleCount - Number of circles to process
 * @param {Float32Array} outX - Output polygon vertex X (pre-allocated)
 * @param {Float32Array} outY - Output polygon vertex Y (pre-allocated)
 * @param {number} maxVertices - Max output vertices
 * @returns {number} Number of vertices written
 */
export function buildVisibilityPolygon(
  lightX, lightY, maxRadius,
  circleX, circleY, circleR, circleOpacity,
  circleCount, outX, outY, maxVertices
) {
  if (circleCount === 0) {
    return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
  }

  // Build events: 2 tangent events per circle
  let eventCount = 0;

  for (let i = 0; i < circleCount; i++) {
    const dx = circleX[i] - lightX;
    const dy = circleY[i] - lightY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = circleR[i];

    if (dist <= r) continue; // light is inside this circle, skip
    if (dist - r > maxRadius) continue; // too far, skip

    const centerAngle = Math.atan2(dy, dx);
    const halfAngle = tangentHalfAngle(dist, r);
    if (halfAngle < 0) continue;

    const openAngle = normalizeAngle(centerAngle - halfAngle);
    const closeAngle = normalizeAngle(centerAngle + halfAngle);

    if (eventCount + 2 > MAX_EVENTS) {
      warnEventOverflow(circleCount);
      return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
    }

    _eventAngles[eventCount] = openAngle;
    _eventCircleIdx[eventCount] = i;
    _eventType[eventCount] = 1; // open
    eventCount++;

    _eventAngles[eventCount] = closeAngle;
    _eventCircleIdx[eventCount] = i;
    _eventType[eventCount] = 0; // close
    eventCount++;
  }

  if (eventCount === 0) {
    return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
  }

  // Sort events by angle
  for (let i = 0; i < eventCount; i++) _sortIndices[i] = i;
  sortEventsByAngle(eventCount);

  // Sweep: build polygon vertices
  _activeCount = 0;

  // Initialize active set: find circles whose arc spans angle = -PI (the sweep start)
  for (let i = 0; i < circleCount; i++) {
    const dx = circleX[i] - lightX;
    const dy = circleY[i] - lightY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = circleR[i];
    if (dist <= r || dist - r > maxRadius) continue;

    const centerAngle = Math.atan2(dy, dx);
    const halfAngle = tangentHalfAngle(dist, r);
    if (halfAngle < 0) continue;

    const openAngle = normalizeAngle(centerAngle - halfAngle);
    const closeAngle = normalizeAngle(centerAngle + halfAngle);

    // Circle is active at -PI if its arc wraps around (open > close)
    if (openAngle > closeAngle) {
      if (_activeCount < MAX_ACTIVE) {
        _activeCircles[_activeCount++] = i;
      } else {
        warnActiveOverflow();
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }
    }
  }

  let vertCount = 0;

  const startAngle = -Math.PI;
  const endAngle = Math.PI - EPSILON;

  // Emit vertex at the sweep start (-PI)
  vertCount = emitVertex(lightX, lightY, startAngle, maxRadius,
    circleX, circleY, circleR, circleOpacity,
    outX, outY, vertCount, maxVertices);

  let lastAngle = startAngle;

  // Process events in angle order
  for (let e = 0; e < eventCount; e++) {
    const idx = _sortIndices[e];
    const angle = _eventAngles[idx];
    const ci = _eventCircleIdx[idx];
    const isOpen = _eventType[idx];

    // Fill arc gap: insert intermediate boundary vertices when the angular
    // gap between the previous vertex and this event is large. Without these,
    // the triangle-fan chord cuts across the circle, creating visible cutoffs.
    const preAngle = angle - EPSILON;
    vertCount = emitArcVertices(lightX, lightY, lastAngle, preAngle, maxRadius,
      circleX, circleY, circleR, circleOpacity,
      outX, outY, vertCount, maxVertices);

    // Emit vertex just BEFORE the event (at current closest occluder)
    if (vertCount < maxVertices) {
      vertCount = emitVertex(lightX, lightY, preAngle, maxRadius,
        circleX, circleY, circleR, circleOpacity,
        outX, outY, vertCount, maxVertices);
    }

    // Update active set
    if (isOpen) {
      if (_activeCount < MAX_ACTIVE) {
        _activeCircles[_activeCount++] = ci;
      } else {
        warnActiveOverflow();
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }
    } else {
      for (let a = 0; a < _activeCount; a++) {
        if (_activeCircles[a] === ci) {
          _activeCircles[a] = _activeCircles[--_activeCount];
          break;
        }
      }
    }

    // Emit vertex just AFTER the event (at new closest occluder)
    const postAngle = angle + EPSILON;
    if (vertCount < maxVertices) {
      vertCount = emitVertex(lightX, lightY, postAngle, maxRadius,
        circleX, circleY, circleR, circleOpacity,
        outX, outY, vertCount, maxVertices);
    }

    lastAngle = postAngle;
  }

  // Fill arc gap from last event to end angle
  vertCount = emitArcVertices(lightX, lightY, lastAngle, endAngle, maxRadius,
    circleX, circleY, circleR, circleOpacity,
    outX, outY, vertCount, maxVertices);

  // Close the polygon: emit vertex at end angle (just before +PI)
  if (vertCount < maxVertices) {
    vertCount = emitVertex(lightX, lightY, endAngle, maxRadius,
      circleX, circleY, circleR, circleOpacity,
      outX, outY, vertCount, maxVertices);
  }

  return vertCount;
}

/**
 * Emit a visibility polygon vertex at the given angle.
 * Casts a ray and finds the nearest blocking circle (if any).
 * Returns the new vertex count.
 */
function emitVertex(
  lightX, lightY, angle, maxRadius,
  circleX, circleY, circleR, circleOpacity,
  outX, outY, vertCount, maxVertices
) {
  if (vertCount >= maxVertices) return vertCount;

  let minDist = maxRadius;

  // Check all active circles for the closest intersection
  for (let a = 0; a < _activeCount; a++) {
    const ci = _activeCircles[a];
    const d = rayCircleDist(lightX, lightY, angle, circleX[ci], circleY[ci], circleR[ci]);
    if (d < minDist) {
      minDist = d;
    }
  }

  const vx = lightX + Math.cos(angle) * minDist;
  const vy = lightY + Math.sin(angle) * minDist;

  // Deduplicate: skip if very close to previous vertex
  if (vertCount > 0) {
    const prevX = outX[vertCount - 1];
    const prevY = outY[vertCount - 1];
    const dx = vx - prevX;
    const dy = vy - prevY;
    if (dx * dx + dy * dy < 0.25) return vertCount; // less than 0.5 world units apart
  }

  outX[vertCount] = vx;
  outY[vertCount] = vy;
  return vertCount + 1;
}

/**
 * Insert intermediate boundary vertices when the angular gap between
 * fromAngle and toAngle exceeds MAX_ARC_STEP. Each intermediate vertex
 * is ray-cast through emitVertex so active occluders are respected.
 */
function emitArcVertices(
  lightX, lightY, fromAngle, toAngle, maxRadius,
  circleX, circleY, circleR, circleOpacity,
  outX, outY, vertCount, maxVertices
) {
  const gap = toAngle - fromAngle;
  if (gap <= MAX_ARC_STEP) return vertCount;

  const steps = Math.ceil(gap / MAX_ARC_STEP);
  const step = gap / steps;

  for (let s = 1; s < steps && vertCount < maxVertices; s++) {
    const angle = fromAngle + s * step;
    vertCount = emitVertex(lightX, lightY, angle, maxRadius,
      circleX, circleY, circleR, circleOpacity,
      outX, outY, vertCount, maxVertices);
  }

  return vertCount;
}

/**
 * Build a full circle polygon (no occluders case).
 * Approximates with N vertices.
 */
function buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices) {
  const segments = Math.min(Math.ceil(TWO_PI / MAX_ARC_STEP), maxVertices);
  const step = TWO_PI / segments;

  for (let i = 0; i < segments; i++) {
    const angle = -Math.PI + i * step;
    outX[i] = lightX + Math.cos(angle) * maxRadius;
    outY[i] = lightY + Math.sin(angle) * maxRadius;
  }

  return segments;
}

/**
 * Sort events by angle (insertion sort - fast for small arrays, no allocations)
 */
function sortEventsByAngle(count) {
  for (let i = 1; i < count; i++) {
    const key = _sortIndices[i];
    const keyAngle = _eventAngles[key];
    let j = i - 1;
    while (j >= 0 && _eventAngles[_sortIndices[j]] > keyAngle) {
      _sortIndices[j + 1] = _sortIndices[j];
      j--;
    }
    _sortIndices[j + 1] = key;
  }
}
