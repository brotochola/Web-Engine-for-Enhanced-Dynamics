// angularSweep.js - Visibility polygon for circle + convex polygon occluders
//
// Computes the area visible from a light source, blocked by occluders.
// Circles use analytical tangents; boxes/polygons use silhouette vertex events
// and ray–edge hits. Allocation-free hot path (pre-allocated output / scratch).

import { normalizeAngleSigned } from '../../util/utils.js';
import { MAX_POLYGON_VERTICES } from '../../util/configDefaults.js';

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-5;
// H-04. endAngle is a module constant, so these directions are too. The sweep
// used to call cos/sin on every light even though the comment below already
// called them fixed.
const END_ANGLE = Math.PI - EPSILON;
const END_DIR_C = Math.cos(END_ANGLE);
const END_DIR_S = Math.sin(END_ANGLE);
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

/** Squared distance from a point to a convex polygon. 0 if inside. Edges, not just corners. */
function distSqToConvex(px, py, vertsX, vertsY, start, count) {
  if (pointInConvex(px, py, vertsX, vertsY, start, count)) return 0;
  let minSq = Infinity;
  for (let i = 0; i < count; i++) {
    const i0 = start + i;
    const i1 = start + ((i + 1) % count);
    const ax = vertsX[i0];
    const ay = vertsY[i0];
    const abx = vertsX[i1] - ax;
    const aby = vertsY[i1] - ay;
    const apx = px - ax;
    const apy = py - ay;
    const abLenSq = abx * abx + aby * aby;
    let t = abLenSq > 0 ? (apx * abx + apy * aby) / abLenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const dx = ax + abx * t - px;
    const dy = ay + aby * t - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < minSq) minSq = dSq;
  }
  return minSq;
}

/** Squared distance from a point to a segment. */
export function segmentDistSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq > 0 ? (apx * abx + apy * aby) / abLenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  return dx * dx + dy * dy;
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
      const maxRadiusSq = maxRadius * maxRadius;
      if (vc < 3) continue;

      // Skip only if the whole polygon is outside the light. Corners of a long
      // slab can all sit past the radius while an edge passes next to the light.
      if (distSqToConvex(lightX, lightY, vertsX, vertsY, vs, vc) > maxRadiusSq) continue;

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
  const endAngle = END_ANGLE;
  // start ≈ (-1, 0); end ≈ (-1, 0) — fixed dirs, no Math.cos/sin
  const startDirC = -1;
  const startDirS = 0;

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

    // H-06. EPSILON is 1e-5, so the pre/post samples are the first-order
    // expansion of one (cos, sin) pair. The angular error is O(ε²) ≈ 1e-10 rad.
    // Gate: the stored polygon stays within 1e-4 world units of the exact samples.
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const preC = ca + EPSILON * sa;
    const preS = sa - EPSILON * ca;

    // Pre-toggle sample slightly before event (active-set state before open/close)
    if (vertCountOut < maxVertices) {
      vertCountOut = emitVertex(lightX, lightY, preC, preS, maxRadius,
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
    const postC = ca - EPSILON * sa;
    const postS = sa + EPSILON * ca;
    // Post-toggle sample slightly after event
    if (vertCountOut < maxVertices) {
      vertCountOut = emitVertex(lightX, lightY, postC, postS, maxRadius,
        kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
        outX, outY, vertCountOut, maxVertices);
    }

    lastAngle = postAngle;
  }

  vertCountOut = emitArcVertices(lightX, lightY, lastAngle, endAngle, maxRadius,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    outX, outY, vertCountOut, maxVertices);

  if (vertCountOut < maxVertices) {
    vertCountOut = emitVertex(lightX, lightY, END_DIR_C, END_DIR_S, maxRadius,
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
  // H-05. Midpoints are an arithmetic progression, at most 4 steps (gap < 2π).
  // Angle addition drifts by a few float64 ulps over that run. The gate, stated
  // before this edit, is 1e-4 world units on the stored polygon — above that
  // drift, below anything the sweep is used for.
  let c = Math.cos(fromAngle);
  let s = Math.sin(fromAngle);
  const ch = Math.cos(step);
  const sh = Math.sin(step);
  for (let k = 1; k < steps && vertCountOut < maxVertices; k++) {
    const nc = c * ch - s * sh;
    const ns = s * ch + c * sh;
    c = nc;
    s = ns;
    vertCountOut = emitVertex(lightX, lightY, c, s, maxRadius,
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

  // CCW: BL, BR, TR, TL. No per-call array.
  outX[start] = wx + c * -hw - s * -hh;
  outY[start] = wy + s * -hw + c * -hh;
  outX[start + 1] = wx + c * hw - s * -hh;
  outY[start + 1] = wy + s * hw + c * -hh;
  outX[start + 2] = wx + c * hw - s * hh;
  outY[start + 2] = wy + s * hw + c * hh;
  outX[start + 3] = wx + c * -hw - s * hh;
  outY[start + 3] = wy + s * -hw + c * hh;
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

const FIXTURE_NONE = 0xffff;
const EDGE_QUANT = 1000;
const _solids = [];
const _edgeMap = new Map();

function growFloats(arr, needed) {
  if (arr.length >= needed) return arr;
  let n = arr.length || 64;
  while (n < needed) n *= 2;
  const next = new Float32Array(n);
  if (arr.length) next.set(arr);
  return next;
}

function edgeKey(ax, ay, bx, by) {
  if (bx < ax || (bx === ax && by < ay)) return `${bx},${by},${ax},${ay}`;
  return `${ax},${ay},${bx},${by}`;
}

/**
 * Boundary segments and solid fill for one compound body.
 * Rebuilt only when the fixture pool revision changes.
 * Edges shared by two triangles are interior and dropped, so a canyon stays a hole.
 * `wantFill` false skips the fill triangles: pre-render reads only the segments,
 * and each worker keeps its own cache (review D1).
 * @returns {{ revision: number, seg: Float32Array, segCount: number, fill: Float32Array, fillVerts: number, hasFill: boolean }}
 */
export function ensureCompoundSolid(
  entityIdx, revision,
  head, next, active, vertCount, vertX, vertY,
  headIdx, poolMax, wantFill = true
) {
  let solid = _solids[entityIdx];
  if (solid && solid.revision === revision && (solid.hasFill || !wantFill)) return solid;
  if (!solid) {
    solid = {
      revision: -1,
      seg: new Float32Array(64),
      segCount: 0,
      fill: new Float32Array(64),
      fillVerts: 0,
      hasFill: false,
    };
    _solids[entityIdx] = solid;
  }
  solid.segCount = 0;
  solid.fillVerts = 0;
  _edgeMap.clear();
  if (head && next && active && vertX && vertY && headIdx != null && headIdx !== FIXTURE_NONE) {
    let cur = headIdx;
    let guard = 0;
    const limit = poolMax | 0;
    let fillN = 0;
    while (cur !== FIXTURE_NONE && guard++ < limit) {
      if (active[cur]) {
        const count = vertCount[cur] | 0;
        if (count >= 3 && count <= MAX_POLYGON_VERTICES) {
          const base = cur * MAX_POLYGON_VERTICES;
          if (wantFill) {
            const need = (fillN + (count - 2) * 3) * 2;
            solid.fill = growFloats(solid.fill, need);
            const fill = solid.fill;
            const x0 = vertX[base];
            const y0 = vertY[base];
            for (let i = 1; i < count - 1; i++) {
              const o = fillN * 2;
              fill[o] = x0;
              fill[o + 1] = y0;
              fill[o + 2] = vertX[base + i];
              fill[o + 3] = vertY[base + i];
              fill[o + 4] = vertX[base + i + 1];
              fill[o + 5] = vertY[base + i + 1];
              fillN += 3;
            }
          }
          for (let i = 0; i < count; i++) {
            const j = i + 1 < count ? i + 1 : 0;
            const ax = vertX[base + i];
            const ay = vertY[base + i];
            const bx = vertX[base + j];
            const by = vertY[base + j];
            const iax = Math.round(ax * EDGE_QUANT);
            const iay = Math.round(ay * EDGE_QUANT);
            const ibx = Math.round(bx * EDGE_QUANT);
            const iby = Math.round(by * EDGE_QUANT);
            if (iax === ibx && iay === iby) continue;
            const key = edgeKey(iax, iay, ibx, iby);
            const prev = _edgeMap.get(key);
            if (prev) prev.n++;
            else _edgeMap.set(key, { n: 1, x0: ax, y0: ay, x1: bx, y1: by });
          }
        }
      }
      cur = next[cur];
    }
    solid.fillVerts = fillN;
    let segN = 0;
    for (const edge of _edgeMap.values()) {
      if (edge.n !== 1) continue;
      solid.seg = growFloats(solid.seg, (segN + 1) * 4);
      const o = segN * 4;
      solid.seg[o] = edge.x0;
      solid.seg[o + 1] = edge.y0;
      solid.seg[o + 2] = edge.x1;
      solid.seg[o + 3] = edge.y1;
      segN++;
    }
    solid.segCount = segN;
  }
  solid.revision = revision;
  solid.hasFill = !!wantFill;
  return solid;
}

/**
 * Whether an outline segment faces a point: the segment's outward normal
 * (dy, -dx) points to the point's side. True for CCW outlines, which is how
 * ensureCompoundSolid keeps each edge (its fixture's order).
 */
export function segmentFacesPoint(x0, y0, x1, y1, px, py) {
  return (y1 - y0) * (px - x0) - (x1 - x0) * (py - y0) > 0;
}

/**
 * World-space boundary edges of a solid that overlap the light disc.
 * @returns {number} how many overlapped the light disc
 */
export function collectSolidSegments(
  solid, entityX, entityY, rotC, rotS, offX, offY, lightX, lightY, radiusSq
) {
  if (!solid || solid.segCount <= 0) return 0;
  const originX = entityX + rotC * offX - rotS * offY;
  const originY = entityY + rotS * offX + rotC * offY;
  const seg = solid.seg;
  const n = solid.segCount;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lx0 = seg[o];
    const ly0 = seg[o + 1];
    const lx1 = seg[o + 2];
    const ly1 = seg[o + 3];
    const x0 = originX + rotC * lx0 - rotS * ly0;
    const y0 = originY + rotS * lx0 + rotC * ly0;
    const x1 = originX + rotC * lx1 - rotS * ly1;
    const y1 = originY + rotS * lx1 + rotC * ly1;
    const dist = segmentDistSq(lightX, lightY, x0, y0, x1, y1);
    if (dist > radiusSq) continue;
    hit++;
    // Solid is on the left of a CCW boundary edge. A light on that side
    // cannot see this edge; the canyon wall faces the empty side and stays.
    const ex = x1 - x0;
    const ey = y1 - y0;
    const tx = lightX - x0;
    const ty = lightY - y0;
    if (ex * ty - ey * tx >= 0) continue;
    writePolarSegment(x0, y0, x1, y1, lightX, lightY);
  }
  return hit;
}

/**
 * ponytail: 512 bins is about 0.7°. A canyon narrower than one bin at that
 * distance can seal. More bins is the upgrade; the visibility slot already
 * allows 5000 vertices.
 */
export const POLAR_BINS = 512;
const POLAR_BIN_SCALE = POLAR_BINS / TWO_PI;
const _polarDist = new Float32Array(POLAR_BINS);
// The sweep polygon, copied because in and out may alias. Grows to the largest
// sweep seen: maxPolygonVertices has no cap.
let _holdX = new Float32Array(8192);
let _holdY = new Float32Array(8192);
let _polarRadius = 0;
let _polarActive = 0;

export function clearPolarBins(radius) {
  const r = radius > 0 ? radius : 0;
  _polarRadius = r;
  _polarActive = 0;
  _polarDist.fill(r);
}

export function polarBinsActive() {
  return _polarActive;
}

function raySegT(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const fx = ax - ox;
  const fy = ay - oy;
  const t = (fx * ey - fy * ex) / denom;
  const u = (fx * dy - fy * dx) / denom;
  if (t > 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) return t;
  return Infinity;
}

function writePolarSegment(x0, y0, x1, y1, lx, ly) {
  let open = normalizeAngleSigned(Math.atan2(y0 - ly, x0 - lx));
  let close = normalizeAngleSigned(Math.atan2(y1 - ly, x1 - lx));
  let span = close - open;
  if (span < 0) span += TWO_PI;
  if (span > Math.PI) {
    const swap = open;
    open = close;
    close = swap;
    span = TWO_PI - span;
  }
  if (!(span > 1e-4)) return;
  let b0 = ((open + Math.PI) * POLAR_BIN_SCALE) | 0;
  let b1 = ((close + Math.PI) * POLAR_BIN_SCALE) | 0;
  if (b0 < 0) b0 = 0;
  else if (b0 >= POLAR_BINS) b0 = POLAR_BINS - 1;
  if (b1 < 0) b1 = 0;
  else if (b1 >= POLAR_BINS) b1 = POLAR_BINS - 1;
  if (open <= close) {
    for (let b = b0; b <= b1; b++) stampPolarBin(b, x0, y0, x1, y1, lx, ly);
  } else {
    for (let b = b0; b < POLAR_BINS; b++) stampPolarBin(b, x0, y0, x1, y1, lx, ly);
    for (let b = 0; b <= b1; b++) stampPolarBin(b, x0, y0, x1, y1, lx, ly);
  }
}

function stampPolarBin(b, x0, y0, x1, y1, lx, ly) {
  const ang = -Math.PI + (b + 0.5) * (TWO_PI / POLAR_BINS);
  const t = raySegT(lx, ly, Math.cos(ang), Math.sin(ang), x0, y0, x1, y1);
  if (t < _polarDist[b]) {
    _polarDist[b] = t;
    _polarActive = 1;
  }
}

function sweepDistAt(lx, ly, ang, xs, ys, n, radius) {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let best = radius;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const t = raySegT(lx, ly, dx, dy, xs[i], ys[i], xs[j], ys[j]);
    if (t < best) best = t;
  }
  return best;
}

/**
 * One vertex per bin at min(boundary hit, simple-occluder sweep).
 * Returns the sweep count unchanged when no boundary edge wrote a bin.
 * in and out may be the same buffer.
 *
 * Always the whole circle. Below POLAR_BINS vertices (the engine default
 * maxPolygonVertices is 128), each vertex covers `group` adjacent bins at
 * their centre angle and the nearest of their hits, so light never passes an
 * occluder inside a group. At POLAR_BINS or more it is one vertex per bin.
 */
export function clipVisibilityToPolar(lx, ly, inX, inY, n, outX, outY, maxVerts) {
  if (!_polarActive) return n;
  // The caller stores y at x + maxVerts, so the result must never exceed maxVerts.
  const cap = maxVerts | 0;
  if (cap < 3) return n;
  if (n > _holdX.length) {
    // A cut-short copy closed the polygon with a chord and let light past it.
    _holdX = new Float32Array(n);
    _holdY = new Float32Array(n);
  }
  const holdN = n > 0 ? n : 0;
  for (let i = 0; i < holdN; i++) {
    _holdX[i] = inX[i];
    _holdY[i] = inY[i];
  }
  const group = cap >= POLAR_BINS ? 1 : Math.ceil(POLAR_BINS / cap);
  const count = group === 1 ? POLAR_BINS : Math.ceil(POLAR_BINS / group);
  const radius = _polarRadius;
  for (let k = 0; k < count; k++) {
    const b0 = k * group;
    const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
    let d = _polarDist[b0];
    for (let b = b0 + 1; b < b1; b++) {
      if (_polarDist[b] < d) d = _polarDist[b];
    }
    const ang = -Math.PI + (b0 + b1) * 0.5 * (TWO_PI / POLAR_BINS);
    if (holdN >= 3) {
      const sd = sweepDistAt(lx, ly, ang, _holdX, _holdY, holdN, radius);
      if (sd < d) d = sd;
    }
    outX[k] = lx + Math.cos(ang) * d;
    outY[k] = ly + Math.sin(ang) * d;
  }
  return count;
}

/** Raster one world segment into the current polar buffer. For the kernel. */
export function rasterBoundarySegment(x0, y0, x1, y1, lx, ly) {
  writePolarSegment(x0, y0, x1, y1, lx, ly);
}
