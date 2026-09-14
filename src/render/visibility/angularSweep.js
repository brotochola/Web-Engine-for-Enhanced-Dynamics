// AngularSweep.js - Visibility polygon for circle + convex polygon occluders
//
// Computes the area visible from a light source, blocked by occluders.
// Circles use analytical tangents; boxes/polygons use silhouette vertex events
// and ray–edge hits. Allocation-free hot path (pre-allocated output / scratch).

import { normalizeAngleSigned } from '../../core/utils.js';

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-5;
/** Empty-light disc tessellation only (not free-arc densify). */
const MAX_ARC_STEP = Math.PI / 16;
/** Max free sector before inserting midpoints. Chord stays outside R with FREE_OVERSIZE. */
const MAX_FREE_GAP = Math.PI / 2;
/** 1/cos(MAX_FREE_GAP/2) — chord of a max free sector lies on/outside radius R. */
const FREE_OVERSIZE = 1 / Math.cos(MAX_FREE_GAP * 0.5);

/** Circle occluder (analytical tangents + ray-circle). */
export const OCC_CIRCLE = 0;
/** Convex polygon occluder (world-space verts in shared pool). */
export const OCC_POLY = 1;

/**
 * Compute the two tangent angles from a point to a circle.
 * Returns -1 if the point is inside the circle (no valid tangent).
 */
function tangentHalfAngle(dist, radius) {
  if (dist <= radius) return -1;
  return Math.asin(radius / dist);
}

/**
 * Ray-circle intersection: nearest positive hit distance, or Infinity.
 * Pass unit dir (cos/sin of ray angle) — no trig here.
 */
function rayCircleDist(ox, oy, dirX, dirY, cx, cy, r) {
  const dx = cx - ox;
  const dy = cy - oy;

  const tca = dx * dirX + dy * dirY;
  if (tca < 0) return Infinity;

  const d2 = dx * dx + dy * dy - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return Infinity;

  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 > 0 ? t0 : tca + thc;
}

/**
 * Ray vs convex polygon edges: nearest positive hit, or Infinity.
 * Pass unit dir (cos/sin of ray angle) — no trig here.
 */
function rayPolyDist(ox, oy, dirX, dirY, vertsX, vertsY, start, count) {
  let minT = Infinity;

  for (let i = 0; i < count; i++) {
    const i0 = start + i;
    const i1 = start + ((i + 1) % count);
    const ax = vertsX[i0];
    const ay = vertsY[i0];
    const bx = vertsX[i1];
    const by = vertsY[i1];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dirX * ey - dirY * ex;
    if (Math.abs(denom) < 1e-12) continue;

    const fx = ax - ox;
    const fy = ay - oy;
    const t = (fx * ey - fy * ex) / denom;
    const u = (fx * dirY - fy * dirX) / denom;
    if (t > EPSILON && u >= 0 && u <= 1 && t < minT) {
      minT = t;
    }
  }
  return minT;
}

/** Cross (a - o) × (b - o) */
function crossOrigin(ox, oy, ax, ay, bx, by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/**
 * Point-in-convex (CCW or CW). Uses consistent half-plane test.
 */
function pointInConvex(px, py, vertsX, vertsY, start, count) {
  if (count < 3) return false;
  let sign = 0;
  for (let i = 0; i < count; i++) {
    const i0 = start + i;
    const i1 = start + ((i + 1) % count);
    const c = crossOrigin(vertsX[i0], vertsY[i0], vertsX[i1], vertsY[i1], px, py);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Left/right tangent vertex indices from external point to convex poly.
 * Returns false if light is inside or poly is degenerate.
 */
function polyTangentIndices(lx, ly, vertsX, vertsY, start, count, out) {
  if (count < 3) return false;
  if (pointInConvex(lx, ly, vertsX, vertsY, start, count)) return false;

  let iLeft = 0;
  let iRight = 0;
  for (let i = 1; i < count; i++) {
    const xi = vertsX[start + i];
    const yi = vertsY[start + i];
    if (crossOrigin(lx, ly, vertsX[start + iRight], vertsY[start + iRight], xi, yi) > 0) {
      iRight = i;
    }
    if (crossOrigin(lx, ly, vertsX[start + iLeft], vertsY[start + iLeft], xi, yi) < 0) {
      iLeft = i;
    }
  }
  out[0] = iLeft;
  out[1] = iRight;
  return true;
}

const MAX_EVENTS = 2048;
const _eventAngles = new Float64Array(MAX_EVENTS);
const _eventOccIdx = new Int32Array(MAX_EVENTS);
const _eventType = new Uint8Array(MAX_EVENTS); // 1=open, 0=close
const _sortIndices = new Int32Array(MAX_EVENTS);

const MAX_OCC_CACHE = 1024;
const _occOpen = new Float64Array(MAX_OCC_CACHE);
const _occClose = new Float64Array(MAX_OCC_CACHE);
const _occValid = new Uint8Array(MAX_OCC_CACHE);

const MAX_ACTIVE = 256;
const _activeOcc = new Int32Array(MAX_ACTIVE);
let _activeCount = 0;

/** Prebaked unit circle for empty-light full disc (step = MAX_ARC_STEP). */
const FULL_CIRCLE_SEGS = Math.ceil(TWO_PI / MAX_ARC_STEP);
const _fullCircleC = new Float64Array(FULL_CIRCLE_SEGS);
const _fullCircleS = new Float64Array(FULL_CIRCLE_SEGS);
for (let i = 0; i < FULL_CIRCLE_SEGS; i++) {
  const a = -Math.PI + i * (TWO_PI / FULL_CIRCLE_SEGS);
  _fullCircleC[i] = Math.cos(a);
  _fullCircleS[i] = Math.sin(a);
}
let _warnedEventOverflow = false;
let _warnedActiveOverflow = false;

const _tangentOut = new Int32Array(2);

function warnEventOverflow(occCount) {
  if (_warnedEventOverflow) return;
  _warnedEventOverflow = true;
  console.warn(
    `[AngularSweep] Event cap exceeded (${MAX_EVENTS} max events, ${occCount} occluders). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

function warnActiveOverflow() {
  if (_warnedActiveOverflow) return;
  _warnedActiveOverflow = true;
  console.warn(
    `[AngularSweep] Active occluder cap exceeded (${MAX_ACTIVE} max simultaneous). ` +
    `Falling back to full-circle visibility for this light.`
  );
}

/**
 * Build a visibility polygon from a light source blocked by mixed occluders.
 *
 * @param {number} lightX
 * @param {number} lightY
 * @param {number} maxRadius
 * @param {Uint8Array} kind - OCC_CIRCLE | OCC_POLY per occluder
 * @param {Float32Array} cx - circle center X / poly unused
 * @param {Float32Array} cy - circle center Y / poly unused
 * @param {Float32Array} cr - circle radius / poly unused
 * @param {Int32Array} vertStart - poly vertex pool start index
 * @param {Uint8Array|Int32Array} vertCount - poly vertex count
 * @param {Float32Array} vertsX - shared world-space vertex pool
 * @param {Float32Array} vertsY
 * @param {number} occCount
 * @param {Float32Array} outX
 * @param {Float32Array} outY
 * @param {number} maxVertices
 * @returns {number} vertex count written
 */
export function buildVisibilityPolygon(
  lightX, lightY, maxRadius,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  occCount, outX, outY, maxVertices
) {
  if (occCount === 0) {
    return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
  }

  let eventCount = 0;
  const cacheN = occCount < MAX_OCC_CACHE ? occCount : MAX_OCC_CACHE;
  for (let i = 0; i < cacheN; i++) _occValid[i] = 0;

  for (let i = 0; i < occCount; i++) {
    if (kind[i] === OCC_CIRCLE) {
      const dx = cx[i] - lightX;
      const dy = cy[i] - lightY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = cr[i];
      if (dist <= r) continue;
      if (dist - r > maxRadius) continue;

      const centerAngle = Math.atan2(dy, dx);
      const halfAngle = tangentHalfAngle(dist, r);
      if (halfAngle < 0) continue;

      const openAngle = normalizeAngleSigned(centerAngle - halfAngle);
      const closeAngle = normalizeAngleSigned(centerAngle + halfAngle);
      if (i < MAX_OCC_CACHE) {
        _occOpen[i] = openAngle;
        _occClose[i] = closeAngle;
        _occValid[i] = 1;
      }

      if (eventCount + 2 > MAX_EVENTS) {
        warnEventOverflow(occCount);
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }

      _eventAngles[eventCount] = openAngle;
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 1;
      eventCount++;

      _eventAngles[eventCount] = closeAngle;
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 0;
      eventCount++;
    } else {
      const vs = vertStart[i];
      const vc = vertCount[i] | 0;
      if (vc < 3) continue;

      // Skip if entirely beyond influence (compare squared — no sqrt)
      let minDistSq = Infinity;
      const maxRadiusSq = maxRadius * maxRadius;
      for (let v = 0; v < vc; v++) {
        const dx = vertsX[vs + v] - lightX;
        const dy = vertsY[vs + v] - lightY;
        const dSq = dx * dx + dy * dy;
        if (dSq < minDistSq) minDistSq = dSq;
      }
      if (minDistSq > maxRadiusSq) continue;

      if (!polyTangentIndices(lightX, lightY, vertsX, vertsY, vs, vc, _tangentOut)) {
        continue; // light inside poly
      }

      const iLeft = _tangentOut[0];
      const iRight = _tangentOut[1];
      const openN = normalizeAngleSigned(Math.atan2(
        vertsY[vs + iLeft] - lightY,
        vertsX[vs + iLeft] - lightX
      ));
      const closeN = normalizeAngleSigned(Math.atan2(
        vertsY[vs + iRight] - lightY,
        vertsX[vs + iRight] - lightX
      ));
      if (i < MAX_OCC_CACHE) {
        _occOpen[i] = openN;
        _occClose[i] = closeN;
        _occValid[i] = 1;
      }

      if (eventCount + 2 > MAX_EVENTS) {
        warnEventOverflow(occCount);
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }

      _eventAngles[eventCount] = openN;
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 1;
      eventCount++;

      _eventAngles[eventCount] = closeN;
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 0;
      eventCount++;
    }
  }

  if (eventCount === 0) {
    return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
  }

  for (let i = 0; i < eventCount; i++) _sortIndices[i] = i;
  sortEventsByAngle(eventCount);

  _activeCount = 0;

  // Seed active set at sweep start (-PI) from cached open/close (no second atan2 pass)
  for (let i = 0; i < occCount; i++) {
    if (i >= MAX_OCC_CACHE || !_occValid[i]) continue;
    if (_occOpen[i] > _occClose[i]) {
      if (_activeCount < MAX_ACTIVE) {
        _activeOcc[_activeCount++] = i;
      } else {
        warnActiveOverflow();
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }
    }
  }

  let vertCountOut = 0;
  const startAngle = -Math.PI;
  const endAngle = Math.PI - EPSILON;
  // start ≈ (-1, 0); end ≈ (-1, 0) — fixed dirs, no Math.cos/sin
  const startDirC = -1;
  const startDirS = 0;
  const endDirC = Math.cos(endAngle);
  const endDirS = Math.sin(endAngle);

  vertCountOut = emitVertex(lightX, lightY, startDirC, startDirS, maxRadius,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    outX, outY, vertCountOut, maxVertices);

  let lastAngle = startAngle;

  for (let e = 0; e < eventCount; e++) {
    const idx = _sortIndices[e];
    const angle = _eventAngles[idx];
    const oi = _eventOccIdx[idx];
    const isOpen = _eventType[idx];

    const preAngle = angle - EPSILON;
    vertCountOut = emitArcVertices(lightX, lightY, lastAngle, preAngle, maxRadius,
      kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
      outX, outY, vertCountOut, maxVertices);

    // Pre-toggle sample slightly before event (active-set state before open/close)
    if (vertCountOut < maxVertices) {
      vertCountOut = emitVertex(lightX, lightY, Math.cos(preAngle), Math.sin(preAngle), maxRadius,
        kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
        outX, outY, vertCountOut, maxVertices);
    }

    if (isOpen) {
      if (_activeCount < MAX_ACTIVE) {
        _activeOcc[_activeCount++] = oi;
      } else {
        warnActiveOverflow();
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }
    } else {
      for (let a = 0; a < _activeCount; a++) {
        if (_activeOcc[a] === oi) {
          _activeOcc[a] = _activeOcc[--_activeCount];
          break;
        }
      }
    }

    const postAngle = angle + EPSILON;
    // Post-toggle sample slightly after event
    if (vertCountOut < maxVertices) {
      vertCountOut = emitVertex(lightX, lightY, Math.cos(postAngle), Math.sin(postAngle), maxRadius,
        kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
        outX, outY, vertCountOut, maxVertices);
    }

    lastAngle = postAngle;
  }

  vertCountOut = emitArcVertices(lightX, lightY, lastAngle, endAngle, maxRadius,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    outX, outY, vertCountOut, maxVertices);

  if (vertCountOut < maxVertices) {
    vertCountOut = emitVertex(lightX, lightY, endDirC, endDirS, maxRadius,
      kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
      outX, outY, vertCountOut, maxVertices);
  }

  return vertCountOut;
}

/** @param {number} dirX unit cos @param {number} dirY unit sin — no trig here */
function emitVertex(
  lightX, lightY, dirX, dirY, maxRadius,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  outX, outY, vertCountOut, maxVertices
) {
  if (vertCountOut >= maxVertices) return vertCountOut;

  let minDist = maxRadius;

  for (let a = 0; a < _activeCount; a++) {
    const oi = _activeOcc[a];
    let d;
    if (kind[oi] === OCC_CIRCLE) {
      d = rayCircleDist(lightX, lightY, dirX, dirY, cx[oi], cy[oi], cr[oi]);
    } else {
      d = rayPolyDist(lightX, lightY, dirX, dirY, vertsX, vertsY, vertStart[oi], vertCount[oi] | 0);
    }
    if (d < minDist) minDist = d;
  }

  // Free sky: oversize so fan chord sits outside R; frag clips to uLightRadius
  const placeDist = minDist >= maxRadius - EPSILON ? maxRadius * FREE_OVERSIZE : minDist;
  const vx = lightX + dirX * placeDist;
  const vy = lightY + dirY * placeDist;

  if (vertCountOut > 0) {
    const prevX = outX[vertCountOut - 1];
    const prevY = outY[vertCountOut - 1];
    const dx = vx - prevX;
    const dy = vy - prevY;
    if (dx * dx + dy * dy < 0.25) return vertCountOut;
  }

  outX[vertCountOut] = vx;
  outY[vertCountOut] = vy;
  return vertCountOut + 1;
}

/**
 * Free angular gaps: no 22.5° densify.
 * Split until every sector ≤ MAX_FREE_GAP (one midpoint is NOT enough for
 * ~240° free arcs — that leaves two >90° sectors whose chords cut inside R).
 */
function emitArcVertices(
  lightX, lightY, fromAngle, toAngle, maxRadius,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  outX, outY, vertCountOut, maxVertices
) {
  const gap = toAngle - fromAngle;
  if (gap <= MAX_FREE_GAP || gap <= 0) return vertCountOut;

  // ceil so each step ≤ MAX_FREE_GAP (e.g. 242° → 3 steps → 2 midpoints)
  const steps = Math.ceil(gap / MAX_FREE_GAP);
  const step = gap / steps;
  for (let s = 1; s < steps && vertCountOut < maxVertices; s++) {
    const angle = fromAngle + s * step;
    vertCountOut = emitVertex(lightX, lightY, Math.cos(angle), Math.sin(angle), maxRadius,
      kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
      outX, outY, vertCountOut, maxVertices);
  }
  return vertCountOut;
}

function buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices) {
  const segments = Math.min(FULL_CIRCLE_SEGS, maxVertices);
  for (let i = 0; i < segments; i++) {
    outX[i] = lightX + _fullCircleC[i] * maxRadius;
    outY[i] = lightY + _fullCircleS[i] * maxRadius;
  }
  return segments;
}

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

/**
 * Write 4 world-space corners of an oriented box into a vertex pool.
 * Pass precomputed cos/sin (Transform.rotC/rotS) — no Math.cos/sin here.
 * @returns {number} verts written (always 4)
 */
export function writeOrientedBoxVerts(
  outX, outY, start,
  entityX, entityY, width, height, c, s, offsetX, offsetY
) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const wx = entityX + c * offsetX - s * offsetY;
  const wy = entityY + s * offsetX + c * offsetY;

  // CCW: BL, BR, TR, TL
  const locals = [
    -hw, -hh,
    hw, -hh,
    hw, hh,
    -hw, hh,
  ];
  for (let i = 0; i < 4; i++) {
    const lx = locals[i * 2];
    const ly = locals[i * 2 + 1];
    outX[start + i] = wx + c * lx - s * ly;
    outY[start + i] = wy + s * lx + c * ly;
  }
  return 4;
}

/**
 * Write world-transformed convex polygon verts (local poly + cos/sin + offset).
 * @returns {number} verts written
 */
export function writePolygonVerts(
  outX, outY, start,
  entityX, entityY, c, s, offsetX, offsetY,
  localX, localY, localBase, count
) {
  const wx = entityX + c * offsetX - s * offsetY;
  const wy = entityY + s * offsetX + c * offsetY;
  for (let i = 0; i < count; i++) {
    const lx = localX[localBase + i];
    const ly = localY[localBase + i];
    outX[start + i] = wx + c * lx - s * ly;
    outY[start + i] = wy + s * lx + c * ly;
  }
  return count;
}
