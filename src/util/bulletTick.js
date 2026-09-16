// bulletTick.js — Move + linecast + impact write + despawn.
// Extracted from particle_worker.js so Node kernels hit the same loop.

import { Ray } from '../core/ray.js';

/**
 * Advance every active bullet one step: integrate, raycast prev→next, write
 * impacts, despawn on hit. Writes activeData[0] = live count.
 *
 * Camera culling stays in the worker (not this hyp).
 *
 * @param {Object} p
 * @param {number} p.maxBullets
 * @param {number} p.dtRatio
 * @param {Uint8Array} p.active
 * @param {Float32Array} p.x
 * @param {Float32Array} p.y
 * @param {Float32Array} p.prevX
 * @param {Float32Array} p.prevY
 * @param {Float32Array} p.vx
 * @param {Float32Array} p.vy
 * @param {Float32Array} p.bulletRotC
 * @param {Float32Array} p.bulletRotS
 * @param {Float32Array} p.damage
 * @param {Uint16Array} p.ownerId
 * @param {Uint8Array} p.shooterEntityType
 * @param {Uint16Array} p.activeData - [count, idx0, ...]
 * @param {Int32Array|null} p.impactHeader
 * @param {Float32Array|null} p.impactData
 * @param {number} p.maxImpacts
 * @param {Set<number>|null} p.excludeSet - reused Set; if null, ownerId is passed as scalar excludeA
 * @param {Uint16Array|null} [p.liveIndices] - if set, tick only these slots (compact; no lock)
 * @param {number} [p.liveCount] - length of liveIndices
 * @param {(index: number) => void} [p.onDespawn]
 * @returns {{ activeCount: number, impactWrite: number }}
 */
export function tickBulletsBuffers({
  maxBullets,
  dtRatio,
  active,
  x,
  y,
  prevX,
  prevY,
  vx,
  vy,
  speed,
  bulletRotC,
  bulletRotS,
  damage,
  ownerId,
  shooterEntityType,
  activeData,
  impactHeader,
  impactData,
  maxImpacts,
  excludeSet,
  liveIndices = null,
  liveCount = 0,
  onDespawn,
}) {
  const dt = dtRatio * (1 / 60);
  let activeWrite = 1;
  let impactWrite = 0;
  const impactCap = maxImpacts | 0;
  const useSpeed = speed != null;
  const useLive = liveIndices != null;
  const iterCount = useLive ? liveCount | 0 : maxBullets;

  for (let n = 0; n < iterCount; n++) {
    const i = useLive ? liveIndices[n] : n;
    if (!active[i]) continue;

    const px = x[i];
    const py = y[i];
    prevX[i] = px;
    prevY[i] = py;

    const dx = vx[i] * dt;
    const dy = vy[i] * dt;
    x[i] = px + dx;
    y[i] = py + dy;

    let len;
    if (useSpeed) {
      len = speed[i] * dt;
    } else {
      const lenSq = dx * dx + dy * dy;
      len = lenSq > 1e-12 ? Math.sqrt(lenSq) : 0;
    }

    if (len > 1e-6) {
      let exclude = ownerId[i];
      if (excludeSet) {
        excludeSet.clear();
        excludeSet.add(ownerId[i]);
        exclude = excludeSet;
      }
      const hit = Ray.linecastDir(px, py, bulletRotC[i], bulletRotS[i], len, exclude);
      if (hit.blocked && hit.entityIndex >= 0) {
        const t = Math.min(hit.distance / len, 1);
        const hitX = px + dx * t;
        const hitY = py + dy * t;

        if (impactHeader && impactWrite < impactCap) {
          const base = impactWrite * 6;
          impactData[base] = hit.entityIndex;
          impactData[base + 1] = damage[i];
          impactData[base + 2] = hitX;
          impactData[base + 3] = hitY;
          impactData[base + 4] = ownerId[i];
          impactData[base + 5] = shooterEntityType[i];
          impactWrite++;
        }
        active[i] = 0;
        if (onDespawn) onDespawn(i);
        continue;
      }
    }

    activeData[activeWrite++] = i;
  }

  activeData[0] = activeWrite - 1;
  if (impactHeader) {
    Atomics.store(impactHeader, 0, impactWrite);
    Atomics.add(impactHeader, 1, 1);
  }

  return { activeCount: activeWrite - 1, impactWrite };
}
