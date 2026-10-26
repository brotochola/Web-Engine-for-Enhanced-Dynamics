// The JS visibility sweep and polar raster pre-render ran before visibilitySweep.wasm and solidSegments.wasm took
// every light (E-76 W2a, W1; close-out group B), as they were in src/render/visibility/angularSweep.js:
// buildVisibilityPolygon and its helpers, the compound solids' raster into the polar bins (collectSolidSegments,
// rasterBoundarySegment), the clip and merge onto the bins (clipVisibilityToPolar) and the seen owners
// (markSeenPolarOwners, sweepSawOccluder); and pre-render's JS light loop around them (buildVisibilityPolygonsJs,
// dropUnseenJs), from src/workers/preRenderWorker.js. The kernels' parity tests compare them with the kernels on the
// same bytes.
//
// The bins, their active flag and the constant tables are angularSweep.js' (polarBinArrays, polarBinsActive,
// markPolarBinsActive, copySweepTables), so the JS and the kernels read and write the same state. The clip's merge
// state and the radius it fills to are this module's: clearPolarBins, skipPolarBins and bindPolarBins here are
// angularSweep.js' with that state reset, as they did when it lived there.
import { Collider } from '../../src/components/collider.js';
import { LIGHT_OCCLUDER_MASK_SPRITE, LightOccluder } from '../../src/components/lightOccluder.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Grid } from '../../src/core/grid.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../../src/util/configDefaults.js';
import { lightInfluenceRadius, normalizeAngleSigned } from '../../src/util/utils.js';
import {
  OCC_CIRCLE,
  OCC_POLY,
  POLAR_BINS,
  SWEEP_CAPS,
  bindPolarBins as bindPolarBinsSrc,
  clearPolarBins as clearPolarBinsSrc,
  copySweepTables,
  ensureCompoundSolid,
  ensureSolidChain,
  markPolarBinsActive,
  polarBinArrays,
  polarBinsActive,
  segmentDistSq,
  skipPolarBins as skipPolarBinsSrc,
  warnSweepOverflow,
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../../src/render/visibility/angularSweep.js';
import { SOLID_ARGS } from '../../src/render/visibility/solidSegmentsClient.js';

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
const MAX_EVENTS = SWEEP_CAPS.maxEvents;
const MAX_OCC_CACHE = SWEEP_CAPS.occCache;
const MAX_ACTIVE = SWEEP_CAPS.maxActive;
const FULL_CIRCLE_SEGS = SWEEP_CAPS.fullCircleSegs;
const POLAR_BIN_SCALE = POLAR_BINS / TWO_PI;
// angularSweep.js' tables, the doubles the kernels read.
const TABLES = {
  consts: new Float64Array(3),
  fullC: new Float64Array(FULL_CIRCLE_SEGS),
  fullS: new Float64Array(FULL_CIRCLE_SEGS),
  polarCos: new Float64Array(POLAR_BINS * 2 + 1),
  polarSin: new Float64Array(POLAR_BINS * 2 + 1),
  polarPseudo: new Float64Array(POLAR_BINS * 2 + 1),
};
copySweepTables(TABLES);
const _fullCircleC = TABLES.fullC;
const _fullCircleS = TABLES.fullS;
const _polarCos = TABLES.polarCos;
const _polarSin = TABLES.polarSin;
const _polarPseudo = TABLES.polarPseudo;

// The bins as angularSweep.js holds them now (bindPolarBins may have moved them onto a visibility memory).
let _polarDist = polarBinArrays().dist;
let _polarOwner = polarBinArrays().owner;
function syncBins() {
  const b = polarBinArrays();
  _polarDist = b.dist;
  _polarOwner = b.owner;
}
// The radius clearPolarBins / skipPolarBins gave the bins, which the clip fills to.
let _polarRadius = 0;

/** angularSweep.js' clearPolarBins, with the clip's radius and no merge since. */
export function clearPolarBins(radius) {
  clearPolarBinsSrc(radius);
  _polarRadius = radius > 0 ? radius : 0;
  _mergeCount = -1;
}

/** angularSweep.js' skipPolarBins, likewise. */
export function skipPolarBins(radius) {
  skipPolarBinsSrc();
  _polarRadius = radius > 0 ? radius : 0;
  _mergeCount = -1;
}

/** angularSweep.js' bindPolarBins (which clears the bins to radius 0), likewise. */
export function bindPolarBins(dist, owner) {
  bindPolarBinsSrc(dist, owner);
  syncBins();
  _polarRadius = 0;
  _mergeCount = -1;
}

/** collectSolidSegments on solidSegmentsClient.js' SOLID_ARGS, as the swept light loop passed them. */
export function collectSolidJs(solid, owner) {
  const a = SOLID_ARGS;
  return collectSolidSegments(solid, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], owner);
}

// The ray being sampled and the helpers' results (E-95). buildVisibilityPolygon, emitVertex and
// emitArcVertices are too big for TurboFan to inline, and a double computed in one and passed to the
// next (a sample direction, an arc's angles) or returned (a hit distance) became a heap number per
// event and per occluder test: 37 MB/s in visPolyStressScene's pre-render. Values passed straight
// through (the light) stay arguments; the rest goes through these slots.
const SWEEP = new Float64Array(7);
const S_DIR_X = 0; // the sample's unit direction
const S_DIR_Y = 1;
const S_ARC_FROM = 2; // emitArcVertices' free arc
const S_ARC_TO = 3;
const S_HIT = 4; // rayCircleDist / rayPolyDist / distSqToConvex
const S_OPEN = 5; // an occluder's open and close angles, normalized in place (normalizeSweepPair)
const S_CLOSE = 6;
const INF = Infinity;

/**
 * normalizeAngleSigned (util/utils.js) on SWEEP[S_OPEN] and SWEEP[S_CLOSE], in place, the same
 * arithmetic: buildVisibilityPolygon is too big for TurboFan to inline all four of its calls, and
 * the ones left out boxed the angle going in and coming back.
 */
function normalizeSweepPair() {
  const TWO_PI = Math.PI * 2;
  for (let slot = S_OPEN; slot <= S_CLOSE; slot++) {
    let angle = SWEEP[slot];
    if (angle > Math.PI) {
      angle -= TWO_PI;
      if (angle > Math.PI) angle -= TWO_PI;
    } else if (angle <= -Math.PI) {
      angle += TWO_PI;
      if (angle <= -Math.PI) angle += TWO_PI;
    }
    SWEEP[slot] = angle;
  }
}

/**
 * Ray-circle intersection: nearest positive hit distance, or Infinity, into SWEEP[S_HIT]. The ray
 * leaves (ox, oy) along the unit direction in SWEEP (cos/sin of its angle, no trig here); the circle
 * is occluder oi.
 */
function rayCircleDist(ox, oy, oi, cxs, cys, crs) {
  const dirX = SWEEP[S_DIR_X];
  const dirY = SWEEP[S_DIR_Y];
  const dx = cxs[oi] - ox;
  const dy = cys[oi] - oy;
  SWEEP[S_HIT] = INF;

  const tca = dx * dirX + dy * dirY;
  if (tca < 0) return;

  const d2 = dx * dx + dy * dy - tca * tca;
  const r = crs[oi];
  const r2 = r * r;
  if (d2 > r2) return;

  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  SWEEP[S_HIT] = t0 > 0 ? t0 : tca + thc;
}

/**
 * Ray vs convex polygon edges: nearest positive hit, or Infinity, into SWEEP[S_HIT]. The ray's unit
 * direction is SWEEP's (cos/sin of its angle, no trig here).
 */
function rayPolyDist(ox, oy, vertsX, vertsY, start, count) {
  const dirX = SWEEP[S_DIR_X];
  const dirY = SWEEP[S_DIR_Y];
  let minT = INF;

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
  SWEEP[S_HIT] = minT;
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

/** Squared distance from a point to a convex polygon, into SWEEP[S_HIT]. 0 if inside. Edges, not just corners. */
function distSqToConvex(px, py, vertsX, vertsY, start, count) {
  if (pointInConvex(px, py, vertsX, vertsY, start, count)) {
    SWEEP[S_HIT] = 0;
    return;
  }
  let minSq = INF;
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
  SWEEP[S_HIT] = minSq;
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

const _eventAngles = new Float64Array(MAX_EVENTS);
// E-63: each event's ray direction, from the geometry its angle came from.
const _eventC = new Float64Array(MAX_EVENTS);
const _eventS = new Float64Array(MAX_EVENTS);
const _eventOccIdx = new Int32Array(MAX_EVENTS);
const _eventType = new Uint8Array(MAX_EVENTS); // 1=open, 0=close
const _sortIndices = new Int32Array(MAX_EVENTS);

const _occOpen = new Float64Array(MAX_OCC_CACHE);
const _occClose = new Float64Array(MAX_OCC_CACHE);
const _occValid = new Uint8Array(MAX_OCC_CACHE);

const _activeOcc = new Int32Array(MAX_ACTIVE);
let _activeCount = 0;

// N-39: which occluders the last sweep's vertices landed on. A sweep that gave
// up (event or active overflow, a full circle) cannot tell: everyone counts.
const _occSeenStamp = new Uint32Array(MAX_OCC_CACHE);
let _sweepStamp = 0;
let _sweepSeenValid = false;

/** Whether the last buildVisibilityPolygon put a vertex on occluder `oi` (N-39). */
export function sweepSawOccluder(oi) {
  if (!_sweepSeenValid || oi >= MAX_OCC_CACHE) return true;
  return _occSeenStamp[oi] === _sweepStamp;
}

const _tangentOut = new Int32Array(2);

function warnEventOverflow(occCount) {
  _sweepSeenValid = false;
  warnSweepOverflow(true, occCount);
}

function warnActiveOverflow() {
  _sweepSeenValid = false;
  warnSweepOverflow(false, 0);
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
  _sweepStamp = (_sweepStamp + 1) >>> 0;
  if (_sweepStamp === 0) {
    _occSeenStamp.fill(0);
    _sweepStamp = 1;
  }
  _sweepSeenValid = true;
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
      // The half angle of the tangents from the light; -1 inside the circle. Inline: a call left out
      // of the inlining budget boxed both ways.
      const halfAngle = dist <= r ? -1 : Math.asin(r / dist);
      if (halfAngle < 0) continue;

      SWEEP[S_OPEN] = centerAngle - halfAngle;
      SWEEP[S_CLOSE] = centerAngle + halfAngle;
      normalizeSweepPair();
      const openAngle = SWEEP[S_OPEN];
      const closeAngle = SWEEP[S_CLOSE];
      if (i < MAX_OCC_CACHE) {
        _occOpen[i] = openAngle;
        _occClose[i] = closeAngle;
        _occValid[i] = 1;
      }

      if (eventCount + 2 > MAX_EVENTS) {
        warnEventOverflow(occCount);
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }

      // E-63. The tangents are center ∓ asin(r/dist): their cos/sin come from
      // the center direction and sin = r/dist, cos = sqrt(1 - sin²).
      const cc = dx / dist;
      const sc = dy / dist;
      const sh = r / dist;
      const ch = Math.sqrt(1 - sh * sh);
      _eventAngles[eventCount] = openAngle;
      _eventC[eventCount] = cc * ch + sc * sh;
      _eventS[eventCount] = sc * ch - cc * sh;
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 1;
      eventCount++;

      _eventAngles[eventCount] = closeAngle;
      _eventC[eventCount] = cc * ch - sc * sh;
      _eventS[eventCount] = sc * ch + cc * sh;
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
      distSqToConvex(lightX, lightY, vertsX, vertsY, vs, vc);
      if (SWEEP[S_HIT] > maxRadiusSq) continue;

      if (!polyTangentIndices(lightX, lightY, vertsX, vertsY, vs, vc, _tangentOut)) {
        continue; // light inside poly
      }

      const iLeft = _tangentOut[0];
      const iRight = _tangentOut[1];
      const oX = vertsX[vs + iLeft] - lightX;
      const oY = vertsY[vs + iLeft] - lightY;
      const kX = vertsX[vs + iRight] - lightX;
      const kY = vertsY[vs + iRight] - lightY;
      SWEEP[S_OPEN] = Math.atan2(oY, oX);
      SWEEP[S_CLOSE] = Math.atan2(kY, kX);
      normalizeSweepPair();
      const openN = SWEEP[S_OPEN];
      const closeN = SWEEP[S_CLOSE];
      if (i < MAX_OCC_CACHE) {
        _occOpen[i] = openN;
        _occClose[i] = closeN;
        _occValid[i] = 1;
      }

      if (eventCount + 2 > MAX_EVENTS) {
        warnEventOverflow(occCount);
        return buildFullCircle(lightX, lightY, maxRadius, outX, outY, maxVertices);
      }

      // E-63. The ray points at the tangent vertex itself. A light on the
      // vertex (length 0) keeps cos/sin of atan2's answer.
      const oR = Math.sqrt(oX * oX + oY * oY);
      const kR = Math.sqrt(kX * kX + kY * kY);
      _eventAngles[eventCount] = openN;
      _eventC[eventCount] = oR > 0 ? oX / oR : Math.cos(openN);
      _eventS[eventCount] = oR > 0 ? oY / oR : Math.sin(openN);
      _eventOccIdx[eventCount] = i;
      _eventType[eventCount] = 1;
      eventCount++;

      _eventAngles[eventCount] = closeN;
      _eventC[eventCount] = kR > 0 ? kX / kR : Math.cos(closeN);
      _eventS[eventCount] = kR > 0 ? kY / kR : Math.sin(closeN);
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

  SWEEP[S_DIR_X] = startDirC;
  SWEEP[S_DIR_Y] = startDirS;
  vertCountOut = emitVertex(lightX, lightY, maxRadius,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    outX, outY, vertCountOut, maxVertices);

  let lastAngle = startAngle;

  for (let e = 0; e < eventCount; e++) {
    const idx = _sortIndices[e];
    const angle = _eventAngles[idx];
    const oi = _eventOccIdx[idx];
    const isOpen = _eventType[idx];

    const preAngle = angle - EPSILON;
    SWEEP[S_ARC_FROM] = lastAngle;
    SWEEP[S_ARC_TO] = preAngle;
    vertCountOut = emitArcVertices(lightX, lightY, maxRadius,
      kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
      outX, outY, vertCountOut, maxVertices);

    // H-06. EPSILON is 1e-5, so the pre/post samples are the first-order
    // expansion of one (cos, sin) pair. The angular error is O(ε²) ≈ 1e-10 rad.
    // Gate: the stored polygon stays within 1e-4 world units of the exact samples.
    // E-63: that pair is the event's own direction, not cos/sin of its angle
    // (a few ulps apart; same gate, sweepEventDirection.test.js).
    const ca = _eventC[idx];
    const sa = _eventS[idx];
    const preC = ca + EPSILON * sa;
    const preS = sa - EPSILON * ca;

    // Pre-toggle sample slightly before event (active-set state before open/close)
    if (vertCountOut < maxVertices) {
      SWEEP[S_DIR_X] = preC;
      SWEEP[S_DIR_Y] = preS;
      vertCountOut = emitVertex(lightX, lightY, maxRadius,
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
      SWEEP[S_DIR_X] = postC;
      SWEEP[S_DIR_Y] = postS;
      vertCountOut = emitVertex(lightX, lightY, maxRadius,
        kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
        outX, outY, vertCountOut, maxVertices);
    }

    lastAngle = postAngle;
  }

  SWEEP[S_ARC_FROM] = lastAngle;
  SWEEP[S_ARC_TO] = endAngle;
  vertCountOut = emitArcVertices(lightX, lightY, maxRadius,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    outX, outY, vertCountOut, maxVertices);

  if (vertCountOut < maxVertices) {
    SWEEP[S_DIR_X] = END_DIR_C;
    SWEEP[S_DIR_Y] = END_DIR_S;
    vertCountOut = emitVertex(lightX, lightY, maxRadius,
      kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
      outX, outY, vertCountOut, maxVertices);
  }

  return vertCountOut;
}

/** One sample along SWEEP's unit direction (cos, sin; no trig here). */
function emitVertex(
  lightX, lightY, maxRadius,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  outX, outY, vertCountOut, maxVertices
) {
  if (vertCountOut >= maxVertices) return vertCountOut;
  const dirX = SWEEP[S_DIR_X];
  const dirY = SWEEP[S_DIR_Y];

  // `+` types the seed as a number: from the bare parameter the loop's merge was any value, and each
  // closer hit was boxed into it.
  let minDist = +maxRadius;
  let hitOcc = -1;

  for (let a = 0; a < _activeCount; a++) {
    const oi = _activeOcc[a];
    if (kind[oi] === OCC_CIRCLE) {
      rayCircleDist(lightX, lightY, oi, cx, cy, cr);
    } else {
      rayPolyDist(lightX, lightY, vertsX, vertsY, vertStart[oi], vertCount[oi] | 0);
    }
    const d = SWEEP[S_HIT];
    if (d < minDist) {
      minDist = d;
      hitOcc = oi;
    }
  }
  if (hitOcc >= 0 && minDist < maxRadius - EPSILON) _occSeenStamp[hitOcc] = _sweepStamp;

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
  lightX, lightY, maxRadius,
  kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
  outX, outY, vertCountOut, maxVertices
) {
  const fromAngle = SWEEP[S_ARC_FROM];
  const gap = SWEEP[S_ARC_TO] - fromAngle;
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
    SWEEP[S_DIR_X] = c;
    SWEEP[S_DIR_Y] = s;
    vertCountOut = emitVertex(lightX, lightY, maxRadius,
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
 * World-space boundary edges of a solid that overlap the light disc.
 * `owner` is the id the bins this solid wins record (N-19): an integer, passed
 * down as a parameter. Read from a module variable it cost 8–11 % of this
 * kernel; as a parameter, with _polarActive set once per span, 0–5 %.
 * @returns {number} 0 when no edge overlaps the light disc; otherwise at least 1
 *   (back-facing edges stop being counted once one edge has)
 */
export function collectSolidSegments(
  solid, entityX, entityY, rotC, rotS, offX, offY, lightX, lightY, radiusSq, owner
) {
  syncBins();
  if (!solid || solid.segCount <= 0) return 0;
  ensureSolidChain(solid);
  const originX = entityX + rotC * offX - rotS * offY;
  const originY = entityY + rotS * offX + rotC * offY;
  const seg = solid.seg;
  const chain = solid.chain;
  const n = solid.segCount;
  let hit = 0;
  // The last rastered end and its angle (E-61). Equal coordinates give equal
  // differences. Nonzero ones are the same bits; a zero may differ in sign,
  // which atan2 reads only as ±0 or ±π. Both ±0 give the same bins and span,
  // normalizeAngleSigned folds -π to π, and with both differences zero the
  // light is on the edge's line, where every raySegT is Infinity. So a reused
  // angle stamps what a fresh atan2 would.
  let lastX = NaN;
  let lastY = NaN;
  let lastAngle = 0;
  for (let q = 0; q < n; q++) {
    const o = chain[q] * 4;
    const lx0 = seg[o];
    const ly0 = seg[o + 1];
    const lx1 = seg[o + 2];
    const ly1 = seg[o + 3];
    const x0 = originX + rotC * lx0 - rotS * ly0;
    const y0 = originY + rotS * lx0 + rotC * ly0;
    const x1 = originX + rotC * lx1 - rotS * ly1;
    const y1 = originY + rotS * lx1 + rotC * ly1;
    // Solid is on the left of a CCW boundary edge. A light on that side
    // cannot see this edge; the canyon wall faces the empty side and stays.
    // The facing test is a cross product, the range test a division, so the
    // range test runs for a back-facing edge only until something hit (E-50).
    const ex = x1 - x0;
    const ey = y1 - y0;
    const tx = lightX - x0;
    const ty = lightY - y0;
    if (ex * ty - ey * tx >= 0) {
      if (hit === 0 && segmentDistSq(lightX, lightY, x0, y0, x1, y1) <= radiusSq) hit++;
      continue;
    }
    if (segmentDistSq(lightX, lightY, x0, y0, x1, y1) > radiusSq) continue;
    hit++;
    const open = x0 === lastX && y0 === lastY
      ? lastAngle
      : normalizeAngleSigned(Math.atan2(y0 - lightY, x0 - lightX));
    const close = normalizeAngleSigned(Math.atan2(y1 - lightY, x1 - lightX));
    lastX = x1;
    lastY = y1;
    lastAngle = close;
    rasterPolarSpan(open, close, x0, y0, x1, y1, lightX, lightY, owner);
  }
  return hit;
}

// The last clipVisibilityToPolar merge, for markSeenPolarOwners: -1 = none ran.
let _mergeCount = -1;
let _mergeGroup = 1;
let _mergeEdges = 0;

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

function writePolarSegment(x0, y0, x1, y1, lx, ly, owner) {
  rasterPolarSpan(
    normalizeAngleSigned(Math.atan2(y0 - ly, x0 - lx)),
    normalizeAngleSigned(Math.atan2(y1 - ly, x1 - lx)),
    x0, y0, x1, y1, lx, ly, owner
  );
}

/** Stamp the bins between the ends' angles, each normalizeAngleSigned(atan2(...)). */
function rasterPolarSpan(open, close, x0, y0, x1, y1, lx, ly, owner) {
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
  // b0 through b1, past the last bin to the first when the span wraps. One call
  // site keeps this small enough to inline into collectSolidSegments (E-61).
  const end = open <= close ? b1 : b1 + POLAR_BINS;
  let stamped = 0;
  for (let v = b0; v <= end; v++) {
    stamped |= stampPolarBin(v < POLAR_BINS ? v : v - POLAR_BINS, x0, y0, x1, y1, lx, ly, owner);
  }
  if (stamped) markPolarBinsActive();
}

function stampPolarBin(b, x0, y0, x1, y1, lx, ly, owner) {
  const m = 2 * b + 1;
  const t = raySegT(lx, ly, _polarCos[m], _polarSin[m], x0, y0, x1, y1);
  if (t < _polarDist[b]) {
    _polarDist[b] = t;
    _polarOwner[b] = owner;
    return 1;
  }
  return 0;
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
  syncBins();
  if (!polarBinsActive()) {
    _mergeCount = 0;
    return n;
  }
  // The caller stores y at x + maxVerts, so the result must never exceed maxVerts.
  const cap = maxVerts | 0;
  if (cap < 3) return n;
  const group = cap >= POLAR_BINS ? 1 : Math.ceil(POLAR_BINS / cap);
  const count = group === 1 ? POLAR_BINS : Math.ceil(POLAR_BINS / group);
  // No copy of the input: mergeSweep reads every vertex before its first write.
  mergeSweep(lx, ly, inX, inY, n, count, group, _polarRadius, outX, outY);
  _mergeCount = count;
  _mergeGroup = group;
  _mergeEdges = n >= 3 ? n : 0;
  return count;
}

/**
 * N-19. After clipVisibilityToPolar: set seen[owner] = stamp for every bin
 * whose hit is on the polygon, i.e. not behind the simple-occluder sweep at
 * that ray (mergeSweep keeps the bin unless the sweep is strictly nearer).
 * Every bin counts, not only the nearest of a vertex's group, so a solid seen
 * in one bin of a group is seen. Returns how many bins marked, or -1 when no
 * merge ran since clearPolarBins (the caller then cannot tell, and keeps all).
 */
export function markSeenPolarOwners(seen, stamp) {
  syncBins();
  if (_mergeCount < 0) return -1;
  let marked = 0;
  for (let k = 0; k < _mergeCount; k++) {
    const b0 = k * _mergeGroup;
    const b1 = b0 + _mergeGroup < POLAR_BINS ? b0 + _mergeGroup : POLAR_BINS;
    const sweep = _mergeEdges > 0 ? _rayBest[k] : Infinity;
    for (let b = b0; b < b1; b++) {
      const owner = _polarOwner[b];
      if (owner >= 0 && _polarDist[b] <= sweep) {
        seen[owner] = stamp;
        marked++;
      }
    }
  }
  return marked;
}

// E-43. The merge took each output ray's nearest hit on the sweep polygon by
// testing every sweep edge: rays x edges raySegT calls, 512 x several hundred
// for a light among many boxes. raySegT is finite only for a ray inside the
// angle the edge subtends from the light, extended by raySegT's own 1e-4 slack
// at both ends. So each edge is tested against the rays in that arc, padded by
// ARC_PAD (rays are 2π/512 apart), and lowers their running minimum. An edge
// whose arc is near a half turn passes by the light and is tested by every ray,
// as is one whose arc is NaN. The arc is found without atan2 (E-62): the cross
// product of its ends says which way is short, and pseudoAngle orders the ends
// and the rays. A minimum is the same in any order and every ray
// left out would get Infinity, so the polygon is the full scan's, bit for bit.
// A visibility polygon's edges tile the circle: the work is about rays + edges.
// That includes the 32-gon placeholder of a light with only compound occluders,
// which E-41 merged at three edges per ray: this is faster on it too.
const ARC_PAD = 1e-6;

// A stand-in for atan2(y, x) that keeps its order over (-π, π]: -2 at -π, 0 at
// 0, 2 at π, one unit per quarter turn. Its slope is 1/2 to 1 per radian, so a
// pad of ARC_PAD units covers at least ARC_PAD radians.
function pseudoAngle(x, y) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const p = ay / (ax + ay);
  if (y < 0) return x < 0 ? p - 2 : -p;
  return x < 0 ? 2 - p : p;
}

const _rayAng = new Float64Array(POLAR_BINS); // pseudoAngle of each ray
const _rayCos = new Float64Array(POLAR_BINS);
const _raySin = new Float64Array(POLAR_BINS);
const _rayBest = new Float64Array(POLAR_BINS);

function firstRayAtOrAfter(n, a) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_rayAng[mid] < a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstRayAfter(n, a) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_rayAng[mid] <= a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mergeSweep(lx, ly, xs, ys, n, count, group, radius, outX, outY) {
  // Fewer than 3 vertices is no polygon: the bins alone.
  const edges = n >= 3 ? n : 0;
  if (edges > 0) {
    for (let k = 0; k < count; k++) {
      const b0 = k * group;
      const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
      const m = b0 + b1;
      _rayAng[k] = _polarPseudo[m];
      _rayCos[k] = _polarCos[m];
      _raySin[k] = _polarSin[m];
      _rayBest[k] = radius;
    }
  }
  for (let i = 0; i < edges; i++) {
    const j = i + 1 < edges ? i + 1 : 0;
    const ax = xs[i];
    const ay = ys[i];
    const bx = xs[j];
    const by = ys[j];
    const ex = bx - ax;
    const ey = by - ay;
    const fx = ax - lx;
    const fy = ay - ly;
    // The slack-extended ends, from the light.
    const sx = fx - 1e-4 * ex;
    const sy = fy - 1e-4 * ey;
    const tx = fx + (1 + 1e-4) * ex;
    const ty = fy + (1 + 1e-4) * ey;
    const cr = sx * ty - sy * tx;
    // Rays [k0, k1), and [0, k2) when the arc wraps past ±π.
    let k0 = 0;
    let k1 = count;
    let k2 = 0;
    // A sine under 1e-3 with the ends apart is near a half turn: every ray.
    if (cr * cr > 1e-6 * (sx * sx + sy * sy) * (tx * tx + ty * ty) || sx * tx + sy * ty > 0) {
      // Counter-clockwise from p0 to p1 is the short way. A wrong sign of a
      // rounded cr leaves p0 and p1 within ARC_PAD: take them in order then.
      const ps = pseudoAngle(sx, sy);
      const pt = pseudoAngle(tx, ty);
      const p0 = cr >= 0 ? ps : pt;
      const p1 = cr >= 0 ? pt : ps;
      let lo;
      let hi;
      if (p1 >= p0) {
        lo = p0;
        hi = p1;
      } else if (p0 - p1 < ARC_PAD) {
        lo = p1;
        hi = p0;
      } else {
        lo = p0;
        hi = p1 + 4;
      }
      lo -= ARC_PAD;
      hi += ARC_PAD;
      if (lo < -2) {
        k0 = firstRayAtOrAfter(count, lo + 4);
        k2 = firstRayAfter(count, hi);
      } else if (hi > 2) {
        k0 = firstRayAtOrAfter(count, lo);
        k2 = firstRayAfter(count, hi - 4);
      } else {
        k0 = firstRayAtOrAfter(count, lo);
        k1 = firstRayAfter(count, hi);
      }
    }
    for (let k = k0; k < k1; k++) {
      const t = raySegT(lx, ly, _rayCos[k], _raySin[k], ax, ay, bx, by);
      if (t < _rayBest[k]) _rayBest[k] = t;
    }
    for (let k = 0; k < k2; k++) {
      const t = raySegT(lx, ly, _rayCos[k], _raySin[k], ax, ay, bx, by);
      if (t < _rayBest[k]) _rayBest[k] = t;
    }
  }
  for (let k = 0; k < count; k++) {
    const b0 = k * group;
    const b1 = b0 + group < POLAR_BINS ? b0 + group : POLAR_BINS;
    let d = _polarDist[b0];
    for (let b = b0 + 1; b < b1; b++) {
      if (_polarDist[b] < d) d = _polarDist[b];
    }
    if (edges > 0 && _rayBest[k] < d) d = _rayBest[k];
    const m = b0 + b1;
    outX[k] = lx + _polarCos[m] * d;
    outY[k] = ly + _polarSin[m] * d;
  }
}

/** Raster one world segment into the current polar buffer. For kernels and tests. */
export function rasterBoundarySegment(x0, y0, x1, y1, lx, ly, owner = -1) {
  syncBins();
  writePolarSegment(x0, y0, x1, y1, lx, ly, owner);
}

// As in preRenderWorker.js (that module installs its worker when it is imported, so it is not imported here).
const INVALID_TEXTURE_ID = 0xFFFF;

/**
 * buildVisibilityPolygons' JS light loop, as pre-render ran it with no visibility kernel: the gather, the sweep
 * (buildVisibilityPolygon), the compound raster (collectSolidSegments), the clip and the seen owners (dropUnseenJs),
 * on `pre`'s scratch and buffers. The kernels' wired parity tests run it on the same worker as their reference.
 */
export function buildVisibilityPolygonsJs(pre) {
    if (!pre.visibilityPolygonsEnabled) return;
    const buf = pre._vpWriteBuffer;
    if (!buf) { return; }

    const selfLitBuf = pre._selfLitWriteBuffer;
    if (selfLitBuf) selfLitBuf.header[0] = 0;

    // Optional SoA may be absent when scene never registered LightEmitter / LightOccluder
    if (!LightEmitter.active || !LightOccluder.active || !Collider.active) {
        buf.header[0] = 0;
        return;
    }

    const transformActive = Transform.active;
    const occluderActive = LightOccluder.active;
    const occluderMaskMode = LightOccluder.maskMode;
    const occluderBlock = LightOccluder.block;
    const colliderActive = Collider.active;
    const shapeType = Collider.shapeType;
    const colRadius = Collider.radius;
    const colWidth = Collider.width;
    const colHeight = Collider.height;
    const colOffX = Collider.offsetX;
    const colOffY = Collider.offsetY;
    const polyCountArr = Collider.polyCount;
    const polyVertX = Collider.polyVertexX;
    const polyVertY = Collider.polyVertexY;
    const polyCentroidX = Collider.polyCentroidX;
    const polyCentroidY = Collider.polyCentroidY;
    const fixtureCountArr = Collider.fixtureCount;
    const fixtureHead = ColliderFixture.head;
    const fixtureNext = ColliderFixture.next;
    const fixtureActiveArr = ColliderFixture.active;
    const fixtureVertCount = ColliderFixture.vertCount;
    const fixtureVertX = ColliderFixture.vertexX;
    const fixtureVertY = ColliderFixture.vertexY;
    const fixturePoolMax = ColliderFixture.maxCount | 0;
    const fixtureRevision = ColliderFixture.revision;
    const lightEnabled = LightEmitter.active;
    const lightIntensity = LightEmitter.lightIntensity;
    const sqrtLightIntensity = LightEmitter.sqrtLightIntensity;

    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    const maxVerts = pre._vpMaxVerts;
    const maxLts = pre._vpMaxLights;
    const slotBytes = pre._vpSlotBytes;
    const kind = pre._vpOccKind;
    const cX = pre._vpCircleX;
    const cY = pre._vpCircleY;
    const cR = pre._vpCircleR;
    const vertStart = pre._vpVertStart;
    const vertCountArr = pre._vpVertCount;
    const vertsX = pre._vpVertsX;
    const vertsY = pre._vpVertsY;
    const maxOccluders = pre._vpMaxOccluders;
    const outX = pre._vpOutX;
    const outY = pre._vpOutY;
    const i32 = buf.i32;
    const f32 = buf.f32;
    const pose = pre._displayPoseOut;

    const entityLastTextureId = pre.entityLastTextureId;
    const maxSelfLit = pre._selfLitMax || 0;
    let selfLitCount = 0;
    const selfLitI32 = selfLitBuf ? selfLitBuf.i32 : null;
    const selfLitF32 = selfLitBuf ? selfLitBuf.f32 : null;
    const selfLitU16 = selfLitBuf ? selfLitBuf.u16 : null;
    const selfLitU8 = selfLitBuf ? selfLitBuf.u8 : null;
    const selfLitItemBytes = pre._selfLitItemBytes || 28;
    const selfLitSolid = pre._selfLitSolid;
    const selfLitOcc = pre._selfLitOcc;

    const visibleLights = pre.visibleLightsData;
    if (!visibleLights) { buf.header[0] = 0; return; }

    const lightCount = visibleLights[0];
    if (lightCount === 0) { buf.header[0] = 0; return; }
    if (lightCount > maxLts) {
        pre._warnOnce(
            '_warnedVisibilityPolygonLightCap',
            `[PRE_RENDER] visibility polygon light cap reached (${maxLts}). Increase lighting.maxLights or reduce raycasted visible lights.`
        );
    }

    let lightsWritten = 0;

    for (let li = 0; li < lightCount && lightsWritten < maxLts; li++) {
        const lightIdx = visibleLights[1 + li];
        if (!lightEnabled[lightIdx]) continue;

        const intensity = lightIntensity[lightIdx];
        if (intensity <= 0) continue;

        // Same display pose as sprites (post-step publish), not live Transform
        pre._displayPose(lightIdx, pose);
        const lx = pose[0];
        const ly = pose[1];
        const influenceRadius = lightInfluenceRadius(sqrtLightIntensity[lightIdx]);

        let occCount = 0;
        let vertPool = 0;
        let occluderLimitHit = false;
        clearPolarBins(influenceRadius);
        const selfLitStart = selfLitCount;
        let solidsLit = 0;

        if (neighborData && stride > 0) {
            const offset = lightIdx * stride;
            const nCount = neighborData[offset];
            for (let k = 0; k < nCount; k++) {
                if (occCount >= maxOccluders) {
                    occluderLimitHit = true;
                    break;
                }
                const nIdx = neighborData[offset + 1 + k];
                if (!transformActive[nIdx] || !occluderActive[nIdx] || !colliderActive[nIdx]) continue;
                if (occluderBlock && !(occluderBlock[nIdx] > 0)) continue;

                pre._displayPose(nIdx, pose);
                const wx = pose[0];
                const wy = pose[1];
                const c = pose[2];
                const s = pose[3];

                const shape = shapeType[nIdx];
                if (shape === ShapeType.Chain) continue;
                const ox = colOffX[nIdx] || 0;
                const oy = colOffY[nIdx] || 0;
                const nFixtures = fixtureCountArr ? (fixtureCountArr[nIdx] | 0) : 0;
                if (nFixtures > 0 && fixtureHead && nIdx < fixtureHead.length) {
                    const lcx = polyCentroidX ? polyCentroidX[nIdx] : 0;
                    const lcy = polyCentroidY ? polyCentroidY[nIdx] : 0;
                    const centX = wx + c * (ox + lcx) - s * (oy + lcy);
                    const centY = wy + s * (ox + lcx) + c * (oy + lcy);
                    const hw = (colWidth[nIdx] || 0) * 0.5;
                    const hh = (colHeight[nIdx] || 0) * 0.5;
                    const reach = Math.sqrt(hw * hw + hh * hh);
                    const cdx = centX - lx;
                    const cdy = centY - ly;
                    const bound = influenceRadius + reach;
                    if (cdx * cdx + cdy * cdy > bound * bound) continue;

                    const solid = ensureCompoundSolid(
                        nIdx,
                        fixtureRevision ? fixtureRevision[0] : 0,
                        fixtureHead, fixtureNext, fixtureActiveArr,
                        fixtureVertCount, fixtureVertX, fixtureVertY,
                        fixtureHead[nIdx], fixturePoolMax,
                        false // segments only: the fill is pixi's (self-lit)
                    );
                    const hit = collectSolidSegments(
                        solid, wx, wy, c, s, ox, oy,
                        lx, ly, influenceRadius * influenceRadius, nIdx
                    );
                    if (hit > 0 && selfLitI32 && selfLitCount < maxSelfLit) {
                        const byteOff = 4 + selfLitCount * selfLitItemBytes;
                        const i32Off = byteOff >> 2;
                        selfLitI32[i32Off] = nIdx;
                        selfLitI32[i32Off + 1] = lightIdx;
                        selfLitF32[i32Off + 2] = wx;
                        selfLitF32[i32Off + 3] = wy;
                        selfLitF32[i32Off + 4] = c;
                        selfLitF32[i32Off + 5] = s;
                        const u16Off = byteOff >> 1;
                        let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                        if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                            texId = pre._resolveEntitySpriteTextureId(nIdx);
                        }
                        selfLitU16[u16Off + 12] = texId;
                        selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                        selfLitU8[byteOff + 27] = 0;
                        selfLitSolid[selfLitCount] = 1;
                        solidsLit++;
                        selfLitCount++;
                    }
                    continue;
                }
                const occX = wx + ox;
                const occY = wy + oy;
                const dx = occX - lx;
                const dy = occY - ly;
                let reach = 0;
                if (shape === ShapeType.Circle) {
                    reach = colRadius[nIdx] || 0;
                } else {
                    const hw = (colWidth[nIdx] || 0) * 0.5;
                    const hh = (colHeight[nIdx] || 0) * 0.5;
                    // H-03: sqrt, not Math.hypot - the overflow/underflow guard is wasted here.
                    // Measured ~16x cheaper (5/5 counterbalanced rounds, 1e-3..1e7). NOT
                    // bit-identical to hypot: it agrees on ~64% of in-range pairs and differs by
                    // a few ulps on the rest, because hypot is deliberately the more accurate of
                    // the two. That is ~1e-16 relative, far under the Float32 this value is
                    // stored into. Overflow is unreachable (Float64 squares overflow past ~1.34e154).
                    // Do not reintroduce hypot here without measuring it again.
                    reach = Math.sqrt(hw * hw + hh * hh);
                }
                const maxReach = influenceRadius + reach;
                if (dx * dx + dy * dy > maxReach * maxReach) continue;

                let packed = false;

                if (shape === ShapeType.Circle) {
                    const r = colRadius[nIdx];
                    if (!(r > 0)) continue;
                    kind[occCount] = OCC_CIRCLE;
                    cX[occCount] = wx + ox;
                    cY[occCount] = wy + oy;
                    cR[occCount] = r;
                    vertStart[occCount] = 0;
                    vertCountArr[occCount] = 0;
                    packed = true;
                } else if (shape === ShapeType.Box) {
                    const w = colWidth[nIdx];
                    const h = colHeight[nIdx];
                    if (!(w > 0) || !(h > 0)) continue;
                    kind[occCount] = OCC_POLY;
                    vertStart[occCount] = vertPool;
                    writeOrientedBoxVerts(
                        vertsX, vertsY, vertPool,
                        wx, wy, w, h, c, s, ox, oy
                    );
                    vertCountArr[occCount] = 4;
                    vertPool += 4;
                    packed = true;
                } else if (shape === ShapeType.Polygon) {
                    const pc = polyCountArr[nIdx] | 0;
                    if (pc >= 3) {
                        kind[occCount] = OCC_POLY;
                        vertStart[occCount] = vertPool;
                        const base = nIdx * MAX_POLYGON_VERTICES;
                        writePolygonVerts(
                            vertsX, vertsY, vertPool,
                            wx, wy, c, s, ox, oy,
                            polyVertX, polyVertY, base, pc
                        );
                        vertCountArr[occCount] = pc;
                        vertPool += pc;
                        packed = true;
                    } else {
                        // Fallback to box extents when poly not filled
                        const w = colWidth[nIdx];
                        const h = colHeight[nIdx];
                        if (!(w > 0) || !(h > 0)) continue;
                        kind[occCount] = OCC_POLY;
                        vertStart[occCount] = vertPool;
                        writeOrientedBoxVerts(
                            vertsX, vertsY, vertPool,
                            wx, wy, w, h, c, s, ox, oy
                        );
                        vertCountArr[occCount] = 4;
                        vertPool += 4;
                        packed = true;
                    }
                }

                if (!packed) continue;

                // Self-lit queue: bake display pose (frame-locked with sprites / umbra)
                if (selfLitI32 && selfLitCount < maxSelfLit) {
                    const byteOff = 4 + selfLitCount * selfLitItemBytes;
                    const i32Off = byteOff >> 2;
                    selfLitI32[i32Off] = nIdx;
                    selfLitI32[i32Off + 1] = lightIdx;
                    selfLitF32[i32Off + 2] = wx;
                    selfLitF32[i32Off + 3] = wy;
                    selfLitF32[i32Off + 4] = c;
                    selfLitF32[i32Off + 5] = s;
                    const u16Off = byteOff >> 1;
                    let texId = entityLastTextureId ? entityLastTextureId[nIdx] : INVALID_TEXTURE_ID;
                    if (texId === INVALID_TEXTURE_ID && (occluderMaskMode[nIdx] | 0) === LIGHT_OCCLUDER_MASK_SPRITE) {
                        texId = pre._resolveEntitySpriteTextureId(nIdx);
                    }
                    selfLitU16[u16Off + 12] = texId; // after 6×i32/f32 = 24 bytes
                    selfLitU8[byteOff + 26] = occluderMaskMode[nIdx] | 0;
                    selfLitU8[byteOff + 27] = 0;
                    selfLitSolid[selfLitCount] = 0;
                    selfLitOcc[selfLitCount] = occCount;
                    selfLitCount++;
                }

                occCount++;
            }
        }
        if (occluderLimitHit) {
            pre._warnOnce(
                '_warnedVisibilityPolygonOccluderCap',
                `[PRE_RENDER] visibility polygon occluder cap reached (${maxOccluders} per light). Reduce occluder density or raise the internal cap.`
            );
        }

        let vertCount = buildVisibilityPolygon(
            lx, ly, influenceRadius,
            kind, cX, cY, cR, vertStart, vertCountArr, vertsX, vertsY,
            occCount, outX, outY, maxVerts
        );
        const polarActive = polarBinsActive();
        if (polarActive) {
            vertCount = clipVisibilityToPolar(
                lx, ly, outX, outY, vertCount, outX, outY, maxVerts
            );
        }
        // N-19 / N-39: an occluder is self-lit where this light sees it, not
        // wherever it is in range (rock behind rock, a box behind a box stay dark).
        if (selfLitCount > selfLitStart) {
            selfLitCount = dropUnseenJs(pre, selfLitBuf, selfLitStart, selfLitCount, solidsLit > 0 && polarActive);
        }

        // Layout: [lightIdx:i32, lightX:f32, lightY:f32, vertexCount:i32, x[N]:f32, y[N]:f32]
        const baseIndex = (4 + lightsWritten * slotBytes) >> 2;
        i32[baseIndex] = lightIdx;
        f32[baseIndex + 1] = lx;
        f32[baseIndex + 2] = ly;
        i32[baseIndex + 3] = vertCount;

        // A loop, not set(subarray(...)): two views per light per frame were 2.2 MB/s of garbage
        // in visPolyStressScene (N-1). The same Float32 rounding either way.
        const xStart = baseIndex + 4;
        const yStart = xStart + maxVerts;
        const copyCount = vertCount < maxVerts ? vertCount : maxVerts; // subarray clamped too
        for (let v = 0; v < copyCount; v++) {
            f32[xStart + v] = outX[v];
            f32[yStart + v] = outY[v];
        }

        lightsWritten++;
    }

    buf.header[0] = lightsWritten;
    if (selfLitBuf) selfLitBuf.header[0] = selfLitCount;
}

/**
 * N-19 / N-39. Keep this light's self-lit items [start, end) that its
 * polygon shows: a solid when one of its polar bins is on it
 * (markSeenPolarOwners; no bin at all means none is), a simple occluder
 * when a sweep vertex landed on it (sweepSawOccluder). Returns the new count.
 */
export function dropUnseenJs(pre, buf, start, end, polarActive) {
    let stamp = (pre._selfLitSeenStamp + 1) >>> 0;
    if (stamp === 0) {
        pre._selfLitSeen.fill(0);
        stamp = 1;
    }
    pre._selfLitSeenStamp = stamp;
    const seen = pre._selfLitSeen;
    const solidsKnown = !polarActive || markSeenPolarOwners(seen, stamp) >= 0;
    const solid = pre._selfLitSolid;
    const occ = pre._selfLitOcc;
    const itemBytes = pre._selfLitItemBytes;
    const i32 = buf.i32;
    const u8 = buf.u8;
    let w = start;
    for (let q = start; q < end; q++) {
        const off = 4 + q * itemBytes;
        if (solid[q] ? solidsKnown && seen[i32[off >> 2]] !== stamp : !sweepSawOccluder(occ[q])) continue;
        if (w !== q) {
            u8.copyWithin(4 + w * itemBytes, off, off + itemBytes);
            solid[w] = solid[q];
            occ[w] = occ[q];
        }
        w++;
    }
    return w;
}
