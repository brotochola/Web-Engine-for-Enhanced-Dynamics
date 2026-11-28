// E-199: the neighbour aggregates of wasm/spatialPublish.c's publish_batch_agg, in JS, with the same arithmetic in
// the same order (float32 inputs widened to double, the outputs rounded to float32 by their arrays), so the kernel's
// outputs equal these bit for bit (tests/node/neighborAggregatesWasm.test.js). The row it publishes is the plain
// publish's (publishFilteredNeighborsJs).

import { AGG_F_COHESION, AGG_F_NEAREST, AGG_F_SEPARATION, AGG_F_VELOCITY } from '../../src/util/neighborAggregatesSpec.js';

const SEPARATION_MIN_D2 = 1;

/**
 * Entity a's row and aggregates, as publish_batch_agg writes them.
 * @param {number} a entity
 * @param {{ pos: Float32Array, range: Float32Array, cand: ArrayLike<number>, rows: { [i: number]: number } }} io
 * @param {number} maxNeighbors
 * @param {object} t the type's resolved config (resolveNeighborAggregates' classes[k])
 * @param {object} out { separationX, separationY, separationCount, centroidX, centroidY, cohesionCount,
 *   averageVelocityX, averageVelocityY, nearestIndex, nearestDistanceSq, nearestCount, nearestSlots }
 * @param {Float32Array | null} vx RigidBody.vx (null: no velocity averaged)
 * @param {Float32Array | null} vy
 */
export function publishAggregatesJs(a, io, maxNeighbors, t, out, vx, vy) {
  const { pos, range, cand, rows } = io;
  const stride = 1 + maxNeighbors;
  const myX = pos[a * 4];
  const myY = pos[a * 4 + 1];
  const myRange = range[a];
  const base = a * stride;
  const candCount = cand[base];
  const flags = t.flags & (vx && vy ? 0xffffffff : ~AGG_F_VELOCITY);
  const sep = (flags & AGG_F_SEPARATION) !== 0;
  const coh = (flags & AGG_F_COHESION) !== 0;
  const vel = (flags & AGG_F_VELOCITY) !== 0;
  const near = (flags & AGG_F_NEAREST) !== 0;
  const inRange = (b, lo, span) => ((b - lo) >>> 0) < span;
  let published = 0;
  let sx = 0;
  let sy = 0;
  let sn = 0;
  let cx = 0;
  let cy = 0;
  let vxs = 0;
  let vys = 0;
  let cn = 0;
  let nn = 0;
  const nb = a * out.nearestSlots;
  const nearId = out.nearestIndex;
  const nearD2 = out.nearestDistanceSq;
  for (let i = 0; i < candCount && published < maxNeighbors; i++) {
    const b = cand[base + 1 + i];
    const bx = pos[b * 4];
    const by = pos[b * 4 + 1];
    const dx = bx - myX;
    const dy = by - myY;
    const er = myRange + pos[b * 4 + 2];
    const d2 = dx * dx + dy * dy;
    if (!(d2 < er * er)) continue;
    rows[base + 1 + published] = b;
    published++;
    if (sep && inRange(b, t.sepLo, t.sepSpan) && d2 > SEPARATION_MIN_D2 && d2 < t.sepR2) {
      const w = 1 - d2 * t.sepFalloff;
      const dd = d2 < t.sepFloor2 ? t.sepFloor2 : d2;
      sx -= (dx * w) / dd;
      sy -= (dy * w) / dd;
      sn++;
    }
    if (coh && inRange(b, t.cohLo, t.cohSpan) && d2 >= t.cohMin2) {
      cx += bx;
      cy += by;
      if (vel) {
        vxs += vx[b];
        vys += vy[b];
      }
      cn++;
    }
    if (near && inRange(b, t.nearLo, t.nearSpan)) {
      const d2s = Math.fround(d2);
      let slot;
      if (nn < t.nearK) slot = nn++;
      else if (d2s < nearD2[nb + t.nearK - 1]) slot = t.nearK - 1;
      else continue;
      while (slot > 0 && d2s < nearD2[nb + slot - 1]) {
        nearD2[nb + slot] = nearD2[nb + slot - 1];
        nearId[nb + slot] = nearId[nb + slot - 1];
        slot--;
      }
      nearD2[nb + slot] = d2s;
      nearId[nb + slot] = b;
    }
  }
  rows[base] = published;
  if (sep) {
    out.separationX[a] = sx;
    out.separationY[a] = sy;
    out.separationCount[a] = sn;
  }
  if (coh) {
    out.centroidX[a] = cn ? cx / cn : 0;
    out.centroidY[a] = cn ? cy / cn : 0;
    out.cohesionCount[a] = cn;
    if (vel) {
      out.averageVelocityX[a] = cn ? vxs / cn : 0;
      out.averageVelocityY[a] = cn ? vys / cn : 0;
    }
  }
  if (near) out.nearestCount[a] = nn;
}
