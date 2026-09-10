/**
 * Pack fed colliders into GPU Body + verts arrays (no alloc in the hot loop).
 */
import { Collider } from '../components/Collider.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Layer } from '../core/Layer.js';
import { MAX_POLYGON_VERTICES, ShapeType, COMPUTE_FLAG_STATIC, COMPUTE_FLAG_SWEEP } from '../core/ConfigDefaults.js';

export const BODY_FLOATS = 16;
export const BODY_STRIDE_BYTES = BODY_FLOATS * 4;

/**
 * @param {number} layerId
 * @param {Float32Array} bodyData
 * @param {Float32Array} vertData
 * @param {number} maxBodies
 * @param {{ sweep: boolean }} [opts]
 * @returns {{ bodyCount: number, vertCount: number }}
 */
export function packBox2dBodies(layerId, bodyData, vertData, maxBodies, opts) {
  const indices = Layer._feedIndices[layerId];
  const countArr = Layer._feedCount;
  const feederCount = countArr ? Atomics.load(countArr, layerId) : 0;
  const cap = maxBodies | 0;
  const sweep = !opts || opts.sweep !== false;
  let bodyCount = 0;
  let vertCount = 0;
  const maxVerts = vertData ? (vertData.length / 2) | 0 : 0;

  if (!indices || feederCount <= 0 || cap <= 0) {
    return { bodyCount: 0, vertCount: 0 };
  }

  const tx = Transform.x;
  const ty = Transform.y;
  const rotC = Transform.rotC;
  const rotS = Transform.rotS;
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

  const n = feederCount < cap ? feederCount : cap;

  function emit(i, x, y, c, s, hw, hh, kind, flags, velx, vely, w, vStart, vCount) {
    if (bodyCount >= cap) return false;
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
    bodyData[b + 13] = 0;
    bodyData[b + 14] = 0;
    bodyData[b + 15] = 0;
    bodyCount++;
    return true;
  }

  for (let f = 0; f < n; f++) {
    if (bodyCount >= cap) break;
    const i = indices[f];
    if (!collActive || !collActive[i]) continue;
    const c = rotC ? rotC[i] : 1;
    const s = rotS ? rotS[i] : 0;
    const offX = ox ? ox[i] : 0;
    const offY = oy ? oy[i] : 0;
    const worldX = tx[i] + c * offX - s * offY;
    const worldY = ty[i] + s * offX + c * offY;
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
    if (!emit(i, worldX, worldY, c, s, hw, hh, kind, flags, velx, vely, w, vStart, vCount)) break;

    if (!sweep || (isStatic && isStatic[i]) || !px) continue;
    const dx = worldX - px[i];
    const dy = worldY - py[i];
    const dist = Math.hypot(dx, dy);
    const cell = 8;
    const samples = Math.min(8, Math.ceil(dist / cell));
    if (samples <= 1) continue;
    const sweepFlags = (flags & ~1) | COMPUTE_FLAG_SWEEP;
    const prevC = rotC ? rotC[i] : c;
    const prevS = rotS ? rotS[i] : s;
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      const sx = px[i] + dx * t;
      const sy = py[i] + dy * t;
      if (!emit(i, sx, sy, prevC, prevS, hw, hh, kind, sweepFlags, velx, vely, w, vStart, vCount)) break;
    }
  }

  return { bodyCount, vertCount };
}
