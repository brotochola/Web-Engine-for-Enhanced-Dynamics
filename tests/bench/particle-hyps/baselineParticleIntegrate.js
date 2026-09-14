// particleIntegrate.js - Pure particle physics integration + active/visible list building
// Extracted from particle_worker.js (same pattern as decalStamp.js) so the hot per-particle
// loops can be exercised from Node (tests/bench) without instantiating workers.
// particle_worker.js calls these as thin wrappers (this.* -> plain params).

import { ParticleEmitter } from './ParticleEmitter.js';

/**
 * Advance physics for the currently active particle list: lifetime, gravity, ground
 * contact, floor fade/despawn. Despawns particles back to ParticleEmitter's free list
 * in place (component.active[i] = 0 + ParticleEmitter.returnToPool(i)).
 *
 * @param {Object} p
 * @param {Uint16Array} p.activeIndices - Local index buffer (built by buildActiveListBuffers /
 *   buildActiveAndVisibleListBuffers)
 * @param {number} p.count - Valid entries in activeIndices
 * @param {number} p.deltaTime - Frame delta time (ms)
 * @param {number} p.dtRatio - Fixed-step delta ratio
 * @param {boolean} p.decalsEnabled
 * @param {Uint16Array|null} p.particlesToStamp - Output buffer for stayOnTheFloor indices (may be null)
 * @param {Object} p.components - ParticleComponent-shaped SoA views: active, x, y, z, vx, vy, vz,
 *   lifespan, currentLife, gravity, alpha, fadeOnTheFloor, timeOnFloor, initialAlpha,
 *   stayOnTheFloor, despawnOnGroundContact, tweenMask, flat
 * @returns {{ activeCount: number, stampedCount: number }}
 */
export function updateParticlePhysicsBuffers({
  activeIndices,
  count,
  deltaTime,
  dtRatio,
  decalsEnabled,
  particlesToStamp,
  components,
}) {
  const {
    active,
    x,
    y,
    z,
    vx,
    vy,
    vz,
    lifespan,
    currentLife,
    gravity,
    alpha,
    fadeOnTheFloor,
    timeOnFloor,
    initialAlpha,
    stayOnTheFloor,
    despawnOnGroundContact,
    flat,
  } = components;

  let activeCount = 0;
  let stampedCount = 0;

  for (let idx = 0; idx < count; idx++) {
    const i = activeIndices[idx];

    currentLife[i] += deltaTime;

    if (currentLife[i] >= lifespan[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }
    // Flat: screen-plane only — always integrate XY (ignore z / floor flags)
    if (flat[i]) {
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
      activeCount++;
      continue;
    }

    // Heighted: gravity + air / ground
    vz[i] += gravity[i] * dtRatio;

    if (z[i] < 0) {
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
      z[i] += vz[i] * dtRatio;
      activeCount++;
      continue;
    }

    // On ground
    z[i] = 0;
    vx[i] = 0;
    vy[i] = 0;
    vz[i] = 0;

    if (despawnOnGroundContact[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }

    if (stayOnTheFloor[i]) {
      if (decalsEnabled && particlesToStamp) {
        particlesToStamp[stampedCount++] = i;
      }
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
      continue;
    }

    if (fadeOnTheFloor[i] > 0) {
      if (timeOnFloor[i] === 0) {
        initialAlpha[i] = alpha[i];
      }

      timeOnFloor[i] += deltaTime;
      const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);
      alpha[i] = initialAlpha[i] * (1 - fadeProgress);

      if (alpha[i] <= 0) {
        active[i] = 0;
        ParticleEmitter.returnToPool(i);
        continue;
      }
    }

    activeCount++;
  }

  return { activeCount, stampedCount };
}

/**
 * Build the active particle index list only (no camera / visibility test).
 * Mirrors the "camera not ready" fallback branch of buildActiveAndVisibleListBuffers.
 *
 * @param {Object} p
 * @param {number} p.maxParticles
 * @param {Uint8Array} p.active
 * @param {Uint16Array} p.localIndices - Output: local active index buffer
 * @param {Int32Array|null} [p.activeData] - Optional SAB [count, idx0, idx1, ...]
 * @param {number} p.expectedActive - Free-list-derived upper bound (early exit)
 * @returns {number} activeCount
 */
export function buildActiveListBuffers({ maxParticles, active, localIndices, activeData, expectedActive }) {
  let count = 0;
  let i = 0;

  for (; i + 3 < maxParticles && count < expectedActive; i += 4) {
    if (active[i]) {
      localIndices[count] = i;
      if (activeData) activeData[1 + count] = i;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 1]) {
      localIndices[count] = i + 1;
      if (activeData) activeData[1 + count] = i + 1;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 2]) {
      localIndices[count] = i + 2;
      if (activeData) activeData[1 + count] = i + 2;
      count++;
      if (count >= expectedActive) break;
    }
    if (active[i + 3]) {
      localIndices[count] = i + 3;
      if (activeData) activeData[1 + count] = i + 3;
      count++;
    }
  }

  for (; i < maxParticles && count < expectedActive; i++) {
    if (active[i]) {
      localIndices[count] = i;
      if (activeData) activeData[1 + count] = i;
      count++;
    }
  }

  if (activeData) activeData[0] = count;
  return count;
}

/**
 * Fused active-list + screen-visibility build (camera-ready path). Camera bounds must
 * already be resolved to scalar screen-space min/max (see utils.calculateCameraScreenBounds).
 *
 * @param {Object} p
 * @param {number} p.maxParticles
 * @param {Uint8Array} p.active
 * @param {Float32Array} p.x
 * @param {Float32Array} p.y
 * @param {Uint8Array} p.isItOnScreen - Written per-particle
 * @param {Uint16Array} p.localIndices - Output: local active index buffer
 * @param {Int32Array|null} [p.activeData]
 * @param {Int32Array|null} [p.visibleData]
 * @param {number} p.expectedActive
 * @param {number} p.camZoom
 * @param {number} p.camOffX
 * @param {number} p.camOffY
 * @param {number} p.camMinX
 * @param {number} p.camMaxX
 * @param {number} p.camMinY
 * @param {number} p.camMaxY
 * @returns {{ activeCount: number, visibleCount: number }}
 */
export function buildActiveAndVisibleListBuffers({
  maxParticles,
  active,
  x,
  y,
  isItOnScreen,
  localIndices,
  activeData,
  visibleData,
  expectedActive,
  camZoom,
  camOffX,
  camOffY,
  camMinX,
  camMaxX,
  camMinY,
  camMaxY,
}) {
  let activeCount = 0;
  let visibleCount = 0;
  let i = 0;

  for (; i + 3 < maxParticles && activeCount < expectedActive; i += 4) {
    if (active[i]) {
      localIndices[activeCount] = i;
      if (activeData) activeData[1 + activeCount] = i;
      activeCount++;

      const screenX = x[i] * camZoom - camOffX;
      const screenY = y[i] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i;
        visibleCount++;
      } else {
        isItOnScreen[i] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 1]) {
      localIndices[activeCount] = i + 1;
      if (activeData) activeData[1 + activeCount] = i + 1;
      activeCount++;

      const screenX = x[i + 1] * camZoom - camOffX;
      const screenY = y[i + 1] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 1] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 1;
        visibleCount++;
      } else {
        isItOnScreen[i + 1] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 2]) {
      localIndices[activeCount] = i + 2;
      if (activeData) activeData[1 + activeCount] = i + 2;
      activeCount++;

      const screenX = x[i + 2] * camZoom - camOffX;
      const screenY = y[i + 2] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 2] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 2;
        visibleCount++;
      } else {
        isItOnScreen[i + 2] = 0;
      }
      if (activeCount >= expectedActive) break;
    }

    if (active[i + 3]) {
      localIndices[activeCount] = i + 3;
      if (activeData) activeData[1 + activeCount] = i + 3;
      activeCount++;

      const screenX = x[i + 3] * camZoom - camOffX;
      const screenY = y[i + 3] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
      if (onScreen) {
        isItOnScreen[i + 3] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i + 3;
        visibleCount++;
      } else {
        isItOnScreen[i + 3] = 0;
      }
    }
  }

  for (; i < maxParticles && activeCount < expectedActive; i++) {
    if (!active[i]) continue;

    localIndices[activeCount] = i;
    if (activeData) activeData[1 + activeCount] = i;
    activeCount++;

    const screenX = x[i] * camZoom - camOffX;
    const screenY = y[i] * camZoom - camOffY;
    const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;

    if (onScreen) {
      isItOnScreen[i] = 1;
      if (visibleData) visibleData[1 + visibleCount] = i;
      visibleCount++;
    } else {
      isItOnScreen[i] = 0;
    }
  }

  if (activeData) activeData[0] = activeCount;
  if (visibleData) visibleData[0] = visibleCount;

  return { activeCount, visibleCount };
}
