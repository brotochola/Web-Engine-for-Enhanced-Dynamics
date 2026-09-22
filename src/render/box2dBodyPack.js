/**
 * Pack fed colliders into GPU Body + verts arrays (no alloc in the hot loop).
 *
 * Pose views (opts.poseX/Y/rotC/S) are the frame's display pose. Pixi passes a
 * private copy of the queue's generation, not the live SAB (publishPose reuses
 * that slot). RigidBody.active + pose present → pack that clock, not live HEAP
 * Transform (grab writes HEAP immediately). Sweep/prev stay on the same clock:
 * previous pose slot, or HEAP px/py when packing Transform. Never mix.
 * opts.poseAlpha < 1 lerps prev→curr (same blend as the sprite). 1 skips it.
 */
import { Collider } from '../components/collider.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { MAX_POLYGON_VERTICES, ShapeType, COMPUTE_FLAG_STATIC, COMPUTE_FLAG_SWEEP } from '../util/configDefaults.js';
import { snapshotColliderFeed } from '../util/layerFeed.js';

export const BODY_FLOATS = 16;
export const BODY_STRIDE_BYTES = BODY_FLOATS * 4;

/** Reused pack result (no alloc in the hot loop). */
export const PACK_OUT = { bodyCount: 0, vertCount: 0 };

function writeBody(bodyData, bodyCount, x, y, c, s, hw, hh, kind, flags, velx, vely, w, vStart, vCount, prevX, prevY) {
  const b = bodyCount * BODY_FLOATS;
  bodyData[b] = x;
  bodyData[b + 1] = y;
  bodyData[b + 2] = c;
  bodyData[b + 3] = s;
  bodyData[b + 4] = hw;
  bodyData[b + 5] = hh;
  bodyData[b + 6] = kind;
  bodyData[b + 7] = flags;
  bodyData[b + 8] = velx;
  bodyData[b + 9] = vely;
  bodyData[b + 10] = w;
  bodyData[b + 11] = vStart;
  bodyData[b + 12] = vCount;
  bodyData[b + 13] = prevX;
  bodyData[b + 14] = prevY;
  bodyData[b + 15] = 0;
  return bodyCount + 1;
}

/**
 * @param {number} layerId
 * @param {Float32Array} bodyData
 * @param {Float32Array} vertData
 * @param {number} maxBodies
 * @param {{ sweep?: boolean, poseX?: Float32Array|null, poseY?: Float32Array|null, poseRotC?: Float32Array|null, poseRotS?: Float32Array|null, prevPoseX?: Float32Array|null, prevPoseY?: Float32Array|null, prevPoseRotC?: Float32Array|null, prevPoseRotS?: Float32Array|null }} [opts]
 * @returns {{ bodyCount: number, vertCount: number }}
 */
export function packBox2dBodies(layerId, bodyData, vertData, maxBodies, opts) {
  const cap = maxBodies | 0;
  const sweep = !opts || opts.sweep !== false;
  const poseX = opts ? opts.poseX : null;
  const poseY = opts ? opts.poseY : null;
  const poseRotC = opts ? opts.poseRotC : null;
  const poseRotS = opts ? opts.poseRotS : null;
  const prevPoseX = opts ? opts.prevPoseX : null;
  const prevPoseY = opts ? opts.prevPoseY : null;
  const prevPoseRotC = opts ? opts.prevPoseRotC : null;
  const prevPoseRotS = opts ? opts.prevPoseRotS : null;
  const poseAlpha = opts && opts.poseAlpha < 1 && opts.poseAlpha >= 0 ? opts.poseAlpha : 1;
  const blendPose = poseAlpha < 1 && !!(prevPoseX && prevPoseY);
  let bodyCount = 0;
  let vertCount = 0;
  const maxVerts = vertData ? (vertData.length / 2) | 0 : 0;
  const want = 1 << (layerId | 0);

  if (cap <= 0) {
    PACK_OUT.bodyCount = 0;
    PACK_OUT.vertCount = 0;
    return PACK_OUT;
  }

  const tx = Transform.x;
  const ty = Transform.y;
  const rotC = Transform.rotC;
  const rotS = Transform.rotS;
  const rbActive = RigidBody.active;
  const vx = RigidBody.vx;
  const vy = RigidBody.vy;
  const omega = RigidBody.angularVelocity;
  const isStatic = RigidBody.static;
  const px = RigidBody.px;
  const py = RigidBody.py;
  const collActive = Collider.active;
  const shapeType = Collider.shapeType;
  const width = Collider.width;
  const height = Collider.height;
  const radius = Collider.radius;
  const ox = Collider.offsetX;
  const oy = Collider.offsetY;
  const polyCount = Collider.polyCount;
  const polyVX = Collider.polyVertexX;
  const polyVY = Collider.polyVertexY;
  const feedBits = Collider.feedBits;
  const layerMask = Collider.layerMask;
  let overflow = false;
  const snap = snapshotColliderFeed(layerId);
  const useFeed = !!snap;
  const n = useFeed ? snap.count : (collActive ? collActive.length : 0);
  const feedIdx = useFeed ? snap.indices : null;

  for (let f = 0; f < n; f++) {
    const i = feedIdx ? feedIdx[f] : f;
    if (!collActive || !collActive[i]) continue;
    if (layerMask && !(layerMask[i] & want)) continue;
    if (bodyCount >= cap) {
      overflow = true;
      break;
    }
    const usePose = !!(poseX && rbActive && rbActive[i]);
    let c = usePose && poseRotC ? poseRotC[i] : (rotC ? rotC[i] : 1);
    let s = usePose && poseRotS ? poseRotS[i] : (rotS ? rotS[i] : 0);
    const offX = ox ? ox[i] : 0;
    const offY = oy ? oy[i] : 0;
    let posX = usePose ? poseX[i] : tx[i];
    let posY = usePose ? (poseY ? poseY[i] : ty[i]) : ty[i];
    if (blendPose && usePose) {
      const x0 = prevPoseX[i];
      const y0 = prevPoseY[i];
      posX = x0 + (posX - x0) * poseAlpha;
      posY = y0 + (posY - y0) * poseAlpha;
      if (prevPoseRotC && prevPoseRotS) {
        const pc = prevPoseRotC[i];
        const ps = prevPoseRotS[i];
        const rc = pc + (c - pc) * poseAlpha;
        const rs = ps + (s - ps) * poseAlpha;
        const len = Math.sqrt(rc * rc + rs * rs) || 1;
        c = rc / len;
        s = rs / len;
      }
    }
    const worldX = posX + c * offX - s * offY;
    const worldY = posY + s * offX + c * offY;
    const kind = shapeType[i] | 0;
    let hw = 0;
    let hh = 0;
    let vStart = 0;
    let vCount = 0;
    if (kind === ShapeType.Circle) {
      hw = radius[i];
      hh = 0;
    } else if (kind === ShapeType.Polygon) {
      const pc = polyCount[i] | 0;
      vStart = vertCount;
      vCount = pc;
      const base = i * MAX_POLYGON_VERTICES;
      let minX = 1e9;
      let minY = 1e9;
      let maxX = -1e9;
      let maxY = -1e9;
      for (let v = 0; v < pc && vertCount < maxVerts; v++) {
        const pxv = polyVX[base + v];
        const pyv = polyVY[base + v];
        const dst = vertCount * 2;
        vertData[dst] = pxv;
        vertData[dst + 1] = pyv;
        if (pxv < minX) minX = pxv;
        if (pyv < minY) minY = pyv;
        if (pxv > maxX) maxX = pxv;
        if (pyv > maxY) maxY = pyv;
        vertCount++;
      }
      hw = (maxX - minX) * 0.5;
      hh = (maxY - minY) * 0.5;
    } else {
      hw = (width[i] || 0) * 0.5;
      hh = (height[i] || 0) * 0.5;
    }
    let flags = feedBits ? feedBits[i] : 0;
    flags = (flags & ~COMPUTE_FLAG_STATIC) | (isStatic && isStatic[i] ? COMPUTE_FLAG_STATIC : 0);
    const velx = vx ? vx[i] : 0;
    const vely = vy ? vy[i] : 0;
    const w = omega ? omega[i] : 0;

    let prevPx = worldX;
    let prevPy = worldY;
    let sweepFromX = 0;
    let sweepFromY = 0;
    let sweepC = c;
    let sweepS = s;
    let canSweep = false;
    if (usePose) {
      if (prevPoseX && prevPoseY) {
        prevPx = prevPoseX[i];
        prevPy = prevPoseY[i];
        sweepFromX = prevPx;
        sweepFromY = prevPy;
        sweepC = prevPoseRotC ? prevPoseRotC[i] : c;
        sweepS = prevPoseRotS ? prevPoseRotS[i] : s;
        canSweep = true;
      }
    } else if (px) {
      prevPx = px[i];
      prevPy = py ? py[i] : worldY;
      sweepFromX = prevPx;
      sweepFromY = prevPy;
      sweepC = rotC ? rotC[i] : c;
      sweepS = rotS ? rotS[i] : s;
      canSweep = true;
    }

    const ddx = worldX - prevPx;
    const ddy = worldY - prevPy;
    if (bodyCount >= cap) {
      overflow = true;
      break;
    }
    bodyCount = writeBody(bodyData, bodyCount, worldX, worldY, c, s, hw, hh, kind, flags, velx, vely, w, vStart, vCount, prevPx, prevPy);

    if (!sweep || !canSweep || (isStatic && isStatic[i])) continue;
    const dx = worldX - sweepFromX;
    const dy = worldY - sweepFromY;
    const distSq = dx * dx + dy * dy;
    const cell = 8;
    if (distSq <= cell * cell) continue;
    const samples = Math.min(8, Math.ceil(Math.sqrt(distSq) / cell));
    if (samples <= 1) continue;
    const sweepFlags = (flags & ~1) | COMPUTE_FLAG_SWEEP;
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      const sx = sweepFromX + dx * t;
      const sy = sweepFromY + dy * t;
      if (bodyCount >= cap) {
        overflow = true;
        break;
      }
      bodyCount = writeBody(bodyData, bodyCount, sx, sy, sweepC, sweepS, hw, hh, kind, sweepFlags, velx, vely, w, vStart, vCount, sx - ddx, sy - ddy);
    }
  }

  PACK_OUT.bodyCount = bodyCount;
  PACK_OUT.vertCount = vertCount;
  if (overflow && !packBox2dBodies._overflowWarned) {
    packBox2dBodies._overflowWarned = 1;
    console.warn(`packBox2dBodies: overflow (maxBodies=${cap})`);
  }
  return PACK_OUT;
}
